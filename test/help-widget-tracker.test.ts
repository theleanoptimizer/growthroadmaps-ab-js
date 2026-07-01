// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HelpWidgetTracker } from "../src/help-widget-tracker";
import type { ABEvent } from "../src/types";

describe("HelpWidgetTracker", () => {
  const events: ABEvent[] = [];
  const batcher = {
    push: (e: ABEvent) => {
      events.push(e);
    },
  };

  beforeEach(() => {
    events.length = 0;
    document.body.innerHTML = "";
    vi.stubGlobal("window", {
      location: { href: "https://example.com/pricing", pathname: "/pricing", search: "" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits query_text truncated on help search change", () => {
    const input = document.createElement("input");
    input.type = "search";
    input.name = "help-search";
    input.placeholder = "Search help";
    document.body.appendChild(input);

    const tracker = new HelpWidgetTracker(
      batcher as never,
      "user-1",
      "sess-1",
      () => true,
      () => true,
    );
    tracker.start();

    input.value = "  how do refunds work for annual plans  ";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const searchEvt = events.find((e) => e.type === "help_widget_search");
    expect(searchEvt).toBeTruthy();
    expect(searchEvt!.metadata?.query_text).toBe("how do refunds work for annual plans");
    expect(searchEvt!.metadata?.query_length).toBe("how do refunds work for annual plans".length);

    const longQuery = "x".repeat(200);
    input.value = longQuery;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const second = events.filter((e) => e.type === "help_widget_search").pop();
    expect(String(second!.metadata?.query_text).length).toBeLessThanOrEqual(120);

    tracker.destroy();
  });
});
