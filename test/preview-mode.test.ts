// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GrowthRoadmaps } from '../src/index';
import { DEFAULT_API_HOST } from '../src/constants';

const PROJECT_KEY = 'pk_preview_test';
const PREVIEW_TOKEN = 'c840d9dd-9ec0-48f9-909c-0cf416b292de';
const PANEL_KEY = '71fe9df9-3512-4adf-913a-c4ab184d697e';

describe('preview mode API host', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.style.opacity = '';
    delete (window as any).gr;
    delete (window as any).__gr_loader_ran;
    delete (window as any).__ab_reveal;
    (window as any).__gr_loader_cfg = { pk: PROJECT_KEY };
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).__gr_loader_cfg;
  });

  it('uses Growth Roadmaps API when apiHost is the customer origin', async () => {
    history.replaceState({}, '', `/?_ab_preview=${PREVIEW_TOKEN}`);
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/ab/preview/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            experiment_id: 'exp-1',
            experiment_name: 'Checkout',
            variant_id: 'var-b',
            variant_name: 'Variant B',
            mode: 'client',
            css: 'body { outline: 2px solid red; }',
            js: null,
            external_js: null,
            external_css: null,
          }),
        });
      }
      if (url.includes('js.growthroadmaps.com/configs/')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const sdk = new GrowthRoadmaps({
      projectKey: PROJECT_KEY,
      apiHost: window.location.origin,
      mutationObserver: false,
    });
    await sdk.init();

    const previewCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/ab/preview/'),
    );
    expect(previewCall?.[0]).toBe(
      `${DEFAULT_API_HOST}/api/ab/preview/${encodeURIComponent(PREVIEW_TOKEN)}`,
    );
    expect(document.querySelector('style[data-ab-css="var-b"]')).not.toBeNull();
  });

  it('fetches preview panel from Growth Roadmaps API', async () => {
    history.replaceState({}, '', `/?_ab_preview=panel&key=${PANEL_KEY}`);
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/ab/preview/panel')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            domain: 'example.com',
            experiments: [
              {
                id: 'exp-1',
                name: 'Homepage Test',
                mode: 'client',
                traffic_percentage: 100,
                variants: [
                  { id: 'var-1', name: 'Control', weight: 50, is_control: true },
                  { id: 'var-2', name: 'Variant B', weight: 50, is_control: false, css: null, js: null },
                ],
                url_rules: [],
                targeting_rules: [],
              },
            ],
          }),
        });
      }
      if (url.includes('js.growthroadmaps.com/configs/')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const sdk = new GrowthRoadmaps({
      projectKey: PROJECT_KEY,
      apiHost: window.location.origin,
      mutationObserver: false,
    });
    await sdk.init();

    const panelCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/ab/preview/panel'),
    );
    expect(panelCall?.[0]).toBe(
      `${DEFAULT_API_HOST}/api/ab/preview/panel?pk=${encodeURIComponent(PROJECT_KEY)}&key=${encodeURIComponent(PANEL_KEY)}`,
    );
    expect(document.getElementById('gr-preview-panel-host')).not.toBeNull();
  });
});
