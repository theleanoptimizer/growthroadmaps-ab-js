// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModalTracker } from '../src/modal-tracker';
import type { EventBatcher } from '../src/batcher';

function makeBatcher(): EventBatcher & { pushed: unknown[] } {
  const pushed: unknown[] = [];
  return {
    pushed,
    push(e: unknown) {
      pushed.push(e);
    },
    start() {},
    stop() {},
    flush() {},
  } as unknown as EventBatcher & { pushed: unknown[] };
}

describe('ModalTracker — faux btn triggers', () => {
  let tracker: ModalTracker;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 300,
      top: 10,
      left: 10,
      bottom: 310,
      right: 410,
      x: 10,
      y: 10,
      toJSON() {
        return {};
      },
    });
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      zIndex: '1000',
      position: 'fixed',
    } as CSSStyleDeclaration);
  });

  afterEach(() => {
    tracker?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens modal flow from btn--red div with trigger text', () => {
    const batcher = makeBatcher();
    tracker = new ModalTracker(batcher, 'user-1', 'sess-1', () => true, () => true);
    tracker.start();

    const cta = document.createElement('div');
    cta.className = 'btn--red customQuotePopup';
    cta.title = 'Get a Custom Tour Quote';
    cta.textContent = 'GET A CUSTOM TOUR QUOTE';
    document.body.appendChild(cta);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<h2>Custom quote</h2>';
    // Append after click so detect finds it (simulates popup open).
    cta.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body.appendChild(dialog);

    vi.advanceTimersByTime(500);

    const open = batcher.pushed.find(
      (e) => (e as { type: string }).type === 'session_modal_open',
    ) as { metadata: Record<string, unknown> } | undefined;
    expect(open).toBeDefined();
    expect(String(open!.metadata.trigger_selector)).toContain('btn--red');
    expect(open!.metadata.trigger_text).toBe('GET A CUSTOM TOUR QUOTE');
  });

  it('ignores plain non-interactive div clicks', () => {
    const batcher = makeBatcher();
    tracker = new ModalTracker(batcher, 'user-1', 'sess-1', () => true, () => true);
    tracker.start();

    const div = document.createElement('div');
    div.className = 'cq_content_sec2';
    document.body.appendChild(div);
    div.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    vi.advanceTimersByTime(500);

    expect(batcher.pushed.length).toBe(0);
  });
});
