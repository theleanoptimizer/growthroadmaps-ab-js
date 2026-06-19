// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { looksClickable } from '../src/click-interactivity';

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

  it('does not use getComputedStyle — pointer cursor alone is not clickable', () => {
    const wrapper = document.createElement('div');
    wrapper.style.cursor = 'pointer';
    const inner = document.createElement('span');
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    expect(looksClickable(inner)).toBe(false);
  });

  it('returns false for plain div without cues', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(looksClickable(div)).toBe(false);
  });
});
