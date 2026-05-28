import type { ExperimentConfig, Goal } from './types';

export interface GoalContext {
  experiments: ExperimentConfig[];
  trackFor: (expName: string, goalKey: string, o?: { value?: number }) => void;
  flushBeacon: () => void;
  firedGoals: Set<string>;
  saveFiredGoals: () => void;
  dbg: (...args: unknown[]) => void;
}

function gk(g: Goal): string { return g.goal_type + (g.value ? ':' + g.value : ''); }

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

export function checkUrlGoals(ctx: GoalContext): void {
  const W = typeof window !== 'undefined' ? window : undefined;
  if (!W) return;
  for (const e of ctx.experiments) {
    if (e.status !== 'running' || !e.goals) continue;
    for (const g of e.goals) {
      if (g.goal_type !== 'url_match' || !g.value) continue;
      const k = e.name + '::' + gk(g);
      if (ctx.firedGoals.has(k)) continue;
      const matched = urlMatch(W.location.href, g.url_match_type || 'contains', g.value);
      ctx.dbg('URL goal check:', e.name, '| pattern:', g.value, '| matched:', matched);
      if (matched) { ctx.firedGoals.add(k); ctx.saveFiredGoals(); ctx.trackFor(e.name, gk(g)); }
    }
  }
}

function incrementSessionPageviews(): number {
  if (typeof sessionStorage === 'undefined') return 1;
  const k = '_ab_pv';
  const n = parseInt(sessionStorage.getItem(k) || '0', 10) + 1;
  sessionStorage.setItem(k, String(n));
  return n;
}

function setupBrowsingGoals(ctx: GoalContext): () => void {
  const W = typeof window !== 'undefined' ? window : undefined;
  if (!W) return () => {};

  incrementSessionPageviews();
  const returnKey = '_ab_return_' + W.location.hostname;
  const hadVisited = typeof localStorage !== 'undefined' && !!localStorage.getItem(returnKey);
  if (typeof localStorage !== 'undefined' && !localStorage.getItem(returnKey)) {
    localStorage.setItem(returnKey, '1');
  }

  const pageviewGoals: { e: string; g: string }[] = [];
  const bounceGoals: { e: string; g: string }[] = [];
  const revisitGoals: { e: string; g: string }[] = [];

  for (const e of ctx.experiments) {
    if (e.status !== 'running' || !e.goals) continue;
    for (const g of e.goals) {
      if (g.goal_type === 'pageviews') pageviewGoals.push({ e: e.name, g: gk(g) });
      if (g.goal_type === 'bounce_rate') bounceGoals.push({ e: e.name, g: gk(g) });
      if (g.goal_type === 'revisit_rate') revisitGoals.push({ e: e.name, g: gk(g) });
    }
  }

  if (hadVisited) {
    for (const rg of revisitGoals) {
      const k = rg.e + '::' + rg.g;
      if (ctx.firedGoals.has(k)) continue;
      ctx.firedGoals.add(k);
      ctx.saveFiredGoals();
      ctx.trackFor(rg.e, rg.g);
    }
  }

  const onLeave = () => {
    const currentPv = parseInt(sessionStorage.getItem('_ab_pv') || '1', 10);
    let any = false;
    for (const bg of bounceGoals) {
      const k = bg.e + '::' + bg.g;
      if (ctx.firedGoals.has(k)) continue;
      if (currentPv <= 1) {
        ctx.firedGoals.add(k);
        ctx.saveFiredGoals();
        ctx.trackFor(bg.e, bg.g);
        any = true;
      }
    }
    for (const pg of pageviewGoals) {
      const k = pg.e + '::' + pg.g;
      if (ctx.firedGoals.has(k)) continue;
      ctx.firedGoals.add(k);
      ctx.saveFiredGoals();
      ctx.trackFor(pg.e, pg.g, { value: currentPv });
      any = true;
    }
    if (any) ctx.flushBeacon();
  };

  W.addEventListener('pagehide', onLeave);
  return () => W.removeEventListener('pagehide', onLeave);
}

