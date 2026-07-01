let cachedDeviceType: string | undefined;
let cachedPagePath = '';

function computeDeviceType(): string {
  const ua = navigator.userAgent;
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobi|Android/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function getDeviceType(): string {
  if (!cachedDeviceType) cachedDeviceType = computeDeviceType();
  return cachedDeviceType;
}

export function pathOnly(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function getCurrentPagePath(): string {
  if (typeof window === 'undefined') return cachedPagePath;
  if (!cachedPagePath) cachedPagePath = pathOnly(window.location.href);
  return cachedPagePath;
}

export function getPageHost(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hostname.replace(/^www\./, '').toLowerCase();
}

export function setCurrentPagePath(url?: string): void {
  if (typeof window === 'undefined') return;
  cachedPagePath = pathOnly(url ?? window.location.href);
}

export function nowIso(): string {
  return new Date().toISOString();
}
