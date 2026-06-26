// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isTrackingSessionSampled,
  resolveEffectiveTrackingSamplingRate,
  trackingSamplingStorageKey,
} from "../src/tracking-sampling";
import {
  isTrafficExcludedForExperiment,
  resolveTrackingSessionSampled,
  shouldBypassTrackingSamplingForExperiments,
} from "../src/tracking-sampling-bypass";
import type { ExperimentConfig } from "../src/types";

const runningExp: ExperimentConfig = {
  id: "exp-1",
  name: "Homepage test",
  status: "running",
  traffic_percentage: 100,
  variants: [{ id: "var-a", name: "A", weight: 50 }, { id: "var-b", name: "B", weight: 50 }],
};

describe("isTrackingSessionSampled", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    vi.spyOn(Math, "random").mockReturnValue(0.3);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("always includes sessions when rate is 1", () => {
    expect(isTrackingSessionSampled("proj-1", 1)).toBe(true);
    expect(sessionStorage.getItem(trackingSamplingStorageKey("proj-1"))).toBeNull();
  });

  it("always excludes sessions when rate is 0", () => {
    expect(isTrackingSessionSampled("proj-1", 0)).toBe(false);
  });

  it("sticks the random decision for the session tab", () => {
    expect(isTrackingSessionSampled("proj-2", 0.5)).toBe(true);
    vi.mocked(Math.random).mockReturnValue(0.99);
    expect(isTrackingSessionSampled("proj-2", 0.5)).toBe(true);
    expect(sessionStorage.getItem(trackingSamplingStorageKey("proj-2"))).toBe("1");
  });

  it("excludes when random draw exceeds rate", () => {
    vi.mocked(Math.random).mockReturnValue(0.9);
    expect(isTrackingSessionSampled("proj-3", 0.5)).toBe(false);
    expect(sessionStorage.getItem(trackingSamplingStorageKey("proj-3"))).toBe("0");
  });
});

describe("resolveEffectiveTrackingSamplingRate", () => {
  it("prefers project-level rate when set", () => {
    expect(resolveEffectiveTrackingSamplingRate(0.5, [0.2, 0.1])).toBe(0.5);
  });

  it("falls back to min heatmap config rate when project rate is missing", () => {
    expect(resolveEffectiveTrackingSamplingRate(undefined, [0.2, 0.5])).toBe(0.2);
  });

  it("defaults to 20% when no project or config rates exist", () => {
    expect(resolveEffectiveTrackingSamplingRate(undefined, [])).toBe(0.2);
  });
});

describe("shouldBypassTrackingSamplingForExperiments", () => {
  const ctx = {
    userId: "visitor-1",
    passesUrlRules: () => true,
    passesTargeting: () => true,
  };

  it("returns true for an in-bucket running experiment assignment", () => {
    const assignments = new Map([["exp-1", { id: "var-a" }]]);
    expect(shouldBypassTrackingSamplingForExperiments([runningExp], assignments, ctx)).toBe(true);
  });

  it("returns false when there are no assignments", () => {
    expect(shouldBypassTrackingSamplingForExperiments([runningExp], new Map(), ctx)).toBe(false);
  });

  it("returns false for draft experiments", () => {
    const draft = { ...runningExp, status: "draft" };
    const assignments = new Map([["exp-1", { id: "var-a" }]]);
    expect(shouldBypassTrackingSamplingForExperiments([draft], assignments, ctx)).toBe(false);
  });

  it("returns false when URL rules do not match", () => {
    const assignments = new Map([["exp-1", { id: "var-a" }]]);
    expect(
      shouldBypassTrackingSamplingForExperiments([runningExp], assignments, {
        ...ctx,
        passesUrlRules: () => false,
      }),
    ).toBe(false);
  });

  it("returns false for traffic-excluded visitors", () => {
    const lowTraffic = { ...runningExp, traffic_percentage: 1 };
    const assignments = new Map([["exp-1", { id: "var-a" }]]);
    let excludedUser = "";
    for (let i = 0; i < 500; i++) {
      const candidate = `user-${i}`;
      if (isTrafficExcludedForExperiment("exp-1", candidate, 1)) {
        excludedUser = candidate;
        break;
      }
    }
    expect(excludedUser).not.toBe("");
    expect(
      shouldBypassTrackingSamplingForExperiments([lowTraffic], assignments, {
        ...ctx,
        userId: excludedUser,
      }),
    ).toBe(false);
  });
});

describe("resolveTrackingSessionSampled", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    sessionStorage.setItem(trackingSamplingStorageKey("proj-bypass"), "0");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bypasses sticky exclusion for active experiment participants", () => {
    const assignments = new Map([["exp-1", { id: "var-a" }]]);
    expect(
      resolveTrackingSessionSampled("proj-bypass", 0.2, [runningExp], assignments, {
        userId: "visitor-1",
        passesUrlRules: () => true,
        passesTargeting: () => true,
      }, isTrackingSessionSampled),
    ).toBe(true);
  });

  it("respects sticky exclusion when no experiment bypass applies", () => {
    expect(
      resolveTrackingSessionSampled("proj-bypass", 0.2, [runningExp], new Map(), {
        userId: "visitor-1",
        passesUrlRules: () => true,
        passesTargeting: () => true,
      }, isTrackingSessionSampled),
    ).toBe(false);
  });
});
