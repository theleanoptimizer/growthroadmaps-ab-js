// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrowthRoadmaps } from '../src/index';

const TEST_API = 'https://api.test.com';
const PROJECT_KEY = 'pk_mo_test';

// Each call to runJs() does `document.createElement('script')`. Spy on that
// method and count how many times a 'script' element was created from the
// moment the spy is installed. This is unaffected by pre-existing DOM state
// and works reliably across tests in the same jsdom environment.
function makeScriptSpy() {
  const spy = vi.spyOn(document, 'createElement');
  const baseline = spy.mock.calls.filter(([tag]) => (tag as string) === 'script').length;
  return {
    scriptCount: () =>
      spy.mock.calls.filter(([tag]) => (tag as string) === 'script').length - baseline,
  };
}

function makeExperiment(
  id: string,
  extraVariantProps: Partial<{ runOnce: boolean; js: string; selectors: string[] }> = {},
  extraExpProps: object = {},
) {
  return {
    id,
    name: `MO Exp ${id}`,
    status: 'running',
    mode: 'client',
    traffic_percentage: 100,
    variants: [
      {
        id: `${id}-v`,
        name: 'treatment',
        weight: 100,
        js: '/* variant JS */',
        selectors: ['.mo-target'],
        ...extraVariantProps,
      },
    ],
    goals: [],
    url_rules: [],
    targeting_rules: [],
    ...extraExpProps,
  };
}

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

function setupFetch(config: object) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? input.toString();
    if (
      url.includes('/api/ab/experiments/all-configs') ||
      url.includes('growthroadmaps.com/configs')
    ) {
      return new Response(JSON.stringify(config), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
}

function addTargetElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'mo-target';
  document.body.appendChild(el);
  return el;
}

// Advance the fake clock past the MutationObserver's `setTimeout(run, 50)`.
// Two steps: first yield so the MO microtask fires and schedules the timeout,
// then advance past the timeout and let the loadExternalJs().then() chain flush.
async function tickMutationObserver() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(200);
}

describe('MutationObserver late-element detection', () => {
  let sdk: GrowthRoadmaps;

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    sdk?.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fires variant JS exactly once when target element is appended after init', async () => {
    const config = makeConfig([makeExperiment('exp-once')]);
    vi.stubGlobal('fetch', setupFetch(config));

    sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API, userId: 'user-mo-1' });
    await sdk.init();

    const { scriptCount } = makeScriptSpy();
    expect(scriptCount()).toBe(0);

    addTargetElement();
    await tickMutationObserver();

    expect(scriptCount()).toBe(1);
  });

  it('does not fire a second time when the element remounts and runOnce is true (default)', async () => {
    const config = makeConfig([makeExperiment('exp-runonce-t')]);
    vi.stubGlobal('fetch', setupFetch(config));

    sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API, userId: 'user-mo-2' });
    await sdk.init();

    const { scriptCount } = makeScriptSpy();

    const el = addTargetElement();
    await tickMutationObserver();
    expect(scriptCount()).toBe(1);

    el.remove();
    addTargetElement();
    await tickMutationObserver();

    expect(scriptCount()).toBe(1);
  });

  it('fires variant JS again when the element remounts and runOnce is false', async () => {
    const config = makeConfig([makeExperiment('exp-runonce-f', { runOnce: false })]);
    vi.stubGlobal('fetch', setupFetch(config));

    sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API, userId: 'user-mo-3' });
    await sdk.init();

    const { scriptCount } = makeScriptSpy();

    const el = addTargetElement();
    await tickMutationObserver();
    expect(scriptCount()).toBe(1);

    el.remove();
    addTargetElement();
    await tickMutationObserver();

    expect(scriptCount()).toBe(2);
  });

  it('does not create a MutationObserver or fire JS when mutationObserver is false in config', async () => {
    const config = makeConfig([makeExperiment('exp-mo-off')]);
    vi.stubGlobal('fetch', setupFetch(config));

    const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');

    sdk = new GrowthRoadmaps({
      projectKey: PROJECT_KEY,
      apiHost: TEST_API,
      userId: 'user-mo-4',
      mutationObserver: false,
    });
    await sdk.init();

    const { scriptCount } = makeScriptSpy();
    expect(observeSpy).not.toHaveBeenCalled();

    addTargetElement();
    await tickMutationObserver();

    expect(scriptCount()).toBe(0);
  });

  it('stops firing after destroy() is called — subsequent DOM mutations are ignored', async () => {
    const config = makeConfig([makeExperiment('exp-destroy')]);
    vi.stubGlobal('fetch', setupFetch(config));

    sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API, userId: 'user-mo-5' });
    await sdk.init();

    sdk.destroy();

    const { scriptCount } = makeScriptSpy();

    addTargetElement();
    await tickMutationObserver();

    expect(scriptCount()).toBe(0);
  });

  it('re-arms the observer after a SPA route change and fires JS for late-mounted elements', async () => {
    // Experiment is scoped to /page-b only via a URL include rule.
    // On the initial load (/) the experiment is inactive so the MO is not
    // set up. After navigating to /page-b and calling pageChanged() the
    // experiment becomes eligible and the observer is armed — a late-mounted
    // element must then trigger the variant JS.
    const config = makeConfig([
      makeExperiment('exp-spa', {}, {
        url_rules: [{ action: 'include', match_type: 'contains', value: '/page-b' }],
      }),
    ]);
    vi.stubGlobal('fetch', setupFetch(config));

    sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API, userId: 'user-mo-6' });
    await sdk.init();

    // Before navigating: experiment is not active — late-mounted element should not fire.
    const { scriptCount } = makeScriptSpy();
    addTargetElement();
    await tickMutationObserver();
    expect(scriptCount()).toBe(0);

    // Navigate to the targeted page and re-arm.
    history.pushState({}, '', '/page-b');
    sdk.pageChanged();

    // Now a newly-mounted element should trigger the variant JS.
    addTargetElement();
    await tickMutationObserver();
    expect(scriptCount()).toBe(1);

    history.pushState({}, '', '/');
  });

  it('fires variant JS exactly once even when multiple matching elements arrive in one batch', async () => {
    const config = makeConfig([makeExperiment('exp-batch')]);
    vi.stubGlobal('fetch', setupFetch(config));

    sdk = new GrowthRoadmaps({ projectKey: PROJECT_KEY, apiHost: TEST_API, userId: 'user-mo-7' });
    await sdk.init();

    const { scriptCount } = makeScriptSpy();

    addTargetElement();
    addTargetElement();
    addTargetElement();

    await tickMutationObserver();

    expect(scriptCount()).toBe(1);
  });
});
