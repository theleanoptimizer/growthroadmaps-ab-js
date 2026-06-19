import { describe, it, expect } from 'vitest';
import {
  ClickProximityTracker,
  DEAD_COUNT,
  RAGE_COUNT,
} from '../src/click-proximity';

describe('ClickProximityTracker', () => {
  it('flags dead click on second nearby click within window', () => {
    const tracker = new ClickProximityTracker();
    const t0 = 1000;
    const first = tracker.record(50, 50, t0);
    expect(first.isDeadClick).toBe(false);
    expect(first.isRageClick).toBe(false);

    const second = tracker.record(52, 51, t0 + 200);
    expect(second.isDeadClick).toBe(true);
    expect(second.isRageClick).toBe(false);
  });

  it('flags rage click on third nearby click', () => {
    const tracker = new ClickProximityTracker();
    const t0 = 2000;
    tracker.record(10, 10, t0);
    tracker.record(11, 10, t0 + 100);
    const third = tracker.record(10, 12, t0 + 200);
    expect(third.isDeadClick).toBe(true);
    expect(third.isRageClick).toBe(true);
    expect(DEAD_COUNT).toBe(2);
    expect(RAGE_COUNT).toBe(3);
  });

  it('does not flag clicks far apart', () => {
    const tracker = new ClickProximityTracker();
    const t0 = 3000;
    tracker.record(10, 10, t0);
    const far = tracker.record(200, 200, t0 + 100);
    expect(far.isDeadClick).toBe(false);
    expect(far.isRageClick).toBe(false);
  });

  it('reset clears proximity history', () => {
    const tracker = new ClickProximityTracker();
    const t0 = 4000;
    tracker.record(50, 50, t0);
    tracker.reset();
    const after = tracker.record(50, 50, t0 + 100);
    expect(after.isDeadClick).toBe(false);
  });
});
