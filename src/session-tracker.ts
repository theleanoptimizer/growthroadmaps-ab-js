import { EventBatcher } from './batcher';
import type { SessionEvent } from './types';
import { registerClickHandler } from './click-delegate';
import { getDeviceType, getCurrentPagePath, nowIso, setCurrentPagePath } from './session-context';
import { getCookie, setCookie, isLikely404Page, DOWNLOAD_EXT_RE } from './visitor-identity';
export { isSensitiveElement, sanitizeVisibleText } from './element-privacy';

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
  return `_gr_ft_${projectKey || 'default'}`;
}

export function loadFirstTouchAttribution(projectKey: string): FirstTouchAttribution | null {
  try {
    const raw = getCookie(firstTouchStorageKey(projectKey));
    if (!raw) return null;
    return JSON.parse(raw) as FirstTouchAttribution;
  } catch {
    return null;
  }
}

export function saveFirstTouchAttribution(projectKey: string, attrs: FirstTouchAttribution): void {
  try {
    setCookie(firstTouchStorageKey(projectKey), JSON.stringify(attrs), 63072000);
  } catch { /* ignore */ }
}

export function getOrCaptureFirstTouch(projectKey: string): FirstTouchAttribution {
  const existing = loadFirstTouchAttribution(projectKey);
  if (existing) return existing;
  const captured = captureFirstTouchFromPage();
  saveFirstTouchAttribution(projectKey, captured);
  return captured;
}

