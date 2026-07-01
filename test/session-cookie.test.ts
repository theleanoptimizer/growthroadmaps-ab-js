// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  AB_SESSION_COOKIE,
  getCookie,
  mirrorAbSessionCookie,
  setSessionCookie,
} from "../src/visitor-identity";

describe("session cookie (_ab_sid)", () => {
  beforeEach(() => {
    document.cookie = "";
  });

  it("sets session-scoped cookie without max-age", () => {
    setSessionCookie(AB_SESSION_COOKIE, "sess-uuid-123");
    expect(getCookie(AB_SESSION_COOKIE)).toBe("sess-uuid-123");
    expect(document.cookie).not.toMatch(/max-age=/i);
  });

  it("mirrorAbSessionCookie writes trimmed session id", () => {
    mirrorAbSessionCookie("  abc-def-ghi  ");
    expect(getCookie(AB_SESSION_COOKIE)).toBe("abc-def-ghi");
  });
});
