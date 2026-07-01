// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";

function gc(n: string): string | null {
  const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Mirrors core bundle readCallRailSid(). */
function readCallRailSid(win: Window & { CallTrkSwap?: { _session_id?: string } }): string | undefined {
  const g = win.CallTrkSwap?._session_id;
  if (typeof g === "string" && g.trim()) return g.trim().slice(0, 128);
  let v = gc("calltrk_session_id");
  if (v) return v.slice(0, 128);
  for (const part of document.cookie.split(";")) {
    const p = part.trim();
    if (p.startsWith("calltrk_session_id_")) {
      v = decodeURIComponent(p.slice(p.indexOf("=") + 1)).trim();
      if (v) return v.slice(0, 128);
    }
  }
  return undefined;
}

describe("readCallRailSid", () => {
  beforeEach(() => {
    const parts = document.cookie ? document.cookie.split(";") : [];
    for (const part of parts) {
      const name = part.trim().split("=")[0];
      if (name) document.cookie = `${name}=;max-age=0;path=/`;
    }
    delete (window as { CallTrkSwap?: { _session_id?: string } }).CallTrkSwap;
  });

  it("prefers CallTrkSwap global", () => {
    (window as { CallTrkSwap?: { _session_id?: string } }).CallTrkSwap = {
      _session_id: "global-session-uuid",
    };
    expect(readCallRailSid(window)).toBe("global-session-uuid");
  });

  it("reads calltrk_session_id cookie", () => {
    document.cookie = "calltrk_session_id=cookie-session-uuid;path=/";
    expect(readCallRailSid(window)).toBe("cookie-session-uuid");
  });

  it("reads namespaced calltrk_session_id_ cookie", () => {
    document.cookie = "calltrk_session_id_12345=company-session-uuid;path=/";
    expect(readCallRailSid(window)).toBe("company-session-uuid");
  });
});
