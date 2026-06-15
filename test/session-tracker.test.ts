import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SessionTracker,
  isSensitiveElement,
  getOrCaptureFirstTouch,
  firstTouchStorageKey,
  loadFirstTouchAttribution,
} from "../src/session-tracker";

describe("SessionTracker", () => {
  const push = vi.fn();
  const batcher = { push } as { push: typeof push };

  beforeEach(() => {
    push.mockClear();
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    vi.stubGlobal("window", {
      location: {
        href: "https://example.com/pricing?utm_source=google&utm_medium=cpc&utm_campaign=test",
        origin: "https://example.com",
        search: "?utm_source=google&utm_medium=cpc&utm_campaign=test",
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", {
      title: "Pricing",
      hidden: false,
      referrer: "https://www.google.com/",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createElement: (tag: string) => {
        const el = {
          tagName: tag.toUpperCase(),
          type: "",
          id: "",
          classList: { slice: () => [] as string[] },
          matches: (sel: string) =>
            tag === "input" && sel.includes("password"),
          textContent: "",
        };
        return el;
      },
    });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });
    vi.stubGlobal("history", {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits initial page view on start", () => {
    const tracker = new SessionTracker(batcher as never, "user-1", "sess-1", () => true, () => true, "proj-1");
    tracker.start();
    expect(push).toHaveBeenCalled();
    const evt = push.mock.calls[0][0];
    expect(evt.type).toBe("session_page_view");
    expect(evt.metadata.navigation_type).toBe("initial");
    expect(evt.metadata.utm_source).toBe("google");
    expect(evt.metadata.utm_medium).toBe("cpc");
    expect(evt.metadata.referrer).toContain("google.com");
  });

  it("persists first-touch in sessionStorage and does not re-send on SPA navigation", () => {
    const tracker = new SessionTracker(batcher as never, "user-1", "sess-1", () => true, () => true, "proj-1");
    tracker.start();
    push.mockClear();
    history.pushState({}, "", "/checkout");
    const calls = push.mock.calls.filter((c) => c[0].type === "session_page_view");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0].metadata.utm_source).toBeUndefined();
    expect(loadFirstTouchAttribution("proj-1")?.utm_source).toBe("google");
  });

  it("getOrCaptureFirstTouch uses storage key scoped by project", () => {
    getOrCaptureFirstTouch("pk-a");
    expect(firstTouchStorageKey("pk-a")).toBe("_gr_sa_attr_pk-a");
  });

  it("masks sensitive elements", () => {
    const el = document.createElement("input");
    el.type = "password";
    expect(isSensitiveElement(el)).toBe(true);
  });

  it("does not emit visibility event when tab becomes visible", () => {
    let visHandler: (() => void) | undefined;
    vi.stubGlobal("document", {
      title: "Pricing",
      hidden: false,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "visibilitychange") visHandler = handler;
      }),
      removeEventListener: vi.fn(),
    });
    const tracker = new SessionTracker(batcher as never, "user-1", "sess-1", () => true, () => true);
    tracker.start();
    push.mockClear();
    visHandler?.();
    expect(push).not.toHaveBeenCalled();
  });

  it("emits visibility event when tab is hidden", () => {
    let visHandler: (() => void) | undefined;
    vi.stubGlobal("document", {
      title: "Pricing",
      hidden: true,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "visibilitychange") visHandler = handler;
      }),
      removeEventListener: vi.fn(),
    });
    const tracker = new SessionTracker(batcher as never, "user-1", "sess-1", () => true, () => true);
    tracker.start();
    push.mockClear();
    visHandler?.();
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_visibility" }),
    );
  });
});
