// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSpecialSdkMode, runExperimentBootstrap } from '../src/experiment-bootstrap';

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
});

describe('runExperimentBootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.opacity = '';
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

  it('applies cached CSS on normal URLs with fresh cache', () => {
    seedBootstrapCache();

    runExperimentBootstrap();

    const style = document.querySelector('style[data-ab-css="var-1"]');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('background: red');
    expect(typeof (window as any).__ab_reveal).toBe('function');
  });
});
