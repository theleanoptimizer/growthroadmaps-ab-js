import { EventBatcher } from './batcher';
import { HeatmapClickEvent, HeatmapScrollEvent, HeatmapUrlRule } from './types';

interface ClickRecord {
  x: number;
  y: number;
  t: number;
}

interface CompiledUrlRule {
  match_type: string;
  value: string;
  regex?: RegExp;
}

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch']);
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

function isInteractive(el: Element): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
  if (el.closest('a, button, [role="button"], input, select, textarea')) return true;
  return false;
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

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string | undefined,
    consentCheck: () => boolean,
    urlRuleSets: Array<Array<HeatmapUrlRule>>
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#consent = consentCheck;
    this.#currentPageUrl = window.location.href;

    this.#compiledRuleSets = urlRuleSets.map(ruleSet =>
      ruleSet.map(rule => {
        const compiled: CompiledUrlRule = { match_type: rule.match_type, value: rule.value };
        if (rule.match_type === 'regex') {
          try { compiled.regex = new RegExp(rule.value); } catch {}
        }
        return compiled;
      })
    );

    if (this.#compiledRuleSets.length === 0) return;

    this.#tracking = this.#shouldTrack();
    this.#attachClickListener();
    this.#attachScrollListener();
    this.#attachUnloadListener();
  }

  #shouldTrack(): boolean {
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
    this.#batcher.push(e);
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
      const interactive = isInteractive(target);
      const deadClick = !interactive;

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

      const evt: HeatmapClickEvent = {
        type: 'heatmap_click',
        variant_id: this.#variantId || '',
        user_id: this.#userId,
        session_id: this.#sessionId,
        timestamp: new Date().toISOString(),
        metadata: {
          page_url: this.#currentPageUrl,
          x,
          y,
          viewport_width: vw,
          viewport_height: vh,
          element_selector: getSelector(target),
          element_tag: target.tagName.toLowerCase(),
          is_interactive: interactive,
          is_rage_click: rageClick,
          is_dead_click: deadClick,
          device_type: deviceType(),
        },
      };

      this.#push(evt);
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

  #attachUnloadListener(): void {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') this.#sendScrollEvent();
    };
    const onUnload = () => this.#sendScrollEvent();

    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('beforeunload', onUnload);
    this.#cleanups.push(() => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('beforeunload', onUnload);
    });
  }

  pageChanged(): void {
    this.#sendScrollEvent();
    this.#currentPageUrl = window.location.href;
    this.#maxScroll = 0;
    this.#scrollSent = false;
    this.#ringBuffer = [];
    this.#tracking = this.#shouldTrack();
  }

  destroy(): void {
    this.#sendScrollEvent();
    for (const fn of this.#cleanups) fn();
    this.#cleanups = [];
  }
}
