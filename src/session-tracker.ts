import { EventBatcher } from './batcher';
import { registerClickHandler } from './click-delegate';
import { getDeviceType, getCurrentPagePath, nowIso, setCurrentPagePath } from './session-context';

type NavigationType = 'initial' | 'spa' | 'back' | 'forward';

export interface FirstTouchAttribution {
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  fbclid?: string;
  msclkid?: string;
}

function readParam(params: URLSearchParams, key: string): string | undefined {
  const v = params.get(key);
  return v && v.trim() ? v.trim() : undefined;
}

function captureFirstTouchFromPage(): FirstTouchAttribution {
  const out: FirstTouchAttribution = {};
  try {
    out.referrer = document.referrer?.slice(0, 500) || undefined;
    const params = new URLSearchParams(window.location.search);
    out.utm_source = readParam(params, 'utm_source');
    out.utm_medium = readParam(params, 'utm_medium');
    out.utm_campaign = readParam(params, 'utm_campaign');
    out.utm_content = readParam(params, 'utm_content');
    out.utm_term = readParam(params, 'utm_term');
    out.gclid = readParam(params, 'gclid');
    out.fbclid = readParam(params, 'fbclid');
    out.msclkid = readParam(params, 'msclkid');
  } catch { /* ignore */ }
  return out;
}

export function firstTouchStorageKey(projectKey: string): string {
  return `_gr_sa_attr_${projectKey || 'default'}`;
}

export function loadFirstTouchAttribution(projectKey: string): FirstTouchAttribution | null {
  try {
    const raw = sessionStorage.getItem(firstTouchStorageKey(projectKey));
    if (!raw) return null;
    return JSON.parse(raw) as FirstTouchAttribution;
  } catch {
    return null;
  }
}

export function saveFirstTouchAttribution(projectKey: string, attrs: FirstTouchAttribution): void {
  try {
    sessionStorage.setItem(firstTouchStorageKey(projectKey), JSON.stringify(attrs));
  } catch { /* ignore quota */ }
}

export function getOrCaptureFirstTouch(projectKey: string): FirstTouchAttribution {
  const existing = loadFirstTouchAttribution(projectKey);
  if (existing) return existing;
  const captured = captureFirstTouchFromPage();
  saveFirstTouchAttribution(projectKey, captured);
  return captured;
}

const SENSITIVE_SELECTOR_RE =
  /input\[type=(?:password|email|tel|hidden)\]|autocomplete=["']cc-|data-gr-mask/i;

export function isSensitiveElement(el: Element | null): boolean {
  if (!el) return false;
  if (el.matches('input[type=password],input[type=email],input[type=tel],input[type=hidden],[autocomplete^="cc-"],[data-gr-mask]')) {
    return true;
  }
  return SENSITIVE_SELECTOR_RE.test(getSelector(el));
}

function getSelector(el: Element): string {
  if (el.id) return '#' + el.id;
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).slice(0, 3).join('.');
  return cls ? `${tag}.${cls}` : tag;
}

export function sanitizeVisibleText(el: Element | null): string | undefined {
  if (!el || isSensitiveElement(el)) return undefined;
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  return text.slice(0, 120) || undefined;
}

const SPA_PAGE_VIEW_DEBOUNCE_MS = 100;