const SPA_PAGE_VIEW_DEBOUNCE_MS = 100;
const SCROLL_MILESTONES = [25, 50, 75, 100] as const;

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
  #hiddenAt: number | null = null;
  #scrollMilestonesSent = new Set<number>();
  #performanceSent = false;
  #extraMeta?: () => Record<string, unknown>;

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string,
    consent: () => boolean,
    enabled: () => boolean,
    projectKey = '',
    extraMeta?: () => Record<string, unknown>,
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#projectKey = projectKey;
    this.#consent = consent;
    this.#enabled = enabled;
    this.#extraMeta = extraMeta;
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
    this.#bindScrollMilestones();
    this.#bindPerformance();
    this.#bindCodelessGoals();
    if (isLikely404Page()) this.#emitNotFound();
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
      ...(this.#extraMeta?.() || {}),
      page_url: pageUrl,
      device_type: getDeviceType(),
    };
  }

  #pushSessionEvent(event: {
    type: SessionEvent['type'];
    metadata: Record<string, unknown>;
  }): void {
    this.#batcher.push({
      type: event.type,
      user_id: this.#userId,
      session_id: this.#sessionId,
      variant_id: this.#variantId,
      timestamp: nowIso(),
      metadata: event.metadata,
    });
  }

  #emitNotFound(): void {
    if (!this.#canTrack()) return;
    this.#pushSessionEvent({
      type: 'session_not_found',
      metadata: {
        ...this.#baseMeta(getCurrentPagePath()),
        page_title: document.title?.slice(0, 200),
      },
    });
  }

  #bindCodelessGoals(): void {
    const onClick = (e: MouseEvent) => {
      if (!this.#canTrack()) return;
      const anchor = (e.target as Element | null)?.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (anchor.hasAttribute('download') || DOWNLOAD_EXT_RE.test(href)) {
        this.#pushSessionEvent({
          type: 'session_file_download',
          metadata: {
            ...this.#baseMeta(getCurrentPagePath()),
            download_href: href.slice(0, 500),
          },
        });
      }
    };
    document.addEventListener('click', onClick, true);
    this.#cleanups.push(() => document.removeEventListener('click', onClick, true));
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
    this.#scrollMilestonesSent.clear();
    this.#performanceSent = false;
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
      const pageUrl = getCurrentPagePath();
      if (document.hidden) {
        this.#hiddenAt = Date.now();
        this.#batcher.push({
          type: 'session_visibility',
          user_id: this.#userId,
          session_id: this.#sessionId,
          variant_id: this.#variantId,
          timestamp: nowIso(),
          metadata: {
            ...this.#baseMeta(pageUrl),
            hidden: true,
          },
        });
        return;
      }
      if (this.#hiddenAt != null) {
        const awayDuration = Date.now() - this.#hiddenAt;
        this.#hiddenAt = null;
        if (awayDuration > 0) {
          this.#batcher.push({
            type: 'session_visibility_return',
            user_id: this.#userId,
            session_id: this.#sessionId,
            variant_id: this.#variantId,
            timestamp: nowIso(),
            metadata: {
              ...this.#baseMeta(pageUrl),
              away_duration_ms: awayDuration,
            },
          });
        }
      }
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
        const pageUrl = getCurrentPagePath();
        if (dest.origin !== window.location.origin) {
          this.#batcher.push({
            type: 'session_navigation',
            user_id: this.#userId,
            session_id: this.#sessionId,
            variant_id: this.#variantId,
            timestamp: nowIso(),
            metadata: {
              ...this.#baseMeta(pageUrl),
              navigation_kind: 'external',
            },
          });
        } else {
          this.#batcher.push({
            type: 'session_internal_nav',
            user_id: this.#userId,
            session_id: this.#sessionId,
            variant_id: this.#variantId,
            timestamp: nowIso(),
            metadata: {
              ...this.#baseMeta(pageUrl),
              destination_path: dest.pathname + dest.search,
            },
          });
        }
      } catch { /* ignore */ }
    };
    const unregister = registerClickHandler(onClick);
    this.#cleanups.push(unregister);
  }

  #bindScrollMilestones(): void {
    const checkScroll = () => {
      if (!this.#canTrack()) return;
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const viewportHeight = window.innerHeight;
      const pageHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        viewportHeight,
      );
      if (pageHeight <= viewportHeight) return;
      const percent = Math.min(100, Math.round(((scrollTop + viewportHeight) / pageHeight) * 100));
      const pageUrl = getCurrentPagePath();
      for (const milestone of SCROLL_MILESTONES) {
        if (percent >= milestone && !this.#scrollMilestonesSent.has(milestone)) {
          this.#scrollMilestonesSent.add(milestone);
          this.#batcher.push({
            type: 'session_scroll_milestone',
            user_id: this.#userId,
            session_id: this.#sessionId,
            variant_id: this.#variantId,
            timestamp: nowIso(),
            metadata: {
              ...this.#baseMeta(pageUrl),
              scroll_percent: milestone,
            },
          });
        }
      }
    };
    window.addEventListener('scroll', checkScroll, { passive: true });
    this.#cleanups.push(() => window.removeEventListener('scroll', checkScroll));
    checkScroll();
  }

  #bindPerformance(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const vitals: { lcp_ms?: number; cls?: number; inp_ms?: number; ttfb_ms?: number } = {};
    try {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav?.responseStart) vitals.ttfb_ms = Math.round(nav.responseStart);
    } catch { /* ignore */ }

    const maybeEmit = (force = false) => {
      if (!this.#canTrack() || this.#performanceSent) return;
      const hasPaintMetric =
        vitals.lcp_ms != null || vitals.cls != null || vitals.inp_ms != null;
      if (!force && !hasPaintMetric) return;
      if (
        vitals.lcp_ms == null &&
        vitals.cls == null &&
        vitals.inp_ms == null &&
        vitals.ttfb_ms == null
      ) {
        return;
      }
      this.#performanceSent = true;
      this.#batcher.push({
        type: 'session_performance',
        user_id: this.#userId,
        session_id: this.#sessionId,
        variant_id: this.#variantId,
        timestamp: nowIso(),
        metadata: {
          ...this.#baseMeta(getCurrentPagePath()),
          ...vitals,
        },
      });
    };

    try {
      const lcpObs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) vitals.lcp_ms = Math.round(last.startTime);
        maybeEmit();
      });
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
      this.#cleanups.push(() => lcpObs.disconnect());
    } catch { /* unsupported */ }

    try {
      let cls = 0;
      const clsObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput) {
            cls += (entry as PerformanceEntry & { value?: number }).value ?? 0;
          }
        }
        vitals.cls = Math.round(cls * 1000) / 1000;
        maybeEmit();
      });
      clsObs.observe({ type: 'layout-shift', buffered: true });
      this.#cleanups.push(() => clsObs.disconnect());
    } catch { /* unsupported */ }

    try {
      const inpObs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1] as PerformanceEntry & { duration?: number };
        if (last?.duration != null) vitals.inp_ms = Math.round(last.duration);
        maybeEmit();
      });
      inpObs.observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
      this.#cleanups.push(() => inpObs.disconnect());
    } catch { /* unsupported */ }

    setTimeout(() => maybeEmit(true), 8000);
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
