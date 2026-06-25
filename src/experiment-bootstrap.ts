/**
 * Pre-paint experiment bootstrap — replays cached variant CSS and handles
 * redirect-mode bucketing. Skips entirely when localStorage has no fresh cache
 * with URL-eligible running experiments (fast path for behavioral-only sites).
 */
export function runExperimentBootstrap(): void {
  const W = window as any;
  const D = document;

  W.abq = W.abq || [];

  const cfg = W.__gr_loader_cfg;
  if (!cfg || !cfg.pk) return;
  W.__gr_loader_ran = true;
  const pk = cfg.pk as string;

  let cfgRaw: string | null;
  try {
    cfgRaw = localStorage.getItem('ab_cfg_' + pk);
  } catch {
    return;
  }
  if (!cfgRaw) return;

  let cachedCfg: any;
  try {
    cachedCfg = JSON.parse(cfgRaw);
  } catch {
    return;
  }
  if (cachedCfg && cachedCfg.timestamp && Date.now() - cachedCfg.timestamp > 60000) {
    return;
  }

  const eligible: Record<string, boolean> = {};
  if (cachedCfg && cachedCfg.experiments) {
    for (let i = 0; i < cachedCfg.experiments.length; i++) {
      const exp = cachedCfg.experiments[i];
      if ((exp.status === 'running' || exp.status === 'rolling_out') && passR(exp.url_rules)) {
        eligible[exp.id] = true;
      }
    }
  }
  if (!Object.keys(eligible).length) return;

  D.documentElement.style.opacity = '0';
  const t = setTimeout(function () {
    D.documentElement.style.opacity = '1';
  }, 1000);
  W.__ab_reveal = function () {
    clearTimeout(t);
    D.documentElement.style.opacity = '1';
  };

  function urlM(url: string, type: string, val: string): boolean {
    return type === 'exact' || type === 'equals'
      ? url === val
      : type === 'contains'
        ? url.indexOf(val) !== -1
        : type === 'starts_with'
          ? url.indexOf(val) === 0
          : type === 'regex'
            ? (function () {
                try {
                  return new RegExp(val).test(url);
                } catch {
                  return false;
                }
              })()
            : url.indexOf(val) !== -1;
  }

  function loaderFnv1a(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  function loaderAssignVariant(expId: string, uid: string, variants: any[]): any {
    const bucket = loaderFnv1a(expId + '::' + uid) % 100;
    let acc = 0;
    for (let i = 0; i < variants.length; i++) {
      acc += variants[i].weight || 0;
      if (bucket < acc) return variants[i];
    }
    return variants[variants.length - 1];
  }

  function loaderGetCookie(name: string): string | null {
    const m = D.cookie.match('(?:^|;)\\s*' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function loaderResolveUrl(url: string): URL | null {
    try {
      return new URL(url);
    } catch {
      /* fall through */
    }
    if (url && url.charAt(0) === '/') {
      try {
        return new URL(url, W.location.origin);
      } catch {
        return null;
      }
    }
    return null;
  }

  function passR(rules: any[]): boolean {
    if (!rules || !rules.length) return true;
    const url = W.location.href;
    for (let j = 0; j < rules.length; j++) {
      if (rules[j].action === 'exclude' && urlM(url, rules[j].match_type, rules[j].value)) return false;
    }
    const inc = rules.filter(function (r: any) {
      return r.action !== 'exclude';
    });
    return !inc.length || inc.some(function (r: any) {
      return urlM(url, r.match_type, r.value);
    });
  }

  try {
    const expById: Record<string, any> = {};
    if (cachedCfg.experiments) {
      for (let ei = 0; ei < cachedCfg.experiments.length; ei++) {
        const cexp = cachedCfg.experiments[ei];
        if (cexp && cexp.id) expById[cexp.id] = cexp;
      }
    }
    const raw = localStorage.getItem('ab_va_' + pk);
    if (raw) {
      const assignments = JSON.parse(raw);
      let applied = false;
      for (const eid in assignments) {
        if (!eligible[eid]) continue;
        const expCfg = expById[eid];
        let a = assignments[eid];
        if (expCfg && expCfg.status === 'rolling_out' && expCfg.rollout_variant_id && expCfg.variants) {
          a = null;
          for (let rvi = 0; rvi < expCfg.variants.length; rvi++) {
            if (expCfg.variants[rvi].id === expCfg.rollout_variant_id) {
              const rolloutVar = expCfg.variants[rvi];
              a = {
                variantId: rolloutVar.id,
                css: rolloutVar.css || null,
                external_css: rolloutVar.external_css || null,
                redirect_url: rolloutVar.redirect_url || null,
                is_control: !!rolloutVar.is_control,
              };
              break;
            }
          }
        }
        if (!a) continue;
        if (a && a.external_css && a.external_css.length) {
          for (let k = 0; k < a.external_css.length; k++) {
            if (
              !D.querySelector(
                'link[data-ab-ext-css="' + a.variantId + '"][href="' + a.external_css[k] + '"]',
              )
            ) {
              const lk = D.createElement('link');
              lk.rel = 'stylesheet';
              lk.href = a.external_css[k];
              lk.setAttribute('data-ab-ext-css', a.variantId);
              D.head.appendChild(lk);
              applied = true;
            }
          }
        }
        if (a && a.css && !D.querySelector('style[data-ab-css="' + a.variantId + '"]')) {
          const s = D.createElement('style');
          s.setAttribute('data-ab-css', a.variantId);
          s.textContent = a.css;
          D.head.appendChild(s);
          applied = true;
        }
      }
      if (applied) {
        W.__ab_reveal();
      }

      const botRe = /bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|duckduck/i;
      if (!botRe.test((navigator && navigator.userAgent) || '')) {
        try {
          const spLoopCheck = new URLSearchParams(W.location.search);
          const loopExpId = spLoopCheck.get('_ab_exp');
          const loopVarId = spLoopCheck.get('_ab_var');
          for (let ri = 0; ri < cachedCfg.experiments.length; ri++) {
            const rexp = cachedCfg.experiments[ri];
            if (
              !rexp ||
              rexp.mode !== 'redirect' ||
              (rexp.status !== 'running' && rexp.status !== 'rolling_out')
            )
              continue;
            if (!passR(rexp.url_rules)) continue;
            const rasn = assignments[rexp.id];
            if (!rasn || !rasn.variantId) continue;
            if (loopExpId === rexp.id && loopVarId === rasn.variantId) continue;
            let rurl = rasn.redirect_url || null;
            if (!rurl && rexp.variants) {
              for (let rv = 0; rv < rexp.variants.length; rv++) {
                if (rexp.variants[rv].id === rasn.variantId) {
                  rurl = rexp.variants[rv].redirect_url || null;
                  break;
                }
              }
            }
            if (!rurl) continue;
            const rdestObj = loaderResolveUrl(rurl);
            if (!rdestObj) continue;
            if (W.location.hostname === rdestObj.hostname && W.location.pathname === rdestObj.pathname)
              continue;
            try {
              rdestObj.searchParams.set('_ab_exp', rexp.id);
              rdestObj.searchParams.set('_ab_var', rasn.variantId);
              W.location.replace(rdestObj.toString());
            } catch {
              /* ignore */
            }
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (cachedCfg && cachedCfg.experiments) {
      const botRe2 = /bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|duckduck/i;
      if (!botRe2.test((navigator && navigator.userAgent) || '')) {
        const vid = loaderGetCookie('_ab_vid');
        if (vid) {
          try {
            const spLp = new URLSearchParams(W.location.search);
            const lpExp = spLp.get('_ab_exp');
            const rawAss = localStorage.getItem('ab_va_' + pk);
            const existingAss = rawAss ? JSON.parse(rawAss) : {};
            for (let ni = 0; ni < cachedCfg.experiments.length; ni++) {
              const nexp = cachedCfg.experiments[ni];
              if (
                !nexp ||
                nexp.mode !== 'redirect' ||
                (nexp.status !== 'running' && nexp.status !== 'rolling_out')
              )
                continue;
              if (!passR(nexp.url_rules)) continue;
              if (existingAss[nexp.id] && existingAss[nexp.id].variantId) continue;
              if (!nexp.variants || !nexp.variants.length) continue;
              if (lpExp === nexp.id) continue;
              const ntpct = nexp.traffic_percentage != null ? nexp.traffic_percentage : 100;
              if (ntpct < 100 && loaderFnv1a(nexp.id + '::traffic::' + vid) % 100 >= ntpct) continue;
              const nv =
                nexp.status === 'rolling_out' && nexp.rollout_variant_id
                  ? (function () {
                      for (let rj = 0; rj < nexp.variants.length; rj++) {
                        if (nexp.variants[rj].id === nexp.rollout_variant_id) return nexp.variants[rj];
                      }
                      return null;
                    })()
                  : loaderAssignVariant(nexp.id, vid, nexp.variants);
              if (!nv || nv.is_control || !nv.redirect_url) continue;
              const ndestObj = loaderResolveUrl(nv.redirect_url);
              if (!ndestObj) continue;
              if (
                W.location.hostname === ndestObj.hostname &&
                W.location.pathname === ndestObj.pathname
              )
                continue;
              try {
                ndestObj.searchParams.set('_ab_exp', nexp.id);
                ndestObj.searchParams.set('_ab_var', nv.id);
                W.location.replace(ndestObj.toString());
              } catch {
                /* ignore */
              }
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
}
