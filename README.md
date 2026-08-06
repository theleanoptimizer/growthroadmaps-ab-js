# @growthroadmaps/growth-client

A standalone, zero-dependency client-side JavaScript SDK for Growth Roadmaps. The unified SDK consolidates A/B testing, heatmaps, and surveys into a single script. It fetches experiment configurations from the platform API, deterministically assigns users to variants, batches exposure and conversion events, supports an anti-flicker mode, collects heatmap data, and displays surveys — all from one lightweight bundle.

## Installation

Include the SDK via a script tag or install as an ES module.

### Cloudflare Pages (`js.growthroadmaps.com`)

The `growthroadmaps-ab-js` repo is deployed by Cloudflare Pages on every push. The build runs `npm run build`, which also runs `scripts/stage-configs-for-pages.mjs`.

**Dual writers:** Pages git builds and Heroku wrangler config publishes both do a **full-site replace**. They share Redis lock `sdk:cdn:deploy:lock` via `POST/DELETE /api/sdk/cdn-deploy-lock` (Pages) and `cloudflarePagesSdkPublisher` (Heroku). A Pages build that cannot acquire the lock within ~2 minutes **fails** so it cannot race a wrangler deploy. After a successful stage, the lock is heartbeated (~10 minutes) to cover Pages upload/activate; it is not released on success (TTL expires). On fatal staging errors the lock is released so Heroku can retry.

**What the post-build step does:**

1. Acquire the shared CDN deploy lock (when `SDK_CONFIG_KEYS_TOKEN` is set)
2. Refuse the build if any file in `required-bundles.json` is missing from `dist/` (including `growth.min.js` and `gr-panels.min.js`)
3. Backfill any prior production `*.min.js` not already in `dist/` (new build always wins; fills aliases like `panels.min.js` / `growth-loader.min.js`)
4. Re-assert required bundles
5. Stage `/configs/*.json` from prior deployments / API — **fail** if prior production had configs and zero could be staged
6. Heartbeat the lock for the activate window

**Config discovery** (in order):

1. Recent Cloudflare Pages deployment manifests — requires CF env vars below
2. Fallback: `GET https://growthroadmaps.com/api/sdk/config-keys.json` lists all project keys; each config is then fetched from the API (which auto-generates from the database when missing)

When `SDK_CONFIG_KEYS_TOKEN` is set on the main app, the config-keys and CDN lock endpoints require `Authorization: Bearer <token>`. Set the same value on Cloudflare Pages build env so `stage-configs-for-pages.mjs` can authenticate and take the lock.

Set these **Cloudflare Pages environment variables** (production):

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` (Pages read access for the account)
- `SDK_CONFIG_KEYS_TOKEN` (must match Heroku — required for lock + config-keys auth)

Config file bodies are fetched from `https://growthroadmaps.com/api/sdk/config/{projectKey}.json`. Local builds skip lock/staging when `SKIP_CONFIG_STAGING=1` or when `SDK_CONFIG_KEYS_TOKEN` is unset (lock skipped with a warning; required-bundle assert still runs).

## Usage

### Standard Script Tag (no anti-flicker)

```html
<script src="https://js.growthroadmaps.com/growth.min.js" async></script>
<script>
  window.addEventListener('gr:ready', async function() {
    window.gr = new GrowthRoadmaps({
      projectKey: 'proj_xxx',
      apiHost: 'https://growthroadmaps.com',
      userId: 'user_123'
    })
    await window.gr.init()
    var variant = window.gr.getVariant('hero-cta', 'control')
    if (variant === 'variant_b') {
      document.getElementById('cta').textContent = 'Start free trial'
    }
    window.gr.track('signup')
  })
</script>
```

### Anti-Flicker Installation

```html
<!-- Step 1: paste this as the FIRST script in <head>, before anything else -->
<script>
(function(){
  var t=setTimeout(function(){document.documentElement.style.opacity='1'},3000);
  document.documentElement.style.opacity='0';
  window.__ab_reveal=function(){clearTimeout(t);document.documentElement.style.opacity='1'};
})()
</script>

<!-- Step 2: load the SDK async as normal -->
<script src="https://js.growthroadmaps.com/growth.min.js" async></script>

<!-- Step 3: init with antiFlicker: true — SDK reveals page automatically -->
<script>
  window.addEventListener('gr:ready', async function() {
    window.gr = new GrowthRoadmaps({
      projectKey: 'proj_xxx',
      apiHost: 'https://growthroadmaps.com',
      userId: 'user_123',
      antiFlicker: true
    })
    await window.gr.init()  // page becomes visible here
    var variant = window.gr.getVariant('hero-cta', 'control')
    if (variant === 'variant_b') {
      document.getElementById('cta').textContent = 'Start free trial'
    }
    window.gr.track('signup')
  })
</script>
```

