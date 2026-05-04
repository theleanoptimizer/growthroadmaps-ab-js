import {
  GrowthConfig,
  ExperimentConfig,
  ProjectInfo,
  TrackOptions,
  Variant,
  UrlRule,
  Goal,
  TargetingRule,
  ABEvent,
  AudienceAttributeConfig,
  GrowthCommand,
} from './types';
import { assignVariant, fnv1a } from './hasher';
import { getCachedConfig, setCachedConfig, isCacheFresh } from './storage';
import { EventBatcher } from './batcher';
import { getAntiFlickerSnippet, revealPage } from './anti-flicker';
import type { HeatmapTracker } from './heatmap';
import type { FormTracker } from './form-tracker';
import { renderPreviewPanel, getStoredSelections, applyPanelVariant } from './preview-panel';
import { initReviewMode } from './review-panel';
import type { SurveyManager } from './survey';
import type { SurveyData } from './types';

interface LazyModule<T> {
  __lazyLoad?: () => Promise<T>;
}

type HeatmapModule = { HeatmapTracker: typeof HeatmapTracker };
type FormTrackerModule = { FormTracker: typeof FormTracker };
type SurveyModule = { SurveyManager: typeof SurveyManager };

interface GrowthWindow extends Window {
  dataLayer: Record<string, unknown>[];
}

const W = typeof window !== 'undefined' ? window as unknown as GrowthWindow : undefined;
const D = typeof document !== 'undefined' ? document : undefined;
const N = typeof navigator !== 'undefined' ? navigator : undefined;

