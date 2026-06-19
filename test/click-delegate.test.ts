// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerClickHandler } from '../src/click-delegate';

describe('click-delegate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches to registered handlers in order', () => {
    const order: number[] = [];
    const unregisterA = registerClickHandler(() => { order.push(1); });
    const unregisterB = registerClickHandler(() => { order.push(2); });

    document.body.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }),
    );

    expect(order).toEqual([1, 2]);
    unregisterB();
    unregisterA();
  });
});
