import {
  ABTestingConfig,
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

const W = typeof window !== 'undefined' ? window : undefined;
const D = typeof document !== 'undefined' ? document : undefined;
const N = typeof navigator !== 'undefined' ? navigator : undefined;

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
    const out: Record<string, { variantId: string; css?: string }> = {};
    for (const [eid, v] of assignments) {
      const e = experiments.find(x => x.id === eid);
      if (e && e.status === 'running' && e.mode === 'client') {
        out[eid] = { variantId: v.id, css: v.css || undefined };
      }
    }
    localStorage.setItem('ab_va_' + pk, JSON.stringify(out));
  } catch {}
}

export { getAntiFlickerSnippet } from './anti-flicker';
export type { ABTestingConfig, ExperimentConfig, Variant, TrackOptions } from './types';

function urlMatch(url: string, type: string, val: string): boolean {
  switch (type) {
    case 'exact': case 'equals': return url === val;
    case 'contains': return url.includes(val);
    case 'starts_with': return url.startsWith(val);
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
  if (!D || !v.css) return;
  const a = 'data-ab-css';
  if (D.querySelector(`style[${a}="${v.id}"]`)) return;
  const s = D.createElement('style');
  s.setAttribute(a, v.id);
  s.textContent = v.css;
  D.head.appendChild(s);
  m.set(eid, s);
}

function runJs(v: Variant): void {
  if (!v.js) return;
  try { new Function(v.js)(); } catch (e) { console.error('[AB] JS error ' + v.name + ':', e); }
}

function goalKey(g: Goal): string { return g.goal_type + (g.value ? ':' + g.value : ''); }

function mkEvt(eid: string, vid: string, uid: string, sid?: string, extra?: Record<string, unknown>): ABEvent {
  return { type: 'exposure', experiment_id: eid, variant_id: vid, user_id: uid, session_id: sid, timestamp: new Date().toISOString(), ...extra } as ABEvent;
}

function mkConv(eid: string, vid: string, uid: string, sid: string | undefined, gn: string, gv?: number, md?: Record<string, unknown>): ABEvent {
  return { type: 'conversion', experiment_id: eid, variant_id: vid, user_id: uid, session_id: sid, goal_name: gn, goal_value: gv, metadata: md, timestamp: new Date().toISOString() } as ABEvent;
}

export class ABTesting {
  #c: ABTestingConfig;
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

  constructor(c: ABTestingConfig) {
    if (c.clientKey && !c.projectKey) c.projectKey = c.clientKey;
    this.#consentRequired = c.cookieConsent === 'required';
    this.#consent = !this.#consentRequired;
    if (!c.userId && !c.sessionId && D) c.userId = vid(this.#consentRequired);
    if (W && W.__ab_loader_ran && W.__ab_loader_cfg) {
      if (!c.projectKey && !c.clientKey) c.projectKey = W.__ab_loader_cfg.pk;
      if (!c.apiHost && W.__ab_loader_cfg.host) c.apiHost = W.__ab_loader_cfg.host;
    }
    this.#c = c;
    this.#b = new EventBatcher(c.apiHost, c.projectKey || c.clientKey || '');
    if (c.heatmaps && D) {
      this.#initHeatmap();
    }
  }

  async #initHeatmap(): Promise<void> {
    const { HeatmapTracker } = await import('./heatmap');
    this.#ht = new HeatmapTracker(this.#b, this.#c.userId || this.#c.sessionId || '', this.#c.sessionId, () => this.#consent);
  }

  #pk(): string { return this.#c.projectKey || this.#c.clientKey || ''; }
  #uid(): string | undefined { return this.#c.userId || this.#c.sessionId; }

  #adoptLoaderStyles(): void {
    if (!D || !W?.__ab_loader_ran) return;
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
              const fv = { id: d.variant_id, name: d.variant_name, weight: 100, css: d.css, js: d.js } as Variant;
              if (d.mode === 'client') { addCss(fv, '', this.#sm); runJs(fv); }
              console.info('[AB] Preview: ' + d.variant_name + ' (' + d.experiment_name + ')');
              return;
            }
          } catch {}
        }
      }
      const pk = this.#pk();
      const cc = getCachedConfig(pk);
      if (cc && isCacheFresh(cc)) { this.#e = cc.experiments; this.#p = cc.project || null; return; }
      try {
        const r = await fetch(this.#c.apiHost + '/api/ab/experiments/all-configs?pk=' + encodeURIComponent(pk));
        if (!r.ok) throw 0;
        const d = await r.json();
        if (d.experiments && d.project) { this.#p = d.project; this.#e = Object.values(d.experiments) as ExperimentConfig[]; }
        else this.#e = Array.isArray(d) ? d : Object.values(d);
        setCachedConfig(pk, { experiments: this.#e, project: this.#p || undefined, timestamp: Date.now() });
      } catch { this.#e = cc ? cc.experiments : []; this.#p = cc?.project || null; }
    } catch { this.#e = []; } finally {
      this.#adoptLoaderStyles();
      revealPage();
      if (this.#consent) this.#b.start();
      if (!this.#pv) { this.#goals(); this.#route(); }
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
      try { if (W?.gtag) { W.gtag('event', 'ab_assignment', { send_to: e.ga.measurement_id, [e.ga.dimension_name]: v.name, experiment_id: e.id, experiment_name: e.name }); this.#gf.add(e.id); } } catch {}
    }
    if (this.#ht) this.#ht.setVariantId(v.id);
    if (e.mode === 'client' && !this.#ran.has(v.id)) { this.#ran.add(v.id); addCss(v, e.id, this.#sm); runJs(v); }
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
      if (v.js && !this.#ran.has(v.id)) { this.#ran.add(v.id); runJs(v); }
    }
  }

  #onNav(): void {
    const u = W!.location.href;
    if (u === this.#lu) return;
    this.#lu = u;
    if (this.#ht) this.#ht.pageChanged();
    this.#allUrlGoals();
    this.#reeval();
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

  destroy(): void {
    if (this.#ht) { this.#ht.destroy(); this.#ht = null; }
    this.#b.destroy();
    for (const c of this.#cl) c();
    this.#cl = [];
    if (this.#rc) { this.#rc(); this.#rc = null; }
  }
}

if (W) {
  W.ABTesting = ABTesting;
  W.getAntiFlickerSnippet = getAntiFlickerSnippet;
  try { W.dispatchEvent(new CustomEvent('ab:ready')); } catch {}
}