function ensureDataLayer(): void {
  if (!W) return;
  W.dataLayer = W.dataLayer || [];
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function gc(n: string): string | null {
  if (!D) return null;
  const m = D.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function sc(id: string): void {
  if (D) D.cookie = `_ab_vid=${encodeURIComponent(id)};path=/;max-age=31536000;SameSite=Lax`;
}

function syncExpCookie(assignments: Map<string, Variant>, experiments: ExperimentConfig[]): void {
  if (!D) return;
  const labels: string[] = [];
  for (const [eid, v] of assignments) {
    const e = experiments.find(x => x.id === eid);
    if (e && e.sequence_number != null && v.index != null) {
      labels.push(`EXP-${e.sequence_number}-${v.index}`);
    }
  }
  D.cookie = `_ab_exp=${encodeURIComponent(labels.join(','))};path=/;max-age=31536000;SameSite=Lax`;
}

function vid(skipCookie?: boolean): string {
  if (!skipCookie) {
    const v = gc('_ab_vid');
    if (v) return v;
  }
  const id = uuid();
  if (!skipCookie) sc(id);
  return id;
}

interface SavedAssignment { variantId: string; css?: string; external_css?: string[]; external_js?: string[]; exposedAt?: number }

function saveAssignments(pk: string, assignments: Map<string, Variant>, experiments: ExperimentConfig[], exposedAt?: Map<string, number>): void {
  try {
    const out: Record<string, SavedAssignment> = {};
    for (const [eid, v] of assignments) {
      const e = experiments.find(x => x.id === eid);
      if (e && e.status === 'running') {
        const entry: SavedAssignment = { variantId: v.id };
        if (e.mode === 'client') {
          if (v.css) entry.css = v.css;
          if (v.external_css) entry.external_css = v.external_css;
          if (v.external_js) entry.external_js = v.external_js;
        }
        const ts = exposedAt?.get(eid);
        if (ts) entry.exposedAt = ts;
        out[eid] = entry;
      }
    }
    localStorage.setItem('ab_va_' + pk, JSON.stringify(out));
  } catch {}
  try { syncExpCookie(assignments, experiments); } catch {}
}

function loadAssignments(pk: string, experiments: ExperimentConfig[], exposedAtOut?: Map<string, number>): Map<string, Variant> {
  const map = new Map<string, Variant>();
  try {
    const raw = localStorage.getItem('ab_va_' + pk);
    if (!raw) return map;
    const saved: Record<string, SavedAssignment> = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return map;
    for (const eid in saved) {
      const entry = saved[eid];
      if (!entry || !entry.variantId) continue;
      const e = experiments.find(x => x.id === eid && x.status === 'running');
      if (!e || !e.variants?.length) continue;
      const v = e.variants.find(x => x.id === entry.variantId);
      if (v) {
        map.set(eid, v);
        if (exposedAtOut && entry.exposedAt) exposedAtOut.set(eid, entry.exposedAt);
      }
    }
  } catch {}
  return map;
}

export { getAntiFlickerSnippet } from './anti-flicker';
export type { GrowthConfig, ExperimentConfig, Variant, TrackOptions } from './types';

function urlMatch(url: string, type: string, val: string): boolean {
  switch (type) {
    case 'exact': case 'equals': return url === val;
    case 'contains': return url.includes(val);
    case 'starts_with': return url.startsWith(val);
    case 'ends_with': return url.endsWith(val);
    case 'wildcard': try { const p = val.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'); return new RegExp('^' + p + '$').test(url); } catch { return false; }
    case 'matches': try { const path = new URL(url).pathname; return path === val || path === val.replace(/\/$/, '') || path.replace(/\/$/, '') === val; } catch { return false; }
    case 'regex': try { return new RegExp(val).test(url); } catch { return false; }
    default: return url.includes(val);
  }
}

function passesRules(rules: UrlRule[] | undefined): boolean {
  if (!rules?.length || !W) return true;
  const url = W.location.href;
  for (const r of rules) if (r.action === 'exclude' && urlMatch(url, r.match_type, r.value)) return false;
  const inc = rules.filter(r => r.action !== 'exclude');
  return !inc.length || inc.some(r => urlMatch(url, r.match_type, r.value));
}

function devType(): string {
  if (!N) return 'desktop';
  const u = N.userAgent;
  return /Tablet|iPad/i.test(u) ? 'tablet' : /Mobi|Android/i.test(u) ? 'mobile' : 'desktop';
}

function uam(pats: [RegExp, string][]): string {
  if (!N) return '';
  for (const [r, n] of pats) if (r.test(N.userAgent)) return n;
  return '';
}

const BR: [RegExp, string][] = [[/Edg\//i, 'Edge'], [/Chrome/i, 'Chrome'], [/Firefox/i, 'Firefox'], [/Safari/i, 'Safari'], [/Opera|OPR/i, 'Opera']];
const OL: [RegExp, string][] = [[/Windows/i, 'Windows'], [/Mac OS/i, 'macOS'], [/Android/i, 'Android'], [/iOS|iPhone|iPad/i, 'iOS'], [/Linux/i, 'Linux']];

function eop(op: string, a: string | null | undefined, b: string): boolean {
  switch (op) {
    case 'equals': return a === b;
    case 'not_equals': return a !== b;
    case 'contains': return typeof a === 'string' && a.includes(b);
    case 'not_contains': return typeof a !== 'string' || !a.includes(b);
    case 'regex': try { return typeof a === 'string' && new RegExp(b).test(a); } catch { return false; }
    case 'exists': return a != null && a !== '';
    case 'not_exists': return a == null || a === '';
    default: return true;
  }
}

function kvop(op: string, raw: string, get: (k: string) => string | null | undefined): boolean {
  const i = raw.indexOf('=');
  const k = i > -1 ? raw.slice(0, i) : raw;
  const v = get(k);
  if (op === 'exists' || op === 'not_exists') return eop(op, v, '');
  return i > -1 ? eop(op, v, raw.slice(i + 1)) : eop(op, v, raw);
}

function evalRule(r: TargetingRule, _k: string, a?: Record<string, string>): boolean {
  switch (r.attribute) {
    case 'device': return eop(r.operator, devType(), r.value);
    case 'browser': return eop(r.operator, uam(BR), r.value);
    case 'os': return eop(r.operator, uam(OL), r.value);
    case 'language': return eop(r.operator, N?.language || '', r.value);
    case 'country': return eop(r.operator, a?.['country'], r.value);
    case 'query_param': return kvop(r.operator, r.value, k => W ? new URLSearchParams(W.location.search).get(k) : null);
    case 'cookie': return kvop(r.operator, r.value, gc);
    case 'custom': return kvop(r.operator, r.value, k => a?.[k] ?? null);
    default: return true;
  }
}

function addCss(v: Variant, eid: string, m: Map<string, HTMLStyleElement>): void {
  if (!D) return;
  if (v.external_css && v.external_css.length) {
    for (var i = 0; i < v.external_css.length; i++) {
      var href = v.external_css[i];
      if (!D.querySelector('link[data-ab-ext-css="' + v.id + '"][href="' + href + '"]')) {
        var lk = D.createElement('link');
        lk.rel = 'stylesheet';
        lk.href = href;
        lk.setAttribute('data-ab-ext-css', v.id);
        D.head.appendChild(lk);
      }
    }
  }
  if (!v.css) return;
  const a = 'data-ab-css';
  if (D.querySelector(`style[${a}="${v.id}"]`)) return;
  const s = D.createElement('style');
  s.setAttribute(a, v.id);
  s.textContent = v.css;
  D.head.appendChild(s);
  m.set(eid, s);
}

function loadExternalJs(v: Variant): Promise<void> {
  if (!D || !v.external_js || !v.external_js.length) return Promise.resolve();
  var chain: Promise<void> = Promise.resolve();
  for (var i = 0; i < v.external_js.length; i++) {
    (function(src: string) {
      chain = chain.then(function() {
        var existing = D!.querySelector('script[data-ab-ext-js="' + v.id + '"][src="' + src + '"]') as HTMLScriptElement | null;
        if (existing) {
          if (existing.getAttribute('data-ab-loaded') === '1') return Promise.resolve();
          return new Promise<void>(function(resolve) {
            existing!.addEventListener('load', function() { resolve(); });
            existing!.addEventListener('error', function() { resolve(); });
            if (existing!.getAttribute('data-ab-loaded') === '1') resolve();
          });
        }
        return new Promise<void>(function(resolve) {
          var sc = D!.createElement('script');
          sc.src = src;
          sc.setAttribute('data-ab-ext-js', v.id);
          sc.onload = function() { sc.setAttribute('data-ab-loaded', '1'); resolve(); };
          sc.onerror = function() { sc.setAttribute('data-ab-loaded', '1'); resolve(); };
          D!.head.appendChild(sc);
        });
      });
    })(v.external_js[i]);
  }
  return chain;
}

function runJs(v: Variant): void {
  if (!v.js) return;
  try {
    var wrapped = '(function(){try{' + v.js + '\n}catch(e){console.error("[GR] JS error ' + v.name.replace(/["\\]/g, '') + ':",e)}})();';
    var sc = D!.createElement('script');
    sc.textContent = wrapped;
    D!.head.appendChild(sc);
  } catch (e) { console.error('[GR] JS error ' + v.name + ':', e); }
}

function goalKey(g: Goal): string { return g.goal_type + (g.value ? ':' + g.value : ''); }

function mkEvt(eid: string, vid: string, uid: string, sid?: string, extra?: Record<string, unknown>, attrs?: Record<string, string>): ABEvent {
  const extraMeta = extra?.metadata as Record<string, unknown> | undefined;
  const metadata: Record<string, unknown> = { ...(extraMeta || {}), device_type: devType() };
  if (attrs && Object.keys(attrs).length > 0) metadata.attributes = { ...attrs };
  return { type: 'exposure', experiment_id: eid, variant_id: vid, user_id: uid, session_id: sid, timestamp: new Date().toISOString(), metadata } as ABEvent;
}

function mkConv(eid: string, vid: string, uid: string, sid: string | undefined, gn: string, gv?: number, md?: Record<string, unknown>, attrs?: Record<string, string>): ABEvent {
  const metadata: Record<string, unknown> = { ...(md || {}), device_type: devType() };
  if (attrs && Object.keys(attrs).length > 0) metadata.attributes = { ...attrs };
  return { type: 'conversion', experiment_id: eid, variant_id: vid, user_id: uid, session_id: sid, goal_name: gn, goal_value: gv, metadata, timestamp: new Date().toISOString() } as ABEvent;
}

/**
 * Main SDK class for Growth Roadmaps A/B testing.
 *
 * ## Command queue (pre-load attribute pushes)
 *
 * If you need to set audience attributes before the SDK script finishes
 * loading (e.g. server-rendered user data), use the `window.abq` queue:
 *
 * ```html
 * <!-- Place this BEFORE the SDK <script> tag -->
 * <script>
 *   window.abq = window.abq || [];
 *   window.abq.push({ type: 'setAttribute', key: 'plan', value: 'pro' });
 *   window.abq.push({ type: 'setAttribute', key: 'logged_in', value: 'true' });
 * </script>
 * ```
 *
 * The constructor drains every queued command on init, then replaces
 * `window.abq` with a live proxy so subsequent `push()` calls take effect
 * immediately without needing a reference to the SDK instance.
 */
export class GrowthRoadmaps {
  #c: GrowthConfig;
  #e: ExperimentConfig[] = [];
  #p: ProjectInfo | null = null;
  #b: EventBatcher;
  #seen = new Set<string>();
  #exposedAt = new Map<string, number>();
  #a = new Map<string, Variant>();
  #ran = new Set<string>();
  #cl: (() => void)[] = [];
  #fg = new Set<string>();
  #origSubmit: (() => void) | null = null;
  #gf = new Set<string>();
  #pv = false;
  #pvExps: Array<{ id: string; name: string; variants: Variant[] }> = [];
  #lu: string = W ? W.location.href : '';
  #rc: (() => void) | null = null;
  #sm = new Map<string, HTMLStyleElement>();
  #consent: boolean;
  #consentRequired: boolean;
  #pendingEvents: ABEvent[] = [];
  #ht: HeatmapTracker | null = null;
  #ft: FormTracker | null = null;
  #hc: Array<{ capture_mode: string; url_rules: Array<{ match_type: string; value: string }> }> = [];
  #fac: Array<{ capture_mode: string; url_rules: Array<{ match_type: string; value: string }>; form_selectors?: string[] }> = [];
  #sv: SurveyManager | null = null;
  #surveyData: SurveyData[] = [];
  #debug = false;
  // Project-level audience attribute definitions (from /all-configs).
  #aud: AudienceAttributeConfig[] = [];
  // Detected attribute key -> value (in-memory + sessionStorage backed).
  // Forwarded on every subsequent event in metadata.attributes so results
  // can be filtered by audience slice. Reserved keys can never appear.
  #attrs: Record<string, string> = {};
  #audCl: (() => void)[] = [];
  // Tracks one-shot audience rules already fired so listeners don't re-set
  // the same attribute on every click/submit.
  #audFired = new Set<string>();

  constructor(c: GrowthConfig) {
    this.#consentRequired = c.cookieConsent === 'required';
    this.#consent = !this.#consentRequired;
    if (W) {
      const sp = new URLSearchParams(W.location.search);
      const dp = sp.get('_ab_debug');
      if (dp === 'true') { this.#debug = true; try { sessionStorage.setItem('_ab_debug', '1'); } catch {} }
      else if (dp === 'false') { this.#debug = false; try { sessionStorage.removeItem('_ab_debug'); } catch {} }
      else { try { if (sessionStorage.getItem('_ab_debug') === '1') this.#debug = true; } catch {} }
    }
    if (!c.userId && !c.sessionId && D) c.userId = vid(this.#consentRequired);
    if (!c.sessionId) {
      try {
        let sid = sessionStorage.getItem('_ab_sid');
        if (!sid) {
          sid = uuid();
          if (this.#consent) sessionStorage.setItem('_ab_sid', sid);
        }
        c.sessionId = sid;
      } catch {
        c.sessionId = uuid();
      }
    }
    if (W && W.__gr_loader_ran) {
      const cfg = W.__gr_loader_cfg;
      if (cfg) {
        if (!c.projectKey) c.projectKey = cfg.pk;
        if (!c.apiHost && cfg.host) c.apiHost = cfg.host;
      }
    }
    this.#c = c;
    this.#b = new EventBatcher(c.apiHost, c.projectKey || '', this.#debug);
    // Restore previously-detected audience attributes for this session so a
    // visitor who clicked "pricing" earlier still gets that attribute on the
    // exposure fired on the next page.
    try {
      const raw = sessionStorage.getItem('_ab_attrs_' + (c.projectKey || ''));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const k in parsed) {
            if (typeof parsed[k] === 'string' && /^[a-z0-9_]{1,64}$/.test(k) && !this.#isReservedAttr(k)) {
              this.#attrs[k] = parsed[k];
            }
          }
        }
      }
    } catch {}
    // Seed attributes from explicit SDK config — anything passed in
    // `customAttributes` should ride along on every event for audience
    // filtering. Apply the same key regex / reserved-key / length caps used
    // for runtime detection so we never leak garbage into event metadata.
    if (c.customAttributes && typeof c.customAttributes === 'object') {
      for (const k in c.customAttributes) {
        const v = (c.customAttributes as Record<string, unknown>)[k];
        if (v == null) continue;
        const sv = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
        if (sv === null) continue;
        if (!/^[a-z0-9_]{1,64}$/.test(k) || this.#isReservedAttr(k)) continue;
        this.#attrs[k] = sv.slice(0, 255);
      }
      this.#persistAttrs();
    }
    // Drain the pre-load command queue (window.abq) that may have been
    // populated by inline scripts running before this SDK bundle arrived.
    // Only 'setAttribute' commands are supported in this first pass; all
    // other command types are silently ignored.
    if (W && Array.isArray(W.abq)) {
      const queued = W.abq as GrowthCommand[];
      for (let i = 0; i < queued.length; i++) {
        const cmd = queued[i];
        if (cmd && cmd.type === 'setAttribute') {
          this.setAttribute(cmd.key, cmd.value);
        }
      }
    }
    // Replace the array with a live proxy so any subsequent push() calls
    // take effect immediately without needing a reference to the instance.
    if (W) {
      const self = this;
      W.abq = {
        push(cmd: GrowthCommand): void {
          if (cmd && cmd.type === 'setAttribute') {
            self.setAttribute(cmd.key, cmd.value);
          }
        },
      };
    }

    if (this.#debug) console.log('[GR Debug] SDK initialized', { projectKey: c.projectKey, apiHost: c.apiHost, userId: c.userId });
  }

  #isReservedAttr(key: string): boolean {
    return key === 'device_type' || key === 'traffic_excluded' || key === 'attributes';
  }

  #persistAttrs(): void {
    try {
      sessionStorage.setItem('_ab_attrs_' + this.#pk(), JSON.stringify(this.#attrs));
    } catch {}
  }

  // Public + internal entry point. Stores the value in metadata.attributes so
  // every subsequent event carries it for audience-based filtering. Reserved
  // keys are silently dropped to prevent collisions with built-in metadata.
  // Numbers and booleans are coerced to string (matching customAttributes
  // initialization), so callers can pass `setAttribute('plan', 1)` or
  // `setAttribute('paying', true)` without manual stringification.
  #applyAttribute(key: string, value: unknown): void {
    if (!key || !/^[a-z0-9_]{1,64}$/.test(key) || this.#isReservedAttr(key)) return;
    let stringValue: string;
    if (typeof value === 'string') {
      stringValue = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      stringValue = String(value);
    } else if (typeof value === 'boolean') {
      stringValue = value ? 'true' : 'false';
    } else {
      return;
    }
    const v = stringValue.slice(0, 255);
    if (this.#attrs[key] === v) return;
    this.#attrs[key] = v;
    this.#persistAttrs();
    this.#dbg('Audience attribute set:', key, '=', v);
  }

  #dbg(...args: unknown[]): void { if (this.#debug) console.log('[GR Debug]', ...args); }

  async #initHeatmap(urlRuleSets: Array<Array<{ match_type: string; value: string }>>, trackAllPages: boolean): Promise<void> {
    if (!D || (urlRuleSets.length === 0 && !trackAllPages)) return;
    const mod = await import('./heatmap') as HeatmapModule & LazyModule<HeatmapModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    this.#ht = new resolved.HeatmapTracker(this.#b, this.#c.userId || this.#c.sessionId || '', this.#c.sessionId, () => this.#consent, urlRuleSets, trackAllPages);
    // Backfill variant ID: getVariant() / #applyClientExperiments() may have run before
    // this async module finished loading, so this.#ht was null when setVariantId was called.
    if (this.#a.size > 0) {
      const lastVariant = [...this.#a.values()].pop();
      if (lastVariant) this.#ht.setVariantId(lastVariant.id);
    }
  }

  async #initFormTracker(formConfigs: Array<{ capture_mode: string; url_rules: Array<{ match_type: string; value: string }>; form_selectors?: string[] }>): Promise<void> {
    if (!D || formConfigs.length === 0) return;
    const mod = await import('./form-tracker') as FormTrackerModule & LazyModule<FormTrackerModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    this.#ft = new resolved.FormTracker(this.#b, this.#c.userId || this.#c.sessionId || '', this.#c.sessionId, () => this.#consent, formConfigs);
  }

  #pk(): string { return this.#c.projectKey || ''; }
  #uid(): string | undefined { return this.#c.userId || this.#c.sessionId; }
  #isPanelSession(): boolean { try { return !!sessionStorage.getItem('_ab_panel_key') && sessionStorage.getItem('_ab_panel_pk') === this.#pk(); } catch { return false; } }
  #getPanelKey(): string | null { try { return sessionStorage.getItem('_ab_panel_pk') === this.#pk() ? sessionStorage.getItem('_ab_panel_key') : null; } catch { return null; } }
  #clearPanelAssets(): void {
    if (!D) return;
    D.querySelectorAll('style[data-ab-css], style[data-ab-panel-css], link[data-ab-ext-css], link[data-ab-panel-css], script[data-ab-ext-js], script[data-ab-panel-js]').forEach(el => el.remove());
    this.#sm.clear();
  }

  #adoptLoaderStyles(): void {
    if (!D || !W?.__gr_loader_ran || this.#pv) return;
    const tags = D.querySelectorAll('style[data-ab-css]');
    tags.forEach(tag => {
      const vid = tag.getAttribute('data-ab-css');
      if (!vid) return;
      let matched = false;
      for (const e of this.#e) {
        if (e.status !== 'running' || e.mode !== 'client') continue;
        for (const v of e.variants) {
          if (v.id === vid) {
            this.#sm.set(e.id, tag as HTMLStyleElement);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) {
        tag.remove();
      }
    });
  }

  async init(): Promise<void> {
    try {
      if (W) {
        // Check for review mode first — takes priority over preview mode
        const reviewToken = new URLSearchParams(W.location.search).get('_ab_review');
        if (reviewToken) {
          await initReviewMode(this.#c.apiHost);
          revealPage();
          console.info('[GR] Review mode active — tracking disabled');
          return;
        }

        const sp = new URLSearchParams(W.location.search);
        const t = sp.get('_ab_preview');

        if (t === 'panel' || this.#isPanelSession()) {
          const panelKey = sp.get('key') || this.#getPanelKey();
          if (panelKey) {
            try {
              const pk = this.#pk();
              if (t === 'panel') {
                try { sessionStorage.setItem('_ab_panel_key', panelKey); sessionStorage.setItem('_ab_panel_pk', pk); } catch {}
              }
              const r = await fetch(this.#c.apiHost + '/api/ab/preview/panel?pk=' + encodeURIComponent(pk) + '&key=' + encodeURIComponent(panelKey));
              if (r.ok) {
                const panelConfig = await r.json();
                this.#pv = true;
                this.#pvExps = panelConfig.experiments.map((exp: { id: string; name: string; variants: Variant[] }) => ({ id: exp.id, name: exp.name, variants: exp.variants }));
                this.#clearPanelAssets();
                const selections = getStoredSelections();
                for (const exp of panelConfig.experiments) {
                  if (!passesRules(exp.url_rules)) continue;
                  if (exp.targeting_rules?.length && !exp.targeting_rules.every((tr: {id?:string;attribute:string;operator:string;value:string}) => evalRule(tr as TargetingRule, pk, this.#c.customAttributes))) continue;
                  const selectedId = selections[exp.id] || (exp.variants[0]?.id || '');
                  if (selectedId) {
                    applyPanelVariant(exp, selectedId);
                  }
                }
                revealPage();
                if (D && D.readyState === 'complete') {
                  renderPreviewPanel(panelConfig);
                } else if (W) {
                  W.addEventListener('load', () => renderPreviewPanel(panelConfig));
                }
                console.info('[GR] Preview panel mode active — tracking disabled');
                return;
              } else if (r.status === 403) {
                try { sessionStorage.removeItem('_ab_panel_key'); sessionStorage.removeItem('_ab_panel_pk'); } catch {}
              }
            } catch {}
          }
        }

        if (t && t !== 'panel') {
          try {
            const r = await fetch(this.#c.apiHost + '/api/ab/preview/' + encodeURIComponent(t));
            if (r.ok) {
              const d = await r.json();
              this.#pv = true;
              const fv = { id: d.variant_id, name: d.variant_name, weight: 100, css: d.css, js: d.js, external_js: d.external_js, external_css: d.external_css } as Variant;
              if (d.mode === 'client') { addCss(fv, '', this.#sm); loadExternalJs(fv).then(function() { runJs(fv); }); }
              console.info('[GR] Preview: ' + d.variant_name + ' (' + d.experiment_name + ')');
              return;
            }
          } catch {}
        }
      }
      const pk = this.#pk();
      const cc = getCachedConfig(pk);
      const useCached = cc && isCacheFresh(cc);
      if (useCached) { this.#e = cc.experiments; this.#p = cc.project || null; this.#hc = cc.heatmapConfigs || []; this.#fac = cc.formAnalyticsConfigs || []; this.#aud = cc.audiences || []; this.#surveyData = cc.surveys || []; }
      try {
        const storedEtag = (() => { try { return localStorage.getItem('_ab_cfg_etag_' + pk); } catch { return null; } })();
        const headers: Record<string, string> = {};
        if (storedEtag) headers['If-None-Match'] = storedEtag;
        const cdnUrl = 'https://js.growthroadmaps.com/configs/' + encodeURIComponent(pk) + '.json';
        const fallbackUrl = this.#c.apiHost + '/api/sdk/config/' + encodeURIComponent(pk) + '.json';
        let r: Response | null = null;
        try {
          const cdnR = await fetch(cdnUrl, { headers });
          if (cdnR.ok || cdnR.status === 304) { r = cdnR; } else { throw 0; }
        } catch {
          r = await fetch(fallbackUrl, { headers });
        }
        if (r.status === 304) {
          // Server confirms config is unchanged. If the local cache TTL had expired
          // (useCached === false), state was never hydrated above — do it now from the
          // stale cc since the server confirms it's still current. Refresh the timestamp
          // so it's treated as fresh for the next TTL period.
          if (!useCached && cc) {
            this.#e = cc.experiments; this.#p = cc.project || null;
            this.#hc = cc.heatmapConfigs || []; this.#fac = cc.formAnalyticsConfigs || [];
            this.#aud = cc.audiences || []; this.#surveyData = cc.surveys || [];
            setCachedConfig(pk, { ...cc, timestamp: Date.now() });
          }
        } else if (r.ok) {
          const etag = r.headers.get('etag');
          if (etag) { try { localStorage.setItem('_ab_cfg_etag_' + pk, etag); } catch {} }
          const d = await r.json();
          if (d.project) this.#p = d.project;
          if (!useCached) {
            if (d.experiments) this.#e = Object.values(d.experiments) as ExperimentConfig[];
            else this.#e = Array.isArray(d) ? d : Object.values(d);
          }
          if (d.heatmapConfigs) this.#hc = d.heatmapConfigs;
          if (d.formAnalyticsConfigs) this.#fac = d.formAnalyticsConfigs;
          if (Array.isArray(d.audiences)) this.#aud = d.audiences as AudienceAttributeConfig[];
          if (Array.isArray(d.surveys)) this.#surveyData = d.surveys;
          setCachedConfig(pk, { experiments: this.#e, project: this.#p || undefined, heatmapConfigs: this.#hc, formAnalyticsConfigs: this.#fac, audiences: this.#aud, surveys: this.#surveyData, timestamp: Date.now() });
        } else { throw 0; }
      } catch { if (!useCached) { this.#e = cc ? cc.experiments : []; this.#p = cc?.project || null; this.#hc = cc?.heatmapConfigs || []; this.#fac = cc?.formAnalyticsConfigs || []; this.#aud = cc?.audiences || []; this.#surveyData = cc?.surveys || []; } }
    } catch { this.#e = []; } finally {
      const running = this.#e.filter(x => x.status === 'running');
      this.#dbg('Config loaded:', running.length, 'running experiments', running.map(x => x.name));
      if (this.#p) this.#dbg('Project:', this.#p.domain || this.#p.id);
      this.#adoptLoaderStyles();
      revealPage();
      if (this.#consent && !this.#pv) this.#b.start();
      if (!this.#pv) {
        const restored = loadAssignments(this.#pk(), this.#e, this.#exposedAt);
        for (const [eid, v] of restored) {
          if (!this.#a.has(eid)) {
            this.#a.set(eid, v);
            const eName = this.#e.find(x => x.id === eid)?.name;
            this.#dbg('Restored assignment:', eName, '→', v.name);
          }
        }
        // Audience detection installs first so that any matching url_match
        // attribute on the current page is set BEFORE the exposure event
        // fires inside #applyClientExperiments / first getVariant() call.
        this.#audSetup();
        this.#goals(); this.#route(); this.#applyClientExperiments();
      }
      if (!this.#pv && this.#c.heatmaps && this.#p?.heatmaps_enabled !== false) {
        const hasAllPages = this.#p?.heatmap_all_pages_enabled === true;
        const hasAllForms = this.#p?.form_analytics_all_forms_enabled === true;
        const ruleSets = this.#hc.map(c => c.url_rules || []);

        if (ruleSets.length > 0 || hasAllPages) {
          this.#initHeatmap(ruleSets, hasAllPages);
        }

        if (this.#fac.length > 0 || hasAllForms) {
          const formConfigs: Array<{ capture_mode: string; url_rules: Array<{ match_type: string; value: string }>; form_selectors: string[] }> = [];
          if (hasAllForms) {
            formConfigs.push({ capture_mode: 'all_forms', url_rules: [], form_selectors: [] });
          }
          formConfigs.push(...this.#fac.map(c => ({ capture_mode: 'specific', url_rules: c.url_rules || [], form_selectors: (c.form_selectors || []) as string[] })));
          this.#initFormTracker(formConfigs);
        }
      }
      if (!this.#pv && this.#c.surveys && this.#p?.surveys_enabled !== false) {
        this.#initSurveys();
      }
    }
  }

  getProject(): ProjectInfo | null { return this.#p; }

  #pushEvent(e: ABEvent): void {
    if (this.#consent) {
      this.#b.push(e);
    } else {
      this.#pendingEvents.push(e);
    }
  }

  grantConsent(): void {
    if (this.#consent) return;
    this.#consent = true;
    const u = this.#uid();
    if (u) {
      const existing = gc('_ab_vid');
      if (!existing) sc(u);
    }
    if (this.#c.sessionId) {
      try {
        if (!sessionStorage.getItem('_ab_sid')) sessionStorage.setItem('_ab_sid', this.#c.sessionId);
      } catch {}
    }
    this.#b.start();
    for (const e of this.#pendingEvents) this.#b.push(e);
    this.#pendingEvents = [];
  }

  revokeConsent(): void {
    this.#consent = false;
    this.#pendingEvents = [];
    if (D) D.cookie = '_ab_vid=;path=/;max-age=0;SameSite=Lax';
    this.#b.destroy();
  }

  // Wires up project-level audience attribute detection: url_match rules
  // fire on initial page + every SPA navigation; element_click + form_submit
  // attach delegated listeners that set the attribute when triggered.
  #audSetup(): void {
    for (const c of this.#audCl) c();
    this.#audCl = [];
    this.#audFired.clear();
    if (!W || !this.#aud.length) return;

    // URL match rules — evaluate against current href right away.
    this.#audUrlScan();

    if (!D) return;

    const clickRules = this.#aud.filter(a => a.source_type === 'click' && a.value);
    if (clickRules.length) {
      const handler = (ev: Event) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        for (const r of clickRules) {
          const k = 'click::' + r.id;
          if (this.#audFired.has(k)) continue;
          let matched = false;
          try { matched = !!r.value && !!t.closest(r.value); } catch { matched = false; }
          if (matched) {
            this.#audFired.add(k);
            this.#applyAttribute(r.attribute_key, r.set_value || 'yes');
          }
        }
      };
      D.addEventListener('click', handler, true);
      this.#audCl.push(() => D!.removeEventListener('click', handler, true));
    }

    // Selector mode requires a CSS selector value; URL/action_url mode
    // treats an empty value as "match all forms" (mirrors the goals
    // form_submit semantics and matches what the API/UI promise users).
    const formRules = this.#aud.filter(a =>
      a.source_type === 'form_submit' &&
      (a.url_match_type === 'selector' ? !!a.value : true)
    );
    if (formRules.length) {
      // Two match modes for form_submit:
      //  - url_match_type === 'selector' → CSS selector against the form
      //  - any other url_match_type      → URL match against form.action,
      //    using the same urlMatch() helper as url_match audiences (so
      //    contains/equals/starts_with/ends_with/regex all work uniformly).
      //    An empty value in this mode means "match all submits".
      const checkForm = (form: HTMLFormElement) => {
        for (const r of formRules) {
          const k = 'form::' + r.id;
          if (this.#audFired.has(k)) continue;
          let matched = false;
          const mt = r.url_match_type || 'selector';
          try {
            if (mt === 'selector') {
              matched = !!r.value && (form.matches(r.value) || !!form.closest(r.value));
            } else if (!r.value) {
              matched = true;
            } else {
              const action = form.getAttribute('action') || (W ? W.location.href : '');
              // Resolve relative actions against the current document.
              let resolved = action;
              try { resolved = new URL(action, W ? W.location.href : undefined).href; } catch {}
              matched = urlMatch(resolved, mt, r.value);
            }
          } catch { matched = false; }
          if (matched) {
            this.#audFired.add(k);
            this.#applyAttribute(r.attribute_key, r.set_value || 'yes');
          }
        }
      };
      const submitHandler = (ev: Event) => {
        const form = ev.target;
        if (form instanceof HTMLFormElement) checkForm(form);
      };
      D.addEventListener('submit', submitHandler, true);
      this.#audCl.push(() => D!.removeEventListener('submit', submitHandler, true));
    }
  }

  // Re-run url_match audience detection (called on initial setup + SPA
  // navigations). Reserved keys are filtered out at config time but we
  // double-check via #applyAttribute.
  #audUrlScan(): void {
    if (!W || !this.#aud.length) return;
    const url = W.location.href;
    for (const r of this.#aud) {
      if (r.source_type !== 'url_match' || !r.value) continue;
      const k = 'url::' + r.id + '::' + url;
      if (this.#audFired.has(k)) continue;
      const matchType = r.url_match_type || 'contains';
      let matched = false;
      try { matched = urlMatch(url, matchType, r.value); } catch { matched = false; }
      if (matched) {
        this.#audFired.add(k);
        this.#applyAttribute(r.attribute_key, r.set_value || 'yes');
      }
    }
  }

  #goals(): void {
    for (const c of this.#cl) c();
    this.#cl = []; this.#fg.clear();
    if (!W) return;
    const cl: { e: string; g: string; s: string }[] = [];
    const engagementGoals: { e: string; g: string; value: string; matchType: string }[] = [];
    const formGoals: { e: string; g: string; value: string; matchType: string; isSelector: boolean }[] = [];
    for (const e of this.#e) {
      if (e.status !== 'running' || !e.goals) continue;
      for (const g of e.goals) {
        this.#dbg('Goal registered:', e.name, '→', g.goal_type, g.value || '');
        if (g.goal_type === 'click' && g.value && D) cl.push({ e: e.name, g: goalKey(g), s: g.value });
        if (g.goal_type === 'url_match') this.#urlGoal(e.name, goalKey(g), g);
        if (g.goal_type === 'engagement' && g.value) engagementGoals.push({ e: e.name, g: goalKey(g), value: g.value, matchType: g.url_match_type || 'contains' });
        if (g.goal_type === 'form_submit') formGoals.push({ e: e.name, g: goalKey(g), value: g.value || '', matchType: g.url_match_type || 'contains', isSelector: g.url_match_type === 'selector' });
      }
    }
    if (cl.length) {
      if (cl.length >= 3) {
        const h = (ev: Event) => { const t = ev.target; if (!(t instanceof Element)) return; let any = false; for (const c of cl) { try { const matched = !!t.closest(c.s); this.#dbg('Click goal check:', c.e, '| selector:', c.s, '| matched:', matched); if (matched) { this.trackFor(c.e, c.g); any = true; } } catch {} } if (any) this.#b.flushBeacon(); };
        D!.addEventListener('click', h);
        this.#cl.push(() => D!.removeEventListener('click', h));
      } else {
        for (const c of cl) {
          const h = (ev: Event) => { const matched = ev.target instanceof Element && !!ev.target.closest(c.s); this.#dbg('Click goal check:', c.e, '| selector:', c.s, '| matched:', matched); if (matched) { this.trackFor(c.e, c.g); this.#b.flushBeacon(); } };
          D!.addEventListener('click', h); this.#cl.push(() => D!.removeEventListener('click', h));
        }
      }
    }
    if (engagementGoals.length && D) {
      const engagementTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'IMG']);
      const h = (ev: Event) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const el = engagementTags.has(t.tagName) ? t : t.closest('a,button,input,textarea,select,label,img');
        if (!el) return;
        const url = W!.location.href;
        for (const eg of engagementGoals) {
          const k = eg.e + '::' + eg.g;
          if (this.#fg.has(k)) continue;
          const matched = urlMatch(url, eg.matchType, eg.value);
          this.#dbg('Engagement goal check:', eg.e, '| pattern:', eg.value, '| type:', eg.matchType, '| matched:', matched);
          if (matched) { this.#fg.add(k); this.trackFor(eg.e, eg.g); }
        }
      };
      D.addEventListener('mousedown', h);
      this.#cl.push(() => D!.removeEventListener('mousedown', h));
    }
    if (formGoals.length && D) {
      const checkForm = (form: HTMLFormElement, source: string) => {
        for (const fg of formGoals) {
          const k = fg.e + '::' + fg.g;
          if (this.#fg.has(k)) continue;
          let matched: boolean;
          if (fg.isSelector) {
            try { matched = !!fg.value && (form.matches(fg.value) || !!form.closest(fg.value)); } catch { matched = false; }
            this.#dbg(`Form goal check (${source} selector):`, fg.e, '| selector:', fg.value, '| matched:', matched);
          } else {
            const action = form.action || W!.location.href;
            matched = !fg.value || urlMatch(action, fg.matchType, fg.value);
            this.#dbg(`Form goal check (${source} action URL):`, fg.e, '| action:', action, '| pattern:', fg.value, '| type:', fg.matchType, '| matched:', matched);
          }
          if (matched) { this.#fg.add(k); this.trackFor(fg.e, fg.g); this.#b.flushBeacon(); }
        }
      };
      const h = (ev: Event) => {
        const form = ev.target;
        if (!(form instanceof HTMLFormElement)) return;
        checkForm(form, 'event');
      };
      D.addEventListener('submit', h);
      this.#cl.push(() => D!.removeEventListener('submit', h));
      const orig = HTMLFormElement.prototype.submit;
      this.#origSubmit = orig;
      const self = this;
      HTMLFormElement.prototype.submit = function(this: HTMLFormElement) {
        self.#dbg('Form goal check (programmatic submit):', this);
        checkForm(this, 'programmatic submit');
        return orig.call(this);
      };
      this.#cl.push(() => { HTMLFormElement.prototype.submit = orig; self.#origSubmit = null; });
    }
  }

  getVariant(name: string, fb: string): string {
    if (this.#pv) {
      const selections = getStoredSelections();
      const pvExp = this.#pvExps.find(x => x.name === name);
      if (pvExp) {
        const selectedId = selections[pvExp.id];
        if (selectedId) {
          const v = pvExp.variants.find(x => x.id === selectedId);
          if (v) return v.name;
        }
        if (pvExp.variants.length > 0) return pvExp.variants[0].name;
      }
      return fb;
    }
    const u = this.#uid();
    if (!u) return fb;
    const e = this.#e.find(x => x.name === name && x.status === 'running');
    if (!e?.variants?.length) { this.#dbg('getVariant: experiment not found or no variants:', name); return fb; }
    if (!passesRules(e.url_rules)) { this.#dbg('getVariant: URL rules not matched for', name); return fb; }
    if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) { this.#dbg('getVariant: targeting rules not matched for', name); return fb; }
    const pct = e.traffic_percentage ?? 100;
    const ex = pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct;
    let v = this.#a.get(e.id);
    if (!v) {
      v = ex ? (e.variants.find(x => x.is_control) || e.variants.find(x => x.name.toLowerCase() === 'control') || e.variants[0]) : assignVariant(e.id, u, e.variants);
      this.#a.set(e.id, v);
      this.#dbg('getVariant: assigned', name, '→', v.name, ex ? '(traffic excluded)' : '');
    } else {
      this.#dbg('getVariant: cached', name, '→', v.name);
    }
    if (!this.#seen.has(e.id)) {
      this.#seen.add(e.id);
      this.#exposedAt.set(e.id, Date.now());
      this.#pushEvent(mkEvt(e.id, v.id, u, this.#c.sessionId, ex ? { metadata: { traffic_excluded: true } } : undefined, this.#attrs));
      this.#dbg('Exposure event sent:', name, '→', v.name);
      if (this.#sv) this.#sv.onExposure();
    }
    if (ex) return v.name;
    if (e.ga && !this.#gf.has(e.id)) {
      try { ensureDataLayer(); const gaLabel = e.sequence_number && v.index ? `EXP-${e.sequence_number}-${v.index}` : v.name; const dlEvent: Record<string, unknown> = { event: 'experience_impression', measurement_id: e.ga.measurement_id, [e.ga.dimension_name]: gaLabel, experiment_id: e.id, experiment_name: e.name }; W!.dataLayer.push(dlEvent); this.#gf.add(e.id); this.#dbg('GA4 dataLayer.push (experience_impression):', name, dlEvent); } catch {}
    }
    if (this.#ht) this.#ht.setVariantId(v.id);
    if (this.#ft) this.#ft.setVariantId(v.id);
    if (e.mode === 'client' && !this.#ran.has(v.id)) { this.#ran.add(v.id); addCss(v, e.id, this.#sm); loadExternalJs(v).then(function() { runJs(v); }); }
    saveAssignments(this.#pk(), this.#a, this.#e, this.#exposedAt);
    return v.name;
  }

  track(goal: string, o?: TrackOptions): void {
    if (this.#pv) return;
    const u = this.#uid();
    if (!u) return;
    this.#dbg('track() called:', goal, '— assignments:', this.#a.size);
    let sent = 0;
    for (const [eid, v] of this.#a) {
      const e = this.#e.find(x => x.id === eid);
      if (!e) continue;
      const matchedGoal = e.goals?.find(g => g.goal_type === 'custom' && (g.label === goal || g.value === goal));
      if (!matchedGoal) { this.#dbg('track() SKIPPED:', e.name, '— no matching custom goal for', goal); continue; }
      this.#dbg('Conversion sent (track):', e.name, '→', v.name, 'goal:', goal);
      this.#pushEvent(mkConv(e.id, v.id, u, this.#c.sessionId, goal, o?.value, o?.metadata, this.#attrs));
      if (this.#sv) this.#sv.onConversion(e.id, matchedGoal.id);
      sent++;
    }
    if (sent === 0) this.#dbg('track() WARNING: no matching experiments found for goal', goal);
  }

  trackFor(en: string, gn: string, o?: { value?: number }): void {
    if (this.#pv) return;
    const u = this.#uid();
    if (!u) return;
    const e = this.#e.find(x => x.name === en);
    const v = e && this.#a.get(e.id);
    if (!e || !v) { this.#dbg('trackFor() SKIPPED:', en, 'goal:', gn, '— no assignment found', e ? '(experiment exists but no variant assigned)' : '(experiment not found)'); return; }
    this.#dbg('Conversion sent (trackFor):', en, '→', v.name, 'goal:', gn);
    this.#pushEvent(mkConv(e.id, v.id, u, this.#c.sessionId, gn, o?.value, undefined, this.#attrs));
    const matchedGoal = e.goals?.find(g => goalKey(g) === gn);
    if (matchedGoal && this.#sv) this.#sv.onConversion(e.id, matchedGoal.id);
  }

  #urlGoal(en: string, gn: string, g: Goal): void {
    const k = en + '::' + gn;
    if (this.#fg.has(k) || !g.value) return;
    const matched = urlMatch(W!.location.href, g.url_match_type || 'contains', g.value);
    this.#dbg('URL goal check:', en, '| pattern:', g.value, '| type:', g.url_match_type || 'contains', '| url:', W!.location.href, '| matched:', matched);
    if (matched) { this.#fg.add(k); this.trackFor(en, gn); }
  }

  #allUrlGoals(): void {
    for (const e of this.#e) { if (e.status !== 'running' || !e.goals) continue; for (const g of e.goals) if (g.goal_type === 'url_match') this.#urlGoal(e.name, goalKey(g), g); }
  }

  #applyClientExperiments(): void {
    const u = this.#uid();
    if (!u) return;
    let applied = false;
    let assigned = false;
    for (const e of this.#e) {
      if (e.status !== 'running' || e.mode !== 'client' || !e.variants?.length) continue;
      if (!passesRules(e.url_rules)) { this.#dbg('applyClient: URL rules not matched for', e.name); continue; }
      if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) { this.#dbg('applyClient: targeting rules not matched for', e.name); continue; }
      const pct = e.traffic_percentage ?? 100;
      const ex = pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct;
      let v = this.#a.get(e.id);
      if (!v) {
        v = ex ? (e.variants.find(x => x.is_control) || e.variants.find(x => x.name.toLowerCase() === 'control') || e.variants[0]) : assignVariant(e.id, u, e.variants);
        this.#a.set(e.id, v);
        assigned = true;
        this.#dbg('applyClient: assigned', e.name, '→', v.name, ex ? '(traffic excluded)' : '');
      } else {
        this.#dbg('applyClient: already assigned', e.name, '→', v.name);
      }
      if (!this.#seen.has(e.id)) {
        this.#seen.add(e.id);
        this.#exposedAt.set(e.id, Date.now());
        this.#pushEvent(mkEvt(e.id, v.id, u, this.#c.sessionId, ex ? { metadata: { traffic_excluded: true } } : undefined, this.#attrs));
        this.#dbg('Exposure event sent:', e.name, '→', v.name);
        if (this.#sv) this.#sv.onExposure();
      }
      if (!ex) {
        if (e.ga && !this.#gf.has(e.id)) {
          try { ensureDataLayer(); const gaLabel = e.sequence_number && v.index ? `EXP-${e.sequence_number}-${v.index}` : v.name; const dlEvent: Record<string, unknown> = { event: 'experience_impression', measurement_id: e.ga.measurement_id, [e.ga.dimension_name]: gaLabel, experiment_id: e.id, experiment_name: e.name }; W!.dataLayer.push(dlEvent); this.#gf.add(e.id); this.#dbg('GA4 dataLayer.push (experience_impression):', e.name, dlEvent); } catch {}
        }
        if (!this.#ran.has(v.id)) { this.#ran.add(v.id); addCss(v, e.id, this.#sm); loadExternalJs(v).then(function() { runJs(v); }); }
        if (this.#ht) this.#ht.setVariantId(v.id);
        if (this.#ft) this.#ft.setVariantId(v.id);
        applied = true;
      }
    }
    if (applied || assigned) saveAssignments(this.#pk(), this.#a, this.#e, this.#exposedAt);
  }

  #reeval(): void {
    const u = this.#uid();
    if (!u) return;
    let assigned = false;
    for (const e of this.#e) {
      if (e.status !== 'running' || e.mode !== 'client' || !e.variants?.length) continue;
      const ok = passesRules(e.url_rules);
      const tag = this.#sm.get(e.id);
      if (!ok && tag) { tag.remove(); this.#sm.delete(e.id); }
      if (!ok || tag) continue;
      if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) continue;
      const pct = e.traffic_percentage ?? 100;
      if (pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct) continue;
      let v = this.#a.get(e.id);
      if (!v) { v = assignVariant(e.id, u, e.variants); this.#a.set(e.id, v); assigned = true; }
      addCss(v, e.id, this.#sm);
      if ((v.js || (v.external_js && v.external_js.length)) && !this.#ran.has(v.id)) { this.#ran.add(v.id); loadExternalJs(v).then(function() { runJs(v); }); }
      if (this.#ht) this.#ht.setVariantId(v.id);
      if (this.#ft) this.#ft.setVariantId(v.id);
    }
    if (assigned) saveAssignments(this.#pk(), this.#a, this.#e, this.#exposedAt);
  }

  #onNav(): void {
    const u = W!.location.href;
    if (u === this.#lu) return;
    this.#lu = u;
    if (this.#ht) this.#ht.pageChanged();
    if (this.#ft) this.#ft.pageChanged();
    this.#audUrlScan();
    this.#allUrlGoals();
    this.#reeval();
    if (this.#sv) this.#sv.onRouteChange();
  }

  #route(): void {
    if (!W || this.#rc) return;
    const h = () => this.#onNav();
    const oP = history.pushState, oR = history.replaceState;
    history.pushState = function(...a: Parameters<typeof history.pushState>) { const r = oP.apply(this, a); h(); return r; };
    history.replaceState = function(...a: Parameters<typeof history.replaceState>) { const r = oR.apply(this, a); h(); return r; };
    W.addEventListener('popstate', h);
    this.#rc = () => { history.pushState = oP; history.replaceState = oR; W.removeEventListener('popstate', h); };
  }

  pageChanged(): void { this.#lu = ''; this.#onNav(); }

  async #initSurveys(): Promise<void> {
    const sc = this.#c.surveys;
    const teamId = (typeof sc === 'object' && sc.teamId) ? sc.teamId : this.#pk();
    if (!teamId) return;
    try {
      const mod = await import('./survey') as SurveyModule & LazyModule<SurveyModule>;
      const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
      this.#sv = new resolved.SurveyManager(this.#c.apiHost, teamId, this.#c.userId, () => {
        const map = new Map<string, { variantId: string; exposedAt: number | null }>();
        for (const [eid, v] of this.#a) {
          map.set(eid, { variantId: v.id, exposedAt: this.#exposedAt.get(eid) || null });
        }
        return map;
      });
      const surveyData = this.#surveyData;
      const load = () => {
        if (surveyData.length > 0) {
          this.#sv!.loadFromData(surveyData);
        } else {
          this.#sv!.load();
        }
      };
      if (D && D.readyState === 'complete') {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(load);
        else setTimeout(load, 0);
      } else if (W) {
        W.addEventListener('load', () => {
          if (typeof requestIdleCallback === 'function') requestIdleCallback(load);
          else setTimeout(load, 0);
        });
      }
    } catch {}
  }

  surveyTrack(actionName: string): void {
    if (this.#sv) this.#sv.trackAction(actionName);
  }

  setUserId(id: string): void {
    if (this.#sv) this.#sv.setUserId(id);
  }

  setAttribute(key: string, value: string | number | boolean): void {
    // Survey widget historically expected strings; coerce there too so
    // both sinks see the same canonical value.
    const coerced =
      typeof value === 'string'
        ? value
        : typeof value === 'number' && Number.isFinite(value)
          ? String(value)
          : typeof value === 'boolean'
            ? (value ? 'true' : 'false')
            : '';
    if (this.#sv) this.#sv.setAttribute(key, coerced);
    // Mirror into AB audience attributes so manually-set values can also
    // slice results. Reserved keys are dropped inside #applyAttribute.
    this.#applyAttribute(key, value);
  }

  setEmail(email: string): void {
    if (this.#sv) this.#sv.setEmail(email);
  }

  destroy(): void {
    if (this.#ht) { this.#ht.destroy(); this.#ht = null; }
    if (this.#ft) { this.#ft.destroy(); this.#ft = null; }
    this.#b.destroy();
    for (const c of this.#cl) c();
    this.#cl = [];
    for (const c of this.#audCl) c();
    this.#audCl = [];
    if (this.#rc) { this.#rc(); this.#rc = null; }
  }
}

if (W) {
  W.GrowthRoadmaps = GrowthRoadmaps;
  W.getAntiFlickerSnippet = getAntiFlickerSnippet;
  try { W.dispatchEvent(new CustomEvent('gr:ready')); } catch {}
}
