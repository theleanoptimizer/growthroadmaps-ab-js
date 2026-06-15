// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  looksClickable,
  captureClickBaseline,
  hadMeaningfulResponse,
  DEAD_CLICK_VERIFY_MS,
} from '../src/click-interactivity';

describe('looksClickable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns true for native interactive tags', () => {
    for (const tag of ['button', 'a', 'input', 'label']) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      expect(looksClickable(el)).toBe(true);
    }
  });

  it('returns true for role="button"', () => {
    const span = document.createElement('span');
    span.setAttribute('role', 'button');
    document.body.appendChild(span);
    expect(looksClickable(span)).toBe(true);
  });

  it('returns true for tabindex', () => {
    const div = document.createElement('div');
    div.setAttribute('tabindex', '0');
    document.body.appendChild(div);
    expect(looksClickable(div)).toBe(true);
  });

  it('returns true for data-action attribute', () => {
    const div = document.createElement('div');
    div.setAttribute('data-action', 'submit');
    document.body.appendChild(div);
    expect(looksClickable(div)).toBe(true);
  });

  it('returns true for child of button via closest', () => {
    const btn = document.createElement('button');
    const span = document.createElement('span');
    btn.appendChild(span);
    document.body.appendChild(btn);
    expect(looksClickable(span)).toBe(true);
  });

  it('returns true when ancestor has cursor:pointer', () => {
    const wrapper = document.createElement('div');
    wrapper.style.cursor = 'pointer';
    const inner = document.createElement('span');
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    expect(looksClickable(inner)).toBe(true);
  });

  it('returns false for plain div without cues', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(looksClickable(div)).toBe(false);
  });

  it('exports DEAD_CLICK_VERIFY_MS as 500', () => {
    expect(DEAD_CLICK_VERIFY_MS).toBe(500);
  });
});

describe('hadMeaningfulResponse', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects location.href change', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const baseline = captureClickBaseline(el);
    history.pushState({}, '', '/new-path');
    expect(hadMeaningfulResponse(baseline, el)).toBe(true);
    history.back();
  });

  it('detects focus change', () => {
    const el = document.createElement('div');
    const input = document.createElement('input');
    document.body.appendChild(el);
    document.body.appendChild(input);
    const baseline = captureClickBaseline(el);
    input.focus();
    expect(hadMeaningfulResponse(baseline, el)).toBe(true);
  });

  it('detects aria-expanded change', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-expanded', 'false');
    document.body.appendChild(el);
    const baseline = captureClickBaseline(el);
    el.setAttribute('aria-expanded', 'true');
    expect(hadMeaningfulResponse(baseline, el)).toBe(true);
  });

  it('detects subtree text change', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const baseline = captureClickBaseline(el);
    el.textContent = 'updated';
    expect(hadMeaningfulResponse(baseline, el)).toBe(true);
  });

  it('detects new dialog in body', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const baseline = captureClickBaseline(el);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    expect(hadMeaningfulResponse(baseline, el)).toBe(true);
  });

  it('returns false when nothing changed', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const baseline = captureClickBaseline(el);
    expect(hadMeaningfulResponse(baseline, el)).toBe(false);
  });
});
