// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrowthRoadmaps } from '../src/index';
import { getStorageKey, getCachedConfig, setCachedConfig, clearMemoryCache } from '../src/storage';
import type { ExperimentConfig, CachedConfig } from '../src/types';

const PROJECT_KEY = 'pk_cache_test';
const CACHE_KEY = getStorageKey(PROJECT_KEY);
const ETAG_KEY = `_ab_cfg_etag_${PROJECT_KEY}`;
const API_HOST = 'https://api.example.com';
const CDN_URL = `https://js.growthroadmaps.com/configs/${encodeURIComponent(PROJECT_KEY)}.json`;
const API_URL = `${API_HOST}/api/ab/experiments/all-configs?pk=${encodeURIComponent(PROJECT_KEY)}`;

const STALE_TIMESTAMP = Date.now() - 120_000;

function makeExp(id: string, name: string): ExperimentConfig {
  return {
    id,
    name,
    status: 'running',
    variants: [
      { id: `${id}-ctrl`, name: 'Control', weight: 50, is_control: true },
      { id: `${id}-var`, name: 'Variant', weight: 50 },
    ],
  };
}

function makeConfigResponse(experiments: ExperimentConfig[], extra?: Partial<CachedConfig>): object {
  return {
    project: { id: PROJECT_KEY, domain: 'example.com' },
    experiments: Object.fromEntries(experiments.map(e => [e.id, e])),
    heatmapConfigs: [],
    formAnalyticsConfigs: [],
    audiences: [],
    surveys: [],
    ...extra,
  };
}

function makeStaleCachedProject() {
  return { id: PROJECT_KEY, domain: 'example.com' };
}

function seedStaleCache(experiments: ExperimentConfig[]): void {
  const cached: CachedConfig = {
    experiments,
    project: makeStaleCachedProject(),
    heatmapConfigs: [],
    formAnalyticsConfigs: [],
    audiences: [],
    surveys: [],
    timestamp: STALE_TIMESTAMP,
  };
  localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
}

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? input.toString();
    return handler(url);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function readCachedExperimentIds(): string[] {
  const cc = getCachedConfig(PROJECT_KEY);
  return cc ? cc.experiments.map(e => e.id).sort() : [];
}

function readCachedTimestamp(): number | null {
  const cc = getCachedConfig(PROJECT_KEY);
  return cc ? cc.timestamp : null;
}