export class SessionTracker {
  #batcher: EventBatcher;
  #userId: string;
  #sessionId: string;
  #projectKey: string;
  #consent: () => boolean;
  #enabled: () => boolean;
  #variantId?: string;
  #cleanups: (() => void)[] = [];
  #lastPageUrl = '';
  #lastPageEnter = Date.now();
  #originalPushState?: History['pushState'];
  #originalReplaceState?: History['replaceState'];
  #initialAttributionSent = false;
  #spaPageViewTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string,
    consent: () => boolean,
    enabled: () => boolean,
    projectKey = '',
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#projectKey = projectKey;
    this.#consent = consent;
    this.#enabled = enabled;
  }

  setVariantId(id: string | undefined): void {
    this.#variantId = id;
  }

  start(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    setCurrentPagePath();
    this.#emitPageView('initial');
    this.#patchHistory();
    this.#bindVisibility();
    this.#bindErrors();
    this.#bindNavigation();
  }

  destroy(): void {
    if (this.#spaPageViewTimer !== null) {
      clearTimeout(this.#spaPageViewTimer);
      this.#spaPageViewTimer = null;
    }
    for (const c of this.#cleanups) c();
    this.#cleanups = [];
    if (this.#originalPushState) history.pushState = this.#originalPushState;
    if (this.#originalReplaceState) history.replaceState = this.#originalReplaceState;
  }

  #canTrack(): boolean {
    return this.#consent() && this.#enabled();
  }

  #baseMeta(pageUrl: string): Record<string, unknown> {
    return {
      page_url: pageUrl,
      device_type: getDeviceType(),
    };
  }

  #attributionMeta(navigationType: NavigationType): Record<string, unknown> {
    if (navigationType !== 'initial' || this.#initialAttributionSent) return {};
    const attrs = getOrCaptureFirstTouch(this.#projectKey);
    this.#initialAttributionSent = true;
    const meta: Record<string, unknown> = {};
    if (attrs.referrer) meta.referrer = attrs.referrer;
    if (attrs.utm_source) meta.utm_source = attrs.utm_source;
    if (attrs.utm_medium) meta.utm_medium = attrs.utm_medium;
    if (attrs.utm_campaign) meta.utm_campaign = attrs.utm_campaign;
    if (attrs.utm_content) meta.utm_content = attrs.utm_content;
    if (attrs.utm_term) meta.utm_term = attrs.utm_term;
    if (attrs.gclid) meta.gclid = attrs.gclid;
    if (attrs.fbclid) meta.fbclid = attrs.fbclid;
    if (attrs.msclkid) meta.msclkid = attrs.msclkid;
    return meta;
  }

  #emitPageView(navigationType: NavigationType): void {
    if (!this.#canTrack()) return;
    setCurrentPagePath();
    const pageUrl = getCurrentPagePath();
    const now = Date.now();
    const timeOnPrevious = this.#lastPageUrl ? now - this.#lastPageEnter : undefined;
    this.#batcher.push({
      type: 'session_page_view',
      user_id: this.#userId,
      session_id: this.#sessionId,
      variant_id: this.#variantId,
      timestamp: nowIso(),
      metadata: {
        ...this.#baseMeta(pageUrl),
        ...this.#attributionMeta(navigationType),
        page_title: document.title?.slice(0, 200),
        navigation_type: navigationType,
        time_on_previous_page_ms: timeOnPrevious,
      },
    });
    this.#lastPageUrl = pageUrl;
    this.#lastPageEnter = now;
  }

  #scheduleSpaPageView(): void {
    if (this.#spaPageViewTimer !== null) clearTimeout(this.#spaPageViewTimer);
    this.#spaPageViewTimer = setTimeout(() => {
      this.#spaPageViewTimer = null;
      this.#emitPageView('spa');
    }, SPA_PAGE_VIEW_DEBOUNCE_MS);
  }

  #patchHistory(): void {
    const self = this;
    this.#originalPushState = history.pushState.bind(history);
    this.#originalReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args: Parameters<History['pushState']>) {
      self.#originalPushState!(...args);
      self.#scheduleSpaPageView();
    };
    history.replaceState = function (...args: Parameters<History['replaceState']>) {
      self.#originalReplaceState!(...args);
      self.#scheduleSpaPageView();
    };

    const onPop = () => self.#emitPageView('back');
    window.addEventListener('popstate', onPop);
    this.#cleanups.push(() => window.removeEventListener('popstate', onPop));
  }

  #bindVisibility(): void {
    const onVis = () => {
      if (!this.#canTrack()) return;
      if (!document.hidden) return;
      this.#batcher.push({
        type: 'session_visibility',
        user_id: this.#userId,
        session_id: this.#sessionId,
        variant_id: this.#variantId,
        timestamp: nowIso(),
        metadata: {
          ...this.#baseMeta(getCurrentPagePath()),
          hidden: document.hidden,
        },
      });
    };
    document.addEventListener('visibilitychange', onVis);
    this.#cleanups.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  #bindNavigation(): void {
    const onClick = (e: MouseEvent) => {
      if (!this.#canTrack()) return;
      const target = e.target as Element | null;
      const anchor = target?.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      try {
        const dest = new URL(href, window.location.href);
        if (dest.origin !== window.location.origin) {
          this.#batcher.push({
            type: 'session_navigation',
            user_id: this.#userId,
            session_id: this.#sessionId,
            variant_id: this.#variantId,
            timestamp: nowIso(),
            metadata: {
              ...this.#baseMeta(getCurrentPagePath()),
              navigation_kind: 'external',
            },
          });
        }
      } catch { /* ignore */ }
    };
    const unregister = registerClickHandler(onClick);
    this.#cleanups.push(unregister);
  }

  #buildErrorMetadata(
    baseMeta: Record<string, unknown>,
    opts: {
      message: string;
      source: 'error' | 'unhandledrejection';
      errorName?: string;
      filename?: string;
      lineno?: number;
      colno?: number;
      stack?: string;
    },
  ): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      ...baseMeta,
      message: opts.message.slice(0, 200),
      source: opts.source,
    };
    if (opts.errorName) meta.error_name = opts.errorName.slice(0, 80);
    if (opts.filename) meta.filename = opts.filename.slice(0, 300);
    if (opts.lineno != null && Number.isFinite(opts.lineno)) meta.lineno = opts.lineno;
    if (opts.colno != null && Number.isFinite(opts.colno)) meta.colno = opts.colno;
    if (opts.stack) meta.stack = opts.stack.slice(0, 500);
    return meta;
  }

  #bindErrors(): void {
    const onError = (ev: ErrorEvent) => {
      if (!this.#canTrack()) return;
      const errObj = ev.error instanceof Error ? ev.error : null;
      this.#batcher.push({
        type: 'session_error',
        user_id: this.#userId,
        session_id: this.#sessionId,
        variant_id: this.#variantId,
        timestamp: nowIso(),
        metadata: this.#buildErrorMetadata(this.#baseMeta(getCurrentPagePath()), {
          message: ev.message || errObj?.message || 'Script error',
          source: 'error',
          errorName: errObj?.name,
          filename: ev.filename || undefined,
          lineno: ev.lineno || undefined,
          colno: ev.colno || undefined,
          stack: errObj?.stack,
        }),
      });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      if (!this.#canTrack()) return;
      const reason = ev.reason;
      const errObj = reason instanceof Error ? reason : null;
      const msg = errObj?.message ?? String(reason);
      this.#batcher.push({
        type: 'session_error',
        user_id: this.#userId,
        session_id: this.#sessionId,
        variant_id: this.#variantId,
        timestamp: nowIso(),
        metadata: this.#buildErrorMetadata(this.#baseMeta(getCurrentPagePath()), {
          message: msg,
          source: 'unhandledrejection',
          errorName: errObj?.name,
          stack: errObj?.stack,
        }),
      });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    this.#cleanups.push(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    });
  }

  fireGoal(goalId: string, ga4EventName?: string): void {
    if (!this.#canTrack()) return;
    this.#batcher.push({
      type: 'session_goal_fired',
      user_id: this.#userId,
      session_id: this.#sessionId,
      variant_id: this.#variantId,
      timestamp: nowIso(),
      metadata: {
        ...this.#baseMeta(getCurrentPagePath()),
        goal_id: goalId,
        ga4_event_name: ga4EventName,
      },
    });
  }
}
