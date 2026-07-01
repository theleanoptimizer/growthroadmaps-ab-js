/** First-party visitor identity helpers (new/returning, visitor session, device). */

export type VisitorType = 'new' | 'returning';

const D = typeof document !== 'undefined' ? document : undefined;
const N = typeof navigator !== 'undefined' ? navigator : undefined;

export const VISITOR_SESSION_IDLE_MS = 30 * 60 * 1000;

export function getCookie(name: string): string | null {
  if (!D) return null;
  const m = D.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export function setCookie(name: string, value: string, maxAgeSec = 31536000): void {
  if (!D) return;
  D.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${maxAgeSec};SameSite=Lax`;
}

/** Session-scoped cookie (no max-age) for CallRail Custom Cookie Capture linkage. */
export function setSessionCookie(name: string, value: string): void {
  if (!D) return;
  D.cookie = `${name}=${encodeURIComponent(value)};path=/;SameSite=Lax`;
}

export const AB_SESSION_COOKIE = "_ab_sid";

export function mirrorAbSessionCookie(sessionId: string): void {
  const trimmed = sessionId.trim();
  if (!trimmed) return;
  setSessionCookie(AB_SESSION_COOKIE, trimmed);
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function setAbVidCookie(id: string): void {
  setCookie('_ab_vid', id);
}

/** Resolve persistent user id and whether this is a new or returning visitor. */
export function resolveVisitorIdentity(skipCookie: boolean): {
  userId: string;
  visitorType: VisitorType;
} {
  if (!skipCookie) {
    const existing = getCookie('_ab_vid');
    if (existing) {
      setCookie('returning', '1');
      return { userId: existing, visitorType: 'returning' };
    }
  }
  const id = uuid();
  if (!skipCookie) setAbVidCookie(id);
  return { userId: id, visitorType: 'new' };
}

export function touchVisitorSession(projectKey: string, canUseCookies: boolean): string {
  const key = `_gr_vs_${projectKey || 'default'}`;
  const now = Date.now();
  if (canUseCookies) {
    try {
      const raw = getCookie(key);
      if (raw) {
        const parsed = JSON.parse(decodeURIComponent(raw)) as { id?: string; lastActivityAt?: number };
        if (
          parsed.id &&
          typeof parsed.lastActivityAt === 'number' &&
          now - parsed.lastActivityAt < VISITOR_SESSION_IDLE_MS
        ) {
          setCookie(key, JSON.stringify({ id: parsed.id, lastActivityAt: now }));
          return parsed.id;
        }
      }
    } catch { /* ignore */ }
    const id = uuid();
    setCookie(key, JSON.stringify({ id, lastActivityAt: now }));
    return id;
  }
  return uuid();
}

export function refreshVisitorSessionActivity(projectKey: string, visitorSessionId: string, canUseCookies: boolean): void {
  if (!canUseCookies) return;
  const key = `_gr_vs_${projectKey || 'default'}`;
  setCookie(key, JSON.stringify({ id: visitorSessionId, lastActivityAt: Date.now() }));
}

const BR = /\b(Chrome|Firefox|Safari|Edge|Opera|MSIE|Trident)\/?[\d.]*/i;
const OL = /\b(Windows NT|Mac OS X|Linux|Android|iOS|iPhone OS)[\d._]*/i;

function uam(re: RegExp): string {
  const m = N?.userAgent?.match(re);
  return m ? m[0] : 'unknown';
}

export function getBrowserOsLanguage(): { browser: string; os: string; language: string } {
  return {
    browser: uam(BR),
    os: uam(OL),
    language: N?.language || 'unknown',
  };
}

/** Common file extensions for codeless download tracking. */
export const DOWNLOAD_EXT_RE = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt|gz|tar|mp3|mp4|mov|avi|dmg|pkg)(?:\?|#|$)/i;

export function isLikely404Page(): boolean {
  if (typeof document === 'undefined') return false;
  const title = (document.title || '').toLowerCase();
  if (title.includes('404') || title.includes('not found') || title.includes('page not found')) return true;
  const meta = document.querySelector('meta[name="gr-not-found"], meta[property="gr:not-found"]');
  return !!meta;
}
