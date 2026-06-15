import { EventBatcher } from './batcher';
import {
  captureClickBaseline,
  DEAD_CLICK_VERIFY_MS,
  hadMeaningfulResponse,
  looksClickable,
  type ClickOutcomeBaseline,
} from './click-interactivity';
import { HeatmapClickEvent, HeatmapScrollEvent, HeatmapAttentionEvent, HeatmapUrlRule } from './types';

interface ClickRecord {
  x: number;
  y: number;
  t: number;
}

interface PendingDeadCheck {
  timeoutId: ReturnType<typeof setTimeout>;
  baseline: ClickOutcomeBaseline;
  target: Element;
  evt: HeatmapClickEvent;
}

interface CompiledUrlRule {
  match_type: string;
  value: string;
  regex?: RegExp;
}

const RAGE_RADIUS = 30;
const RAGE_COUNT = 3;
const RAGE_WINDOW = 1000;
const SCROLL_THROTTLE = 200;

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

function deviceType(): string {
  const ua = navigator.userAgent;
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobi|Android/i.test(ua)) return 'mobile';
  return 'desktop';
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

const ATTENTION_BUCKETS = 20;
const ATTENTION_POLL_MS = 250;

export class HeatmapTracker {
  #batcher: EventBatcher;
  #userId: string;
  #sessionId?: string;
  #ringBuffer: ClickRecord[] = [];
  #maxScroll = 0;
  #scrollSent = false;
  #cleanups: (() => void)[] = [];
  #variantId?: string;
  #consent: () => boolean;
  #currentPageUrl: string;
  #compiledRuleSets: CompiledUrlRule[][];
  #tracking = false;
  #trackAllPages: boolean;
  #samplingRate: number;
  #attentionBuckets: number[] = new Array(ATTENTION_BUCKETS).fill(0);
  #attentionTimer: ReturnType<typeof setInterval> | null = null;
  #attentionSent = false;
  #pendingDeadChecks = new Set<PendingDeadCheck>();

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string | undefined,
    consentCheck: () => boolean,
    urlRuleSets: Array<Array<HeatmapUrlRule>>,
    trackAllPages = false,
    samplingRate = 1.0,
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#consent = consentCheck;
    this.#currentPageUrl = window.location.href;
    this.#trackAllPages = trackAllPages;
    this.#samplingRate = samplingRate;

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
    this.#attachClickListener();
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

  #push(e: HeatmapClickEvent | HeatmapScrollEvent): void {
    if (!this.#consent()) return;
    if (Math.random() > this.#samplingRate) return;
    this.#batcher.push(e);
  }

  #finalizeDeadCheck(pending: PendingDeadCheck): void {
    this.#pendingDeadChecks.delete(pending);
    const responded = hadMeaningfulResponse(pending.baseline, pending.target);
    const isDeadClick = !responded;
    const md = pending.evt.metadata as Record<string, unknown>;
    md.is_dead_click = isDeadClick;
    md.is_interactive = !isDeadClick;
    this.#push(pending.evt);
  }

