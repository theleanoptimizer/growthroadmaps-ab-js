import type { ExperimentConfig, Variant, UrlRule } from './types';

interface PanelGoal {
  id: string;
  goal_type: string;
  value: string | null;
  url_match_type: string | null;
}

interface PanelExperiment {
  id: string;
  name: string;
  mode: string;
  traffic_percentage: number;
  variants: Variant[];
  url_rules: UrlRule[];
  targeting_rules: Array<{ id: string; attribute: string; operator: string; value: string }>;
  goals?: PanelGoal[];
}

interface PanelConfig {
  experiments: PanelExperiment[];
  domain: string;
}

interface DebugLogEntry {
  time: string;
  type: 'match' | 'skip' | 'goal-match' | 'goal-miss' | 'info';
  message: string;
}

function getPanelStorageKey(): string {
  try {
    const pk = sessionStorage.getItem('_ab_panel_pk');
    return pk ? '_ab_panel_variants_' + pk : '_ab_panel_variants';
  } catch { return '_ab_panel_variants'; }
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

function passesUrlRules(rules: UrlRule[] | undefined): boolean {
  if (!rules?.length) return true;
  const url = window.location.href;
  for (const r of rules) if (r.action === 'exclude' && urlMatch(url, r.match_type, r.value)) return false;
  const inc = rules.filter(r => r.action !== 'exclude');
  return !inc.length || inc.some(r => urlMatch(url, r.match_type, r.value));
}

function devType(): string {
  if (typeof navigator === 'undefined') return 'desktop';
  const u = navigator.userAgent;
  return /Tablet|iPad/i.test(u) ? 'tablet' : /Mobi|Android/i.test(u) ? 'mobile' : 'desktop';
}

function getBrowser(): string {
  if (typeof navigator === 'undefined') return '';
  const u = navigator.userAgent;
  if (/Edg\//i.test(u)) return 'Edge';
  if (/Chrome/i.test(u)) return 'Chrome';
  if (/Firefox/i.test(u)) return 'Firefox';
  if (/Safari/i.test(u)) return 'Safari';
  if (/Opera|OPR/i.test(u)) return 'Opera';
  return '';
}

function getOS(): string {
  if (typeof navigator === 'undefined') return '';
  const u = navigator.userAgent;
  if (/Windows/i.test(u)) return 'Windows';
  if (/Mac OS/i.test(u)) return 'macOS';
  if (/Android/i.test(u)) return 'Android';
  if (/iOS|iPhone|iPad/i.test(u)) return 'iOS';
  if (/Linux/i.test(u)) return 'Linux';
  return '';
}

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

function gc(n: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function evalTargetingRule(r: { attribute: string; operator: string; value: string }): boolean {
  switch (r.attribute) {
    case 'device': return eop(r.operator, devType(), r.value);
    case 'browser': return eop(r.operator, getBrowser(), r.value);
    case 'os': return eop(r.operator, getOS(), r.value);
    case 'language': return eop(r.operator, navigator?.language || '', r.value);
    case 'query_param': {
      const i = r.value.indexOf('=');
      const k = i > -1 ? r.value.slice(0, i) : r.value;
      const v = new URLSearchParams(window.location.search).get(k);
      if (r.operator === 'exists' || r.operator === 'not_exists') return eop(r.operator, v, '');
      return i > -1 ? eop(r.operator, v, r.value.slice(i + 1)) : eop(r.operator, v, r.value);
    }
    case 'cookie': {
      const i = r.value.indexOf('=');
      const k = i > -1 ? r.value.slice(0, i) : r.value;
      const v = gc(k);
      if (r.operator === 'exists' || r.operator === 'not_exists') return eop(r.operator, v, '');
      return i > -1 ? eop(r.operator, v, r.value.slice(i + 1)) : eop(r.operator, v, r.value);
    }
    default: return true;
  }
}

function passesTargetingRules(rules: Array<{ attribute: string; operator: string; value: string }> | undefined): boolean {
  if (!rules?.length) return true;
  return rules.every(evalTargetingRule);
}

function fmtTime(): string {
  const d = new Date();
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function getStoredSelections(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(getPanelStorageKey());
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function setStoredSelections(sel: Record<string, string>): void {
  try { sessionStorage.setItem(getPanelStorageKey(), JSON.stringify(sel)); } catch {}
}

export function applyPanelVariant(exp: PanelExperiment, variantId: string): void {
  const v = exp.variants.find(x => x.id === variantId);
  if (!v) return;

  if (exp.mode === 'client') {
    if (v.external_css && v.external_css.length) {
      for (const href of v.external_css) {
        if (!document.querySelector('link[data-ab-panel-css="' + v.id + '"][href="' + href + '"]')) {
          const lk = document.createElement('link');
          lk.rel = 'stylesheet';
          lk.href = href;
          lk.setAttribute('data-ab-panel-css', v.id);
          document.head.appendChild(lk);
        }
      }
    }
    if (v.css) {
      const attr = 'data-ab-panel-css';
      if (!document.querySelector('style[' + attr + '="' + v.id + '"]')) {
        const s = document.createElement('style');
        s.setAttribute(attr, v.id);
        s.textContent = v.css;
        document.head.appendChild(s);
      }
    }
    if (v.external_js && v.external_js.length) {
      let chain: Promise<void> = Promise.resolve();
      for (const src of v.external_js) {
        chain = chain.then(() => new Promise<void>(resolve => {
          if (document.querySelector('script[data-ab-panel-js="' + v.id + '"][src="' + src + '"]')) { resolve(); return; }
          const sc = document.createElement('script');
          sc.src = src;
          sc.setAttribute('data-ab-panel-js', v.id);
          sc.onload = () => resolve();
          sc.onerror = () => resolve();
          document.head.appendChild(sc);
        }));
      }
      chain.then(() => {
        if (v.js) {
          try {
            const sc = document.createElement('script');
            sc.textContent = '(function(){try{' + v.js + '}catch(e){console.error("[GR Preview]",e)}})();';
            document.head.appendChild(sc);
          } catch {}
        }
      });
    } else if (v.js) {
      try {
        const sc = document.createElement('script');
        sc.textContent = '(function(){try{' + v.js + '}catch(e){console.error("[GR Preview]",e)}})();';
        document.head.appendChild(sc);
      } catch {}
    }
  }

  console.info('[GR] Preview panel: applied ' + v.name + ' (' + exp.name + ')');
}

export function renderPreviewPanel(config: PanelConfig): void {
  const existing = document.getElementById('gr-preview-panel-host');
  if (existing) existing.remove();
  const host = document.createElement('div');
  host.id = 'gr-preview-panel-host';
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });
  const selections = getStoredSelections();
  const currentUrl = window.location.href;

  const experiments = config.experiments.map(exp => {
    const matchesUrl = passesUrlRules(exp.url_rules);
    const matchesTargeting = passesTargetingRules(exp.targeting_rules);
    const matchesPage = matchesUrl && matchesTargeting;
    const selectedVariantId = selections[exp.id] || (exp.variants[0]?.id || '');
    return { ...exp, matchesUrl, matchesTargeting, matchesPage, selectedVariantId };
  });

  const matchedCount = experiments.filter(e => e.matchesPage).length;

  let collapsed = false;
  try { collapsed = sessionStorage.getItem('_ab_panel_collapsed') === '1'; } catch {}

  let debugOn = false;
  try { debugOn = sessionStorage.getItem('_ab_panel_debug') === '1'; } catch {}

  const debugLogs: DebugLogEntry[] = [];
  let debugCleanups: Array<() => void> = [];
  const firedGoalKeys = new Set<string>();

  let renderScheduled = false;
  function addDebugLog(type: DebugLogEntry['type'], message: string) {
    const entry: DebugLogEntry = { time: fmtTime(), type, message };
    debugLogs.push(entry);
    console.log('[GR Debug] Preview: ' + message);
    if (!renderScheduled) {
      renderScheduled = true;
      queueMicrotask(() => { renderScheduled = false; render(); });
    }
  }

  function setupDryRunGoals() {
    teardownDryRunGoals();
    firedGoalKeys.clear();

    for (const exp of experiments) {
      const selectedVariant = exp.variants.find(v => v.id === exp.selectedVariantId);
      const variantLabel = selectedVariant ? selectedVariant.name : 'unknown';

      if (exp.matchesPage) {
        addDebugLog('match', exp.name + ' matched this page → ' + variantLabel);
      } else {
        const reason = !exp.matchesUrl ? 'URL rules not matched' : 'targeting rules not matched';
        addDebugLog('skip', exp.name + ' skipped (' + reason + ')');
      }

      if (!exp.goals?.length || !exp.matchesPage) continue;

      for (const goal of exp.goals) {
        if (goal.goal_type === 'url_match' && goal.value) {
          const matched = urlMatch(window.location.href, goal.url_match_type || 'contains', goal.value);
          if (matched) {
            const k = exp.id + '::url::' + goal.id;
            if (!firedGoalKeys.has(k)) {
              firedGoalKeys.add(k);
              addDebugLog('goal-match', 'URL goal would convert for ' + exp.name + ' → ' + variantLabel + ' (pattern: ' + goal.value + ')');
            }
          } else {
            addDebugLog('goal-miss', 'URL goal not matched for ' + exp.name + ' (pattern: ' + goal.value + ', current: ' + window.location.href + ')');
          }
        }

        if (goal.goal_type === 'click' && goal.value && document) {
          const selector = goal.value;
          const handler = (ev: Event) => {
            const t = ev.target;
            if (!(t instanceof Element)) return;
            const k = exp.id + '::click::' + goal.id;
            if (firedGoalKeys.has(k)) return;
            try {
              if (t.closest(selector)) {
                firedGoalKeys.add(k);
                addDebugLog('goal-match', 'click goal would convert for ' + exp.name + ' → ' + variantLabel + ' (selector: ' + selector + ')');
              } else {
                addDebugLog('goal-miss', 'click goal not matched for ' + exp.name + ' (selector: ' + selector + ', clicked: ' + t.tagName.toLowerCase() + ')');
              }
            } catch {}
          };
          document.addEventListener('click', handler);
          debugCleanups.push(() => document.removeEventListener('click', handler));
        }

        if (goal.goal_type === 'form_submit') {
          const isSelector = goal.url_match_type === 'selector';
          const handler = (ev: Event) => {
            const form = ev.target;
            if (!(form instanceof HTMLFormElement)) return;
            const k = exp.id + '::form::' + goal.id;
            if (firedGoalKeys.has(k)) return;
            let matched = false;
            if (isSelector && goal.value) {
              try { matched = form.matches(goal.value) || !!form.closest(goal.value); } catch {}
            } else {
              const action = form.action || window.location.href;
              matched = !goal.value || urlMatch(action, goal.url_match_type || 'contains', goal.value);
            }
            if (matched) {
              firedGoalKeys.add(k);
              addDebugLog('goal-match', 'form goal would convert for ' + exp.name + ' → ' + variantLabel + ' (' + (isSelector ? 'selector' : 'action URL') + ': ' + (goal.value || '*') + ')');
            } else {
              addDebugLog('goal-miss', 'form goal not matched for ' + exp.name + ' (' + (isSelector ? 'selector' : 'action URL') + ': ' + (goal.value || '*') + ')');
            }
          };
          document.addEventListener('submit', handler);
          debugCleanups.push(() => document.removeEventListener('submit', handler));
        }

        if (goal.goal_type === 'engagement' && goal.value) {
          const engagementTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'IMG']);
          const handler = (ev: Event) => {
            const t = ev.target;
            if (!(t instanceof Element)) return;
            const el = engagementTags.has(t.tagName) ? t : t.closest('a,button,input,textarea,select,label,img');
            if (!el) return;
            const k = exp.id + '::engagement::' + goal.id;
            if (firedGoalKeys.has(k)) return;
            const matched = urlMatch(window.location.href, goal.url_match_type || 'contains', goal.value!);
            if (matched) {
              firedGoalKeys.add(k);
              addDebugLog('goal-match', 'engagement goal would convert for ' + exp.name + ' → ' + variantLabel + ' (pattern: ' + goal.value + ')');
            } else {
              addDebugLog('goal-miss', 'engagement goal not matched for ' + exp.name + ' (pattern: ' + goal.value + ', current: ' + window.location.href + ')');
            }
          };
          document.addEventListener('mousedown', handler);
          debugCleanups.push(() => document.removeEventListener('mousedown', handler));
        }
      }
    }
  }

  function teardownDryRunGoals() {
    for (const cleanup of debugCleanups) cleanup();
    debugCleanups = [];
  }

  if (debugOn) {
    setupDryRunGoals();
  }

  function render() {
    shadow.innerHTML = '';

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .panel-toggle {
        width: 40px; height: 40px; border-radius: 50%; border: none;
        background: #6366f1; color: #fff; cursor: pointer; display: flex;
        align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        transition: transform 0.15s;
      }
      .panel-toggle:hover { transform: scale(1.1); }
      .panel-toggle svg { width: 20px; height: 20px; }
      .badge {
        position: absolute; top: -4px; right: -4px; background: #ef4444;
        color: #fff; font-size: 10px; font-weight: 700; width: 18px; height: 18px;
        border-radius: 50%; display: flex; align-items: center; justify-content: center;
      }
      .panel {
        width: 360px; max-height: 520px; background: #fff; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15); overflow: hidden; display: flex; flex-direction: column;
      }
      .panel-header {
        padding: 12px 16px; background: #6366f1; color: #fff; display: flex;
        align-items: center; justify-content: space-between; font-size: 13px; font-weight: 600;
      }
      .panel-header button {
        background: none; border: none; color: #fff; cursor: pointer; padding: 2px;
        opacity: 0.8; transition: opacity 0.15s;
      }
      .panel-header button:hover { opacity: 1; }
      .panel-body { overflow-y: auto; flex: 1; }
      .exp-item {
        padding: 12px 16px; border-bottom: 1px solid #f1f5f9;
      }
      .exp-item:last-child { border-bottom: none; }
      .exp-name {
        font-size: 13px; font-weight: 600; color: #1e293b; margin-bottom: 2px;
        display: flex; align-items: center; gap: 6px;
      }
      .exp-mode {
        font-size: 10px; background: #e2e8f0; color: #64748b; padding: 1px 6px;
        border-radius: 4px; font-weight: 500; text-transform: uppercase;
      }
      .exp-status {
        font-size: 11px; color: #94a3b8; margin-bottom: 6px;
      }
      .match-badge {
        display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 4px;
        font-weight: 500;
      }
      .match-yes { background: #dcfce7; color: #16a34a; }
      .match-no { background: #fef2f2; color: #ef4444; }
      .variant-select {
        width: 100%; padding: 6px 8px; font-size: 12px; border: 1px solid #e2e8f0;
        border-radius: 6px; background: #fff; color: #1e293b; cursor: pointer;
        outline: none; transition: border-color 0.15s;
      }
      .variant-select:focus { border-color: #6366f1; }
      .variant-select:disabled { opacity: 0.5; cursor: not-allowed; }
      .no-experiments {
        padding: 24px 16px; text-align: center; color: #94a3b8; font-size: 13px;
      }
      .panel-footer {
        padding: 8px 16px; background: #f8fafc; border-top: 1px solid #f1f5f9;
        font-size: 10px; color: #94a3b8; display: flex; align-items: center;
        justify-content: space-between;
      }
      .debug-toggle {
        display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
        border-radius: 4px; border: 1px solid #e2e8f0; background: #fff;
        color: #64748b; font-size: 10px; cursor: pointer; font-weight: 500;
        transition: all 0.15s;
      }
      .debug-toggle:hover { border-color: #6366f1; color: #6366f1; }
      .debug-toggle.active { background: #6366f1; color: #fff; border-color: #6366f1; }
      .debug-toggle svg { width: 12px; height: 12px; }
      .debug-section {
        border-top: 1px solid #e2e8f0; background: #f8fafc;
        max-height: 180px; overflow-y: auto;
      }
      .debug-section-header {
        padding: 6px 16px; font-size: 10px; font-weight: 600; color: #64748b;
        text-transform: uppercase; letter-spacing: 0.5px; background: #f1f5f9;
        position: sticky; top: 0; z-index: 1;
      }
      .debug-entry {
        padding: 4px 16px; font-size: 11px; color: #475569; border-bottom: 1px solid #f1f5f9;
        display: flex; gap: 6px; align-items: flex-start;
      }
      .debug-entry:last-child { border-bottom: none; }
      .debug-time { color: #94a3b8; font-size: 10px; white-space: nowrap; font-family: monospace; }
      .debug-icon { flex-shrink: 0; width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; font-size: 10px; }
      .debug-icon.match { color: #16a34a; }
      .debug-icon.skip { color: #f59e0b; }
      .debug-icon.goal-match { color: #6366f1; }
      .debug-icon.goal-miss { color: #94a3b8; }
      .debug-icon.info { color: #3b82f6; }
      .debug-msg { flex: 1; word-break: break-word; line-height: 1.3; }
      .debug-empty { padding: 12px 16px; text-align: center; color: #94a3b8; font-size: 11px; }
    `;
    shadow.appendChild(style);

    if (collapsed) {
      const toggleWrap = document.createElement('div');
      toggleWrap.style.cssText = 'position:relative;';
      const btn = document.createElement('button');
      btn.className = 'panel-toggle';
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2Z"/></svg>';
      btn.title = 'Open A/B Preview Panel';
      btn.onclick = () => { collapsed = false; try { sessionStorage.setItem('_ab_panel_collapsed', '0'); } catch {} render(); };
      if (matchedCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(matchedCount);
        toggleWrap.appendChild(badge);
      }
      toggleWrap.appendChild(btn);
      shadow.appendChild(toggleWrap);
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'panel';

    const header = document.createElement('div');
    header.className = 'panel-header';
    const headerTitle = document.createElement('span');
    headerTitle.textContent = 'A/B Preview (' + experiments.length + ' experiment' + (experiments.length !== 1 ? 's' : '') + ')';
    header.appendChild(headerTitle);
    const headerBtns = document.createElement('div');
    headerBtns.style.cssText = 'display:flex;align-items:center;gap:4px;';
    const minBtn = document.createElement('button');
    minBtn.title = 'Minimize';
    minBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
    minBtn.onclick = () => { collapsed = true; try { sessionStorage.setItem('_ab_panel_collapsed', '1'); } catch {} render(); };
    headerBtns.appendChild(minBtn);
    const closeBtn = document.createElement('button');
    closeBtn.title = 'Exit Preview';
    closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
    closeBtn.onclick = () => {
      teardownDryRunGoals();
      try {
        const variantsKey = getPanelStorageKey();
        sessionStorage.removeItem(variantsKey);
        sessionStorage.removeItem('_ab_panel_key');
        sessionStorage.removeItem('_ab_panel_pk');
        sessionStorage.removeItem('_ab_panel_collapsed');
        sessionStorage.removeItem('_ab_panel_debug');
      } catch {}
      window.location.reload();
    };
    headerBtns.appendChild(closeBtn);
    header.appendChild(headerBtns);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';

    if (experiments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'no-experiments';
      empty.textContent = 'No running experiments found.';
      body.appendChild(empty);
    } else {
      for (const exp of experiments) {
        const item = document.createElement('div');
        item.className = 'exp-item';

        const nameRow = document.createElement('div');
        nameRow.className = 'exp-name';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = exp.name;
        nameRow.appendChild(nameSpan);
        const modeSpan = document.createElement('span');
        modeSpan.className = 'exp-mode';
        modeSpan.textContent = exp.mode;
        nameRow.appendChild(modeSpan);
        item.appendChild(nameRow);

        const statusRow = document.createElement('div');
        statusRow.className = 'exp-status';
        const matchBadge = document.createElement('span');
        matchBadge.className = 'match-badge ' + (exp.matchesPage ? 'match-yes' : 'match-no');
        matchBadge.textContent = exp.matchesPage ? 'Matches this page' : (!exp.matchesUrl ? 'URL not matched' : 'Targeting not matched');
        statusRow.appendChild(matchBadge);
        item.appendChild(statusRow);

        const select = document.createElement('select');
        select.className = 'variant-select';
        if (!exp.matchesPage) select.disabled = true;
        for (const v of exp.variants) {
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = v.name + (v.is_control ? ' (Control)' : '');
          if (v.id === exp.selectedVariantId) opt.selected = true;
          select.appendChild(opt);
        }
        select.onchange = () => {
          const newSel = { ...getStoredSelections(), [exp.id]: select.value };
          setStoredSelections(newSel);
          window.location.reload();
        };
        item.appendChild(select);
        body.appendChild(item);
      }
    }

    panel.appendChild(body);

    if (debugOn) {
      const debugSection = document.createElement('div');
      debugSection.className = 'debug-section';

      const debugHeader = document.createElement('div');
      debugHeader.className = 'debug-section-header';
      debugHeader.textContent = 'Debug Log';
      debugSection.appendChild(debugHeader);

      if (debugLogs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'debug-empty';
        empty.textContent = 'No debug events yet. Interact with the page to see goal evaluations.';
        debugSection.appendChild(empty);
      } else {
        for (const entry of debugLogs) {
          const row = document.createElement('div');
          row.className = 'debug-entry';

          const timeSpan = document.createElement('span');
          timeSpan.className = 'debug-time';
          timeSpan.textContent = entry.time;
          row.appendChild(timeSpan);

          const iconSpan = document.createElement('span');
          iconSpan.className = 'debug-icon ' + entry.type;
          const iconMap: Record<string, string> = { 'match': '\u2713', 'skip': '\u2014', 'goal-match': '\u25CF', 'goal-miss': '\u25CB', 'info': '\u2139' };
          iconSpan.textContent = iconMap[entry.type] || '\u2022';
          row.appendChild(iconSpan);

          const msgSpan = document.createElement('span');
          msgSpan.className = 'debug-msg';
          msgSpan.textContent = entry.message;
          row.appendChild(msgSpan);

          debugSection.appendChild(row);
        }
      }

      panel.appendChild(debugSection);
    }

    const footer = document.createElement('div');
    footer.className = 'panel-footer';

    const footerText = document.createElement('span');
    footerText.textContent = 'Preview Mode \u2014 tracking disabled';
    footer.appendChild(footerText);

    const debugBtn = document.createElement('button');
    debugBtn.className = 'debug-toggle' + (debugOn ? ' active' : '');
    debugBtn.title = debugOn ? 'Disable debug mode' : 'Enable debug mode';
    debugBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg> Debug';
    debugBtn.onclick = () => {
      debugOn = !debugOn;
      try { sessionStorage.setItem('_ab_panel_debug', debugOn ? '1' : '0'); } catch {}
      if (debugOn) {
        debugLogs.length = 0;
        setupDryRunGoals();
      } else {
        teardownDryRunGoals();
        debugLogs.length = 0;
      }
      render();
    };
    footer.appendChild(debugBtn);

    panel.appendChild(footer);

    shadow.appendChild(panel);
  }

  render();
}
