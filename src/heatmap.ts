import { EventBatcher } from './batcher';
import { registerClickHandler } from './click-delegate';
import { looksClickable } from './click-interactivity';
import { ClickProximityTracker } from './click-proximity';
import { getDeviceType, getCurrentPagePath, nowIso, setCurrentPagePath } from './session-context';
import { HeatmapClickEvent, HeatmapScrollEvent, HeatmapAttentionEvent, HeatmapUrlRule } from './types';

interface CompiledUrlRule {
  match_type: string;
  value: string;
  regex?: RegExp;
}

const SCROLL_THROTTLE = 200;
const ATTENTION_BUCKETS = 20;
const ATTENTION_FALLBACK_MS = 1000;
const CLICK_COALESCE_MS = 200;
const CLICK_COALESCE_GRID = 25;

function getSelector(el: Element): string {
  if (el.id) return '#' + el.id;
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).slice(0, 3).join('.');
  const parent = el.parentElement;
  if (!parent) return cls ? `${tag}.${cls}` : tag;
  const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
  const idx = siblings.length > 1 ? `:nth-child(${Array.from(parent.children).indexOf(el) + 1})` : '';
  return cls ? `${tag}.${cls}${idx}` : `${tag}${idx}`;
}

function urlMatch(url: string, type: string, val: string, compiledRegex?: RegExp): boolean {
  switch (type) {
    case 'exact': case 'equals': return url === val;
    case 'contains': return url.includes(val);
    case 'starts_with': return url.startsWith(val);
    case 'regex':
      if (compiledRegex) return compiledRegex.test(url);
      try { return new RegExp(val).test(url); } catch { return false; }
    default: return url.includes(val);
  }
}

export class HeatmapTracker {
  #batcher: EventBatcher;
  #userId: string;
  #sessionId?: string;
  #proximity = new ClickProximityTracker();
  #maxScroll = 0;
  #scrollSent = false;
  #cleanups: (() => void)[] = [];
  #variantId?: string;
  #consent: () => boolean;
  #currentPageUrl: string;
  #compiledRuleSets: CompiledUrlRule[][];
  #tracking = false;
  #trackAllPages: boolean;
  #sessionSampled: boolean;
  #attentionBuckets: number[] = new Array(ATTENTION_BUCKETS).fill(0);
  #attentionTimer: ReturnType<typeof setInterval> | null = null;
  #attentionSent = false;
  #lastAttentionTick = Date.now();
  #unregisterClick?: () => void;
  #clickCoalesceMap = new Map<string, number>();
  #extraMeta?: () => Record<string, unknown>;

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string | undefined,
    consentCheck: () => boolean,
    urlRuleSets: Array<Array<HeatmapUrlRule>>,
    trackAllPages = false,
    _samplingRate = 1.0,
    sessionSampled = true,
    extraMeta?: () => Record<string, unknown>,
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#consent = consentCheck;
    this.#currentPageUrl = window.location.href;
    this.#trackAllPages = trackAllPages;
    this.#sessionSampled = sessionSampled;
    this.#extraMeta = extraMeta;

