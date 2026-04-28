// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GrowthRoadmaps } from '../src/index';
import type { AudienceAttributeConfig } from '../src/types';

interface TestSdk {
  sdk: GrowthRoadmaps;
  projectKey: string;
}

const PROJECT_KEY = 'pk_test';
const ATTRS_KEY = `_ab_attrs_${PROJECT_KEY}`;

function mockAllConfigsFetch(audiences: AudienceAttributeConfig[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/ab/experiments/all-configs')) {
      return new Response(
        JSON.stringify({
          project: { id: 'p1', domain: 'localhost' },
          experiments: [],
          heatmapConfigs: [],
          formAnalyticsConfigs: [],
          audiences,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200 });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function createSdk(
  audiences: AudienceAttributeConfig[],
  opts: { url?: string; projectKey?: string } = {},
): Promise<TestSdk> {
  const projectKey = opts.projectKey ?? PROJECT_KEY;
  if (opts.url) history.replaceState({}, '', opts.url);
  mockAllConfigsFetch(audiences);
  const sdk = new GrowthRoadmaps({ projectKey, apiHost: 'https://api.example.com' });
  await sdk.init();
  return { sdk, projectKey };
}

function readPersistedAttrs(projectKey = PROJECT_KEY): Record<string, string> | null {
  const raw = sessionStorage.getItem(`_ab_attrs_${projectKey}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

function clearAllCookies() {
  document.cookie
    .split(';')
    .map(c => c.trim())
    .filter(Boolean)
    .forEach(c => {
      const eq = c.indexOf('=');
      const name = eq > -1 ? c.slice(0, eq) : c;
      document.cookie = `${name}=;path=/;max-age=0;SameSite=Lax`;
    });
}

describe('SDK audience attribute capture', () => {
  let createdSdks: GrowthRoadmaps[];

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearAllCookies();
    document.body.innerHTML = '';
    history.replaceState({}, '', '/');
    createdSdks = [];
  });

  afterEach(() => {
    for (const s of createdSdks) {
      try { s.destroy(); } catch {}
    }
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    clearAllCookies();
    history.replaceState({}, '', '/');
  });

  function track(sdk: GrowthRoadmaps): GrowthRoadmaps {
    createdSdks.push(sdk);
    return sdk;
  }

  it('rehydrates captured attributes from sessionStorage on a fresh SDK instance (page reload)', async () => {
    const { sdk: sdk1 } = await createSdk([]);
    track(sdk1);

    sdk1.setAttribute('plan', 'pro');
    sdk1.setAttribute('beta_user', true);
    sdk1.setAttribute('seats', 12);

    const persistedAfterFirst = readPersistedAttrs();
    expect(persistedAfterFirst).toEqual({
      plan: 'pro',
      beta_user: 'true',
      seats: '12',
    });

    sdk1.destroy();

    // Simulate full page reload — sessionStorage survives, the SDK module is
    // re-imported in a real reload but the constructor's restoration logic is
    // what we exercise here.
    const { sdk: sdk2 } = await createSdk([]);
    track(sdk2);

    // Set a NEW attribute on the second instance. #persistAttrs writes the
    // entire #attrs map, so if rehydration worked the persisted JSON now has
    // the original three keys PLUS the new one.
    sdk2.setAttribute('signed_in', 'yes');

    const persistedAfterReload = readPersistedAttrs();
    expect(persistedAfterReload).toEqual({
      plan: 'pro',
      beta_user: 'true',
      seats: '12',
      signed_in: 'yes',
    });
  });

  it('captures clicks on the document in the capture phase before customer handlers cancel propagation', async () => {
    const audiences: AudienceAttributeConfig[] = [
      {
        id: 'aud-click-1',
        attribute_key: 'clicked_pricing',
        label: 'Clicked Pricing',
        source_type: 'click',
        value: '#cta',
        url_match_type: null,
        set_value: 'yes',
      },
    ];

    const button = document.createElement('button');
    button.id = 'cta';
    button.textContent = 'See pricing';
    document.body.appendChild(button);

    // Customer attaches a handler that aggressively kills the click event.
    // It runs in the bubble phase (default) and at the target — both AFTER
    // our document-level capture-phase listener should have fired.
    const customerHandler = vi.fn((ev: Event) => {
      ev.stopImmediatePropagation();
      ev.stopPropagation();
      ev.preventDefault();
    });
    button.addEventListener('click', customerHandler, false);

    const { sdk } = await createSdk(audiences);
    track(sdk);

    // Sanity: nothing captured before the click.
    expect(readPersistedAttrs()).toBeNull();

    button.click();

    expect(customerHandler).toHaveBeenCalledTimes(1);
    expect(readPersistedAttrs()).toEqual({ clicked_pricing: 'yes' });
  });

  it('re-runs URL-match scans on SPA navigations through wrapped pushState/replaceState', async () => {
    const audiences: AudienceAttributeConfig[] = [
      {
        id: 'aud-url-pricing',
        attribute_key: 'visited_pricing',
        label: 'Visited Pricing',
        source_type: 'url_match',
        value: '/pricing',
        url_match_type: 'contains',
        set_value: 'yes',
      },
      {
        id: 'aud-url-checkout',
        attribute_key: 'visited_checkout',
        label: 'Visited Checkout',
        source_type: 'url_match',
        value: '/checkout',
        url_match_type: 'contains',
        set_value: 'yes',
      },
    ];

    const { sdk } = await createSdk(audiences, { url: '/' });
    track(sdk);

    // Initial scan on '/' — neither audience should match yet.
    expect(readPersistedAttrs()).toBeNull();

    // SPA navigation via pushState should re-trigger url scan.
    history.pushState({}, '', '/pricing');
    expect(readPersistedAttrs()).toEqual({ visited_pricing: 'yes' });

    // replaceState navigation to a different route should fire as well.
    history.replaceState({}, '', '/checkout');
    expect(readPersistedAttrs()).toEqual({
      visited_pricing: 'yes',
      visited_checkout: 'yes',
    });
  });

  it('silently drops reserved keys (device_type, traffic_excluded, attributes)', async () => {
    const { sdk } = await createSdk([]);
    track(sdk);

    sdk.setAttribute('device_type', 'mobile');
    sdk.setAttribute('traffic_excluded', 'true');
    sdk.setAttribute('attributes', 'foo');

    // None of the reserved keys triggered persistence — no key was written.
    expect(sessionStorage.getItem(ATTRS_KEY)).toBeNull();

    // A normal key still works and the persisted blob contains only it.
    sdk.setAttribute('plan', 'pro');
    expect(readPersistedAttrs()).toEqual({ plan: 'pro' });

    // Re-attempt reserved keys after a real attribute exists; they must
    // remain absent from the persisted blob.
    sdk.setAttribute('device_type', 'desktop');
    sdk.setAttribute('traffic_excluded', 'false');
    sdk.setAttribute('attributes', 'bar');

    const persisted = readPersistedAttrs();
    expect(persisted).toEqual({ plan: 'pro' });
    expect(persisted).not.toHaveProperty('device_type');
    expect(persisted).not.toHaveProperty('traffic_excluded');
    expect(persisted).not.toHaveProperty('attributes');
  });

  it('does not rehydrate reserved keys from a tampered sessionStorage payload', async () => {
    sessionStorage.setItem(
      ATTRS_KEY,
      JSON.stringify({
        plan: 'pro',
        device_type: 'mobile',
        traffic_excluded: 'true',
        attributes: 'foo',
      }),
    );

    const { sdk } = await createSdk([]);
    track(sdk);

    // Trigger a rewrite of the persisted blob via a normal setAttribute.
    sdk.setAttribute('signed_in', 'yes');

    const persisted = readPersistedAttrs();
    expect(persisted).toEqual({ plan: 'pro', signed_in: 'yes' });
    expect(persisted).not.toHaveProperty('device_type');
    expect(persisted).not.toHaveProperty('traffic_excluded');
    expect(persisted).not.toHaveProperty('attributes');
  });
});