export function setupGoals(ctx: GoalContext): () => void {
  const W = typeof window !== 'undefined' ? window : undefined;
  const D = typeof document !== 'undefined' ? document : undefined;
  const cleanups: Array<() => void> = [];
  const browsingCleanup = setupBrowsingGoals(ctx);

  const cl: { e: string; g: string; s: string }[] = [];
  const engagementGoals: { e: string; g: string; value: string; matchType: string }[] = [];
  const formGoals: { e: string; g: string; value: string; matchType: string; isSelector: boolean }[] = [];

  for (const e of ctx.experiments) {
    if (e.status !== 'running' || !e.goals) continue;
    for (const g of e.goals) {
      ctx.dbg('Goal registered:', e.name, '→', g.goal_type, g.value || '');
      if (g.goal_type === 'click' && g.value && D) cl.push({ e: e.name, g: gk(g), s: g.value });
      if (g.goal_type === 'url_match' && g.value && W) {
        const k = e.name + '::' + gk(g);
        if (!ctx.firedGoals.has(k)) {
          const matched = urlMatch(W.location.href, g.url_match_type || 'contains', g.value);
          ctx.dbg('URL goal check:', e.name, '| pattern:', g.value, '| matched:', matched);
          if (matched) { ctx.firedGoals.add(k); ctx.saveFiredGoals(); ctx.trackFor(e.name, gk(g)); }
        }
      }
      if (g.goal_type === 'engagement') engagementGoals.push({ e: e.name, g: gk(g), value: g.value || '', matchType: g.url_match_type || 'contains' });
      if (g.goal_type === 'form_submit') formGoals.push({ e: e.name, g: gk(g), value: g.value || '', matchType: g.url_match_type || 'contains', isSelector: g.url_match_type === 'selector' });
    }
  }

  if (cl.length && D) {
    if (cl.length >= 3) {
      const h = (ev: Event) => {
        const t = ev.target; if (!(t instanceof Element)) return;
        let any = false;
        for (const c of cl) { try { const matched = !!t.closest(c.s); ctx.dbg('Click goal check:', c.e, '| selector:', c.s, '| matched:', matched); if (matched) { ctx.trackFor(c.e, c.g); any = true; } } catch {} }
        if (any) ctx.flushBeacon();
      };
      D.addEventListener('click', h);
      cleanups.push(() => D.removeEventListener('click', h));
    } else {
      for (const c of cl) {
        const h = (ev: Event) => { const matched = ev.target instanceof Element && !!ev.target.closest(c.s); ctx.dbg('Click goal check:', c.e, '| selector:', c.s, '| matched:', matched); if (matched) { ctx.trackFor(c.e, c.g); ctx.flushBeacon(); } };
        D.addEventListener('click', h);
        cleanups.push(() => D.removeEventListener('click', h));
      }
    }
  }

  if (engagementGoals.length && D && W) {
    const engagementTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'IMG']);
    const h = (ev: Event) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const el = engagementTags.has(t.tagName) ? t : t.closest('a,button,input,textarea,select,label,img');
      if (!el) return;
      const url = W.location.href;
      for (const eg of engagementGoals) {
        const k = eg.e + '::' + eg.g;
        if (ctx.firedGoals.has(k)) continue;
        const matched = !eg.value || urlMatch(url, eg.matchType, eg.value);
        ctx.dbg('Engagement goal check:', eg.e, '| pattern:', eg.value || '(experiment pages)', '| matched:', matched);
        if (matched) { ctx.firedGoals.add(k); ctx.trackFor(eg.e, eg.g); }
      }
    };
    D.addEventListener('mousedown', h);
    cleanups.push(() => D.removeEventListener('mousedown', h));
  }

  if (formGoals.length && D && W) {
    const checkForm = (form: HTMLFormElement, source: string) => {
      for (const fg of formGoals) {
        const k = fg.e + '::' + fg.g;
        if (ctx.firedGoals.has(k)) continue;
        let matched: boolean;
        if (fg.isSelector) {
          try { matched = !!fg.value && (form.matches(fg.value) || !!form.closest(fg.value)); } catch { matched = false; }
          ctx.dbg(`Form goal check (${source} selector):`, fg.e, '| selector:', fg.value, '| matched:', matched);
        } else {
          const action = form.action || W.location.href;
          matched = !fg.value || urlMatch(action, fg.matchType, fg.value);
          ctx.dbg(`Form goal check (${source} action URL):`, fg.e, '| action:', action, '| pattern:', fg.value, '| matched:', matched);
        }
        if (matched) { ctx.firedGoals.add(k); ctx.trackFor(fg.e, fg.g); ctx.flushBeacon(); }
      }
    };
    const h = (ev: Event) => { const form = ev.target; if (!(form instanceof HTMLFormElement)) return; checkForm(form, 'event'); };
    D.addEventListener('submit', h);
    cleanups.push(() => D.removeEventListener('submit', h));
    const orig = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function(this: HTMLFormElement) {
      ctx.dbg('Form goal check (programmatic submit):', this);
      checkForm(this, 'programmatic submit');
      return orig.call(this);
    };
    cleanups.push(() => { HTMLFormElement.prototype.submit = orig; });
  }

  return () => {
    for (const c of cleanups) c();
    browsingCleanup();
  };
}
