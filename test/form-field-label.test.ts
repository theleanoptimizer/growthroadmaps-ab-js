// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getFieldLabel } from '../src/form-tracker';

describe('getFieldLabel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('uses label[for] text when present', () => {
    document.body.innerHTML = `
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" />
    `;
    const input = document.getElementById('email')!;
    expect(getFieldLabel(input)).toBe('Email address');
  });

  it('uses wrapping label text', () => {
    document.body.innerHTML = `
      <label>
        Phone number
        <input name="phone" type="tel" />
      </label>
    `;
    const input = document.querySelector('input')!;
    expect(getFieldLabel(input)).toBe('Phone number');
  });

  it('uses aria-label when no label element', () => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Departure date');
    document.body.appendChild(input);
    expect(getFieldLabel(input)).toBe('Departure date');
  });

  it('falls back to name then placeholder', () => {
    const byName = document.createElement('input');
    byName.name = 'travelers';
    document.body.appendChild(byName);
    expect(getFieldLabel(byName)).toBe('travelers');

    const byPlaceholder = document.createElement('input');
    byPlaceholder.placeholder = 'Number of travelers';
    document.body.appendChild(byPlaceholder);
    expect(getFieldLabel(byPlaceholder)).toBe('Number of travelers');
  });
});
