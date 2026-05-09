// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeatmapTracker } from '../src/heatmap';
import type { EventBatcher } from '../src/batcher';

function makeBatcher(): EventBatcher & { pushed: unknown[] } {
  const pushed: unknown[] = [];
  return {
    pushed,
    push(e: unknown) { pushed.push(e); },
    start() {},
    stop() {},
    flush() {},
  } as unknown as EventBatcher & { pushed: unknown[] };
}

function makeTracker(
  batcher: EventBatcher,
  opts: {
    userId?: string;
    sessionId?: string;
    consent?: () => boolean;
    urlRuleSets?: Array<Array<{ match_type: string; value: string }>>;
    trackAllPages?: boolean;
    samplingRate?: number;
  } = {},
): HeatmapTracker {
  return new HeatmapTracker(
    batcher,
    opts.userId ?? 'user-1',
    opts.sessionId ?? 'session-abc',
    opts.consent ?? (() => true),
    opts.urlRuleSets ?? [[{ match_type: 'contains', value: '/' }]],
    opts.trackAllPages ?? false,
    opts.samplingRate ?? 1.0,
  );
}

function fireClick(el?: Element, clientX = 100, clientY = 200): void {
  const target = el ?? document.body;
  target.dispatchEvent(
    new MouseEvent('click', { bubbles: true, clientX, clientY }),
  );
}

describe('HeatmapTracker — initialization', () => {
  let tracker: HeatmapTracker;

  afterEach(() => {
    tracker?.destroy();
    vi.restoreAllMocks();
  });

  it('attaches click and scroll listeners on construction', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const winSpy = vi.spyOn(window, 'addEventListener');
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    const docEvents = addSpy.mock.calls.map(([ev]) => ev);
    const winEvents = winSpy.mock.calls.map(([ev]) => ev);

    expect(docEvents).toContain('click');
    expect(winEvents).toContain('scroll');
  });

  it('does NOT attach listeners when both urlRuleSets is empty and trackAllPages is false', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const batcher = makeBatcher();

    const callsBefore = addSpy.mock.calls.length;
    tracker = makeTracker(batcher, { urlRuleSets: [], trackAllPages: false });
    const callsAfter = addSpy.mock.calls.length;

    expect(callsAfter).toBe(callsBefore);
  });

  it('attaches listeners when trackAllPages is true even with empty urlRuleSets', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const callsBefore = addSpy.mock.calls.length;
    const batcher = makeBatcher();
    tracker = makeTracker(batcher, { urlRuleSets: [], trackAllPages: true });
    const callsAfter = addSpy.mock.calls.length;

    expect(callsAfter).toBeGreaterThan(callsBefore);
  });
});

