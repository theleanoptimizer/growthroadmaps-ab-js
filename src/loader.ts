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

  var ck = '_ab_vid';
  var cm = D.cookie.match(new RegExp('(?:^|;\\s*)' + ck + '=([^;]*)'));
  if (!cm) {
    var id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    D.cookie = ck + '=' + encodeURIComponent(id) + ';path=/;max-age=31536000;SameSite=Lax';
  }

  if (host) {
    var link = D.createElement('link');
    link.rel = 'preconnect';
    link.href = host;
    D.head.appendChild(link);
  }

  function urlM(url: string, type: string, val: string): boolean {
    if (type === 'exact' || type === 'equals') return url === val;
    if (type === 'contains') return url.indexOf(val) !== -1;
    if (type === 'starts_with') return url.indexOf(val) === 0;
    if (type === 'regex') { try { return new RegExp(val).test(url); } catch(e) { return false; } }
    return url.indexOf(val) !== -1;
  }

  function passR(rules: any[]): boolean {
    if (!rules || !rules.length) return true;
    var url = W.location.href;
    for (var j = 0; j < rules.length; j++) {
      if (rules[j].action === 'exclude' && urlM(url, rules[j].match_type, rules[j].value)) return false;
    }
    var inc = [];
    for (var j = 0; j < rules.length; j++) {
      if (rules[j].action !== 'exclude') inc.push(rules[j]);
    }
    if (!inc.length) return true;
    for (var j = 0; j < inc.length; j++) {
      if (urlM(url, inc[j].match_type, inc[j].value)) return true;
    }
    return false;
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
          if (a && a.external_js && a.external_js.length) {
            for (var m = 0; m < a.external_js.length; m++) {
              if (!D.querySelector('script[data-ab-ext-js="' + a.variantId + '"][src="' + a.external_js[m] + '"]')) {
                (function(src: string, vid: string) {
                  var ejs = D.createElement('script');
                  ejs.src = src;
                  ejs.setAttribute('data-ab-ext-js', vid);
                  ejs.onload = function() { ejs.setAttribute('data-ab-loaded', '1'); };
                  ejs.onerror = function() { ejs.setAttribute('data-ab-loaded', '1'); };
                  D.head.appendChild(ejs);
                })(a.external_js[m], a.variantId);
              }
            }
          }
        }
        var expLabels = [];
        if (cachedCfg.experiments) {
          for (var eid2 in assignments) {
            var ae = assignments[eid2];
            if (!ae) continue;
            for (var ei = 0; ei < cachedCfg.experiments.length; ei++) {
              var ce = cachedCfg.experiments[ei];
              if (ce.id === eid2 && ce.sequence_number != null) {
                for (var vi = 0; vi < ce.variants.length; vi++) {
                  if (ce.variants[vi].id === ae.variantId && ce.variants[vi].index != null) {
                    expLabels.push("EXP-" + ce.sequence_number + "-" + ce.variants[vi].index);
                    break;
                  }
                }
                break;
              }
            }
          }
        }
        D.cookie = "_ab_exp=" + encodeURIComponent(expLabels.join(",")) + ";path=/;max-age=31536000;SameSite=Lax";
        if (applied) {
          W.__ab_reveal();
        }
      }
    }
  } catch(e) {}

  var sc = D.createElement('script');
  sc.src = 'https://js.growthroadmaps.com/growth.min.js';
  sc.async = true;
  D.head.appendChild(sc);
})();