### With Heatmaps & Surveys

```html
<script src="https://js.growthroadmaps.com/growth.min.js" async></script>
<script>
  window.addEventListener('gr:ready', async function() {
    window.gr = new GrowthRoadmaps({
      projectKey: 'proj_xxx',
      apiHost: 'https://growthroadmaps.com',
      heatmaps: true,
      surveys: true
    })
    await window.gr.init()
  })
</script>
```

### ES Module

```javascript
import { GrowthRoadmaps } from '@growthroadmaps/growth-client'
// identical API, antiFlicker option works the same way
```

## API Reference

### `new GrowthRoadmaps(config)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectKey` | `string` | Yes | Your project's public key |
| `apiHost` | `string` | Yes | The platform API host URL |
| `userId` | `string` | No | The current user's ID |
| `sessionId` | `string` | No | The current session ID |
| `antiFlicker` | `boolean` | No | Enable anti-flicker mode (default: `false`) |
| `heatmaps` | `boolean` | No | Enable heatmap tracking (default: `false`) |
| `surveys` | `boolean \| { teamId }` | No | Enable surveys (default: `false`) |
| `cookieConsent` | `'required'` | No | Require consent before setting cookies |
| `mutationObserver` | `boolean` | No | Watch for late-mounting DOM elements and re-run variant JS when they appear (default: `true`). Set to `false` to revert to one-shot behaviour. |

### `init(): Promise<void>`

Fetches experiment configurations from the API. Caches in memory and localStorage with a 60-second TTL. On failure, falls back to cached config or empty config. Never throws. If surveys are enabled, loads survey configs and sets up triggers.

### `getVariant(experimentName: string, fallback: string): string`

Returns the assigned variant name for the given experiment. Uses deterministic FNV-1a hashing — same userId + experimentId always returns the same variant. Automatically queues an exposure event on first call per experiment per session.

### `track(goalName: string, options?: { value?: number; metadata?: object }): void`

Queues a conversion event for all experiments the user has been exposed to in this session.

### `trackFor(experimentName: string, goalName: string, options?: { value?: number }): void`

Queues a conversion event for a specific experiment only.

### `surveyTrack(actionName: string): void`

Triggers surveys that are configured with a `code` trigger matching the given action name.

### `setUserId(id: string): void`

Sets the user ID for survey targeting and response attribution.

### `setAttribute(key: string, value: string): void`

Sets a user attribute for survey targeting rules.

### `setEmail(email: string): void`

Convenience method to set the email attribute.

### `pageChanged(): void`

Manually notify the SDK of a route change (only needed for hash-based or non-standard routing).

### `getAntiFlickerSnippet(maxHideMs?: number): string`

Returns the inline anti-flicker script string with the specified timeout (default: 3000ms).

## Event Batching

- Events are batched and sent every 2 seconds or when 20 events accumulate
- Uses `navigator.sendBeacon` on page unload to ensure no events are lost
- Retries once on failure before discarding

## Lazy Loading

- **Heatmaps**: The heatmap tracking module is only loaded when `heatmaps: true` is set and heatmap configurations exist
- **Survey Widget**: The survey rendering module (Shadow DOM, styles, question types) is only loaded when a survey is about to display — the lightweight trigger/targeting logic is bundled in the core

## Known Limitations

### Shadow DOM

The `MutationObserver` used to detect late-mounting elements observes `document.body` with `{ childList: true, subtree: true }`. This observer does **not** cross shadow root boundaries. Variants whose target elements live inside a Shadow DOM (e.g. Web Components with closed or open shadow roots) will not be detected automatically by the observer. For those cases you must call variant JS manually after the shadow root and its children are attached, or re-initialise the SDK inside the component's `connectedCallback`.

## Build

```bash
npm run build
```

Outputs:
- `dist/growth.esm.js` — ES module
- `dist/growth.umd.js` — UMD
- `dist/growth.min.js` — Minified UMD (core A/B engine)
- `dist/heatmap.min.js` — Heatmap tracker (lazy loaded)
- `dist/survey.min.js` — Survey manager (lazy loaded)
- `dist/survey-widget.min.js` — Survey widget renderer (lazy loaded)
- `dist/growth-loader.min.js` — Anti-flicker loader
- `dist/index.d.ts` — TypeScript declarations
