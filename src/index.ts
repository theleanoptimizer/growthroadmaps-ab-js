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
} from './types';
import { assignVariant, fnv1a } from './hasher';
import { getCachedConfig, setCachedConfig, isCacheFresh } from './storage';
import { EventBatcher } from './batcher';
import { getAntiFlickerSnippet, revealPage } from './anti-flicker';
import type { HeatmapTracker } from './heatmap';
import type { FormTracker } from './form-tracker';
import type { SurveyManager } from './survey';

interface LazyModule<T> {
  __lazyLoad?: () => Promise<T>;
}

type HeatmapModule = { HeatmapTracker: typeof HeatmapTracker };
type FormTrackerModule = { FormTracker: typeof FormTracker };
type SurveyModule = { SurveyManager: typeof SurveyManager };

type GtagCommand = 'config' | 'event' | 'set' | 'js' | 'consent';
interface GrowthWindow extends Window {
  dataLayer: IArguments[];
  gtag(command: GtagCommand, ...args: unknown[]): void;
}

const W = typeof window !== 'undefined' ? window as unknown as GrowthWindow : undefined;
const D = typeof document !== 'undefined' ? document : undefined;
const N = typeof navigator !== 'undefined' ? navigator : undefined;

function ensureGtag(): void {
  if (!W) return;
  W.dataLayer = W.dataLayer || [];
  if (!W.gtag) { W.gtag = function() { W.dataLayer.push(arguments); }; }
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

function vid(skipCookie?: boolean): string {
  if (!skipCookie) {
    const v = gc('_ab_vid');
    if (v) return v;
  }
  const id = uuid();
  if (!skipCookie) sc(id);
  return id;
}

function saveAssignments(pk: string, assignments: Map<string, Variant>, experiments: ExperimentConfig[]): void {
  try {
    const out: Record<string, { variantId: string; css?: string; external_css?: string[]; external_js?: string[] }> = {};
    for (const [eid, v] of assignments) {
      const e = experiments.find(x => x.id === eid);
      if (e && e.status === 'running' && e.mode === 'client') {
        out[eid] = { variantId: v.id, css: v.css || undefined, external_css: v.external_css || undefined, external_js: v.external_js || undefined };
      }
    }
    localStorage.setItem('ab_va_' + pk, JSON.stringify(out));
  } catch {}
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
  try { new Function(v.js)(); } catch (e) { console.error('[GR] JS error ' + v.name + ':', e); }
}

function goalKey(g: Goal): string { return g.goal_type + (g.value ? ':' + g.value : ''); }

function mkEvt(eid: string, vid: string, uid: string, sid?: string, extra?: Record<string, unknown>): ABEvent {
  return { type: 'exposure', experiment_id: eid, variant_id: vid, user_id: uid, session_id: sid, timestamp: new Date().toISOString(), ...extra } as ABEvent;
}

function mkConv(eid: string, vid: string, uid: string, sid: string | undefined, gn: string, gv?: number, md?: Record<string, unknown>): ABEvent {
  return { type: 'conversion', experiment_id: eid, variant_id: vid, user_id: uid, session_id: sid, goal_name: gn, goal_value: gv, metadata: md, timestamp: new Date().toISOString() } as ABEvent;
}

export class GrowthRoadmaps {
  #c: GrowthConfig;
  #e: ExperimentConfig[] = [];
  #p: ProjectInfo | null = null;
  #b: EventBatcher;
  #seen = new Set<string>();
  #a = new Map<string, Variant>();
  #ran = new Set<string>();
  #cl: (() => void)[] = [];
  #fg = new Set<string>();
  #gf = new Set<string>();
  #pv = false;
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

  constructor(c: GrowthConfig) {
    this.#consentRequired = c.cookieConsent === 'required';
    this.#consent = !this.#consentRequired;
    if (!c.userId && !c.sessionId && D) c.userId = vid(this.#consentRequired);
    if (W && W.__gr_loader_ran) {
      const cfg = W.__gr_loader_cfg;
      if (cfg) {
        if (!c.projectKey) c.projectKey = cfg.pk;
        if (!c.apiHost && cfg.host) c.apiHost = cfg.host;
      }
    }
    this.#c = c;
    this.#b = new EventBatcher(c.apiHost, c.projectKey || '');
  }

  async #initHeatmap(urlRuleSets: Array<Array<{ match_type: string; value: string }>>, trackAllPages: boolean): Promise<void> {
    if (!D || (urlRuleSets.length === 0 && !trackAllPages)) return;
    const mod = await import('./heatmap') as HeatmapModule & LazyModule<HeatmapModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    this.#ht = new resolved.HeatmapTracker(this.#b, this.#c.userId || this.#c.sessionId || '', this.#c.sessionId, () => this.#consent, urlRuleSets, trackAllPages);
  }

  async #initFormTracker(formConfigs: Array<{ capture_mode: string; url_rules: Array<{ match_type: string; value: string }>; form_selectors?: string[] }>): Promise<void> {
    if (!D || formConfigs.length === 0) return;
    const mod = await import('./form-tracker') as FormTrackerModule & LazyModule<FormTrackerModule>;
    const resolved = typeof mod.__lazyLoad === 'function' ? await mod.__lazyLoad() : mod;
    this.#ft = new resolved.FormTracker(this.#b, this.#c.userId || this.#c.sessionId || '', this.#c.sessionId, () => this.#consent, formConfigs);
  }

  #pk(): string { return this.#c.projectKey || ''; }
  #uid(): string | undefined { return this.#c.userId || this.#c.sessionId; }

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
        const t = new URLSearchParams(W.location.search).get('_ab_preview');
        if (t) {
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
      if (useCached) { this.#e = cc.experiments; this.#p = cc.project || null; this.#hc = cc.heatmapConfigs || []; this.#fac = cc.formAnalyticsConfigs || []; }
      try {
        const r = await fetch(this.#c.apiHost + '/api/ab/experiments/all-configs?pk=' + encodeURIComponent(pk));
        if (!r.ok) throw 0;
        const d = await r.json();
        if (d.project) this.#p = d.project;
        if (!useCached) {
          if (d.experiments) this.#e = Object.values(d.experiments) as ExperimentConfig[];
          else this.#e = Array.isArray(d) ? d : Object.values(d);
        }
        if (d.heatmapConfigs) this.#hc = d.heatmapConfigs;
        if (d.formAnalyticsConfigs) this.#fac = d.formAnalyticsConfigs;
        setCachedConfig(pk, { experiments: this.#e, project: this.#p || undefined, heatmapConfigs: this.#hc, formAnalyticsConfigs: this.#fac, timestamp: Date.now() });
      } catch { if (!useCached) { this.#e = cc ? cc.experiments : []; this.#p = cc?.project || null; this.#hc = cc?.heatmapConfigs || []; this.#fac = cc?.formAnalyticsConfigs || []; } }
    } catch { this.#e = []; } finally {
      this.#adoptLoaderStyles();
      revealPage();
      if (this.#consent) this.#b.start();
      if (!this.#pv) { this.#goals(); this.#route(); this.#applyClientExperiments(); }
      if (this.#c.heatmaps && this.#p?.heatmaps_enabled !== false) {
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
      if (this.#c.surveys && this.#p?.surveys_enabled !== false) {
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

  #goals(): void {
    for (const c of this.#cl) c();
    this.#cl = []; this.#fg.clear();
    if (!W) return;
    const cl: { e: string; g: string; s: string }[] = [];
    for (const e of this.#e) {
      if (e.status !== 'running' || !e.goals) continue;
      for (const g of e.goals) {
        if (g.goal_type === 'click' && g.value && D) cl.push({ e: e.name, g: goalKey(g), s: g.value });
        if (g.goal_type === 'url_match') this.#urlGoal(e.name, goalKey(g), g);
      }
    }
    if (!cl.length) return;
    if (cl.length >= 3) {
      const h = (ev: Event) => { const t = ev.target; if (!(t instanceof Element)) return; for (const c of cl) { try { if (t.closest(c.s)) this.trackFor(c.e, c.g); } catch {} } };
      D!.addEventListener('click', h);
      this.#cl.push(() => D!.removeEventListener('click', h));
    } else {
      for (const c of cl) {
        const h = (ev: Event) => { if (ev.target instanceof Element && ev.target.closest(c.s)) this.trackFor(c.e, c.g); };
        D!.addEventListener('click', h); this.#cl.push(() => D!.removeEventListener('click', h));
      }
    }
  }

  getVariant(name: string, fb: string): string {
    if (this.#pv) return fb;
    const u = this.#uid();
    if (!u) return fb;
    const e = this.#e.find(x => x.name === name && x.status === 'running');
    if (!e?.variants?.length) return fb;
    if (!passesRules(e.url_rules)) return fb;
    if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) return fb;
    const pct = e.traffic_percentage ?? 100;
    const ex = pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct;
    let v = this.#a.get(e.id);
    if (!v) {
      v = ex ? (e.variants.find(x => x.is_control) || e.variants.find(x => x.name.toLowerCase() === 'control') || e.variants[0]) : assignVariant(e.id, u, e.variants);
      this.#a.set(e.id, v);
    }
    if (!this.#seen.has(e.id)) {
      this.#seen.add(e.id);
      this.#pushEvent(mkEvt(e.id, v.id, u, this.#c.sessionId, ex ? { metadata: { traffic_excluded: true } } : undefined));
    }
    if (ex) return v.name;
    if (e.ga && !this.#gf.has(e.id)) {
      try { ensureGtag(); const gaLabel = e.sequence_number && v.index ? `EXP-${e.sequence_number}-${v.index}` : v.name; W!.gtag('event', 'ab_assignment', { send_to: e.ga.measurement_id, [e.ga.dimension_name]: gaLabel, experiment_id: e.id, experiment_name: e.name }); this.#gf.add(e.id); } catch {}
    }
    if (this.#ht) this.#ht.setVariantId(v.id);
    if (this.#ft) this.#ft.setVariantId(v.id);
    if (e.mode === 'client' && !this.#ran.has(v.id)) { this.#ran.add(v.id); addCss(v, e.id, this.#sm); loadExternalJs(v).then(function() { runJs(v); }); }
    saveAssignments(this.#pk(), this.#a, this.#e);
    return v.name;
  }

  track(goal: string, o?: TrackOptions): void {
    if (this.#pv) return;
    const u = this.#uid();
    if (!u) return;
    for (const eid of this.#seen) {
      const e = this.#e.find(x => x.id === eid);
      const v = e && this.#a.get(eid);
      if (!e || !v) continue;
      this.#pushEvent(mkConv(e.id, v.id, u, this.#c.sessionId, goal, o?.value, o?.metadata));
    }
  }

  trackFor(en: string, gn: string, o?: { value?: number }): void {
    if (this.#pv) return;
    const u = this.#uid();
    if (!u) return;
    const e = this.#e.find(x => x.name === en);
    const v = e && this.#a.get(e.id);
    if (!e || !v) return;
    this.#pushEvent(mkConv(e.id, v.id, u, this.#c.sessionId, gn, o?.value));
  }

  #urlGoal(en: string, gn: string, g: Goal): void {
    const k = en + '::' + gn;
    if (this.#fg.has(k) || !g.value) return;
    if (urlMatch(W!.location.href, g.url_match_type || 'contains', g.value)) { this.#fg.add(k); this.trackFor(en, gn); }
  }

  #allUrlGoals(): void {
    for (const e of this.#e) { if (e.status !== 'running' || !e.goals) continue; for (const g of e.goals) if (g.goal_type === 'url_match') this.#urlGoal(e.name, goalKey(g), g); }
  }

  #applyClientExperiments(): void {
    const u = this.#uid();
    if (!u) return;
    let applied = false;
    for (const e of this.#e) {
      if (e.status !== 'running' || e.mode !== 'client' || !e.variants?.length) continue;
      if (!passesRules(e.url_rules)) continue;
      if (e.targeting_rules?.length && !e.targeting_rules.every(r => evalRule(r, this.#pk(), this.#c.customAttributes))) continue;
      const pct = e.traffic_percentage ?? 100;
      const ex = pct < 100 && fnv1a(e.id + '::traffic::' + u) % 100 >= pct;
      let v = this.#a.get(e.id);
      if (!v) {
        v = ex ? (e.variants.find(x => x.is_control) || e.variants.find(x => x.name.toLowerCase() === 'control') || e.variants[0]) : assignVariant(e.id, u, e.variants);
        this.#a.set(e.id, v);
      }
      if (!this.#seen.has(e.id)) {
        this.#seen.add(e.id);
        this.#pushEvent(mkEvt(e.id, v.id, u, this.#c.sessionId, ex ? { metadata: { traffic_excluded: true } } : undefined));
      }
      if (!ex) {
        if (e.ga && !this.#gf.has(e.id)) {
          try { ensureGtag(); const gaLabel = e.sequence_number && v.index ? `EXP-${e.sequence_number}-${v.index}` : v.name; W!.gtag('event', 'ab_assignment', { send_to: e.ga.measurement_id, [e.ga.dimension_name]: gaLabel, experiment_id: e.id, experiment_name: e.name }); this.#gf.add(e.id); } catch {}
        }
        if (!this.#ran.has(v.id)) { this.#ran.add(v.id); addCss(v, e.id, this.#sm); loadExternalJs(v).then(function() { runJs(v); }); }
        applied = true;
      }
    }
    if (applied) saveAssignments(this.#pk(), this.#a, this.#e);
  }

  #reeval(): void {
    const u = this.#uid();
    if (!u) return;
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
      if (!v) { v = assignVariant(e.id, u, e.variants); this.#a.set(e.id, v); }
      addCss(v, e.id, this.#sm);
      if ((v.js || (v.external_js && v.external_js.length)) && !this.#ran.has(v.id)) { this.#ran.add(v.id); loadExternalJs(v).then(function() { runJs(v); }); }
    }
  }

  #onNav(): void {
    const u = W!.location.href;
    if (u === this.#lu) return;
    this.#lu = u;
    if (this.#ht) this.#ht.pageChanged();
    if (this.#ft) this.#ft.pageChanged();
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
      this.#sv = new resolved.SurveyManager(this.#c.apiHost, teamId, this.#c.userId);
      const load = () => this.#sv!.load();
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

  setAttribute(key: string, value: string): void {
    if (this.#sv) this.#sv.setAttribute(key, value);
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
    if (this.#rc) { this.#rc(); this.#rc = null; }
  }
}

if (W) {
  W.GrowthRoadmaps = GrowthRoadmaps;
  W.getAntiFlickerSnippet = getAntiFlickerSnippet;
  try { W.dispatchEvent(new CustomEvent('gr:ready')); } catch {}
}
