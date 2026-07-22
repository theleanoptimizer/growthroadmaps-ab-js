import { test, expect, Page, Route } from '@playwright/test';

const PORT = parseInt(process.env.SDK_E2E_PORT || '4173', 10);
const DIST_BASE = `http://127.0.0.1:${PORT}`;
const API_HOST = `http://127.0.0.1:${PORT}`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function makeConfig(overrides: {
  experiments?: object[];
  audiences?: object[];
} = {}) {
  return {
    project: { id: 'proj-e2e', domain: 'localhost', heatmaps_enabled: false, surveys_enabled: false },
    experiments: overrides.experiments ?? [],
    heatmapConfigs: [],
    formAnalyticsConfigs: [],
    audiences: overrides.audiences ?? [],
    surveys: [],
  };
}

async function setupPage(page: Page, config: object) {
  const batchBodies: string[] = [];
  page.on('request', req => {
    if (req.url().includes('/api/ab/events/batch') && req.method() === 'POST') {
      batchBodies.push(req.postData() ?? '');
    }
  });

  await page.route('https://js.growthroadmaps.com/**', (r: Route) => r.abort('failed'));
  await page.route(`${API_HOST}/api/**`, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const url = req.url();
    if (url.includes('/api/ab/experiments/all-configs')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify(config),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: '{}',
      });
    }
  });

  await page.goto(`${DIST_BASE}/`);
  return { batchBodies };
}

async function initSdk(page: Page, projectKey = 'pk_e2e') {
  await page.evaluate(
    ({ apiHost, pk }: { apiHost: string; pk: string }) => {
      const win = window as unknown as Record<string, unknown>;
      const GrowthRoadmaps = win['GrowthRoadmaps'] as new (c: object) => {
        init: () => Promise<void>;
        getVariant: (n: string, d: string) => string;
        flushBeacon: () => void;
      };
      const sdk = new GrowthRoadmaps({ projectKey: pk, apiHost });
      win['__grSdk'] = sdk;
      sdk.init().then(() => { win['__grReady'] = true; });
    },
    { apiHost: API_HOST, pk: projectKey }
  );
  await page.waitForFunction(
    () => (window as unknown as Record<string, unknown>)['__grReady'] === true,
    { timeout: 12_000 }
  );
}

