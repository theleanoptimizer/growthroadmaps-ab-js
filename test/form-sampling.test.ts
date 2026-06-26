// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FormTracker } from "../src/form-tracker";
import type { EventBatcher } from "../src/batcher";

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

function makeTracker(batcher: EventBatcher, sessionSampled: boolean) {
  document.body.innerHTML = `
    <form id="lead-form" action="/submit">
      <input name="email" type="email" />
      <button type="submit">Send</button>
    </form>
  `;
  return new FormTracker(
    batcher,
    "user-1",
    "session-1",
    () => true,
    [{ capture_mode: "all_forms", url_rules: [], form_selectors: [] }],
    sessionSampled,
  );
}

describe("FormTracker sampling gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("drops form events when session is not sampled", () => {
    const batcher = makeBatcher();
    const tracker = makeTracker(batcher, false);
    const form = document.getElementById("lead-form") as HTMLFormElement;
    form.dispatchEvent(new Event("focusin", { bubbles: true }));
    form.dispatchEvent(new Event("focusout", { bubbles: true }));
    tracker.destroy();
    expect(batcher.pushed.length).toBe(0);
  });

  it("emits form events when session is sampled", () => {
    const batcher = makeBatcher();
    const tracker = makeTracker(batcher, true);
    const form = document.getElementById("lead-form") as HTMLFormElement;
    const input = form.querySelector("input") as HTMLInputElement;
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    input.dispatchEvent(new Event("focusout", { bubbles: true }));
    tracker.destroy();
    expect(batcher.pushed.length).toBe(1);
  });

  it("allows upgrading to sampled mid-session", () => {
    const batcher = makeBatcher();
    const tracker = makeTracker(batcher, false);
    tracker.setSessionSampled(true);
    const form = document.getElementById("lead-form") as HTMLFormElement;
    const input = form.querySelector("input") as HTMLInputElement;
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    input.dispatchEvent(new Event("focusout", { bubbles: true }));
    tracker.destroy();
    expect(batcher.pushed.length).toBe(1);
  });
});
