// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSpecialSdkMode, isPanelPreviewSession, runExperimentBootstrap } from '../src/experiment-bootstrap';

const PROJECT_KEY = 'pk_bootstrap_test';

function seedBootstrapCache(): void {
  const now = Date.now();
  localStorage.setItem(
    'ab_cfg_' + PROJECT_KEY,
    JSON.stringify({
      timestamp: now,
      experiments: [
        {
          id: 'exp-1',
          status: 'running',
          mode: 'client',
          url_rules: [],
          variants: [{ id: 'var-1', weight: 100 }],
        },
      ],
    }),
  );
  localStorage.setItem(
    'ab_va_' + PROJECT_KEY,
    JSON.stringify({
      'exp-1': {
        variantId: 'var-1',
        css: 'body { background: red; }',
        external_css: [],
        external_js: [],
      },
    }),
  );
}

function seedRolloutBootstrapCache(): void {
  const now = Date.now();
  localStorage.setItem(
    'ab_cfg_' + PROJECT_KEY,
    JSON.stringify({
      timestamp: now,
      experiments: [
        {
          id: 'exp-rollout-1',
          status: 'rolling_out',
          mode: 'client',
          rollout_variant_id: 'exp-rollout-1-winner',
          url_rules: [],
          variants: [
            { id: 'exp-rollout-1-ctrl', css: '.ctrl{color:red}' },
            { id: 'exp-rollout-1-winner', css: '.winner{color:green}' },
          ],
        },
      ],
    }),
  );
  localStorage.setItem(
    'ab_va_' + PROJECT_KEY,
    JSON.stringify({
      'exp-rollout-1': {
        variantId: 'exp-rollout-1-ctrl',
        css: '.ctrl{color:red}',
        external_css: [],
        external_js: [],
      },
    }),
  );
}

describe('isSpecialSdkMode', () => {
  it('returns true for preview, review, builder, and gr_preview params', () => {
    expect(isSpecialSdkMode('?_ab_preview=token')).toBe(true);
    expect(isSpecialSdkMode('?_ab_preview=panel&key=abc')).toBe(true);
    expect(isSpecialSdkMode('?_ab_review=token')).toBe(true);
    expect(isSpecialSdkMode('?_ab_builder=token')).toBe(true);
    expect(isSpecialSdkMode('?gr_preview=token')).toBe(true);
  });

  it('returns false for normal URLs', () => {
    expect(isSpecialSdkMode('')).toBe(false);
    expect(isSpecialSdkMode('?utm_source=google')).toBe(false);
  });

  it('returns true when panel preview session is active in sessionStorage', () => {
    sessionStorage.setItem('_ab_panel_key', 'panel-key-abc');
    sessionStorage.setItem('_ab_panel_pk', PROJECT_KEY);
    expect(isPanelPreviewSession(PROJECT_KEY)).toBe(true);
    expect(isSpecialSdkMode('', PROJECT_KEY)).toBe(true);
    expect(isSpecialSdkMode('?utm_source=google', PROJECT_KEY)).toBe(true);
  });

  it('returns false for panel session when project key does not match', () => {
    sessionStorage.setItem('_ab_panel_key', 'panel-key-abc');
    sessionStorage.setItem('_ab_panel_pk', 'other-project');
    expect(isPanelPreviewSession(PROJECT_KEY)).toBe(false);
    expect(isSpecialSdkMode('', PROJECT_KEY)).toBe(false);
  });
});

describe('runExperimentBootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.style.opacity = '';
    document.head.querySelectorAll('style[data-ab-css], link[data-ab-ext-css]').forEach(el => el.remove());
    delete (window as any).__gr_loader_ran;
    delete (window as any).__ab_reveal;
    (window as any).__gr_loader_cfg = { pk: PROJECT_KEY };
    history.replaceState({}, '', '/');
  });

  afterEach(() => {
    delete (window as any).__gr_loader_cfg;
    delete (window as any).__gr_loader_ran;
    delete (window as any).__ab_reveal;
  });

  it('skips bootstrap when _ab_preview is present', () => {
    seedBootstrapCache();
    history.replaceState({}, '', '/?_ab_preview=preview-token');

    runExperimentBootstrap();

    expect((window as any).__gr_loader_ran).toBe(true);
    expect(document.documentElement.style.opacity).not.toBe('0');
    expect(document.querySelector('style[data-ab-css]')).toBeNull();
    expect((window as any).__ab_reveal).toBeUndefined();
  });

  it('skips bootstrap when _ab_preview=panel is present', () => {
    seedBootstrapCache();
    history.replaceState({}, '', '/?_ab_preview=panel&key=secret');

    runExperimentBootstrap();

    expect((window as any).__gr_loader_ran).toBe(true);
    expect(document.documentElement.style.opacity).not.toBe('0');
    expect(document.querySelector('style[data-ab-css]')).toBeNull();
    expect((window as any).__ab_reveal).toBeUndefined();
  });

  it('skips bootstrap when panel preview session is active without URL params', () => {
    seedBootstrapCache();
    sessionStorage.setItem('_ab_panel_key', 'panel-key-abc');
    sessionStorage.setItem('_ab_panel_pk', PROJECT_KEY);
    history.replaceState({}, '', '/about');

    runExperimentBootstrap();

    expect((window as any).__gr_loader_ran).toBe(true);
    expect(document.documentElement.style.opacity).not.toBe('0');
    expect(document.querySelector('style[data-ab-css]')).toBeNull();
    expect((window as any).__ab_reveal).toBeUndefined();
  });

  it('applies cached CSS on normal URLs with fresh cache', () => {
    seedBootstrapCache();

    runExperimentBootstrap();

    const style = document.querySelector('style[data-ab-css="var-1"]');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('background: red');
    expect(typeof (window as any).__ab_reveal).toBe('function');
  });

  it('applies rollout winner CSS when status is rolling_out', () => {
    seedRolloutBootstrapCache();

    runExperimentBootstrap();

    expect(document.querySelector('style[data-ab-css="exp-rollout-1-winner"]')).not.toBeNull();
    expect(document.querySelector('style[data-ab-css="exp-rollout-1-winner"]')?.textContent).toContain('color:green');
    expect(document.querySelector('style[data-ab-css="exp-rollout-1-ctrl"]')).toBeNull();
    expect(typeof (window as any).__ab_reveal).toBe('function');
  });

  it('does not bootstrap rolling_out experiment when config cache is stale', () => {
    const stale = Date.now() - 120_000;
    localStorage.setItem(
      'ab_cfg_' + PROJECT_KEY,
      JSON.stringify({
        timestamp: stale,
        experiments: [
          {
            id: 'exp-rollout-1',
            status: 'rolling_out',
            mode: 'client',
            rollout_variant_id: 'exp-rollout-1-winner',
            url_rules: [],
            variants: [
              { id: 'exp-rollout-1-winner', css: '.winner{color:green}' },
            ],
          },
        ],
      }),
    );
    localStorage.setItem(
      'ab_va_' + PROJECT_KEY,
      JSON.stringify({
        'exp-rollout-1': { variantId: 'exp-rollout-1-winner', css: '.winner{color:green}' },
      }),
    );

    runExperimentBootstrap();

    expect(document.querySelector('style[data-ab-css]')).toBeNull();
    expect((window as any).__ab_reveal).toBeUndefined();
  });
});