describe('HeatmapTracker — click event batching', () => {
  let tracker: HeatmapTracker;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    tracker?.destroy();
    vi.restoreAllMocks();
  });

  it('pushes a heatmap_click event to the batcher on each click', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    fireClick();
    expect(batcher.pushed.length).toBe(1);
    expect((batcher.pushed[0] as { type: string }).type).toBe('heatmap_click');
  });

  it('attaches user_id and session_id to click events', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher, { userId: 'user-42', sessionId: 'sess-99' });

    fireClick();

    const evt = batcher.pushed[0] as { user_id: string; session_id: string };
    expect(evt.user_id).toBe('user-42');
    expect(evt.session_id).toBe('sess-99');
  });

  it('attaches the variant_id set via setVariantId()', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);
    tracker.setVariantId('variant-xyz');

    fireClick();

    const evt = batcher.pushed[0] as { variant_id: string };
    expect(evt.variant_id).toBe('variant-xyz');
  });

  it('uses empty string for variant_id when none is set', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    fireClick();

    const evt = batcher.pushed[0] as { variant_id: string };
    expect(evt.variant_id).toBe('');
  });

  it('click metadata contains x, y, viewport dimensions, and element info', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    const btn = document.createElement('button');
    document.body.appendChild(btn);
    fireClick(btn, 50, 80);

    const evt = batcher.pushed[0] as { metadata: Record<string, unknown> };
    const md = evt.metadata;
    expect(md).toBeDefined();
    expect(typeof md.x).toBe('number');
    expect(typeof md.y).toBe('number');
    expect(typeof md.viewport_width).toBe('number');
    expect(typeof md.viewport_height).toBe('number');
    expect(md.element_tag).toBe('button');
  });

  it('marks clicks on button elements as interactive and not dead clicks', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    const btn = document.createElement('button');
    document.body.appendChild(btn);
    fireClick(btn);

    const md = (batcher.pushed[0] as { metadata: Record<string, unknown> }).metadata;
    expect(md.is_interactive).toBe(true);
    expect(md.is_dead_click).toBe(false);
  });

  it('marks clicks on plain divs as non-interactive dead clicks', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    const div = document.createElement('div');
    document.body.appendChild(div);
    fireClick(div);

    const md = (batcher.pushed[0] as { metadata: Record<string, unknown> }).metadata;
    expect(md.is_interactive).toBe(false);
    expect(md.is_dead_click).toBe(true);
  });

  it('marks clicks on elements with role="button" as interactive', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    const span = document.createElement('span');
    span.setAttribute('role', 'button');
    document.body.appendChild(span);
    fireClick(span);

    const md = (batcher.pushed[0] as { metadata: Record<string, unknown> }).metadata;
    expect(md.is_interactive).toBe(true);
  });

  it('marks clicks on anchor tags as interactive', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    const a = document.createElement('a');
    a.href = '#';
    document.body.appendChild(a);
    fireClick(a);

    const md = (batcher.pushed[0] as { metadata: Record<string, unknown> }).metadata;
    expect(md.is_interactive).toBe(true);
  });

  it('detects rage clicks when 3+ nearby clicks occur within 1 second', () => {
    vi.restoreAllMocks();
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    const div = document.createElement('div');
    document.body.appendChild(div);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    fireClick(div, 50, 50);
    fireClick(div, 52, 50);
    fireClick(div, 51, 52);

    const events = batcher.pushed as Array<{ metadata: Record<string, unknown> }>;
    const lastMd = events[events.length - 1].metadata;
    expect(lastMd.is_rage_click).toBe(true);
  });

  it('does not flag rage click when clicks are spread far apart', () => {
    vi.restoreAllMocks();
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    const div = document.createElement('div');
    document.body.appendChild(div);

    fireClick(div, 10, 10);
    fireClick(div, 200, 200);
    fireClick(div, 400, 400);

    const events = batcher.pushed as Array<{ metadata: Record<string, unknown> }>;
    for (const evt of events) {
      expect(evt.metadata.is_rage_click).toBe(false);
    }
  });

  it('suppresses all events when consent check returns false', () => {
    vi.restoreAllMocks();
    const batcher = makeBatcher();
    tracker = makeTracker(batcher, { consent: () => false });

    fireClick();

    expect(batcher.pushed.length).toBe(0);
  });

  it('accumulates multiple clicks as separate batcher events', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);

    fireClick(document.body, 10, 10);
    fireClick(document.body, 20, 20);
    fireClick(document.body, 30, 30);

    expect(batcher.pushed.length).toBe(3);
  });

  it('records a timestamp ISO string on every click event', () => {
    const batcher = makeBatcher();
    tracker = makeTracker(batcher);
    fireClick();

    const evt = batcher.pushed[0] as { timestamp: string };
    expect(() => new Date(evt.timestamp)).not.toThrow();
    expect(new Date(evt.timestamp).toISOString()).toBe(evt.timestamp);
  });
});