describe('loadConfig cache behaviour', () => {
  let createdSdks: GrowthRoadmaps[];

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearMemoryCache();
    document.body.innerHTML = '';
    history.replaceState({}, '', '/');
    createdSdks = [];
  });

  afterEach(() => {
    for (const s of createdSdks) {
      try { s.destroy(); } catch {}
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    clearMemoryCache();
  });

  function track(sdk: GrowthRoadmaps): GrowthRoadmaps {
    createdSdks.push(sdk);
    return sdk;
  }

  it('200 live response overrides stale cached experiments', async () => {
    const staleExp = makeExp('stale-001', 'Stale Experiment');
    const liveExp = makeExp('live-001', 'Live Experiment');

    seedStaleCache([staleExp]);

    mockFetch(url => {
      if (url === CDN_URL || url.includes('all-configs')) {
        return new Response(
          JSON.stringify(makeConfigResponse([liveExp])),
          { status: 200, headers: { 'Content-Type': 'application/json', etag: '"abc123"' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
    await sdk.init();

    const ids = readCachedExperimentIds();
    expect(ids).toContain('live-001');
    expect(ids).not.toContain('stale-001');
  });

  it('200 live response is applied even when a fresh cache exists', async () => {
    const cachedExp = makeExp('cached-001', 'Cached Experiment');
    const liveExp = makeExp('live-002', 'Live Experiment 2');

    const freshCached: CachedConfig = {
      experiments: [cachedExp],
      project: { id: 'p1', domain: 'example.com' },
      heatmapConfigs: [],
      formAnalyticsConfigs: [],
      audiences: [],
      surveys: [],
      timestamp: Date.now(),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(freshCached));

    mockFetch(url => {
      if (url === CDN_URL || url.includes('all-configs')) {
        return new Response(
          JSON.stringify(makeConfigResponse([liveExp])),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
    await sdk.init();

    const ids = readCachedExperimentIds();
    expect(ids).toContain('live-002');
    expect(ids).not.toContain('cached-001');
  });

  it('stale cache is used as fallback when fetch fails (offline / network error)', async () => {
    const staleExp = makeExp('stale-002', 'Stale Fallback Experiment');

    seedStaleCache([staleExp]);

    mockFetch(_url => {
      throw new TypeError('Failed to fetch');
    });

    const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
    await sdk.init();

    const ids = readCachedExperimentIds();
    expect(ids).toContain('stale-002');
  });

  it('stale cache is used as fallback when fetch returns a server error', async () => {
    const staleExp = makeExp('stale-003', 'Stale Server Error Fallback');

    seedStaleCache([staleExp]);

    mockFetch(url => {
      if (url === CDN_URL || url.includes('all-configs')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    });

    const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
    await sdk.init();

    const ids = readCachedExperimentIds();
    expect(ids).toContain('stale-003');
  });

  it('304 response refreshes the cache timestamp without changing experiments', async () => {
    const staleExp = makeExp('stale-304', '304 Stale Experiment');

    seedStaleCache([staleExp]);
    localStorage.setItem(ETAG_KEY, '"etag-v1"');

    const timestampBefore = readCachedTimestamp()!;
    expect(timestampBefore).toBe(STALE_TIMESTAMP);

    const fetchSpy = mockFetch(url => {
      if (url === CDN_URL) {
        return new Response(null, { status: 304 });
      }
      return new Response('{}', { status: 200 });
    });

    const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
    await sdk.init();

    const cc = getCachedConfig(PROJECT_KEY);
    expect(cc).not.toBeNull();
    expect(cc!.experiments.map(e => e.id)).toContain('stale-304');

    expect(cc!.timestamp).toBeGreaterThan(timestampBefore);

    const cdnCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? input.toString();
      return url === CDN_URL;
    });
    expect(cdnCalls.length).toBeGreaterThan(0);
  });

  it('no cache at all and fetch fails yields an empty experiment list', async () => {
    mockFetch(_url => {
      throw new TypeError('Failed to fetch');
    });

    const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
    await sdk.init();

    expect(readCachedExperimentIds()).toEqual([]);
  });

  describe('in-memory fallback when localStorage is unavailable', () => {
    function blockLocalStorage() {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('Access denied', 'SecurityError');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Access denied', 'SecurityError');
      });
    }

    it('setCachedConfig stores in memory when localStorage throws', () => {
      blockLocalStorage();

      const exp = makeExp('mem-001', 'Memory Experiment');
      const config: CachedConfig = {
        experiments: [exp],
        project: { id: 'p1', domain: 'example.com' },
        heatmapConfigs: [],
        formAnalyticsConfigs: [],
        audiences: [],
        surveys: [],
        timestamp: Date.now(),
      };

      setCachedConfig(PROJECT_KEY, config);

      const result = getCachedConfig(PROJECT_KEY);
      expect(result).not.toBeNull();
      expect(result!.experiments.map(e => e.id)).toContain('mem-001');
    });

    it('getCachedConfig returns in-memory value when localStorage throws on read', () => {
      const exp = makeExp('mem-002', 'Memory Read Experiment');
      const config: CachedConfig = {
        experiments: [exp],
        project: { id: 'p1', domain: 'example.com' },
        heatmapConfigs: [],
        formAnalyticsConfigs: [],
        audiences: [],
        surveys: [],
        timestamp: Date.now(),
      };

      setCachedConfig(PROJECT_KEY, config);

      blockLocalStorage();

      const result = getCachedConfig(PROJECT_KEY);
      expect(result).not.toBeNull();
      expect(result!.experiments.map(e => e.id)).toContain('mem-002');
    });

    it('getCachedConfig returns null when both localStorage and memory cache are empty', () => {
      blockLocalStorage();

      const result = getCachedConfig(PROJECT_KEY);
      expect(result).toBeNull();
    });

    it('live fetch result is accessible via memory cache when localStorage is blocked', async () => {
      blockLocalStorage();

      const liveExp = makeExp('mem-live-001', 'Memory Live Experiment');

      mockFetch(url => {
        if (url === CDN_URL || url.includes('all-configs')) {
          return new Response(
            JSON.stringify(makeConfigResponse([liveExp])),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200 });
      });

      const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
      await sdk.init();

      const result = getCachedConfig(PROJECT_KEY);
      expect(result).not.toBeNull();
      expect(result!.experiments.map(e => e.id)).toContain('mem-live-001');
    });

    it('warns when config is missing for the project key (404)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockFetch(() => new Response('Not found', { status: 404 }));

      const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
      await sdk.init();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('No config found for project key'),
      );
      warn.mockRestore();
    });

    it('warns when config.project.id does not match snippet pk', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockFetch(url => {
        if (url === CDN_URL || url.includes('all-configs')) {
          return new Response(
            JSON.stringify(makeConfigResponse([makeExp('exp-1', 'Test')], {
              project: { id: 'different-project-id', domain: 'example.com' },
            })),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200 });
      });

      const sdk = track(new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: API_HOST }));
      await sdk.init();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('does not match snippet pk'),
      );
      warn.mockRestore();
    });
  });
});
