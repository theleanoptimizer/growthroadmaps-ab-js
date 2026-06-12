// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrowthRoadmaps } from '../src/index';
import { clearMemoryCache } from '../src/storage';
import type { ExperimentConfig } from '../src/types';

const PROJECT_KEY = 'pk_rollout_test';
const API_HOST = 'https://api.example.com';
const CDN_URL = `https://js.growthroadmaps.com/configs/${encodeURIComponent(PROJECT_KEY)}.json`;

function makeRollingOutExp(): ExperimentConfig {
  return {
    id: 'exp-rollout-1',
    name: 'Rollout Experiment',
    status: 'rolling_out',
    mode: 'client',
    traffic_percentage: 100,
    rollout_variant_id: 'exp-rollout-1-winner',
    variants: [
      { id: 'exp-rollout-1-ctrl', name: 'Control', weight: 50, is_control: true, css: '.ctrl{color:red}' },
      { id: 'exp-rollout-1-winner', name: 'Winner', weight: 50, css: '.winner{color:green}' },
    ],
  };
}

describe('rollout overrides stale localStorage assignment', () => {
  let sdk: GrowthRoadmaps | null = null;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearMemoryCache();
    document.body.innerHTML = '';
    history.replaceState({}, '', '/');

    // Visitor was bucketed into control while the test was running.
    localStorage.setItem(
      'ab_va_' + PROJECT_KEY,
      JSON.stringify({
        'exp-rollout-1': {
          variantId: 'exp-rollout-1-ctrl',
          css: '.ctrl{color:red}',
        },
      }),
    );
  });

  afterEach(() => {
    sdk?.destroy();
    sdk = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    clearMemoryCache();
  });

  it('applies the rollout winner instead of the saved control bucket', async () => {
    const exp = makeRollingOutExp();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url ?? input.toString();
        if (url === CDN_URL || url.includes('all-configs')) {
          return new Response(
            JSON.stringify({
              project: { id: 'p1', domain: 'example.com' },
              experiments: { [exp.id]: exp },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );

    sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST, mutationObserver: false });
    await sdk.init();

    expect(sdk.getVariant('Rollout Experiment', 'Control')).toBe('Winner');
    expect(document.querySelector('style[data-ab-css="exp-rollout-1-winner"]')).not.toBeNull();
    expect(document.querySelector('style[data-ab-css="exp-rollout-1-ctrl"]')).toBeNull();
  });
});
