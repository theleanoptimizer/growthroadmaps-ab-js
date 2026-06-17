// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isTrackingSessionSampled,
  trackingSamplingStorageKey,
} from "../src/tracking-sampling";

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
