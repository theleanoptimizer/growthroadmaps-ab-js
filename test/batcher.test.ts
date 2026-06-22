// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBatcher, MAX_EVENTS_PER_REQUEST } from "../src/batcher";
import type { ABEvent } from "../src/types";

function scrollEvent(i: number): ABEvent {
  return {
    type: "heatmap_scroll",
    metadata: { page_url: `/p-${i}`, max_scroll_percent: 50 },
  } as ABEvent;
}

describe("EventBatcher", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("matches server batch size limit", () => {
    expect(MAX_EVENTS_PER_REQUEST).toBe(50);
  });

  it("sends at most 50 events per HTTP request when flushing", async () => {
    const batcher = new EventBatcher("https://example.com", "test-key");
    for (let i = 0; i < 75; i++) {
      batcher.push(scrollEvent(i));
    }

    await batcher.flush();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const sizes = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      const body = JSON.parse(init.body as string) as { events: unknown[] };
      return body.events.length;
    });
    expect(sizes).toEqual([50, 25]);
  });
});
