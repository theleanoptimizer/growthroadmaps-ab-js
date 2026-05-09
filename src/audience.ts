import type { AudienceAttributeConfig } from './types';

export interface AudienceContext {
  audiences: AudienceAttributeConfig[];
  applyAttribute: (key: string, value: unknown) => void;
  dbg: (...args: unknown[]) => void;
}

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

export function setupAudience(ctx: AudienceContext): { cleanup: () => void; urlScan: () => void } {
  const W = typeof window !== 'undefined' ? window : undefined;
  const D = typeof document !== 'undefined' ? document : undefined;
  const cleanups: Array<() => void> = [];
  const audFired = new Set<string>();

  function urlScan(): void {
    if (!W || !ctx.audiences.length) return;
    const url = W.location.href;
    for (const r of ctx.audiences) {
      if (r.source_type !== 'url_match' || !r.value) continue;
      const k = 'url::' + r.id + '::' + url;
      if (audFired.has(k)) continue;
      const matchType = r.url_match_type || 'contains';
      let matched = false;
      try { matched = urlMatch(url, matchType, r.value); } catch { matched = false; }
      if (matched) {
        audFired.add(k);
        ctx.applyAttribute(r.attribute_key, r.set_value || 'yes');
      }
    }
  }

  urlScan();

  if (D) {
    const clickRules = ctx.audiences.filter(a => a.source_type === 'click' && a.value);
    if (clickRules.length) {
      const handler = (ev: Event) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        for (const r of clickRules) {
          const k = 'click::' + r.id;
          if (audFired.has(k)) continue;
          let matched = false;
          try { matched = !!r.value && !!t.closest(r.value); } catch { matched = false; }
          if (matched) {
            audFired.add(k);
            ctx.applyAttribute(r.attribute_key, r.set_value || 'yes');
          }
        }
      };
      D.addEventListener('click', handler, true);
      cleanups.push(() => D.removeEventListener('click', handler, true));
    }

    const formRules = ctx.audiences.filter(a =>
      a.source_type === 'form_submit' &&
      (a.url_match_type === 'selector' ? !!a.value : true)
    );
    if (formRules.length && W) {
      const checkForm = (form: HTMLFormElement) => {
        for (const r of formRules) {
          const k = 'form::' + r.id;
          if (audFired.has(k)) continue;
          let matched = false;
          const mt = r.url_match_type || 'selector';
          try {
            if (mt === 'selector') {
              matched = !!r.value && (form.matches(r.value) || !!form.closest(r.value));
            } else if (!r.value) {
              matched = true;
            } else {
              const action = form.getAttribute('action') || (W ? W.location.href : '');
              let resolved = action;
              try { resolved = new URL(action, W ? W.location.href : undefined).href; } catch {}
              matched = urlMatch(resolved, mt, r.value);
            }
          } catch { matched = false; }
          if (matched) {
            audFired.add(k);
            ctx.applyAttribute(r.attribute_key, r.set_value || 'yes');
          }
        }
      };
      const submitHandler = (ev: Event) => { const form = ev.target; if (form instanceof HTMLFormElement) checkForm(form); };
      D.addEventListener('submit', submitHandler, true);
      cleanups.push(() => D.removeEventListener('submit', submitHandler, true));
    }
  }

  return {
    cleanup: () => { for (const c of cleanups) c(); },
    urlScan,
  };
}
