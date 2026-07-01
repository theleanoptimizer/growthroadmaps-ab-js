// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";

/** Mirrors core bundle `scs()` — session-scoped _ab_sid for CallRail linkage. */
function scs(s: string): void {
  document.cookie = `_ab_sid=${encodeURIComponent(s)};path=/;SameSite=Lax`;
}

function getSidCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)_ab_sid=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : null;
}

describe("session cookie (_ab_sid)", () => {
  beforeEach(() => {
    document.cookie = "";
  });

  it("sets session-scoped cookie without max-age", () => {
    scs("sess-uuid-123");
    expect(getSidCookie()).toBe("sess-uuid-123");
    expect(document.cookie).not.toMatch(/max-age=/i);
  });

  it("encodes special characters", () => {
    scs("abc def");
    expect(getSidCookie()).toBe("abc def");
  });
});
