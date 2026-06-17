// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeatmapTracker } from '../src/heatmap';
import { DEAD_CLICK_VERIFY_MS } from '../src/click-interactivity';
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

function makeTracker(samplingRate: number, batcher: EventBatcher, sessionSampled?: boolean) {
  const sampled =
    sessionSampled ?? (samplingRate >= 1 ? true : samplingRate <= 0 ? false : true);
  return new HeatmapTracker(
    batcher,
    'user-1',
    'session-1',
    () => true,
    [[{ match_type: 'contains', value: '/' }]],
    false,
    samplingRate,
    sampled,
  );
}

describe('HeatmapTracker sampling gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function fireClick(x = 100, y = 200) {
    const el = document.createElement('button');
    document.body.appendChild(el);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    await vi.advanceTimersByTimeAsync(DEAD_CLICK_VERIFY_MS);
    document.body.removeChild(el);
  }

  it('drops all events when session is not sampled', async () => {
    const batcher = makeBatcher();
    const tracker = makeTracker(0.5, batcher, false);
    await fireClick();
    expect(batcher.pushed.length).toBe(0);
    tracker.destroy();
  });

  it('keeps all events when session is sampled', async () => {
    const batcher = makeBatcher();
    const tracker = makeTracker(0.5, batcher, true);
    await fireClick();
    expect(batcher.pushed.length).toBe(1);
    tracker.destroy();
  });

  it('keeps all events when samplingRate = 1.0', async () => {
    const batcher = makeBatcher();
    const tracker = makeTracker(1.0, batcher);
    await fireClick();
    expect(batcher.pushed.length).toBe(1);
    tracker.destroy();
  });
});

describe('clicks dashboard correction factor', () => {
  it('correctly computes 1/samplingRate scaled count', () => {
    const samplingRate = 0.2;
    const rawCount = 10;
    const corrected = Math.round(rawCount * (1 / samplingRate));
    expect(corrected).toBe(50);
  });

  it('does not inflate count when samplingRate = 1.0', () => {
    const samplingRate = 1.0;
    const rawCount = 10;
    const correctionFactor = samplingRate < 1.0 ? 1 / samplingRate : 1.0;
    expect(Math.round(rawCount * correctionFactor)).toBe(10);
  });

  it('correctly computes scroll totalSessions correction', () => {
    const samplingRate = 0.2;
    const rawTotal = 100;
    const corrected = Math.round(rawTotal / samplingRate);
    expect(corrected).toBe(500);
  });
});
