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
import { DEFAULT_API_HOST } from './constants';
import { assignVariant, fnv1a } from './hasher';
import {
  resolveVisitorIdentity,
  touchVisitorSession,
  refreshVisitorSessionActivity,
  getBrowserOsLanguage,
  setCookie,
  type VisitorType,
} from './visitor-identity';

function isExperimentActive(status: string): boolean {
  return status === 'running' || status === 'rolling_out';
}

function pickVariant(e: ExperimentConfig, u: string, trafficExcluded: boolean): Variant {
  if (e.status === 'rolling_out' && e.rollout_variant_id) {
    return e.variants.find(x => x.id === e.rollout_variant_id)
      || e.variants.find(x => x.is_control)
      || e.variants[0];
  }
  if (trafficExcluded) {
    return e.variants.find(x => x.is_control)
      || e.variants.find(x => x.name.toLowerCase() === 'control')
      || e.variants[0];
  }
  return assignVariant(e.id, u, e.variants);
}

/** Rollout must win over a stale bucket saved in localStorage from the live test. */
function resolveVariantForUser(
  e: ExperimentConfig,
  u: string,
  trafficExcluded: boolean,
  saved?: Variant,
): Variant {
  if (e.status === 'rolling_out' && e.rollout_variant_id) {
    return pickVariant(e, u, trafficExcluded);
  }
  return saved ?? pickVariant(e, u, trafficExcluded);
}
import { getCachedConfig, setCachedConfig, isCacheFresh } from './storage';
import { EventBatcher } from './batcher';
import { getAntiFlickerSnippet, revealPage } from './anti-flicker';
import { isPanelPreviewSession } from './experiment-bootstrap';
import type { HeatmapTracker } from './heatmap';
import type { FormTracker } from './form-tracker';
import type { SessionTracker } from './session-tracker';
import type { ModalTracker } from './modal-tracker';
import type { HelpWidgetTracker } from './help-widget-tracker';
import type { SurveyManager } from './survey';
import type { SurveyData } from './types';
import type { setupGoals as _setupGoals, checkUrlGoals as _checkUrlGoals, GoalContext } from './goals';
import type { setupAudience as _setupAudience, AudienceContext } from './audience';

interface LazyModule<T> {
  __lazyLoad?: () => Promise<T>;
}

type HeatmapModule = { HeatmapTracker: typeof HeatmapTracker };
type FormTrackerModule = { FormTracker: typeof FormTracker };
type SessionTrackerModule = { SessionTracker: typeof SessionTracker };
type ModalTrackerModule = { ModalTracker: typeof ModalTracker };
type HelpWidgetTrackerModule = { HelpWidgetTracker: typeof HelpWidgetTracker };
type SurveyModule = { SurveyManager: typeof SurveyManager };
type GoalsModule = { setupGoals: typeof _setupGoals; checkUrlGoals: typeof _checkUrlGoals };
type AudienceModule = { setupAudience: typeof _setupAudience };

const NOOP_AUDIENCE: AudienceModule = {
  setupAudience: () => ({ cleanup: () => {}, urlScan: () => {} }),
};

type PanelsResolvedModule = {
  renderPreviewPanel: (c: unknown) => void;
  getStoredSelections: () => Record<string, string>;
  getDisabledRolloutIds: () => Set<string>;
  isRolloutDisabledInPreview: (experimentId: string) => boolean;
  applyPanelVariant: (exp: unknown, variantId: string) => void;
  initReviewMode: (apiHost: string) => Promise<void>;
  initBuilderMode: (apiHost: string) => Promise<void>;
};
type PanelsMod = PanelsResolvedModule & LazyModule<PanelsResolvedModule>;

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

interface SavedAssignment { variantId: string; css?: string; external_css?: string[]; external_js?: string[]; exposedAt?: number; redirect_url?: string; is_control?: boolean; }

