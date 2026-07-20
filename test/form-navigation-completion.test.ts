// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FormTracker } from "../src/form-tracker";
import type { EventBatcher } from "../src/batcher";

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

describe("FormTracker navigation completion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("marks form submitted via navigation after recent CTA click + pageChanged", () => {
    document.body.innerHTML = `
      <form id="booking">
        <input name="travellers" type="number" value="1" />
        <button type="button" id="triggerBookingOnline">Book</button>
      </form>
    `;
    const batcher = makeBatcher();
    const tracker = new FormTracker(
      batcher,
      "user-1",
      "session-1",
      () => true,
      [{ capture_mode: "all_forms", url_rules: [], form_selectors: [] }],
      true,
    );

    const input = document.querySelector("input") as HTMLInputElement;
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const button = document.getElementById("triggerBookingOnline") as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    tracker.pageChanged();

    expect(batcher.pushed.length).toBe(1);
    const evt = batcher.pushed[0] as {
      metadata: { submitted: boolean; completion_mode?: string; fields: Array<{ is_dropoff: boolean }> };
    };
    expect(evt.metadata.submitted).toBe(true);
    expect(evt.metadata.completion_mode).toBe("navigation");
    expect(evt.metadata.fields.every((f) => !f.is_dropoff)).toBe(true);

    tracker.destroy();
  });

  it("still treats leave without recent CTA click as abandon", () => {
    document.body.innerHTML = `
      <form id="booking">
        <input name="email" type="email" />
        <button type="button" id="triggerBookingOnline">Book</button>
      </form>
    `;
    const batcher = makeBatcher();
    const tracker = new FormTracker(
      batcher,
      "user-1",
      "session-1",
      () => true,
      [{ capture_mode: "all_forms", url_rules: [], form_selectors: [] }],
      true,
    );

    const input = document.querySelector("input") as HTMLInputElement;
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));

    tracker.pageChanged();

    expect(batcher.pushed.length).toBe(1);
    const evt = batcher.pushed[0] as {
      metadata: { submitted: boolean; completion_mode?: string; fields: Array<{ is_dropoff: boolean }> };
    };
    expect(evt.metadata.submitted).toBe(false);
    expect(evt.metadata.completion_mode).toBeUndefined();
    expect(evt.metadata.fields.some((f) => f.is_dropoff)).toBe(true);

    tracker.destroy();
  });
});
