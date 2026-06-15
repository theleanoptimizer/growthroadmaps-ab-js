import { EventBatcher } from './batcher';

type NavigationType = 'initial' | 'spa' | 'back' | 'forward';

function pathOnly(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function deviceType(): string {
  const ua = navigator.userAgent;
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobi|Android/i.test(ua)) return 'mobile';
  return 'desktop';
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

export class SessionTracker {
  #batcher: EventBatcher;
  #userId: string;
  #sessionId: string;
  #consent: () => boolean;
  #enabled: () => boolean;
  #variantId?: string;
  #cleanups: (() => void)[] = [];
  #lastPageUrl = '';
  #lastPageEnter = Date.now();
  #originalPushState?: History['pushState'];
  #originalReplaceState?: History['replaceState'];

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string,
    consent: () => boolean,
    enabled: () => boolean,
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#consent = consent;
    this.#enabled = enabled;
  }

  setVariantId(id: string | undefined): void {
    this.#variantId = id;
  }

  start(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this.#emitPageView('initial');
    this.#patchHistory();
    this.#bindVisibility();
    this.#bindErrors();
    this.#bindNavigation();
  }

  destroy(): void {
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
      device_type: deviceType(),
    };
  }

  #emitPageView(navigationType: NavigationType): void {
    if (!this.#canTrack()) return;
    const pageUrl = pathOnly(window.location.href);
    const now = Date.now();
    const timeOnPrevious = this.#lastPageUrl ? now - this.#lastPageEnter : undefined;
    this.#batcher.push({
      type: 'session_page_view',
      user_id: this.#userId,
      session_id: this.#sessionId,
      variant_id: this.#variantId,
      timestamp: new Date().toISOString(),
      metadata: {
        ...this.#baseMeta(pageUrl),
        page_title: document.title?.slice(0, 200),
        navigation_type: navigationType,
        time_on_previous_page_ms: timeOnPrevious,
      },
    });
    this.#lastPageUrl = pageUrl;
    this.#lastPageEnter = now;
  }

  #patchHistory(): void {
    const self = this;
    this.#originalPushState = history.pushState.bind(history);
    this.#originalReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args: Parameters<History['pushState']>) {
      self.#originalPushState!(...args);
      self.#emitPageView('spa');
    };
    history.replaceState = function (...args: Parameters<History['replaceState']>) {
      self.#originalReplaceState!(...args);
      self.#emitPageView('spa');
    };

    const onPop = () => self.#emitPageView('back');
    window.addEventListener('popstate', onPop);
    this.#cleanups.push(() => window.removeEventListener('popstate', onPop));
  }

  #bindVisibility(): void {
    const onVis = () => {
      if (!this.#canTrack()) return;
      this.#batcher.push({
        type: 'session_visibility',
        user_id: this.#userId,
        session_id: this.#sessionId,
        variant_id: this.#variantId,
        timestamp: new Date().toISOString(),
        metadata: {
          ...this.#baseMeta(pathOnly(window.location.href)),
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
            timestamp: new Date().toISOString(),
            metadata: {
              ...this.#baseMeta(pathOnly(window.location.href)),
              navigation_kind: 'external',
            },
          });
        }
      } catch { /* ignore */ }
    };
    document.addEventListener('click', onClick, true);
    this.#cleanups.push(() => document.removeEventListener('click', onClick, true));
  }

  #bindErrors(): void {
    const onError = (ev: ErrorEvent) => {
      if (!this.#canTrack()) return;
      this.#batcher.push({
        type: 'session_error',
        user_id: this.#userId,
        session_id: this.#sessionId,
        variant_id: this.#variantId,
        timestamp: new Date().toISOString(),
        metadata: {
          ...this.#baseMeta(pathOnly(window.location.href)),
          message: (ev.message || 'Script error').slice(0, 200),
        },
      });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      if (!this.#canTrack()) return;
      const msg = ev.reason instanceof Error ? ev.reason.message : String(ev.reason);
      this.#batcher.push({
        type: 'session_error',
        user_id: this.#userId,
        session_id: this.#sessionId,
        variant_id: this.#variantId,
        timestamp: new Date().toISOString(),
        metadata: {
          ...this.#baseMeta(pathOnly(window.location.href)),
          message: msg.slice(0, 200),
        },
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
      timestamp: new Date().toISOString(),
      metadata: {
        ...this.#baseMeta(pathOnly(window.location.href)),
        goal_id: goalId,
        ga4_event_name: ga4EventName,
      },
    });
  }
}
