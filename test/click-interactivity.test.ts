// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isInteractiveControl,
  looksClickable,
  resolveInteractiveClickTarget,
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

  it('returns true for btn--red faux button', () => {
    const div = document.createElement('div');
    div.className = 'btn--red centerContent customQuotePopup';
    document.body.appendChild(div);
    expect(looksClickable(div)).toBe(true);
    expect(isInteractiveControl(div)).toBe(true);
  });

  it('returns true for child inside btn--red', () => {
    const div = document.createElement('div');
    div.className = 'btn--red';
    const span = document.createElement('span');
    span.textContent = 'GET A CUSTOM TOUR QUOTE';
    div.appendChild(span);
    document.body.appendChild(div);
    expect(looksClickable(span)).toBe(true);
  });

  it('does not treat buttonhole class as a button', () => {
    const div = document.createElement('div');
    div.className = 'buttonhole';
    document.body.appendChild(div);
    expect(looksClickable(div)).toBe(false);
    expect(isInteractiveControl(div)).toBe(false);
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

describe('resolveInteractiveClickTarget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('walks up from text child to btn--red', () => {
    const div = document.createElement('div');
    div.className = 'btn--red centerContent';
    div.title = 'Get a Custom Tour Quote';
    const span = document.createElement('span');
    span.textContent = 'GET A CUSTOM TOUR QUOTE';
    div.appendChild(span);
    document.body.appendChild(div);
    expect(resolveInteractiveClickTarget(span)).toBe(div);
  });

  it('prefers semantic button over outer btn-- class wrapper', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'btn--red';
    const btn = document.createElement('button');
    btn.textContent = 'Submit';
    wrapper.appendChild(btn);
    document.body.appendChild(wrapper);
    expect(resolveInteractiveClickTarget(btn)).toBe(btn);
  });

  it('returns role=button when present', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    div.className = 'cq_content_sec2';
    const span = document.createElement('span');
    div.appendChild(span);
    document.body.appendChild(div);
    expect(resolveInteractiveClickTarget(span)).toBe(div);
  });

  it('returns the original element when nothing interactive is found', () => {
    const section = document.createElement('div');
    section.className = 'cq_content_sec2 textSlightlyLarger';
    const p = document.createElement('p');
    p.textContent = 'Tour copy';
    section.appendChild(p);
    document.body.appendChild(section);
    expect(resolveInteractiveClickTarget(p)).toBe(p);
  });
});