    this.#compiledRuleSets = urlRuleSets.map(ruleSet =>
      ruleSet.map(rule => {
        const compiled: CompiledUrlRule = { match_type: rule.match_type, value: rule.value };
        if (rule.match_type === 'regex') {
          try { compiled.regex = new RegExp(rule.value); } catch {}
        }
        return compiled;
      })
    );

    if (this.#compiledRuleSets.length === 0 && !this.#trackAllPages) return;

    this.#tracking = this.#shouldTrack();
    this.#registerClickHandler();
    this.#attachScrollListener();
    this.#attachAttentionTracker();
    this.#attachUnloadListener();
  }

  #shouldTrack(): boolean {
    if (this.#trackAllPages) return true;
    if (this.#compiledRuleSets.length === 0) return false;
    const url = this.#currentPageUrl;
    for (const ruleSet of this.#compiledRuleSets) {
      for (const rule of ruleSet) {
        if (urlMatch(url, rule.match_type, rule.value, rule.regex)) return true;
      }
    }
    return false;
  }

  setVariantId(vid: string): void {
    this.#variantId = vid;
  }

  setSessionSampled(sampled: boolean): void {
    this.#sessionSampled = sampled;
  }

  #push(e: HeatmapClickEvent | HeatmapScrollEvent): void {
    if (!this.#consent()) return;
    if (!this.#sessionSampled) return;
    const extra = this.#extraMeta?.() || {};
    e.metadata = { ...extra, ...(e.metadata || {}) };
    this.#batcher.push(e);
  }

  #handleClick(e: MouseEvent): void {
    if (!this.#tracking) return;

    const target = e.target;
    if (!(target instanceof Element)) return;

    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, vh);
    const x = (scrollLeft + e.clientX) / Math.max(document.documentElement.scrollWidth, 1);
    const y = (scrollTop + e.clientY) / pageHeight;
    const now = Date.now();
    const { isDeadClick, isRageClick } = this.#proximity.record(e.clientX, e.clientY, now);
    const interactive = looksClickable(target);

    if (!isRageClick && !isDeadClick) {
      const gx = Math.floor(x * CLICK_COALESCE_GRID);
      const gy = Math.floor(y * CLICK_COALESCE_GRID);
      const key = `${gx},${gy}`;
      const last = this.#clickCoalesceMap.get(key);
      if (last != null && now - last < CLICK_COALESCE_MS) return;
      this.#clickCoalesceMap.set(key, now);
    }

    const evt: HeatmapClickEvent = {
      type: 'heatmap_click',
      variant_id: this.#variantId || '',
      user_id: this.#userId,
      session_id: this.#sessionId,
      timestamp: new Date(now).toISOString(),
      metadata: {
        page_url: this.#currentPageUrl,
        x,
        y,
        viewport_width: vw,
        viewport_height: vh,
        element_selector: getSelector(target),
        element_tag: target.tagName.toLowerCase(),
        is_interactive: interactive,
        is_rage_click: isRageClick,
        is_dead_click: isDeadClick,
        device_type: getDeviceType(),
      },
    };

    this.#push(evt);
  }

  #registerClickHandler(): void {
    if (!this.#tracking) return;
    const handler = (e: MouseEvent) => this.#handleClick(e);
    this.#unregisterClick = registerClickHandler(handler);
    this.#cleanups.push(() => {
      this.#unregisterClick?.();
      this.#unregisterClick = undefined;
    });
  }

  #attachScrollListener(): void {
    let ticking = false;
    let lastUpdate = 0;

    const updateScroll = () => {
      if (!this.#tracking) return;
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const viewportHeight = window.innerHeight;
      const pageHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
      if (pageHeight <= viewportHeight) {
        this.#maxScroll = 100;
        return;
      }
      const percent = Math.min(100, Math.round(((scrollTop + viewportHeight) / pageHeight) * 100));
      if (percent > this.#maxScroll) this.#maxScroll = percent;
    };

    const handler = () => {
      if (!this.#tracking) return;
      const now = Date.now();
      if (now - lastUpdate < SCROLL_THROTTLE) {
        if (!ticking) {
          ticking = true;
          setTimeout(() => {
            ticking = false;
            updateScroll();
            this.#tickAttention(now);
          }, SCROLL_THROTTLE);
        }
        return;
      }
      lastUpdate = now;
      updateScroll();
      this.#tickAttention(now);
    };

    window.addEventListener('scroll', handler, { passive: true });
    this.#cleanups.push(() => window.removeEventListener('scroll', handler));
    updateScroll();
  }

  #tickAttention(now = Date.now()): void {
    if (!this.#tracking || !this.#consent() || document.hidden) return;
    const elapsed = (now - this.#lastAttentionTick) / 1000;
    if (elapsed <= 0) return;
    this.#lastAttentionTick = now;

    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const viewportHeight = window.innerHeight;
    const pageHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      viewportHeight
    );
    if (pageHeight <= 0) return;
    const vpTop = scrollTop / pageHeight;
    const vpBottom = (scrollTop + viewportHeight) / pageHeight;
    const bucketSize = 1 / ATTENTION_BUCKETS;
    for (let i = 0; i < ATTENTION_BUCKETS; i++) {
      const bTop = i * bucketSize;
      const bBottom = (i + 1) * bucketSize;
      const overlap = Math.max(0, Math.min(vpBottom, bBottom) - Math.max(vpTop, bTop));
      if (overlap > 0) {
        this.#attentionBuckets[i] += elapsed;
      }
    }
  }

  #sendScrollEvent(): void {
    if (!this.#tracking || this.#scrollSent || this.#maxScroll <= 0) return;
    this.#scrollSent = true;

    const pageHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );

    const evt: HeatmapScrollEvent = {
      type: 'heatmap_scroll',
      variant_id: this.#variantId || '',
      user_id: this.#userId,
      session_id: this.#sessionId,
      timestamp: nowIso(),
      metadata: {
        page_url: this.#currentPageUrl,
        max_scroll_percent: this.#maxScroll,
        viewport_height: window.innerHeight,
        page_height: pageHeight,
        device_type: getDeviceType(),
      },
    };

    this.#push(evt);
  }

  #startAttentionTimers(): void {
    if (!this.#tracking || this.#attentionTimer !== null) return;
    this.#lastAttentionTick = Date.now();
    this.#attentionTimer = setInterval(() => {
      if (!document.hidden) this.#tickAttention();
    }, ATTENTION_FALLBACK_MS);
  }

  #stopAttentionTimers(): void {
    if (this.#attentionTimer !== null) {
      clearInterval(this.#attentionTimer);
      this.#attentionTimer = null;
    }
  }

  #attachAttentionTracker(): void {
    if (!this.#tracking) return;
    this.#startAttentionTimers();

    const onVisibility = () => {
      if (document.hidden) {
        this.#tickAttention();
        this.#stopAttentionTimers();
      } else {
        this.#lastAttentionTick = Date.now();
        this.#startAttentionTimers();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.#cleanups.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      this.#stopAttentionTimers();
    });
  }

  #sendAttentionEvent(): void {
    if (!this.#tracking || this.#attentionSent) return;
    if (!this.#consent()) return;
    this.#tickAttention();
    const totalDwell = this.#attentionBuckets.reduce((a, b) => a + b, 0);
    if (totalDwell <= 0) return;
    this.#attentionSent = true;
    const evt: HeatmapAttentionEvent = {
      type: 'heatmap_attention',
      variant_id: this.#variantId || '',
      user_id: this.#userId,
      session_id: this.#sessionId,
      timestamp: nowIso(),
      metadata: {
        page_url: this.#currentPageUrl,
        bucket_dwell_seconds: [...this.#attentionBuckets],
        device_type: getDeviceType(),
      },
    };
    if (this.#sessionSampled) {
      this.#batcher.push(evt);
    }
  }

  #attachUnloadListener(): void {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        this.#sendScrollEvent();
        this.#sendAttentionEvent();
      }
    };
    const onUnload = () => {
      this.#sendScrollEvent();
      this.#sendAttentionEvent();
    };

    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onUnload);
    this.#cleanups.push(() => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onUnload);
    });
  }

  pageChanged(): void {
    this.#sendScrollEvent();
    this.#sendAttentionEvent();
    this.#currentPageUrl = window.location.href;
    setCurrentPagePath(this.#currentPageUrl);
    this.#maxScroll = 0;
    this.#scrollSent = false;
    this.#attentionBuckets = new Array(ATTENTION_BUCKETS).fill(0);
    this.#attentionSent = false;
    this.#proximity.reset();
    this.#lastAttentionTick = Date.now();
    this.#tracking = this.#shouldTrack();
    if (!this.#tracking) {
      this.#stopAttentionTimers();
    } else if (this.#attentionTimer === null && !document.hidden) {
      this.#startAttentionTimers();
    }
  }

  destroy(): void {
    this.#sendScrollEvent();
    this.#sendAttentionEvent();
    for (const fn of this.#cleanups) fn();
    this.#cleanups = [];
  }
}
