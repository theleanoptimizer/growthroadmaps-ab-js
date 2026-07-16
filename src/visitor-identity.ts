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

export function uuid(): string {
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

/** Browser/OS (+ embedded versions) from UA. e.g. Chrome/131.0.0, Windows NT 10.0 */
export function getBrowserOsLanguage(): { browser: string; os: string; language: string } {
  const ua = N?.userAgent ?? '';
  let browser = 'unknown';
  let m: RegExpMatchArray | null;
  const v = (s: string | undefined, n: number) =>
    (s ?? '').replace(/_/g, '.').split('.').slice(0, n).join('.');
  // Edge before Chrome. Opera/IE omitted for core gzip budget.
  if ((m = ua.match(/Edg\/([\d.]+)/i))) browser = 'Edge/' + v(m[1], 3);
  else if ((m = ua.match(/Chrome\/([\d.]+)/i))) browser = 'Chrome/' + v(m[1], 3);
  else if ((m = ua.match(/Firefox\/([\d.]+)/i))) browser = 'Firefox/' + v(m[1], 3);
  else if ((m = ua.match(/Version\/([\d.]+).*Safari/i))) browser = 'Safari/' + v(m[1], 3);

  let os = 'unknown';
  if ((m = ua.match(/Windows NT ([\d.]+)/i))) os = 'Windows NT ' + m[1];
  else if ((m = ua.match(/Android ([\d.]+)/i))) os = 'Android ' + v(m[1], 2);
  else if (/iPhone|iPad|iPod/i.test(ua)) {
    const iv = v(ua.match(/(?:iPhone OS|CPU OS) ([\d_]+)/i)?.[1], 2);
    os = iv ? 'iOS ' + iv : 'iOS';
  } else if ((m = ua.match(/Mac OS X ([\d_]+)/i))) os = 'Mac OS X ' + m[1];
  else if (/Linux/i.test(ua)) os = 'Linux';

  return { browser, os, language: N?.language || 'unknown' };
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
