import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionTracker, isSensitiveElement } from "../src/session-tracker";

describe("SessionTracker", () => {
  const push = vi.fn();
  const batcher = { push } as { push: typeof push };

  beforeEach(() => {
    push.mockClear();
    vi.stubGlobal("window", {
      location: { href: "https://example.com/pricing", origin: "https://example.com" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", {
      title: "Pricing",
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
    const tracker = new SessionTracker(batcher as never, "user-1", "sess-1", () => true, () => true);
    tracker.start();
    expect(push).toHaveBeenCalled();
    const evt = push.mock.calls[0][0];
    expect(evt.type).toBe("session_page_view");
    expect(evt.metadata.navigation_type).toBe("initial");
  });

  it("masks sensitive elements", () => {
    const el = document.createElement("input");
    el.type = "password";
    expect(isSensitiveElement(el)).toBe(true);
  });
});
