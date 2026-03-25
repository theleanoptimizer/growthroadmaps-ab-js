# @growthroadmaps/ab-client

A standalone, zero-dependency client-side JavaScript SDK for running A/B tests. The SDK fetches experiment configurations from the platform API, deterministically assigns users to variants, batches exposure and conversion events, and supports an anti-flicker mode to prevent visible page reflows.

## Installation

Include the SDK via a script tag or install as an ES module.

## Usage

### Standard Script Tag (no anti-flicker)

```html
<script src="https://js.growthroadmaps.com/ab-testing.min.js" async></script>
<script>
  window.addEventListener('ab:ready', async function() {
    const ab = new ABTesting({
      projectKey: 'proj_xxx',
      apiHost: 'https://growthroadmaps.com',
      userId: 'user_123'
    })
    await ab.init()
    const variant = ab.getVariant('hero-cta', 'control')
    if (variant === 'variant_b') {
      document.getElementById('cta').textContent = 'Start free trial'
    }
    ab.track('signup')
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
<script src="https://js.growthroadmaps.com/ab-testing.min.js" async></script>

<!-- Step 3: init with antiFlicker: true — SDK reveals page automatically -->
<script>
  window.addEventListener('ab:ready', async function() {
    const ab = new ABTesting({
      projectKey: 'proj_xxx',
      apiHost: 'https://growthroadmaps.com',
      userId: 'user_123',
      antiFlicker: true
    })
    await ab.init()  // page becomes visible here
    const variant = ab.getVariant('hero-cta', 'control')
    if (variant === 'variant_b') {
      document.getElementById('cta').textContent = 'Start free trial'
    }
    ab.track('signup')
  })
</script>
```

### ES Module

```javascript
import { ABTesting } from '@growthroadmaps/ab-client'
// identical API, antiFlicker option works the same way
```

## API Reference

### `new ABTesting(config)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectKey` | `string` | Yes | Your project's public key |
| `apiHost` | `string` | Yes | The platform API host URL |
| `userId` | `string` | No | The current user's ID |
| `sessionId` | `string` | No | The current session ID |
| `antiFlicker` | `boolean` | No | Enable anti-flicker mode (default: `false`) |

### `init(): Promise<void>`

Fetches experiment configurations from the API. Caches in memory and localStorage with a 60-second TTL. On failure, falls back to cached config or empty config. Never throws.

### `getVariant(experimentName: string, fallback: string): string`

Returns the assigned variant name for the given experiment. Uses deterministic FNV-1a hashing — same userId + experimentId always returns the same variant. Automatically queues an exposure event on first call per experiment per session.

### `track(goalName: string, options?: { value?: number; metadata?: object }): void`

Queues a conversion event for all experiments the user has been exposed to in this session.

### `trackFor(experimentName: string, goalName: string, options?: { value?: number }): void`

Queues a conversion event for a specific experiment only.

### `getAntiFlickerSnippet(maxHideMs?: number): string`

Returns the inline anti-flicker script string with the specified timeout (default: 3000ms).

## Event Batching

- Events are batched and sent every 2 seconds or when 20 events accumulate
- Uses `navigator.sendBeacon` on page unload to ensure no events are lost
- Retries once on failure before discarding

## Build

```bash
npm run build
```

Outputs:
- `dist/ab-testing.esm.js` — ES module
- `dist/ab-testing.umd.js` — UMD
- `dist/ab-testing.min.js` — Minified UMD (~11 KB, ~4.2 KB gzipped)
- `dist/index.d.ts` — TypeScript declarations
