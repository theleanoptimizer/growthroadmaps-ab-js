// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrowthRoadmaps } from '../src/index';


const TEST_API = 'https://api.test.com';
const PROJECT_KEY = 'pk_lazy_goals_test';

function makeConfig(experiments: object[]) {
  return {
    project: { id: 'p1', domain: 'localhost', heatmaps_enabled: false, surveys_enabled: false },
    experiments,
    heatmapConfigs: [],
    formAnalyticsConfigs: [],
    audiences: [],
    surveys: [],
  };
}

function setupFetch(config: object, onBatch?: (body: unknown) => void) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? input.toString();
    if (url.includes('/api/ab/experiments/all-configs') || url.includes('growthroadmaps.com/configs')) {
      return new Response(JSON.stringify(config), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/ab/events/batch') && onBatch) {
      try {
        const body = JSON.parse((init?.body as string) ?? '{}');
        onBatch(body);
      } catch { /* ignore parse errors */ }
    }
    return new Response('{}', { status: 200 });
  });
}

describe('lazy goals chunk — regression', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('setupGoals wires a click listener that fires a conversion after the chunk loads', async () => {
    const config = makeConfig([
      {
        id: 'exp-click-1',
        name: 'Button Click Test',
        status: 'running',
        mode: 'server',
        traffic_percentage: 100,
        variants: [
          { id: 'v-ctrl', name: 'control', weight: 50, is_control: true },
          { id: 'v-trt', name: 'treatment', weight: 50 },
        ],
        goals: [{ id: 'g1', goal_type: 'click', value: '#lazy-cta', label: 'CTA' }],
        url_rules: [],
        targeting_rules: [],
      },
    ]);

    vi.stubGlobal('fetch', setupFetch(config));

    const btn = document.createElement('button');
    btn.id = 'lazy-cta';
    document.body.appendChild(btn);

    const sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API });
    await sdk.init();
    // init() awaits the goals chunk internally (after applying experiments),
    // so goal listeners are guaranteed to be wired before init() resolves.

    // Spy on trackFor AFTER init so we catch the goal conversion call.
    const trackSpy = vi.spyOn(sdk, 'trackFor');

    const variant = sdk.getVariant('Button Click Test', 'control');
    expect(['control', 'treatment']).toContain(variant);

    btn.click();

    // The goal listener (wired by setupGoals via the lazy chunk) must have fired
    // trackFor with the experiment name and the goal's key.
    expect(trackSpy).toHaveBeenCalledWith(
      'Button Click Test',
      expect.stringMatching(/g1|CTA|cta/i),
    );

    sdk.destroy();
    document.body.removeChild(btn);
  });

  it('checkUrlGoals fires a URL-match goal on SPA navigation', async () => {
    const config = makeConfig([
      {
        id: 'exp-url-1',
        name: 'URL Goal Test',
        status: 'running',
        mode: 'server',
        traffic_percentage: 100,
        variants: [
          { id: 'v-ctrl', name: 'control', weight: 50, is_control: true },
          { id: 'v-trt', name: 'treatment', weight: 50 },
        ],
        goals: [{ id: 'g2', goal_type: 'url_match', value: '/thank-you', label: 'Thank You' }],
        url_rules: [],
        targeting_rules: [],
      },
    ]);

    vi.stubGlobal('fetch', setupFetch(config));

    const sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API });
    await sdk.init();

    sdk.getVariant('URL Goal Test', 'control');

    history.pushState({}, '', '/thank-you');
    sdk.pageChanged();

    sdk.destroy();
    history.pushState({}, '', '/');
  });

  it('setupGoals and setupAudience are separate modules (tree-shakeable)', async () => {
    const { setupGoals } = await import('../src/goals');
    const { setupAudience } = await import('../src/audience');

    expect(typeof setupGoals).toBe('function');
    expect(typeof setupAudience).toBe('function');
  });

  it('falls back to API when CDN is unavailable and experiments still load', async () => {
    const config = makeConfig([
      {
        id: 'exp-fallback-1',
        name: 'Fallback Test',
        status: 'running',
        mode: 'client',
        traffic_percentage: 100,
        variants: [
          { id: 'v-ctrl', name: 'control', weight: 50, is_control: true },
          { id: 'v-trt', name: 'treatment', weight: 50 },
        ],
        goals: [],
        url_rules: [],
        targeting_rules: [],
      },
    ]);

    // CDN fetch fails (network error), fallback endpoint returns real config.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? input.toString();
      if (url.includes('growthroadmaps.com/configs')) {
        throw new TypeError('Network error (CDN unavailable)');
      }
      if (url.includes('/api/ab/experiments/all-configs')) {
        // Verify pk query param is present.
        expect(url).toContain('pk=');
        return new Response(JSON.stringify(config), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }));

    const sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API });
    await sdk.init();

    const variant = sdk.getVariant('Fallback Test', 'control');
    expect(['control', 'treatment']).toContain(variant);

    sdk.destroy();
  });

  it('GoalContext firedGoals Set prevents duplicate conversions', async () => {
    const { setupGoals, checkUrlGoals } = await import('../src/goals');

    const fired: string[] = [];
    const firedGoals = new Set<string>();

    const ctx = {
      experiments: [
        {
          id: 'e1',
          name: 'Dup Test',
          status: 'running' as const,
          mode: 'server' as const,
          traffic_percentage: 100,
          variants: [{ id: 'v1', name: 'control', weight: 100, is_control: true }],
          goals: [{ id: 'gx', goal_type: 'url_match', value: '/convert', label: 'Convert', url_match_type: 'contains' }],
          url_rules: [],
        },
      ],
      trackFor: (en: string, gk: string) => fired.push(en + '::' + gk),
      flushBeacon: () => {},
      firedGoals,
      dbg: () => {},
    };

    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost/convert' },
      writable: true,
      configurable: true,
    });

    setupGoals(ctx);
    checkUrlGoals(ctx);
    checkUrlGoals(ctx);

    expect(fired.filter(f => f.includes('Dup Test')).length).toBe(1);
  });
});
