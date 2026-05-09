(function() {
  var W = window as any;
  var D = document;

  // Declare the command queue as early as possible so that any inline scripts
  // appearing before the SDK script tag can safely push commands to it.
  W.abq = W.abq || [];

  var cfg = W.__gr_loader_cfg;
  if (!cfg || !cfg.pk) return;
  W.__gr_loader_ran = true;
  var pk = cfg.pk as string;
  var host = cfg.host as string;

  D.documentElement.style.opacity = '0';
  var t = setTimeout(function() { D.documentElement.style.opacity = '1'; }, 1000);
  W.__ab_reveal = function() { clearTimeout(t); D.documentElement.style.opacity = '1'; };

  // _ab_vid is set by the main SDK on load — no need to pre-generate here.

  if (host) {
    var link = D.createElement('link');
    link.rel = 'preconnect';
    link.href = host;
    D.head.appendChild(link);
  }

  function urlM(url: string, type: string, val: string): boolean {
    return (type === 'exact' || type === 'equals') ? url === val :
      type === 'contains' ? url.indexOf(val) !== -1 :
      type === 'starts_with' ? url.indexOf(val) === 0 :
      type === 'regex' ? (function() { try { return new RegExp(val).test(url); } catch(e) { return false; } })() :
      url.indexOf(val) !== -1;
  }

  // Inline FNV1a-32 — exact match of sdk-client/src/hasher.ts using Math.imul for overflow.
  function loaderFnv1a(str: string): number {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  // Assign a variant — exact match of assignVariant in sdk-client/src/hasher.ts.
  // Buckets by fnv1a(expId+'::'+uid) % 100, then walks cumulative weight.
  function loaderAssignVariant(expId: string, uid: string, variants: any[]): any {
    var bucket = loaderFnv1a(expId + '::' + uid) % 100;
    var acc = 0;
    for (var i = 0; i < variants.length; i++) {
      acc += (variants[i].weight || 0);
      if (bucket < acc) return variants[i];
    }
    return variants[variants.length - 1];
  }

  // Read a cookie value by name.
  function loaderGetCookie(name: string): string | null {
    var m = D.cookie.match('(?:^|;)\\s*' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Resolve a redirect URL — supports both absolute URLs and root-relative paths (/path).
  function loaderResolveUrl(url: string): URL | null {
    try {
      // Try absolute first
      return new URL(url);
    } catch (_) {}
    // Fall back to resolving relative to current origin
    if (url && url.charAt(0) === '/') {
      try { return new URL(url, W.location.origin); } catch (_) {}
    }
    return null;
  }

  function passR(rules: any[]): boolean {
    if (!rules || !rules.length) return true;
    var url = W.location.href;
    for (var j = 0; j < rules.length; j++) {
      if (rules[j].action === 'exclude' && urlM(url, rules[j].match_type, rules[j].value)) return false;
    }
    var inc = rules.filter(function(r: any) { return r.action !== 'exclude'; });
    return !inc.length || inc.some(function(r: any) { return urlM(url, r.match_type, r.value); });
  }

  try {
    var cfgRaw = localStorage.getItem('ab_cfg_' + pk);
    var cachedCfg = cfgRaw ? JSON.parse(cfgRaw) : null;
    if (cachedCfg && cachedCfg.timestamp && (Date.now() - cachedCfg.timestamp > 60000)) {
      cachedCfg = null;
    }
    var eligible: Record<string, boolean> = {};
    if (cachedCfg && cachedCfg.experiments) {
      for (var i = 0; i < cachedCfg.experiments.length; i++) {
        var exp = cachedCfg.experiments[i];
        if (exp.status === 'running' && passR(exp.url_rules)) {
          eligible[exp.id] = true;
        }
      }
    }

    if (cachedCfg) {
      var raw = localStorage.getItem('ab_va_' + pk);
      if (raw) {
        var assignments = JSON.parse(raw);
        var applied = false;
        for (var eid in assignments) {
          if (!eligible[eid]) continue;
          var a = assignments[eid];
          if (a && a.external_css && a.external_css.length) {
            for (var k = 0; k < a.external_css.length; k++) {
              if (!D.querySelector('link[data-ab-ext-css="' + a.variantId + '"][href="' + a.external_css[k] + '"]')) {
                var lk = D.createElement('link');
                lk.rel = 'stylesheet';
                lk.href = a.external_css[k];
                lk.setAttribute('data-ab-ext-css', a.variantId);
                D.head.appendChild(lk);
                applied = true;
              }
            }
          }
          if (a && a.css && !D.querySelector('style[data-ab-css="' + a.variantId + '"]')) {
            var s = D.createElement('style');
            s.setAttribute('data-ab-css', a.variantId);
            s.textContent = a.css;
            D.head.appendChild(s);
            applied = true;
          }
          // external_js deferred to main SDK — JS doesn't affect initial paint.
        }
        // syncExpCookie() is called by main SDK inside saveAssignments() on every load.
        if (applied) {
          W.__ab_reveal();
        }

        // Redirect mode: perform early redirect before page paint for assigned
        // non-control variants (returning visitor with saved assignment).
        // Checks bots and loop-protection query param.
        var botRe = /bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|duckduck/i;
        if (!botRe.test((navigator && navigator.userAgent) || '')) {
          try {
            var spLoopCheck = new URLSearchParams(W.location.search);
            var loopExpId = spLoopCheck.get('_ab_exp');
            var loopVarId = spLoopCheck.get('_ab_var');
            for (var ri = 0; ri < cachedCfg.experiments.length; ri++) {
              var rexp = cachedCfg.experiments[ri];
              if (!rexp || rexp.mode !== 'redirect' || rexp.status !== 'running') continue;
              if (!passR(rexp.url_rules)) continue;
              var rasn = assignments[rexp.id];
              if (!rasn || !rasn.variantId) continue;
              // Loop protection: _ab_exp + _ab_var on the destination page means already redirected
              if (loopExpId === rexp.id && loopVarId === rasn.variantId) continue;
              // Find redirect_url: first from saved assignment, then from variant config
              var rurl = rasn.redirect_url || null;
              if (!rurl && rexp.variants) {
                for (var rv = 0; rv < rexp.variants.length; rv++) {
                  if (rexp.variants[rv].id === rasn.variantId) {
                    rurl = rexp.variants[rv].redirect_url || null;
                    break;
                  }
                }
              }
              if (!rurl) continue;
              // Skip if we are already on the destination (path + host match)
              var rdestObj = loaderResolveUrl(rurl);
              if (!rdestObj) continue;
              if (W.location.hostname === rdestObj.hostname && W.location.pathname === rdestObj.pathname) continue;
              // Redirect with loop-protection params (_ab_exp + _ab_var) — do NOT reveal (page won't paint)
              try {
                rdestObj.searchParams.set('_ab_exp', rexp.id);
                rdestObj.searchParams.set('_ab_var', rasn.variantId);
                W.location.replace(rdestObj.toString());
              } catch (re3) {}
              break;
            }
          } catch (re4) {}
        }
      }
    }

    // Redirect mode pre-paint bucketing for returning visitors who have a cached config
    // but no saved assignment for a redirect experiment (e.g. newly launched experiment).
    // Reads visitor ID from _ab_vid cookie to produce a deterministic variant assignment,
    // then redirects before the main SDK script tag loads.
    if (cachedCfg && cachedCfg.experiments) {
      var botRe2 = /bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|duckduck/i;
      if (!botRe2.test((navigator && navigator.userAgent) || '')) {
        var vid = loaderGetCookie('_ab_vid');
        if (vid) {
          try {
            var spLp = new URLSearchParams(W.location.search);
            var lpExp = spLp.get('_ab_exp');
            var lpVar = spLp.get('_ab_var');
            var rawAss = localStorage.getItem('ab_va_' + pk);
            var existingAss = rawAss ? JSON.parse(rawAss) : {};
            for (var ni = 0; ni < cachedCfg.experiments.length; ni++) {
              var nexp = cachedCfg.experiments[ni];
              if (!nexp || nexp.mode !== 'redirect' || nexp.status !== 'running') continue;
              if (!passR(nexp.url_rules)) continue;
              // Only act if there is NO saved assignment for this experiment
              if (existingAss[nexp.id] && existingAss[nexp.id].variantId) continue;
              if (!nexp.variants || !nexp.variants.length) continue;
              // Loop protection
              if (lpExp === nexp.id) continue;
              // Traffic percentage enforcement (mirrors assignVariant traffic-exclusion logic)
              var ntpct = nexp.traffic_percentage != null ? nexp.traffic_percentage : 100;
              if (ntpct < 100 && (loaderFnv1a(nexp.id + '::traffic::' + vid) % 100) >= ntpct) continue;
              // Bucket visitor deterministically
              var nv = loaderAssignVariant(nexp.id, vid, nexp.variants);
              if (!nv || nv.is_control || !nv.redirect_url) continue;
              // Skip if already on destination
              var ndestObj = loaderResolveUrl(nv.redirect_url);
              if (!ndestObj) continue;
              if (W.location.hostname === ndestObj.hostname && W.location.pathname === ndestObj.pathname) continue;
              // Redirect with loop-protection params — do NOT reveal (page won't paint)
              try {
                ndestObj.searchParams.set('_ab_exp', nexp.id);
                ndestObj.searchParams.set('_ab_var', nv.id);
                W.location.replace(ndestObj.toString());
              } catch (ne3) {}
              break;
            }
          } catch (ne4) {}
        }
      }
    }
  } catch(e) {}

  var sc = D.createElement('script');
  sc.src = 'https://js.growthroadmaps.com/growth.min.js';
  sc.async = true;
  D.head.appendChild(sc);
})();