describe('HeatmapTracker — scroll depth recording', () => {
  let tracker: HeatmapTracker;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    tracker?.destroy();
    vi.restoreAllMocks();
  });

  it('sends a heatmap_scroll event on destroy()', () => {
    const batcher = makeBatcher();

    Object.defineProperty(document.body, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    Object.defineProperty(window, 'pageYOffset', { value: 500, configurable: true });

    tracker = makeTracker(batcher);

    window.dispatchEvent(new Event('scroll'));

    tracker.destroy();

    const scrollEvents = (batcher.pushed as Array<{ type: string }>).filter(e => e.type === 'heatmap_scroll');
    expect(scrollEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('heatmap_scroll event contains max_scroll_percent, viewport_height, and page_height', () => {
    const batcher = makeBatcher();

    Object.defineProperty(document.body, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
    Object.defineProperty(window, 'pageYOffset', { value: 300, configurable: true });

    tracker = makeTracker(batcher);
    window.dispatchEvent(new Event('scroll'));
    tracker.destroy();

    const evt = (batcher.pushed as Array<{ type: string; metadata: Record<string, unknown> }>)
      .find(e => e.type === 'heatmap_scroll');

    expect(evt).toBeDefined();
    expect(typeof evt!.metadata.max_scroll_percent).toBe('number');
    expect(evt!.metadata.max_scroll_percent).toBeGreaterThan(0);
    expect(evt!.metadata.max_scroll_percent).toBeLessThanOrEqual(100);
    expect(typeof evt!.metadata.viewport_height).toBe('number');
    expect(typeof evt!.metadata.page_height).toBe('number');
  });

  it('attaches user_id and session_id to the scroll event', () => {
    const batcher = makeBatcher();

    Object.defineProperty(document.body, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    Object.defineProperty(window, 'pageYOffset', { value: 100, configurable: true });

    tracker = makeTracker(batcher, { userId: 'u-scroll', sessionId: 'sess-scroll' });
    window.dispatchEvent(new Event('scroll'));
    tracker.destroy();

    const evt = (batcher.pushed as Array<{ type: string; user_id: string; session_id: string }>)
      .find(e => e.type === 'heatmap_scroll');

    expect(evt!.user_id).toBe('u-scroll');
    expect(evt!.session_id).toBe('sess-scroll');
  });

  it('sends scroll event only once even if destroy() is called multiple times', () => {
    const batcher = makeBatcher();

    Object.defineProperty(document.body, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    Object.defineProperty(window, 'pageYOffset', { value: 200, configurable: true });

    tracker = makeTracker(batcher);
    window.dispatchEvent(new Event('scroll'));
    tracker.destroy();
    tracker.destroy();

    const scrollEvents = (batcher.pushed as Array<{ type: string }>).filter(e => e.type === 'heatmap_scroll');
    expect(scrollEvents.length).toBe(1);
  });

  it('resets scroll tracking after pageChanged() and records a new scroll event for the new page', () => {
    const batcher = makeBatcher();

    Object.defineProperty(document.body, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    Object.defineProperty(window, 'pageYOffset', { value: 300, configurable: true });

    let fakeNow = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    tracker = makeTracker(batcher, { trackAllPages: true });

    window.dispatchEvent(new Event('scroll'));
    tracker.pageChanged();

    fakeNow += 500;
    window.dispatchEvent(new Event('scroll'));
    tracker.destroy();

    const scrollEvents = (batcher.pushed as Array<{ type: string }>).filter(e => e.type === 'heatmap_scroll');
    expect(scrollEvents.length).toBe(2);
  });

  it('sets max_scroll_percent to 100 when page fits in the viewport', () => {
    const batcher = makeBatcher();

    Object.defineProperty(document.body, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'pageYOffset', { value: 0, configurable: true });

    tracker = makeTracker(batcher);
    window.dispatchEvent(new Event('scroll'));
    tracker.destroy();

    const evt = (batcher.pushed as Array<{ type: string; metadata: Record<string, unknown> }>)
      .find(e => e.type === 'heatmap_scroll');

    expect(evt!.metadata.max_scroll_percent).toBe(100);
  });
});

describe('HeatmapTracker — session ID association', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through undefined session_id when none is provided', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const batcher = makeBatcher();
    const tracker = new HeatmapTracker(
      batcher,
      'user-no-session',
      undefined,
      () => true,
      [[{ match_type: 'contains', value: '/' }]],
    );

    fireClick();
    tracker.destroy();

    const clickEvt = (batcher.pushed as Array<{ type: string; session_id?: string }>)
      .find(e => e.type === 'heatmap_click');

    expect(clickEvt).toBeDefined();
    expect(clickEvt!.session_id).toBeUndefined();
  });

  it('propagates session_id to both click and scroll events', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    Object.defineProperty(document.body, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    Object.defineProperty(window, 'pageYOffset', { value: 100, configurable: true });

    const batcher = makeBatcher();
    const tracker = makeTracker(batcher, { sessionId: 'sess-propagated' });

    fireClick();
    window.dispatchEvent(new Event('scroll'));
    tracker.destroy();

    const pushed = batcher.pushed as Array<{ type: string; session_id?: string }>;

    const clickEvt = pushed.find(e => e.type === 'heatmap_click');
    const scrollEvt = pushed.find(e => e.type === 'heatmap_scroll');

    expect(clickEvt!.session_id).toBe('sess-propagated');
    expect(scrollEvt!.session_id).toBe('sess-propagated');
  });
});

describe('HeatmapTracker — URL rule matching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records clicks when the URL matches a contains rule', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const batcher = makeBatcher();
    const tracker = new HeatmapTracker(
      batcher,
      'u',
      undefined,
      () => true,
      [[{ match_type: 'contains', value: 'localhost' }]],
    );

    fireClick();
    tracker.destroy();

    expect(batcher.pushed.some((e: unknown) => (e as { type: string }).type === 'heatmap_click')).toBe(true);
  });

  it('does not record events when no URL rules match and trackAllPages is false', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const batcher = makeBatcher();
    const tracker = new HeatmapTracker(
      batcher,
      'u',
      undefined,
      () => true,
      [[{ match_type: 'exact', value: 'https://no-match.example.com/xyz' }]],
      false,
    );

    fireClick();
    tracker.destroy();

    expect(batcher.pushed.filter((e: unknown) => (e as { type: string }).type === 'heatmap_click').length).toBe(0);
  });

  it('records clicks when trackAllPages is true regardless of URL rules', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const batcher = makeBatcher();
    const tracker = new HeatmapTracker(
      batcher,
      'u',
      undefined,
      () => true,
      [],
      true,
    );

    fireClick();
    tracker.destroy();

    expect(batcher.pushed.some((e: unknown) => (e as { type: string }).type === 'heatmap_click')).toBe(true);
  });

  it('matches URLs using starts_with rule', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const batcher = makeBatcher();
    const tracker = new HeatmapTracker(
      batcher,
      'u',
      undefined,
      () => true,
      [[{ match_type: 'starts_with', value: 'http' }]],
    );

    fireClick();
    tracker.destroy();

    expect(batcher.pushed.some((e: unknown) => (e as { type: string }).type === 'heatmap_click')).toBe(true);
  });
});

describe('HeatmapTracker — destroy() cleanup', () => {
  it('stops recording clicks after destroy() is called', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const batcher = makeBatcher();
    const tracker = makeTracker(batcher);

    tracker.destroy();
    fireClick();

    const clickEvents = (batcher.pushed as Array<{ type: string }>).filter(e => e.type === 'heatmap_click');
    expect(clickEvents.length).toBe(0);

    vi.restoreAllMocks();
  });

  it('removes event listeners so clicks after destroy do not accumulate', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const batcher = makeBatcher();
    const tracker = makeTracker(batcher);

    fireClick();
    expect(batcher.pushed.length).toBe(1);

    tracker.destroy();

    fireClick();
    fireClick();

    expect(batcher.pushed.filter((e: unknown) => (e as { type: string }).type === 'heatmap_click').length).toBe(1);

    vi.restoreAllMocks();
  });
});
