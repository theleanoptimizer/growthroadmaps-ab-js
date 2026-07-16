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

function windowsNtToVersion(nt: string | undefined): string {
  switch (nt) {
    case '10.0': return '10/11';
    case '6.3': return '8.1';
    case '6.2': return '8';
    case '6.1': return '7';
    default: return nt ?? '';
  }
}

/** Parse browser/OS names + versions from the current user agent. */
export function getBrowserOsLanguage(): {
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  language: string;
} {
  const raw = N?.userAgent?.trim() ?? '';
  let browser = 'unknown';
  let browserVersion = '';
  const browserMatchers: Array<{ name: string; re: RegExp }> = [
    { name: 'Edge', re: /Edg(?:e|A|iOS)?\/([\d.]+)/i },
    { name: 'Opera', re: /(?:OPR|Opera)\/([\d.]+)/i },
    { name: 'Chrome', re: /Chrome\/([\d.]+)/i },
    { name: 'Firefox', re: /Firefox\/([\d.]+)/i },
    { name: 'Safari', re: /Version\/([\d.]+).*Safari/i },
    { name: 'IE', re: /(?:MSIE |rv:)([\d.]+)/i },
  ];
  for (const m of browserMatchers) {
    const hit = raw.match(m.re);
    if (hit) {
      browser = m.name;
      browserVersion = (hit[1] ?? '').split('.').slice(0, 3).join('.');
      break;
    }
  }

  let os = 'unknown';
  let osVersion = '';
  if (/Windows NT/i.test(raw)) {
    os = 'Windows';
    osVersion = windowsNtToVersion(raw.match(/Windows NT ([\d.]+)/i)?.[1]);
  } else if (/Android/i.test(raw)) {
    os = 'Android';
    osVersion = (raw.match(/Android ([\d.]+)/i)?.[1] ?? '').split('.').slice(0, 2).join('.');
  } else if (/iPhone|iPad|iPod|iOS/i.test(raw)) {
    os = 'iOS';
    const v = raw.match(/(?:iPhone OS|CPU OS|CPU iPhone OS) ([\d_]+)/i)?.[1];
    osVersion = (v ?? '').replace(/_/g, '.').split('.').slice(0, 2).join('.');
  } else if (/Mac OS X/i.test(raw)) {
    os = 'macOS';
    const v = raw.match(/Mac OS X ([\d_]+)/i)?.[1];
    osVersion = (v ?? '').replace(/_/g, '.').split('.').slice(0, 2).join('.');
  } else if (/Linux/i.test(raw)) {
    os = 'Linux';
  }

  return {
    browser,
    browserVersion,
    os,
    osVersion,
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
