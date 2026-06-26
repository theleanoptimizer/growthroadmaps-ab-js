import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBatcher } from "../src/batcher";

describe("EventBatcher sessionAdmission", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies handler when sessionAdmission marks a session denied", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sessionAdmission: { "sess-1": false, "sess-2": true } }),
    });

    const denied: string[] = [];
    const batcher = new EventBatcher("https://api.example.com", "pk-test");
    batcher.setSessionAdmissionHandler((ids) => denied.push(...ids));
    batcher.push({ type: "session_page_view", session_id: "sess-1" } as never);

    await batcher.flush();

    expect(denied).toEqual(["sess-1"]);
  });
});