function saveAssignments(pk: string, assignments: Map<string, Variant>, experiments: ExperimentConfig[], exposedAt?: Map<string, number>): void {
  try {
    const out: Record<string, SavedAssignment> = {};
    for (const [eid, v] of assignments) {
      const e = experiments.find(x => x.id === eid);
      if (e && isExperimentActive(e.status)) {
        const entry: SavedAssignment = { variantId: v.id };
        if (e.mode === 'client') {
          if (v.css) entry.css = v.css;
          if (v.external_css) entry.external_css = v.external_css;
          if (v.external_js) entry.external_js = v.external_js;
        }
        if (e.mode === 'redirect') {
          if (v.redirect_url) entry.redirect_url = v.redirect_url;
          entry.is_control = !!v.is_control;
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
      const e = experiments.find(x => x.id === eid && isExperimentActive(x.status));
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

function selectorMatchesNow(selectors: string[]): boolean {
  if (!D || !selectors.length) return false;
  return selectors.some(sel => { try { return !!D!.querySelector(sel); } catch { return false; } });
}

function goalKey(g: Goal): string { return g.goal_type + (g.value ? ':' + g.value : ''); }

function mkEvt(eid: string, vid: string, uid: string, sid?: string, extra?: Record<string, unknown>, attrs?: Record<string, string>, identityMeta?: Record<string, unknown>): ABEvent {
  const extraMeta = extra?.metadata as Record<string, unknown> | undefined;
  const metadata: Record<string, unknown> = { ...(identityMeta || {}), ...(extraMeta || {}), device_type: devType() };
  if (attrs && Object.keys(attrs).length > 0) metadata.attributes = { ...attrs };
  return { type: 'exposure', experiment_id: eid, variant_id: vid, user_id: uid, session_id: sid, timestamp: new Date().toISOString(), metadata } as ABEvent;
}

function mkConv(eid: string, vid: string, uid: string, sid: string | undefined, gn: string, gv?: number, md?: Record<string, unknown>, attrs?: Record<string, string>, identityMeta?: Record<string, unknown>): ABEvent {
  const metadata: Record<string, unknown> = { ...(identityMeta || {}), ...(md || {}), device_type: devType() };
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
  #gf = new Set<string>();
  #goalCtx: { checkUrlGoals: () => void } | null = null;
  #audCtx: { urlScan: () => void; cleanup: () => void } | null = null;
  #panelsMod: PanelsResolvedModule | null = null;
  #pv = false;
  #pvExps: Array<{ id: string; name: string; variants: Variant[] }> = [];
  #lu: string = W ? W.location.href : '';
  #rc: (() => void) | null = null;
  #sm = new Map<string, HTMLStyleElement>();
  #consent: boolean;
  #consentRequired: boolean;
  #pendingEvents: ABEvent[] = [];
  #mo: MutationObserver | null = null;
  #ht: HeatmapTracker | null = null;
  #ft: FormTracker | null = null;
  #st: SessionTracker | null = null;
  #mt: ModalTracker | null = null;
  #hw: HelpWidgetTracker | null = null;
  #trackingSampledEffective = true;
  #hc: Array<{ capture_mode: string; url_rules: Array<{ match_type: string; value: string }>; sampling_rate?: number }> = [];
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
  #visitorType: VisitorType = 'new';
  #visitorSessionId = '';
  #browser = 'unknown';
  #os = 'unknown';
  #language = 'unknown';

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
    if (!c.userId && !c.sessionId && D) {
      const { userId, visitorType } = resolveVisitorIdentity(this.#consentRequired);
      c.userId = userId;
      this.#visitorType = visitorType;
    } else if (c.userId && D && gc('_ab_vid')) {
      this.#visitorType = 'returning';
      if (this.#consent) setCookie('returning', '1');
    }
    const pk = c.projectKey || '';
    this.#visitorSessionId = touchVisitorSession(pk, this.#consent);
    const device = getBrowserOsLanguage();
    this.#browser = device.browser;
    this.#os = device.os;
    this.#language = device.language;
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
        if (cfg.host) {
          const h = cfg.host.replace(/\/$/, '');
          if (!c.apiHost || c.apiHost.replace(/\/$/, '') === h) c.apiHost = DEFAULT_API_HOST;
        }
      }
    }
    if (!c.apiHost) c.apiHost = DEFAULT_API_HOST;
    this.#c = c;
    this.#b = new EventBatcher(c.apiHost, c.projectKey || '', this.#debug, (sa) => {
      const sid = this.#c.sessionId;
      if (sid && sa[sid] === false) this.#revokeServerTrackingCap();
    });
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

  #runVariantJs(v: Variant): void {
    const once = v.runOnce !== false;
    if (once && this.#ran.has(v.id)) return;
    if (once) this.#ran.add(v.id);
    loadExternalJs(v).then(function() { runJs(v); });
  }

  #setupMutationObserver(): void {
    // Always disconnect any existing observer first (ensures idempotent re-arming)
    this.#mo?.disconnect();
    this.#mo = null;

    if (this.#c.mutationObserver === false) return;

    const u = this.#uid();
    if (!u) return;

    // Build (variant, selector) pairs only for currently-eligible experiments
    const pairs: Array<{ v: Variant; sel: string }> = [];
    for (const e of this.#e) {
      if (!isExperimentActive(e.status) || e.mode !== 'client' || !e.variants?.length) continue;
      if (!passesRules(e.url_rules)) continue;
      if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) continue;
      const pct = e.traffic_percentage ?? 100;
      if (pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct) continue;
      const v = this.#a.get(e.id);
      if (!v || !v.selectors?.length) continue;
      for (const sel of v.selectors) {
        pairs.push({ v, sel });
      }
    }
    if (!pairs.length || !D?.body) return;

    // Accumulated across all mutations fired during the throttle window
    const pending: Element[] = [];
    let scheduled = false;
    this.#mo = new MutationObserver((mutations) => {
      // Always collect — never drop during a pending window
      for (const m of mutations) {
        m.addedNodes.forEach(n => { if (n.nodeType === 1) pending.push(n as Element); });
      }
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        // Drain the accumulator atomically so concurrent mutations stay queued
        const batch = pending.splice(0);
        for (const { v, sel } of pairs) {
          // For runOnce variants, #ran is the authoritative gate
          if (v.runOnce !== false && this.#ran.has(v.id)) continue;
          // Find the first newly-added element matching this selector
          let matchedEl: Element | null = null;
          for (const el of batch) {
            try {
              if (el.matches(sel)) { matchedEl = el; break; }
              const child = el.querySelector(sel);
              if (child) { matchedEl = child; break; }
            } catch {}
          }
          if (!matchedEl) continue;
          // Per-element deduplication via data attribute (no memory leak, survives remounts correctly).
          // Sanitize the variant ID so the attribute name is always valid (data-* must be lowercase ASCII).
          const attrKey = 'data-gr-ran-' + v.id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          if (matchedEl.getAttribute(attrKey) === '1') continue;
          matchedEl.setAttribute(attrKey, '1');
          this.#runVariantJs(v);
        }
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
      else setTimeout(run, 50);
    });
    this.#mo.observe(D.body, { childList: true, subtree: true });
  }

  async #initHeatmap(
    urlRuleSets: Array<Array<{ match_type: string; value: string }>>,
    trackAllPages: boolean,
    samplingRate = 1.0,
    sessionSampled = true,
  ): Promise<void> {
    if (!D || (urlRuleSets.length === 0 && !trackAllPages)) return;
    const mod = await import('./heatmap') as HeatmapModule & LazyModule<HeatmapModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    this.#ht = new resolved.HeatmapTracker(
      this.#b,
      this.#c.userId || this.#c.sessionId || '',
      this.#c.sessionId,
      () => this.#consent,
      urlRuleSets,
      trackAllPages,
      samplingRate,
      sessionSampled,
      () => this.#identityMeta(),
    );
    // Backfill variant ID: getVariant() / #applyClientExperiments() may have run before
    // this async module finished loading, so this.#ht was null when setVariantId was called.
    if (this.#a.size > 0) {
      const lastVariant = [...this.#a.values()].pop();
      if (lastVariant) this.#ht.setVariantId(lastVariant.id);
    }
  }

  async #initFormTracker(
    formConfigs: Array<{ capture_mode: string; url_rules: Array<{ match_type: string; value: string }>; form_selectors?: string[] }>,
    sessionSampled = true,
  ): Promise<void> {
    if (!D || formConfigs.length === 0) return;
    const mod = await import('./form-tracker') as FormTrackerModule & LazyModule<FormTrackerModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    this.#ft = new resolved.FormTracker(this.#b, this.#c.userId || this.#c.sessionId || '', this.#c.sessionId, () => this.#consent, formConfigs, sessionSampled);
  }

  async #initSessionTracker(): Promise<void> {
    if (!D) return;
    const mod = await import('./session-tracker') as SessionTrackerModule & LazyModule<SessionTrackerModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    this.#st = new resolved.SessionTracker(
      this.#b,
      this.#c.userId || this.#c.sessionId || '',
      this.#c.sessionId || '',
      () => this.#consent,
      () => this.#p?.session_analysis_enabled !== false && this.#p?.heatmaps_enabled !== false,
      this.#pk(),
      () => this.#identityMeta(),
    );
    if (this.#a.size > 0) {
      const lastVariant = [...this.#a.values()].pop();
      if (lastVariant) this.#st.setVariantId(lastVariant.id);
    }
    this.#st.start();
  }

  async #initModalTracker(): Promise<void> {
    if (!D) return;
    if (this.#c.modalTracking === false) return;
    const mod = await import('./modal-tracker') as ModalTrackerModule & LazyModule<ModalTrackerModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    this.#mt = new resolved.ModalTracker(
      this.#b,
      this.#c.userId || this.#c.sessionId || '',
      this.#c.sessionId || '',
      () => this.#consent,
      () => this.#p?.session_analysis_enabled !== false && this.#c.modalTracking !== false,
      () => this.#identityMeta(),
    );
    if (this.#a.size > 0) {
      const lastVariant = [...this.#a.values()].pop();
      if (lastVariant) this.#mt.setVariantId(lastVariant.id);
    }
    this.#mt.start();
  }

  async #initHelpWidgetTracker(): Promise<void> {
    if (!D) return;
    if (!this.#helpWidgetTrackingEnabled()) return;
    const mod = await import('./help-widget-tracker') as HelpWidgetTrackerModule & LazyModule<HelpWidgetTrackerModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    const customSelector = this.#p?.help_widget_selector?.trim();
    this.#hw = new resolved.HelpWidgetTracker(
      this.#b,
      this.#c.userId || this.#c.sessionId || '',
      this.#c.sessionId || '',
      () => this.#consent,
      () => this.#helpWidgetTrackingEnabled(),
      () => this.#identityMeta(),
      customSelector ? [customSelector] : undefined,
    );
    if (this.#a.size > 0) {
      const lastVariant = [...this.#a.values()].pop();
      if (lastVariant) this.#hw.setVariantId(lastVariant.id);
    }
    this.#hw.start();
  }

  #pk(): string { return this.#c.projectKey || ''; }
  #apiHost(): string { return this.#c.apiHost || DEFAULT_API_HOST; }

  #helpWidgetTrackingEnabled(): boolean {
    return (
      this.#p?.session_analysis_enabled !== false &&
      this.#p?.help_widget_tracking_enabled === true
    );
  }

  #revokeServerTrackingCap(): void {
    this.#trackingSampledEffective = false;
    if (this.#ht) this.#ht.setSessionSampled(false);
    if (this.#ft) this.#ft.setSessionSampled(false);
    if (this.#st) {
      this.#st.destroy();
      this.#st = null;
    }
    if (this.#mt) {
      this.#mt.destroy();
      this.#mt = null;
    }
    if (this.#hw) {
      this.#hw.destroy();
      this.#hw = null;
    }
  }

  #enableExperimentTracking(): void {
    if (this.#pv || this.#trackingSampledEffective) return;
    this.#trackingSampledEffective = true;
    this.#ht?.setSessionSampled(true);
    this.#ft?.setSessionSampled(true);
    if (this.#p?.session_analysis_enabled !== false && !this.#st) void this.#initSessionTracker();
    if (this.#p?.session_analysis_enabled !== false && this.#c.modalTracking !== false && !this.#mt) {
      void this.#initModalTracker();
    }
    if (this.#helpWidgetTrackingEnabled() && !this.#hw) {
      void this.#initHelpWidgetTracker();
    }
  }

  #identityMeta(): Record<string, unknown> {
    refreshVisitorSessionActivity(this.#pk(), this.#visitorSessionId, this.#consent);
    return {
      visitor_type: this.#visitorType,
      visitor_session_id: this.#visitorSessionId,
      browser: this.#browser,
      os: this.#os,
      language: this.#language,
    };
  }
  #saveFiredGoals(): void { try { sessionStorage.setItem('_ab_fg_' + this.#pk(), JSON.stringify([...this.#fg])); } catch {} }
  #uid(): string | undefined { return this.#c.userId || this.#c.sessionId; }
  #isPanelSession(): boolean { return isPanelPreviewSession(this.#pk()); }
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
        if (!isExperimentActive(e.status) || e.mode !== 'client') continue;
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
    // Start loading lazy chunks immediately so they download in parallel with the
    // config fetch — zero extra perceived latency in production (HTTP/2 multiplexed).
    // In ESM / test mode these resolve as native dynamic imports without any script tag.
    // Baseline before this split: growth.min.js 70 KB raw / 20.9 KB gzip.
    const goalsChunkProm = (import('./goals') as Promise<GoalsModule & LazyModule<GoalsModule>>)
      .then(m => (typeof m.__lazyLoad === 'function' ? m.__lazyLoad() as Promise<GoalsModule> : Promise.resolve(m)));
    const audChunkProm = (import('./audience') as Promise<AudienceModule & LazyModule<AudienceModule>>)
      .then(m => (typeof m.__lazyLoad === 'function' ? m.__lazyLoad() as Promise<AudienceModule> : Promise.resolve(m)))
      .catch(() => NOOP_AUDIENCE);

    try {
      if (W) {
        // Check for review mode first — takes priority over preview mode
        const reviewToken = new URLSearchParams(W.location.search).get('_ab_review');
        if (reviewToken) {
          const pm = await import('./panels') as PanelsMod;
          const pr = typeof pm.__lazyLoad === 'function' ? await pm.__lazyLoad() : pm;
          await pr.initReviewMode(this.#apiHost());
          revealPage();
          console.info('[GR] Review mode active — tracking disabled');
          return;
        }

        const sp = new URLSearchParams(W.location.search);

        const builderToken = sp.get('_ab_builder');
        if (builderToken) {
          const pm = await import('./panels') as PanelsMod;
          const pr = typeof pm.__lazyLoad === 'function' ? await pm.__lazyLoad() : pm;
          await pr.initBuilderMode(this.#apiHost());
          this.#pv = true;
          revealPage();
          console.info('[GR] AI Builder mode active — tracking disabled');
          return;
        }

        // gr_preview: IT implementation preview mode.
        const grPreview = sp.get('gr_preview');
        if (grPreview) {
          try {
            const r = await fetch(
              this.#apiHost() + '/api/it/verify-preview?gr_preview=' + encodeURIComponent(grPreview)
            );
            if (r.ok) {
              const d = await r.json();
              if (d.valid) {
                const fv = { id: d.variantId, name: 'preview', weight: 100, css: d.css ?? undefined, js: d.js ?? undefined } as Variant;
                if (d.css) addCss(fv, '', this.#sm);
                if (d.js) runJs(fv);
                console.info('[GR] IT preview mode: winning variant applied via gr_preview');
              } else {
                console.warn('[GR] gr_preview: invalid or tampered token — no variant applied');
              }
            } else {
              console.warn('[GR] gr_preview: server rejected token (status ' + r.status + ')');
            }
          } catch (e) {
            console.warn('[GR] gr_preview: fetch error', e);
          }
          revealPage();
          return;
        }

        const t = sp.get('_ab_preview');

        if (t === 'panel' || this.#isPanelSession()) {
          const panelKey = sp.get('key') || this.#getPanelKey();
          if (panelKey) {
            try {
              const pk = this.#pk();
              if (t === 'panel') {
                try { sessionStorage.setItem('_ab_panel_key', panelKey); sessionStorage.setItem('_ab_panel_pk', pk); } catch {}
              }
              const r = await fetch(this.#apiHost() + '/api/ab/preview/panel?pk=' + encodeURIComponent(pk) + '&key=' + encodeURIComponent(panelKey));
              if (r.ok) {
                const panelConfig = await r.json();
                this.#pv = true;
                this.#pvExps = panelConfig.experiments.map((exp: { id: string; name: string; variants: Variant[] }) => ({ id: exp.id, name: exp.name, variants: exp.variants }));
                this.#clearPanelAssets();
                const pm = await import('./panels') as PanelsMod;
                const pr = typeof pm.__lazyLoad === 'function' ? await pm.__lazyLoad() : pm;
                this.#panelsMod = pr;
                const selections = pr.getStoredSelections();
                for (const exp of panelConfig.experiments) {
                  if (!passesRules(exp.url_rules)) continue;
                  if (exp.targeting_rules?.length && !exp.targeting_rules.every((tr: {id?:string;attribute:string;operator:string;value:string}) => evalRule(tr as TargetingRule, pk, this.#c.customAttributes))) continue;
                  const isRollout = exp.status === 'rolling_out' || exp.rollout_status === 'active';
                  if (isRollout && pr.isRolloutDisabledInPreview(exp.id)) continue;
                  const selectedId = isRollout
                    ? (exp.rollout_variant_id || exp.variants[0]?.id || '')
                    : (selections[exp.id] || (exp.variants[0]?.id || ''));
                  if (selectedId) {
                    pr.applyPanelVariant(exp, selectedId);
                  }
                }
                revealPage();
                if (D && D.readyState === 'complete') {
                  pr.renderPreviewPanel(panelConfig);
                } else if (W) {
                  W.addEventListener('load', () => pr.renderPreviewPanel(panelConfig));
                }
                console.info('[GR] Preview panel mode active — tracking disabled');
                return;
              } else if (r.status === 403) {
                try { sessionStorage.removeItem('_ab_panel_key'); sessionStorage.removeItem('_ab_panel_pk'); } catch {}
              }
            } catch {}
          }
          this.#pv = true;
          revealPage();
          return;
        }

        if (t && t !== 'panel') {
          try {
            const r = await fetch(this.#apiHost() + '/api/ab/preview/' + encodeURIComponent(t));
            if (r.ok) {
              const d = await r.json();
              this.#pv = true;
              const fv = { id: d.variant_id, name: d.variant_name, weight: 100, css: d.css, js: d.js, external_js: d.external_js, external_css: d.external_css } as Variant;
              if (d.mode === 'client') { addCss(fv, '', this.#sm); loadExternalJs(fv).then(function() { runJs(fv); }); }
              console.info('[GR] Preview: ' + d.variant_name + ' (' + d.experiment_name + ')');
              revealPage();
              return;
            }
          } catch {}
          console.warn('[GR] Preview failed');
          this.#pv = true;
          revealPage();
          return;
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
        const fallbackUrl = this.#apiHost() + '/api/ab/experiments/all-configs?pk=' + encodeURIComponent(pk);
        let r: Response | null = null;
        try {
          const cdnR = await fetch(cdnUrl, { headers });
          if (cdnR.ok || cdnR.status === 304) { r = cdnR; } else { throw 0; }
        } catch {
          r = await fetch(fallbackUrl, { headers });
        }
        if (r.status === 304) {
          // Server confirms config is unchanged — refresh the local timestamp.
          if (!useCached && cc) {
            this.#e = cc.experiments; this.#p = cc.project || null;
            this.#hc = cc.heatmapConfigs || []; this.#fac = cc.formAnalyticsConfigs || [];
            this.#aud = cc.audiences || []; this.#surveyData = cc.surveys || [];
            setCachedConfig(pk, { ...cc, timestamp: Date.now() });
          }
        } else if (r.ok) {
          const etag = r.headers.get('etag');
          if (etag) { try { localStorage.setItem('_ab_cfg_etag_' + pk, etag); } catch {} }
          let d = await r.json();
          if (!d || typeof d !== 'object' || (!d.project && !d.experiments && !d.audiences && !d.surveys)) {
            const apiR = await fetch(fallbackUrl, { headers });
            if (!apiR.ok) throw 0;
            d = await apiR.json();
          }
          if (d.project) this.#p = d.project;
          if (d.experiments) this.#e = Object.values(d.experiments) as ExperimentConfig[];
          else this.#e = Array.isArray(d) ? d : Object.values(d);
          if (d.heatmapConfigs) this.#hc = d.heatmapConfigs;
          if (d.formAnalyticsConfigs) this.#fac = d.formAnalyticsConfigs;
          if (Array.isArray(d.audiences)) this.#aud = d.audiences as AudienceAttributeConfig[];
          if (Array.isArray(d.surveys)) this.#surveyData = d.surveys as SurveyData[];
          setCachedConfig(pk, { experiments: this.#e, project: this.#p || undefined, heatmapConfigs: this.#hc, formAnalyticsConfigs: this.#fac, audiences: this.#aud, surveys: this.#surveyData, timestamp: Date.now() });
        } else { throw 0; }
      } catch { if (!useCached) { this.#e = cc ? cc.experiments : []; this.#p = cc?.project || null; this.#hc = cc?.heatmapConfigs || []; this.#fac = cc?.formAnalyticsConfigs || []; this.#aud = cc?.audiences || []; this.#surveyData = cc?.surveys || []; } }
    } catch { this.#e = []; } finally {
      const running = this.#e.filter(x => isExperimentActive(x.status));
      this.#dbg('Config loaded:', running.length, 'active experiments', running.map(x => x.name));
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
        const mkAudCtx = (): AudienceContext => ({
          audiences: this.#aud,
          applyAttribute: (key, value) => this.#applyAttribute(key, value),
          dbg: (...args) => this.#dbg(...args),
        });
        // Audience URL scan runs before experiment assignment so URL-match
        // attributes are available when client-side experiments are applied.
        try {
          const a = await audChunkProm;
          const ac = a.setupAudience(mkAudCtx());
          this.#audCtx = ac;
          this.#audCl.push(ac.cleanup);
        } catch (err) { this.#dbg('Audience chunk load failed:', err); }

        this.#route(); this.#applyClientExperiments(); this.#applyRedirectExperiments();

        try {
          const raw = sessionStorage.getItem('_ab_fg_' + this.#pk());
          if (raw) {
            const keys: unknown = JSON.parse(raw);
            if (Array.isArray(keys)) { for (const k of keys) { if (typeof k === 'string') this.#fg.add(k); } }
          }
        } catch {}

        const mkCtx = (): GoalContext => ({
          experiments: this.#e,
          trackFor: (name, key) => this.trackFor(name, key),
          flushBeacon: () => this.#b.flushBeacon(),
          firedGoals: this.#fg,
          saveFiredGoals: () => this.#saveFiredGoals(),
          dbg: (...args) => this.#dbg(...args),
        });
        try {
          const g = await goalsChunkProm;
          this.#cl.push(g.setupGoals(mkCtx()));
          this.#goalCtx = { checkUrlGoals: () => g.checkUrlGoals(mkCtx()) };
        } catch (err) { this.#dbg('Goals chunk load failed:', err); }
      }
      if (!this.#pv && this.#c.heatmaps && this.#p?.heatmaps_enabled !== false) {
        const hasAllPages = this.#p?.heatmap_all_pages_enabled === true;
        const hasAllForms = this.#p?.form_analytics_all_forms_enabled === true;
        const ruleSets = this.#hc.map(c => c.url_rules || []);
        const rates = this.#hc.map(c => typeof c.sampling_rate === 'number' ? c.sampling_rate : 1.0);
        const { resolveEffectiveTrackingSamplingRate } = await import('./tracking-sampling');
        const effectiveSamplingRate = resolveEffectiveTrackingSamplingRate(
          this.#p?.tracking_sampling_rate,
          rates,
        );
        const wantsSessionAnalysis = this.#p?.session_analysis_enabled !== false;
        const wantsHeatmap = ruleSets.length > 0 || hasAllPages;
        let trackingSampled = true;
        if (effectiveSamplingRate < 1 && (wantsHeatmap || wantsSessionAnalysis || this.#fac.length > 0 || hasAllForms)) {
          const { isTrackingSessionSampled } = await import('./tracking-sampling');
          const uid = this.#uid() ?? '';
          const pk = this.#pk();
          const attrs = this.#c.customAttributes;
          let bypass = false;
          if (uid && this.#a.size) {
            for (const [expId] of this.#a) {
              const exp = this.#e.find(x => x.id === expId);
              if (!exp || !isExperimentActive(exp.status) || !passesRules(exp.url_rules)) continue;
              if (exp.targeting_rules?.length && !exp.targeting_rules.every(r => evalRule(r, pk, attrs))) continue;
              const tp = exp.traffic_percentage ?? 100;
              if (tp < 100 && fnv1a(expId + '::traffic::' + uid) % 100 >= tp) continue;
              bypass = true;
              break;
            }
          }
          trackingSampled = bypass || isTrackingSessionSampled(pk, effectiveSamplingRate);
        }
        this.#trackingSampledEffective = trackingSampled;

        if (wantsHeatmap) {
          void this.#initHeatmap(ruleSets, hasAllPages, effectiveSamplingRate, trackingSampled);
        }

        if (this.#fac.length > 0 || hasAllForms) {
          const formConfigs: Array<{ capture_mode: string; url_rules: Array<{ match_type: string; value: string }>; form_selectors: string[] }> = [];
          if (hasAllForms) {
            formConfigs.push({ capture_mode: 'all_forms', url_rules: [], form_selectors: [] });
          }
          formConfigs.push(...this.#fac.map(c => ({ capture_mode: 'specific', url_rules: c.url_rules || [], form_selectors: (c.form_selectors || []) as string[] })));
          void this.#initFormTracker(formConfigs, trackingSampled);
        }

        if (wantsSessionAnalysis && trackingSampled) {
          void this.#initSessionTracker();
          if (this.#c.modalTracking !== false) {
            void this.#initModalTracker();
          }
          if (this.#helpWidgetTrackingEnabled()) {
            void this.#initHelpWidgetTracker();
          }
        }
      }
      if (!this.#pv && this.#c.surveys && this.#p?.surveys_enabled !== false) {
        this.#initSurveys();
      }
    }
  }

  getProject(): ProjectInfo | null { return this.#p; }

  #pushEvent(e: ABEvent): void {
    const meta = (e.metadata || {}) as Record<string, unknown>;
    e.metadata = { ...this.#identityMeta(), ...meta };
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

  getVariant(name: string, fb: string): string {
    if (this.#pv) {
      const selections = this.#panelsMod ? this.#panelsMod.getStoredSelections() : {};
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
    const e = this.#e.find(x => x.name === name && isExperimentActive(x.status));
    if (!e?.variants?.length) { this.#dbg('getVariant: experiment not found or no variants:', name); return fb; }
    if (!passesRules(e.url_rules)) { this.#dbg('getVariant: URL rules not matched for', name); return fb; }
    if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) { this.#dbg('getVariant: targeting rules not matched for', name); return fb; }
    const pct = e.traffic_percentage ?? 100;
    const ex = pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct;
    const prior = this.#a.get(e.id);
    const v = resolveVariantForUser(e, u, ex, prior);
    if (!prior || prior.id !== v.id) {
      this.#a.set(e.id, v);
      this.#dbg('getVariant: assigned', name, '→', v.name, ex ? '(traffic excluded)' : '');
    } else {
      this.#dbg('getVariant: cached', name, '→', v.name);
    }
    if (!this.#seen.has(e.id)) {
      this.#seen.add(e.id);
      this.#exposedAt.set(e.id, Date.now());
      this.#pushEvent(mkEvt(e.id, v.id, u, this.#c.sessionId, ex ? { metadata: { traffic_excluded: true } } : undefined, this.#attrs, this.#identityMeta()));
      this.#dbg('Exposure event sent:', name, '→', v.name);
      if (this.#sv) this.#sv.onExposure();
      if (!ex) this.#enableExperimentTracking();
    }
    if (ex) return v.name;
    if (e.ga && !this.#gf.has(e.id)) {
      try { ensureDataLayer(); const gaLabel = e.sequence_number && v.index ? `EXP-${e.sequence_number}-${v.index}` : v.name; const dlEvent: Record<string, unknown> = { event: 'experience_impression', measurement_id: e.ga.measurement_id, [e.ga.dimension_name]: gaLabel, experiment_id: e.id, experiment_name: e.name, variant_index: v.index ?? null }; W!.dataLayer.push(dlEvent); this.#gf.add(e.id); this.#dbg('GA4 dataLayer.push (experience_impression):', name, dlEvent); } catch {}
    }
    if (this.#ht) this.#ht.setVariantId(v.id);
    if (this.#ft) this.#ft.setVariantId(v.id);
    if (e.mode === 'client') { addCss(v, e.id, this.#sm); if (this.#c.mutationObserver === false || !v.selectors?.length || selectorMatchesNow(v.selectors)) this.#runVariantJs(v); }
    if (e.mode === 'redirect' && !ex && !v.is_control && v.redirect_url) {
      if (!W) return fb;
      // Check URL params for loop protection (visitor already arrived at destination page via redirect)
      const sp = new URLSearchParams(W.location.search);
      const lpExp = sp.get('_ab_exp'), lpVar = sp.get('_ab_var');
      if (!(lpExp === e.id && lpVar === v.id)) {
        // Resolve destination — supports absolute URLs and root-relative paths (/path)
        let destUrl: URL | null = null;
        try { destUrl = new URL(v.redirect_url); } catch {}
        if (!destUrl && v.redirect_url.startsWith('/')) {
          try { destUrl = new URL(v.redirect_url, W.location.origin); } catch {}
        }
        // Only redirect if not already on the destination page
        if (destUrl && !(W.location.hostname === destUrl.hostname && W.location.pathname === destUrl.pathname)) {
          // Flush beacon so exposure event is sent before navigation
          this.#b.flushBeacon();
          saveAssignments(this.#pk(), this.#a, this.#e, this.#exposedAt);
          destUrl.searchParams.set('_ab_exp', e.id);
          destUrl.searchParams.set('_ab_var', v.id);
          W.location.replace(destUrl.toString());
          return fb; // page will navigate away; return fallback for any synchronous callers
        }
      }
    }
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
      this.#pushEvent(mkConv(e.id, v.id, u, this.#c.sessionId, goal, o?.value, o?.metadata, this.#attrs, this.#identityMeta()));
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
    this.#pushEvent(mkConv(e.id, v.id, u, this.#c.sessionId, gn, o?.value, undefined, this.#attrs, this.#identityMeta()));
    const matchedGoal = e.goals?.find(g => goalKey(g) === gn);
    if (matchedGoal && this.#sv) this.#sv.onConversion(e.id, matchedGoal.id);
  }

  #applyRedirectExperiments(): void {
    if (!W) return;
    const u = this.#uid();
    if (!u) return;
    // Bot detection: skip redirect for known crawlers
    const botRe = /bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|duckduck/i;
    if (botRe.test(N?.userAgent || '')) return;
    // Destination-page ingestion: _ab_exp + _ab_var params mean this is the landing page
    // of a redirect. Persist the assignment for that experiment without re-bucketing or
    // firing a duplicate exposure.
    const sp = new URLSearchParams(W.location.search);
    const paramExpId = sp.get('_ab_exp');
    const paramVarId = sp.get('_ab_var');
    if (paramExpId && paramVarId) {
      const paramExp = this.#e.find(x => x.id === paramExpId && x.mode === 'redirect' && isExperimentActive(x.status));
      if (paramExp) {
        if (!this.#a.has(paramExpId)) {
          // Fresh visitor: bucketed+redirected by loader pre-paint but assignment was never
          // persisted to localStorage. Ingest the assignment so the main loop can find it.
          // Do NOT mark #seen here — the main loop must fire exposure exactly once.
          const paramVariant = paramExp.variants?.find(x => x.id === paramVarId);
          if (paramVariant) {
            this.#a.set(paramExpId, paramVariant);
            this.#dbg('applyRedirect: destination-page ingestion (will expose)', paramExp.name, '→', paramVariant.name);
          }
        } else if (this.#exposedAt.has(paramExpId)) {
          // Returning visitor: exposure was already fired on the source page before redirect
          // (exposedAt was persisted to localStorage and restored). Suppress re-exposure.
          this.#seen.add(paramExpId);
          this.#dbg('applyRedirect: destination-page — exposure already sent, suppressing for', paramExp.name);
        }
        // Third case: assigned but exposedAt absent — exposure was never sent, main loop fires it.
      }
    }
    let assigned = false;
    let exposed = false;
    for (const e of this.#e) {
      if (!isExperimentActive(e.status) || e.mode !== 'redirect' || !e.variants?.length) continue;
      if (!passesRules(e.url_rules)) continue;
      if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) continue;
      const pct = e.traffic_percentage ?? 100;
      const ex = pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct;
      const prior = this.#a.get(e.id);
      const v = resolveVariantForUser(e, u, ex, prior);
      if (!prior || prior.id !== v.id) {
        this.#a.set(e.id, v);
        assigned = true;
        this.#dbg('applyRedirect: assigned', e.name, '→', v.name, ex ? '(traffic excluded)' : '');
      }
      if (!this.#seen.has(e.id)) {
        this.#seen.add(e.id);
        this.#exposedAt.set(e.id, Date.now());
        this.#pushEvent(mkEvt(e.id, v.id, u, this.#c.sessionId, ex ? { metadata: { traffic_excluded: true } } : undefined, this.#attrs, this.#identityMeta()));
        this.#dbg('Exposure event (redirect):', e.name, '→', v.name);
        if (this.#sv) this.#sv.onExposure();
        if (!ex) this.#enableExperimentTracking();
        exposed = true;
      }
      if (ex || v.is_control || !v.redirect_url) continue;
      // Loop protection: already on destination page — both experiment and variant match params
      if (paramExpId === e.id && paramVarId === v.id) continue;
      // Resolve redirect URL — supports absolute (http/https) and root-relative (/path)
      let destUrl: URL | null = null;
      try { destUrl = new URL(v.redirect_url); } catch {}
      if (!destUrl && v.redirect_url.startsWith('/')) {
        try { destUrl = new URL(v.redirect_url, W.location.origin); } catch {}
      }
      if (!destUrl) continue;
      // Check if already on destination by hostname + pathname
      if (W.location.hostname === destUrl.hostname && W.location.pathname === destUrl.pathname) continue;
      // Flush events synchronously before redirect
      this.#b.flushBeacon();
      // Redirect with loop-protection params (_ab_exp + _ab_var)
      destUrl.searchParams.set('_ab_exp', e.id);
      destUrl.searchParams.set('_ab_var', v.id);
      W.location.replace(destUrl.toString());
      break;
    }
    // Persist whenever assignment OR exposedAt changed — ensures exposedAt is saved after
    // destination-page first-exposure so subsequent loads don't fire a duplicate event.
    if (assigned || exposed) saveAssignments(this.#pk(), this.#a, this.#e, this.#exposedAt);
  }

  #applyClientExperiments(): void {
    const u = this.#uid();
    if (!u) return;
    let applied = false;
    let assigned = false;
    for (const e of this.#e) {
      if (!isExperimentActive(e.status) || e.mode !== 'client' || !e.variants?.length) continue;
      if (!passesRules(e.url_rules)) { this.#dbg('applyClient: URL rules not matched for', e.name); continue; }
      if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) { this.#dbg('applyClient: targeting rules not matched for', e.name); continue; }
      const pct = e.traffic_percentage ?? 100;
      const ex = pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct;
      const prior = this.#a.get(e.id);
      const v = resolveVariantForUser(e, u, ex, prior);
      if (!prior || prior.id !== v.id) {
        this.#a.set(e.id, v);
        assigned = true;
        this.#dbg('applyClient: assigned', e.name, '→', v.name, ex ? '(traffic excluded)' : '');
      } else {
        this.#dbg('applyClient: already assigned', e.name, '→', v.name);
      }
      if (!this.#seen.has(e.id)) {
        this.#seen.add(e.id);
        this.#exposedAt.set(e.id, Date.now());
        this.#pushEvent(mkEvt(e.id, v.id, u, this.#c.sessionId, ex ? { metadata: { traffic_excluded: true } } : undefined, this.#attrs, this.#identityMeta()));
        this.#dbg('Exposure event sent:', e.name, '→', v.name);
        if (this.#sv) this.#sv.onExposure();
        if (!ex) this.#enableExperimentTracking();
      }
      if (!ex) {
        if (e.ga && !this.#gf.has(e.id)) {
          try { ensureDataLayer(); const gaLabel = e.sequence_number && v.index ? `EXP-${e.sequence_number}-${v.index}` : v.name; const dlEvent: Record<string, unknown> = { event: 'experience_impression', measurement_id: e.ga.measurement_id, [e.ga.dimension_name]: gaLabel, experiment_id: e.id, experiment_name: e.name, variant_index: v.index ?? null }; W!.dataLayer.push(dlEvent); this.#gf.add(e.id); this.#dbg('GA4 dataLayer.push (experience_impression):', e.name, dlEvent); } catch {}
        }
        addCss(v, e.id, this.#sm);
        if (this.#c.mutationObserver === false || !v.selectors?.length || selectorMatchesNow(v.selectors)) this.#runVariantJs(v);
        if (this.#ht) this.#ht.setVariantId(v.id);
        if (this.#ft) this.#ft.setVariantId(v.id);
        applied = true;
      }
    }
    if (applied || assigned) saveAssignments(this.#pk(), this.#a, this.#e, this.#exposedAt);
    this.#setupMutationObserver();
  }

  #reeval(): void {
    const u = this.#uid();
    if (!u) return;
    let assigned = false;
    for (const e of this.#e) {
      if (!isExperimentActive(e.status) || e.mode !== 'client' || !e.variants?.length) continue;
      const ok = passesRules(e.url_rules);
      const tag = this.#sm.get(e.id);
      if (!ok && tag) { tag.remove(); this.#sm.delete(e.id); }
      if (!ok || tag) continue;
      if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) continue;
      const pct = e.traffic_percentage ?? 100;
      if (pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct) continue;
      const prior = this.#a.get(e.id);
      const v = resolveVariantForUser(e, u, false, prior);
      if (!prior || prior.id !== v.id) { this.#a.set(e.id, v); assigned = true; }
      addCss(v, e.id, this.#sm);
      if ((v.js || (v.external_js && v.external_js.length)) && (this.#c.mutationObserver === false || !v.selectors?.length || selectorMatchesNow(v.selectors))) this.#runVariantJs(v);
      if (this.#ht) this.#ht.setVariantId(v.id);
      if (this.#ft) this.#ft.setVariantId(v.id);
    }
    if (assigned) saveAssignments(this.#pk(), this.#a, this.#e, this.#exposedAt);
    this.#setupMutationObserver();
  }

  #onNav(): void {
    const u = W!.location.href;
    if (u === this.#lu) return;
    this.#lu = u;
    if (this.#ht) this.#ht.pageChanged();
    if (this.#ft) this.#ft.pageChanged();
    this.#audCtx?.urlScan();
    this.#goalCtx?.checkUrlGoals();
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
      this.#sv = new resolved.SurveyManager(this.#apiHost(), teamId, this.#c.userId, () => {
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
    if (this.#st) { this.#st.destroy(); this.#st = null; }
    if (this.#mt) { this.#mt.destroy(); this.#mt = null; }
    if (this.#hw) { this.#hw.destroy(); this.#hw = null; }
    this.#mo?.disconnect(); this.#mo = null;
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

  const wireConsentHelpers = () => {
    W!.grGrantConsent = function () {
      W!.gr && W!.gr.grantConsent();
    };
    W!.grRevokeConsent = function () {
      W!.gr && W!.gr.revokeConsent();
    };
  };

  try {
    W.dispatchEvent(new CustomEvent('gr:ready'));
  } catch {}

  const loaderCfg = W.__gr_loader_cfg;
  if (loaderCfg?.autoInit && loaderCfg.pk) {
    const gr = new GrowthRoadmaps({
      projectKey: loaderCfg.pk,
      apiHost: DEFAULT_API_HOST,
      heatmaps: true,
      surveys: true,
      antiFlicker: true,
      cookieConsent: loaderCfg.cookieConsent,
    });
    W.gr = gr;
    if (loaderCfg.cookieConsent === 'required') {
      wireConsentHelpers();
    }
    void gr.init();
  }
}
