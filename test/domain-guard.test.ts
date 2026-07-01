import { describe, it, expect } from "vitest";
import {
  normalizeHostname,
  hostnameMatchesProjectDomain,
  isHostnameAuthorizedForProject,
  isCurrentHostnameAuthorized,
} from "../src/domain-guard";

describe("sdk domain-guard", () => {
  it("matches project domain and subdomains", () => {
    expect(hostnameMatchesProjectDomain("shop.example.com", "example.com")).toBe(true);
    expect(hostnameMatchesProjectDomain("example.com", "example.com")).toBe(true);
    expect(hostnameMatchesProjectDomain("other.com", "example.com")).toBe(false);
  });

  it("honors tracking_authorized_domains", () => {
    expect(
      isHostnameAuthorizedForProject("mysite.vercel.app", {
        domain: "example.com",
        tracking_authorized_domains: ["mysite.vercel.app"],
      }),
    ).toBe(true);
  });

  it("normalizeHostname strips protocol", () => {
    expect(normalizeHostname("https://WWW.Example.com/path")).toBe("example.com");
  });

  it("isCurrentHostnameAuthorized matches current window hostname", () => {
    if (typeof window === "undefined") {
      expect(isCurrentHostnameAuthorized({ domain: "example.com" })).toBe(true);
      return;
    }
    const host = window.location.hostname.replace(/^www\./, "").toLowerCase();
    expect(isCurrentHostnameAuthorized({ domain: host })).toBe(true);
  });
});