  #cancelPendingDeadChecks(): void {
    for (const pending of this.#pendingDeadChecks) {
      clearTimeout(pending.timeoutId);
    }
    this.#pendingDeadChecks.clear();
  }

  #flushPendingDeadChecks(): void {
    const pending = [...this.#pendingDeadChecks];
    for (const check of pending) {
      clearTimeout(check.timeoutId);
      this.#finalizeDeadCheck(check);
    }
  }

  #scheduleDeadClickCheck(target: Element, evt: HeatmapClickEvent): void {
    const baseline = captureClickBaseline(target);
    const pending: PendingDeadCheck = {
      timeoutId: 0 as unknown as ReturnType<typeof setTimeout>,
      baseline,
      target,
      evt,
    };

    pending.timeoutId = setTimeout(() => {
      if (!this.#pendingDeadChecks.has(pending)) return;
      this.#finalizeDeadCheck(pending);
    }, DEAD_CLICK_VERIFY_MS);

    this.#pendingDeadChecks.add(pending);
  }

  #attachClickListener(): void {
    const handler = (e: MouseEvent) => {
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
      const clickable = looksClickable(target);

      this.#ringBuffer.push({ x: e.clientX, y: e.clientY, t: now });
      if (this.#ringBuffer.length > 10) this.#ringBuffer.shift();

      let rageClick = false;
      if (this.#ringBuffer.length >= RAGE_COUNT) {
        const recent = this.#ringBuffer.filter(r => now - r.t <= RAGE_WINDOW);
        if (recent.length >= RAGE_COUNT) {
          const last = recent[recent.length - 1];
          const nearby = recent.filter(r =>
            Math.abs(r.x - last.x) <= RAGE_RADIUS && Math.abs(r.y - last.y) <= RAGE_RADIUS
          );
          if (nearby.length >= RAGE_COUNT) rageClick = true;
        }
      }

      const clickTimestamp = new Date(now).toISOString();
      const evt: HeatmapClickEvent = {
        type: 'heatmap_click',
        variant_id: this.#variantId || '',
        user_id: this.#userId,
        session_id: this.#sessionId,
        timestamp: clickTimestamp,
        metadata: {
          page_url: this.#currentPageUrl,
          x,
          y,
          viewport_width: vw,
          viewport_height: vh,
          element_selector: getSelector(target),
          element_tag: target.tagName.toLowerCase(),
          is_interactive: false,
          is_rage_click: rageClick,
          is_dead_click: false,
          device_type: deviceType(),
        },
      };

      if (!clickable) {
        this.#push(evt);
        return;
      }

      (evt.metadata as Record<string, unknown>).is_interactive = true;
      this.#scheduleDeadClickCheck(target, evt);
    };

    document.addEventListener('click', handler, { passive: true, capture: true });
    this.#cleanups.push(() => document.removeEventListener('click', handler, true));
  }

  #attachScrollListener(): void {
    let ticking = false;
    let lastUpdate = 0;

    const update = () => {
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
          setTimeout(() => { ticking = false; update(); }, SCROLL_THROTTLE);
        }
        return;
      }
      lastUpdate = now;
      update();
    };

    window.addEventListener('scroll', handler, { passive: true });
    this.#cleanups.push(() => window.removeEventListener('scroll', handler));
    update();
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
      timestamp: new Date().toISOString(),
      metadata: {
        page_url: this.#currentPageUrl,
        max_scroll_percent: this.#maxScroll,
        viewport_height: window.innerHeight,
        page_height: pageHeight,
        device_type: deviceType(),
      },
    };

    this.#push(evt);
  }

  #attachAttentionTracker(): void {
    if (!this.#tracking) return;
    const tick = () => {
      if (!this.#tracking || !this.#consent()) return;
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
          this.#attentionBuckets[i] += ATTENTION_POLL_MS / 1000;
        }
      }
    };
    this.#attentionTimer = setInterval(tick, ATTENTION_POLL_MS);
    this.#cleanups.push(() => {
      if (this.#attentionTimer !== null) {
        clearInterval(this.#attentionTimer);
        this.#attentionTimer = null;
      }
    });
  }

  #sendAttentionEvent(): void {
    if (!this.#tracking || this.#attentionSent) return;
    if (!this.#consent()) return;
    const totalDwell = this.#attentionBuckets.reduce((a, b) => a + b, 0);
    if (totalDwell <= 0) return;
    this.#attentionSent = true;
    const evt: HeatmapAttentionEvent = {
      type: 'heatmap_attention',
      variant_id: this.#variantId || '',
      user_id: this.#userId,
      session_id: this.#sessionId,
      timestamp: new Date().toISOString(),
      metadata: {
        page_url: this.#currentPageUrl,
        bucket_dwell_seconds: [...this.#attentionBuckets],
        device_type: (() => {
          const ua = navigator.userAgent;
          if (/Tablet|iPad/i.test(ua)) return 'tablet';
          if (/Mobi|Android/i.test(ua)) return 'mobile';
          return 'desktop';
        })(),
      },
    };
    if (Math.random() <= this.#samplingRate) {
      this.#batcher.push(evt);
    }
  }

  #attachUnloadListener(): void {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        this.#flushPendingDeadChecks();
        this.#sendScrollEvent();
        this.#sendAttentionEvent();
      }
    };
    const onUnload = () => {
      this.#flushPendingDeadChecks();
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
    this.#cancelPendingDeadChecks();
    this.#sendScrollEvent();
    this.#sendAttentionEvent();
    this.#currentPageUrl = window.location.href;
    this.#maxScroll = 0;
    this.#scrollSent = false;
    this.#attentionBuckets = new Array(ATTENTION_BUCKETS).fill(0);
    this.#attentionSent = false;
    this.#ringBuffer = [];
    this.#tracking = this.#shouldTrack();
    if (this.#attentionTimer !== null) {
      clearInterval(this.#attentionTimer);
      this.#attentionTimer = null;
    }
    this.#attachAttentionTracker();
  }

  destroy(): void {
    this.#cancelPendingDeadChecks();
    this.#sendScrollEvent();
    this.#sendAttentionEvent();
    for (const fn of this.#cleanups) fn();
    this.#cleanups = [];
  }
}