test.describe('Lazy chunk loading — end-to-end', () => {
  test('goals.min.js loads via script tag and records a click-goal conversion', async ({ page }) => {
    const config = makeConfig({
      experiments: [
        {
          id: 'exp-click-e2e',
          name: 'E2E Click Test',
          status: 'running',
          mode: 'server',
          traffic_percentage: 100,
          variants: [
            { id: 'v-ctrl', name: 'control', weight: 50, is_control: true },
            { id: 'v-trt', name: 'treatment', weight: 50 },
          ],
          goals: [{ id: 'g-click', goal_type: 'click', value: '#cta-btn', label: 'CTA' }],
          url_rules: [],
          targeting_rules: [],
        },
      ],
    });

    const { batchBodies } = await setupPage(page, config);
    await initSdk(page);

    const goalsLoaded = await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>)['__grGoals'] !== 'undefined'
    );
    expect(goalsLoaded, 'goals.min.js should have been loaded into window.__grGoals').toBe(true);

    await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      const sdk = win['__grSdk'] as { getVariant: (n: string, d: string) => string };
      sdk.getVariant('E2E Click Test', 'control');
    });

    await page.locator('#cta-btn').click();

    await page.waitForTimeout(3_000);

    const convEvents: Array<Record<string, unknown>> = [];
    for (const bodyStr of batchBodies) {
      try {
        const parsed = JSON.parse(bodyStr);
        if (Array.isArray(parsed.events)) {
          for (const e of parsed.events) {
            if (e.type === 'conversion') convEvents.push(e);
          }
        }
      } catch { /* ignore */ }
    }

    expect(convEvents.length, 'at least one conversion event should be recorded').toBeGreaterThanOrEqual(1);

    const goalEvent = convEvents.find(e =>
      typeof e['goal_name'] === 'string' && /click|cta|g-click/i.test(e['goal_name'] as string)
    );
    expect(goalEvent, 'click goal conversion event should be present').toBeTruthy();
  });

  test('gr-attrs.min.js loads via script tag and captures click-rule attributes', async ({ page }) => {
    const config = makeConfig({
      experiments: [
        {
          id: 'exp-aud-e2e',
          name: 'E2E Audience Test',
          status: 'running',
          mode: 'server',
          traffic_percentage: 100,
          variants: [{ id: 'v-ctrl', name: 'control', weight: 100, is_control: true }],
          goals: [],
          url_rules: [],
          targeting_rules: [],
        },
      ],
      audiences: [
        {
          id: 'aud-1',
          attribute_key: 'visited_pricing',
          source_type: 'click',
          value: '#pricing-link',
          set_value: 'yes',
        },
      ],
    });

    await setupPage(page, config);
    await initSdk(page, 'pk_e2e_aud');

    const audienceLoaded = await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>)['__grAudience'] !== 'undefined'
    );
    expect(audienceLoaded, 'gr-attrs.min.js should have been loaded into window.__grAudience').toBe(true);

    await page.locator('#pricing-link').click({ force: true });

    await page.waitForFunction(
      () => {
        try {
          const raw = sessionStorage.getItem('_ab_attrs_pk_e2e_aud');
          if (!raw) return false;
          const parsed = JSON.parse(raw);
          return parsed && parsed['visited_pricing'] === 'yes';
        } catch { return false; }
      },
      { timeout: 8_000 }
    );

    const attrs = await page.evaluate(() => {
      const raw = sessionStorage.getItem('_ab_attrs_pk_e2e_aud');
      return raw ? JSON.parse(raw) : null;
    });
    expect(attrs).toBeTruthy();
    expect(attrs['visited_pricing']).toBe('yes');
  });

  test('growth.min.js has correct IIFE wrapper and global name', async ({ page }) => {
    const resp = await page.request.get(`${DIST_BASE}/growth.min.js`);
    expect(resp.ok()).toBe(true);
    const src = await resp.text();

    expect(src, 'should contain UMD factory wrapper').toMatch(/\bfactory\b/);
    expect(src, 'should expose GrowthRoadmapsSDK global').toContain('GrowthRoadmapsSDK');
    expect(src, 'should contain GrowthRoadmaps class').toContain('GrowthRoadmaps');
  });

  test('goals.min.js IIFE sets window.__grGoals and exports setupGoals', async ({ page }) => {
    const resp = await page.request.get(`${DIST_BASE}/goals.min.js`);
    expect(resp.ok()).toBe(true);
    const src = await resp.text();

    expect(src, 'goals chunk should reference __grGoals global').toContain('__grGoals');
    expect(src, 'goals chunk should export setupGoals').toMatch(/setupGoals/);
  });

  test('gr-attrs.min.js IIFE sets window.__grAudience and exports setupAudience', async ({ page }) => {
    const resp = await page.request.get(`${DIST_BASE}/gr-attrs.min.js`);
    expect(resp.ok()).toBe(true);
    const src = await resp.text();

    expect(src, 'audience chunk should reference __grAudience global').toContain('__grAudience');
    expect(src, 'audience chunk should export setupAudience').toMatch(/setupAudience/);
  });

  test('blocked gr-attrs chunk does not throw uncaught rejection', async ({ page }) => {
    const config = makeConfig({
      audiences: [
        {
          id: 'aud-blocked',
          attribute_key: 'blocked_test',
          source_type: 'click',
          value: '#pricing-link',
          set_value: 'yes',
        },
      ],
    });

    const rejections: string[] = [];
    page.on('pageerror', err => rejections.push(err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') rejections.push(msg.text());
    });

    await page.route(`${DIST_BASE}/gr-attrs.min.js`, route => route.abort('blockedbyclient'));
    await setupPage(page, config);
    await initSdk(page, 'pk_e2e_blocked');

    expect(
      rejections.some(r => /Load failed:\s*audience/i.test(r)),
      'should not surface audience load failure as an uncaught error'
    ).toBe(false);
  });

  test('gr-panels.min.js is served correctly and references __grPanels', async ({ page }) => {
    const resp = await page.request.get(`${DIST_BASE}/gr-panels.min.js`);
    expect(resp.ok(), 'gr-panels.min.js should be served by the static dist server').toBe(true);

    const src = await resp.text();
    expect(src.length, 'gr-panels.min.js should be non-empty').toBeGreaterThan(100);
    expect(src, 'gr-panels.min.js should define the __grPanels global').toContain('__grPanels');
  });

  test('experiment bootstrap fast path skips anti-flicker without cached experiments', async ({ page }) => {
    await page.addInitScript(() => {
      window.__gr_loader_cfg = {
        pk: 'pk_fast',
        host: window.location.origin,
      };
      localStorage.clear();
    });
    await page.goto(`${DIST_BASE}/`);
    const opacity = await page.evaluate(() => document.documentElement.style.opacity);
    expect(opacity).not.toBe('0');
    expect(await page.evaluate(() => window.__gr_loader_ran)).toBe(true);
  });

  test('experiment bootstrap replays cached variant CSS from localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      const pk = 'pk_slow';
      window.__gr_loader_cfg = { pk, host: window.location.origin };
      localStorage.setItem(
        'ab_cfg_' + pk,
        JSON.stringify({
          timestamp: Date.now(),
          experiments: [{ id: 'exp1', status: 'running', url_rules: [] }],
        }),
      );
      localStorage.setItem(
        'ab_va_' + pk,
        JSON.stringify({
          exp1: { variantId: 'v1', css: 'body { outline: 1px solid red; }', external_css: [] },
        }),
      );
    });
    await page.goto(`${DIST_BASE}/`);
    expect(await page.evaluate(() => window.__gr_loader_ran)).toBe(true);
    expect(
      await page.evaluate(() => !!document.querySelector('style[data-ab-css="v1"]')),
    ).toBe(true);
  });
});
