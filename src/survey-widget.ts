import { SurveyData, SurveyQuestion } from './types';
import { markSurveyShown } from './survey-trigger';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function sanitizeCssValue(value: string): string {
  return value.replace(/[<>"']/g, '');
}

interface SurveyContainer {
  host: HTMLDivElement;
  shadow: ShadowRoot;
}

const MOBILE_POSITION_STYLE_ID = 'growth-surveys-mobile-position';

function ensureMobilePositionStyle(): void {
  if (document.getElementById(MOBILE_POSITION_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MOBILE_POSITION_STYLE_ID;
  style.textContent = '@media (max-width:479px){#growth-surveys-widget:not([data-gs-modal]){top:50%!important;left:50%!important;right:auto!important;bottom:auto!important;transform:translate(-50%,-50%)!important;}}';
  document.head.appendChild(style);
}

function createShadowContainer(): SurveyContainer {
  ensureMobilePositionStyle();
  const host = document.createElement('div');
  host.id = 'growth-surveys-widget';
  host.style.cssText = 'position:fixed;z-index:999999;';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  return { host, shadow };
}

interface ActiveWidget {
  surveyId: string;
  host: HTMLDivElement;
  survey: SurveyData;
}

let activeWidgets: ActiveWidget[] = [];

const SHADOW_MAP: Record<string, string> = {
  none: 'none',
  soft: '0 6px 20px rgba(0,0,0,.12)',
  medium: '0 20px 60px rgba(0,0,0,.25)',
  strong: '0 30px 80px rgba(0,0,0,.4)',
};

function resolveShadow(value: string | undefined): string {
  return SHADOW_MAP[value || 'medium'] || SHADOW_MAP.medium;
}

function hexToRgba(hex: string, opacity: number): string {
  const h = (hex || '').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return 'rgba(0,0,0,' + opacity + ')';
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + opacity + ')';
}

function resolveBackdrop(s: NonNullable<SurveyData['styling']>): { bg: string; blur: number } {
  const color = sanitizeCssValue(s.backdropColor || '#000000');
  const op = typeof s.backdropOpacity === 'number' ? Math.max(0, Math.min(1, s.backdropOpacity)) : 0.5;
  const blur = typeof s.backdropBlur === 'number' ? Math.max(0, Math.min(20, s.backdropBlur)) : 0;
  return { bg: hexToRgba(color, op), blur };
}

function getStyles(styling: SurveyData['styling']): string {
  const s = styling || {};
  const brandColor = sanitizeCssValue(s.brandColor || '#6366f1');
  const bgColor = sanitizeCssValue(s.bgColor || '#ffffff');
  const textColor = sanitizeCssValue(s.textColor || '#1f2937');
  const borderRadius = sanitizeCssValue(s.borderRadius || '8') + 'px';
  const shadow = resolveShadow(s.shadow);
  const backdrop = resolveBackdrop(s);
  const blurCss = backdrop.blur > 0 ? 'backdrop-filter:blur(' + backdrop.blur + 'px);-webkit-backdrop-filter:blur(' + backdrop.blur + 'px);' : '';
  return '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
    '.gs-backdrop{position:fixed;inset:0;background:' + backdrop.bg + ';' + blurCss + 'z-index:0;}' +
    '.gs-card{position:relative;z-index:1;background:' + bgColor + ';color:' + textColor + ';border-radius:' + borderRadius + ';box-shadow:' + shadow + ';width:380px;max-width:calc(100vw - 40px);max-height:80vh;overflow-y:auto;border-top:3px solid ' + brandColor + ';}' +
    '.gs-inner{padding:24px;}' +
    '.gs-close{position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;color:#9ca3af;font-size:18px;line-height:1;}' +
    '.gs-close:hover{color:' + textColor + ';}' +
    '.gs-headline{font-size:16px;font-weight:600;margin-bottom:4px;}' +
    '.gs-desc{font-size:13px;color:#6b7280;margin-bottom:16px;}' +
    '.gs-btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 20px;border-radius:6px;font-size:14px;font-weight:500;cursor:pointer;border:none;transition:opacity .2s;}' +
    '.gs-btn-primary{background:' + brandColor + ';color:#fff;}' +
    '.gs-btn-primary:hover{opacity:.9;}' +
    '.gs-btn-outline{background:transparent;border:1px solid #d1d5db;color:' + textColor + ';}' +
    '.gs-btn-outline:hover{background:#f3f4f6;}' +
    '.gs-input{width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;outline:none;background:' + bgColor + ';color:' + textColor + ';}' +
    '.gs-input:focus{border-color:' + brandColor + ';box-shadow:0 0 0 2px ' + brandColor + '33;}' +
    '.gs-textarea{resize:vertical;min-height:80px;}' +
    '.gs-option{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font-size:14px;margin-bottom:6px;transition:border-color .15s;}' +
    '.gs-option:hover{border-color:' + brandColor + ';}' +
    '.gs-option.selected{border-color:' + brandColor + ';background:' + brandColor + '11;}' +
    '.gs-radio{width:16px;height:16px;border-radius:50%;border:2px solid #d1d5db;display:flex;align-items:center;justify-content:center;flex-shrink:0;}' +
    '.gs-radio.selected{border-color:' + brandColor + ';}' +
    '.gs-radio.selected::after{content:"";width:8px;height:8px;border-radius:50%;background:' + brandColor + ';}' +
    '.gs-checkbox{width:16px;height:16px;border-radius:4px;border:2px solid #d1d5db;display:flex;align-items:center;justify-content:center;flex-shrink:0;}' +
    '.gs-checkbox.selected{border-color:' + brandColor + ';background:' + brandColor + ';}' +
    '.gs-checkbox.selected::after{content:"\\2713";color:#fff;font-size:11px;}' +
    '.gs-progress{width:100%;height:3px;background:#e5e7eb;border-radius:2px;margin-top:16px;}' +
    '.gs-progress-bar{height:100%;border-radius:2px;background:' + brandColor + ';transition:width .3s;}' +
    '.gs-progress-counter{font-size:11px;color:#9ca3af;margin-top:8px;text-align:center;}' +
    '.gs-nav{display:flex;justify-content:space-between;align-items:center;margin-top:16px;}' +
    '.gs-rating{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:8px 0;}' +
    '.gs-rating-num{width:40px;height:40px;border-radius:8px;border:2px solid #d1d5db;background:transparent;color:' + textColor + ';display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;font-weight:600;transition:all .15s;}' +
    '.gs-rating-num:hover{border-color:' + brandColor + ';}' +
    '.gs-rating-num.selected{border-color:' + brandColor + ';background:' + brandColor + ';color:#fff;}' +
    '.gs-rating-smiley{background:none;border:0;padding:4px;border-radius:6px;font-size:24px;line-height:1;cursor:pointer;transition:transform .15s;}' +
    '.gs-rating-smiley:hover{transform:scale(1.1);}' +
    '.gs-rating-smiley.selected{background:#f3f4f6;}' +
    '.gs-star{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;background:none;border:0;padding:2px;transition:transform .15s;}' +
    '.gs-star:hover{transform:scale(1.1);}' +
    '.gs-star svg{width:28px;height:28px;fill:transparent;stroke:#d1d5db;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}' +
    '.gs-star.selected svg{fill:' + brandColor + ';stroke:' + brandColor + ';}' +
    '.gs-nps{display:flex;gap:3px;justify-content:center;flex-wrap:wrap;margin:8px 0;}' +
    '.gs-nps-item{width:30px;height:30px;border:1px solid #d1d5db;border-radius:4px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;font-weight:500;transition:all .15s;}' +
    '.gs-nps-item:hover,.gs-nps-item.selected{border-color:' + brandColor + ';background:' + brandColor + ';color:#fff;}' +
    '.gs-labels{display:flex;justify-content:space-between;font-size:11px;color:#9ca3af;margin-top:4px;}' +
    '.gs-consent{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:14px;}' +
    '.gs-center{text-align:center;}' +
    '.gs-req{color:#ef4444;margin-left:2px;}' +
    '</style>';
}

type AnswerValue = string | number | string[];

function answerStr(v: AnswerValue | undefined): string {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.join(', ');
  return v;
}

function renderQuestion(q: SurveyQuestion, step: number, answers: Record<string, AnswerValue>): string {
  let html = '';
  const answer = answers[q.id];
  html += '<div class="gs-headline">' + escapeHtml(q.headline || 'Question ' + (step + 1)) + (q.required ? '<span class="gs-req">*</span>' : '') + '</div>';
  if (q.description) html += '<div class="gs-desc">' + escapeHtml(q.description) + '</div>';

  switch (q.type) {
    case 'freeText':
      if (q.longAnswer) {
        html += '<textarea class="gs-input gs-textarea" data-qid="' + q.id + '" placeholder="' + escapeHtml(q.placeholder || 'Type here...') + '">' + escapeHtml(answerStr(answer)) + '</textarea>';
      } else {
        html += '<input class="gs-input" data-qid="' + q.id + '" type="' + (q.inputType || 'text') + '" placeholder="' + escapeHtml(q.placeholder || 'Type here...') + '" value="' + escapeHtml(answerStr(answer)) + '">';
      }
      break;
    case 'singleSelect':
      (q.options || []).forEach(function(opt) {
        const sel = answer === opt.label ? ' selected' : '';
        html += '<div class="gs-option' + sel + '" data-qid="' + q.id + '" data-value="' + escapeHtml(opt.label) + '"><div class="gs-radio' + sel + '"></div>' + escapeHtml(opt.label) + '</div>';
      });
      break;
    case 'multiSelect': {
      const selected: string[] = Array.isArray(answer) ? answer : [];
      (q.options || []).forEach(function(opt) {
        const sel = selected.indexOf(opt.label) !== -1 ? ' selected' : '';
        html += '<div class="gs-option' + sel + '" data-qid="' + q.id + '" data-value="' + escapeHtml(opt.label) + '" data-multi="true"><div class="gs-checkbox' + sel + '"></div>' + escapeHtml(opt.label) + '</div>';
      });
      break;
    }
    case 'rating': {
      const shape = q.ratingShape || 'star';
      html += '<div class="gs-rating">';
      const starSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
      const smileys = ['😞','😕','😐','🙂','😃','🤩','😍','🥳','🌟','💯'];
      for (let i = 1; i <= (q.ratingScale || 5); i++) {
        if (shape === 'star') {
          const selected = typeof answer === 'number' && i <= answer;
          html += '<button type="button" class="gs-star' + (selected ? ' selected' : '') + '" data-qid="' + q.id + '" data-value="' + i + '">' + starSvg + '</button>';
        } else if (shape === 'smiley') {
          const isActive = typeof answer === 'number' && i <= answer;
          html += '<button type="button" class="gs-rating-smiley' + (isActive ? ' selected' : '') + '" data-qid="' + q.id + '" data-value="' + i + '">' + smileys[Math.min(i-1, smileys.length-1)] + '</button>';
        } else {
          const isActive = typeof answer === 'number' && i <= answer;
          html += '<button type="button" class="gs-rating-num' + (isActive ? ' selected' : '') + '" data-qid="' + q.id + '" data-value="' + i + '">' + i + '</button>';
        }
      }
      html += '</div>';
    }
      if (q.lowLabel || q.highLabel) html += '<div class="gs-labels"><span>' + escapeHtml(q.lowLabel || '') + '</span><span>' + escapeHtml(q.highLabel || '') + '</span></div>';
      break;
    case 'nps':
      html += '<div class="gs-nps">';
      for (let n = 0; n <= 10; n++) {
        const sel = answer === n ? ' selected' : '';
        html += '<div class="gs-nps-item' + sel + '" data-qid="' + q.id + '" data-value="' + n + '">' + n + '</div>';
      }
      html += '</div>';
      if (q.lowLabel || q.highLabel) html += '<div class="gs-labels"><span>' + escapeHtml(q.lowLabel || '') + '</span><span>' + escapeHtml(q.highLabel || '') + '</span></div>';
      break;
    case 'cta':
      html += '<div class="gs-center"><button class="gs-btn gs-btn-primary" data-qid="' + q.id + '" data-value="clicked">' + escapeHtml(q.buttonLabel || 'Continue') + '</button></div>';
      if (q.dismissible) html += '<div class="gs-center" style="margin-top:8px"><span style="cursor:pointer;font-size:12px;color:#9ca3af" data-qid="' + q.id + '" data-value="dismissed">Skip</span></div>';
      break;
    case 'consent': {
      const checked = answer === 'accepted';
      html += '<div class="gs-consent" data-qid="' + q.id + '"><div class="gs-checkbox' + (checked ? ' selected' : '') + '"></div><span>' + escapeHtml(q.consentLabel || 'I agree') + '</span></div>';
      break;
    }
    case 'date':
      html += '<input class="gs-input" data-qid="' + q.id + '" type="date" value="' + escapeHtml(answerStr(answer)) + '">';
      break;
    default:
      html += '<input class="gs-input" data-qid="' + q.id + '" type="text" placeholder="Type here..." value="' + escapeHtml(answerStr(answer)) + '">';
  }
  return html;
}

export function renderSurveyWidget(
  survey: SurveyData,
  apiHost: string,
  userId: string | null,
  teamId: string,
  shownSurveys: Set<string>,
  sessionId?: string | null,
): void {
  if (shownSurveys.has(survey.id)) return;
  shownSurveys.add(survey.id);
  markSurveyShown(teamId, survey.id);

  const container = createShadowContainer();
  container.host.setAttribute('data-gs-survey-id', survey.id);
  activeWidgets.push({ surveyId: survey.id, host: container.host, survey });

  const styling = survey.styling || {};
  const position = styling.position || 'bottomRight';
  const questions = survey.questions || [];
  const welcomeCard = survey.welcomeCard || { enabled: false };
  const thankYouCard = survey.thankYouCard || { enabled: true, headline: 'Thank you!', description: 'Your response has been recorded.' };
  const settings = survey.settings || {};
  let currentStep = welcomeCard.enabled ? -1 : 0;
  const answers: Record<string, AnswerValue> = {};
  let cachedStyles: string | null = null;

  const positionStyles: Record<string, string> = {
    bottomRight: 'bottom:20px;right:20px;',
    bottomLeft: 'bottom:20px;left:20px;',
    topRight: 'top:20px;right:20px;',
    topLeft: 'top:20px;left:20px;',
    center: 'top:50%;left:50%;transform:translate(-50%,-50%);'
  };
  const isCenterPosition = position === 'center' || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width:479px)').matches);
  const showBackdrop = !!styling.backdrop && isCenterPosition;
  if (showBackdrop) {
    container.host.setAttribute('data-gs-modal', '1');
    container.host.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;';
  } else {
    container.host.style.cssText += positionStyles[position] || positionStyles.bottomRight;
  }
  const backdropClickToClose = !!styling.backdrop && !!styling.backdropClickToClose;
  let prevBodyOverflow: string | null = null;
  if (showBackdrop && typeof document !== 'undefined' && document.body) {
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  function releaseScrollLock(): void {
    if (showBackdrop && typeof document !== 'undefined' && document.body) {
      document.body.style.overflow = prevBodyOverflow || '';
    }
  }
  (container.host as HTMLDivElement & { __gsCleanup?: () => void }).__gsCleanup = releaseScrollLock;

  function buildSurveyMeta(extraMeta: Record<string, unknown>): Record<string, unknown> {
    const baseMeta: Record<string, unknown> = {
      userAgent: navigator.userAgent,
      url: window.location.href,
      referrer: document.referrer,
    };
    if (sessionId) baseMeta.session_id = sessionId;
    if (userId) baseMeta.user_id = userId;
    return { ...baseMeta, ...extraMeta };
  }

  function submitPartialResponse(): void {
    if (Object.keys(answers).length === 0) return;
    const extraMeta = (survey as { meta?: Record<string, unknown> }).meta || {};
    const payload: { data: Record<string, AnswerValue>; meta: Record<string, unknown>; status: string; respondentId?: string } = {
      data: answers,
      meta: buildSurveyMeta(extraMeta),
      status: 'partial'
    };
    if (userId) payload.respondentId = userId;
    fetch(apiHost + '/api/public/surveys/' + survey.id + '/respond', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).catch(function() {});
  }

  function dismissWidget(savePartial: boolean): void {
    if (savePartial && currentStep >= 0 && currentStep < questions.length) submitPartialResponse();
    releaseScrollLock();
    container.host.remove();
    activeWidgets = activeWidgets.filter(w => w.host !== container.host);
  }

  function evaluateLogic(q: SurveyQuestion): string | null {
    if (!q.logic || q.logic.length === 0) return null;
    const answer = answers[q.id];
    for (const rule of q.logic) {
      let match = false;
      switch (rule.condition) {
        case 'submitted': match = answer != null && answer !== ''; break;
        case 'skipped': match = answer == null || answer === ''; break;
        case 'equals': match = String(answer) === String(rule.value); break;
        case 'notEquals': match = String(answer) !== String(rule.value); break;
        case 'contains': match = String(answer || '').indexOf(rule.value || '') !== -1; break;
        case 'greaterThan': match = Number(answer) > Number(rule.value); break;
        case 'lessThan': match = Number(answer) < Number(rule.value); break;
        case 'clicked': match = answer === 'clicked'; break;
        case 'dismissed': match = answer === 'dismissed'; break;
        case 'accepted': match = answer === 'accepted'; break;
      }
      if (match) return rule.destination;
    }
    return null;
  }

  function submitResponse(): void {
    const extraMeta = (survey as { meta?: Record<string, unknown> }).meta || {};
    const payload: { data: Record<string, AnswerValue>; meta: Record<string, unknown>; status: string; respondentId?: string } = {
      data: answers,
      meta: buildSurveyMeta(extraMeta),
      status: 'complete'
    };
    if (userId) payload.respondentId = userId;
    fetch(apiHost + '/api/public/surveys/' + survey.id + '/respond', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).catch(function() {});
  }

  // Conditional rendering — a question is visible only when its `showIf`
  // predicate matches an earlier answer. Used by the exit-intent
  // "purpose of visit" template (Q3 shown only when Q2 = "No").
  function isQuestionVisible(q: SurveyQuestion): boolean {
    if (!q || !q.showIf || !q.showIf.questionId) return true;
    const target = answers[q.showIf.questionId];
    if (target == null || target === '') return false;
    const eq = q.showIf.equals;
    if (Array.isArray(eq)) {
      if (Array.isArray(target)) return eq.some(v => target.indexOf(v) !== -1);
      return eq.indexOf(String(target)) !== -1;
    }
    if (Array.isArray(target)) return target.indexOf(String(eq)) !== -1;
    return String(target) === String(eq);
  }

  function nextVisibleStep(from: number): number {
    let i = from;
    while (i < questions.length && !isQuestionVisible(questions[i])) i++;
    return i;
  }

  function prevVisibleStep(from: number): number {
    let i = from;
    while (i >= 0 && !isQuestionVisible(questions[i])) i--;
    return i;
  }

  function goNext(): void {
    const q = questions[currentStep];
    if (q && q.required) {
      const a = answers[q.id];
      if (a == null || a === '' || (Array.isArray(a) && a.length === 0)) return;
    }
    if (q) {
      const dest = evaluateLogic(q);
      if (dest === 'end') { submitResponse(); currentStep = questions.length; render(); return; }
      if (dest) {
        const idx = questions.findIndex(x => x.id === dest);
        if (idx !== -1) { currentStep = nextVisibleStep(idx); render(); return; }
      }
    }
    currentStep = nextVisibleStep(currentStep + 1);
    if (currentStep >= questions.length) { submitResponse(); }
    render();
  }

  function attachEvents(): void {
    const root = container.shadow;
    root.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', (e: Event) => {
        const action = (e.currentTarget as Element).getAttribute('data-action');
        if (action === 'close') { dismissWidget(false); }
        if (action === 'start') { currentStep = 0; render(); }
        if (action === 'back') { currentStep = Math.max(0, prevVisibleStep(currentStep - 1)); render(); }
        if (action === 'next') { goNext(); }
      });
    });
    root.querySelectorAll('.gs-option:not([data-multi])').forEach(el => {
      el.addEventListener('click', (e: Event) => {
        const qid = (e.currentTarget as Element).getAttribute('data-qid')!;
        answers[qid] = (e.currentTarget as Element).getAttribute('data-value') || '';
        render();
      });
    });
    root.querySelectorAll('.gs-option[data-multi="true"]').forEach(el => {
      el.addEventListener('click', (e: Event) => {
        const qid = (e.currentTarget as Element).getAttribute('data-qid')!;
        const val = (e.currentTarget as Element).getAttribute('data-value')!;
        const curr: string[] = Array.isArray(answers[qid]) ? (answers[qid] as string[]).slice() : [];
        const idx = curr.indexOf(val);
        if (idx !== -1) curr.splice(idx, 1); else curr.push(val);
        answers[qid] = curr;
        render();
      });
    });
    root.querySelectorAll('.gs-rating-num, .gs-rating-smiley, .gs-nps-item, .gs-star').forEach(el => {
      el.addEventListener('click', (e: Event) => {
        const qid = (e.currentTarget as Element).getAttribute('data-qid')!;
        answers[qid] = Number((e.currentTarget as Element).getAttribute('data-value'));
        render();
      });
    });
    root.querySelectorAll('[data-qid][data-value="clicked"], [data-qid][data-value="dismissed"]').forEach(el => {
      if ((el as Element).classList.contains('gs-option') || (el as Element).classList.contains('gs-rating-num') || (el as Element).classList.contains('gs-rating-smiley') || (el as Element).classList.contains('gs-nps-item')) return;
      el.addEventListener('click', (e: Event) => {
        const qid = (e.currentTarget as Element).getAttribute('data-qid')!;
        answers[qid] = (e.currentTarget as Element).getAttribute('data-value') || '';
        goNext();
      });
    });
    root.querySelectorAll('.gs-consent').forEach(el => {
      el.addEventListener('click', (e: Event) => {
        const qid = (e.currentTarget as Element).getAttribute('data-qid')!;
        answers[qid] = answers[qid] === 'accepted' ? 'dismissed' : 'accepted';
        render();
      });
    });
    root.querySelectorAll('.gs-input, .gs-textarea').forEach(el => {
      el.addEventListener('input', (e: Event) => {
        const qid = (e.target as Element).getAttribute('data-qid');
        if (qid) answers[qid] = (e.target as HTMLInputElement).value;
      });
    });
    if (showBackdrop && backdropClickToClose) {
      const backdrop = root.querySelector('.gs-backdrop');
      if (backdrop) {
        backdrop.addEventListener('click', () => { dismissWidget(true); });
      }
    }
  }

  function render(): void {
    if (!cachedStyles) cachedStyles = getStyles(styling);
    let html = cachedStyles;
    if (showBackdrop) html += '<div class="gs-backdrop"></div>';
    html += '<div class="gs-card">';
    html += '<button class="gs-close" data-action="close">&times;</button>';
    html += '<div class="gs-inner">';

    if (currentStep < 0 && welcomeCard.enabled) {
      html += '<div class="gs-center">';
      html += '<div class="gs-headline">' + escapeHtml(welcomeCard.headline || survey.name) + '</div>';
      if (welcomeCard.description) html += '<div class="gs-desc">' + escapeHtml(welcomeCard.description) + '</div>';
      html += '<button class="gs-btn gs-btn-primary" data-action="start">' + escapeHtml(welcomeCard.buttonLabel || 'Start') + '</button>';
      html += '</div>';
    } else if (currentStep >= 0 && currentStep < questions.length) {
      const q = questions[currentStep];
      html += renderQuestion(q, currentStep, answers);
      html += '<div class="gs-nav">';
      if (currentStep > 0 && !settings.hideBackButton) {
        html += '<button class="gs-btn gs-btn-outline" data-action="back">Back</button>';
      } else {
        html += '<div></div>';
      }
      html += '<button class="gs-btn gs-btn-primary" data-action="next">' + (currentStep === questions.length - 1 ? 'Submit' : 'Next') + '</button>';
      html += '</div>';
      const progressStyle: string = styling.progressStyle || (styling.progressBar === false ? 'none' : 'bar');
      if (progressStyle !== 'none' && questions.length > 1) {
        if (progressStyle === 'bar' || progressStyle === 'both') {
          html += '<div class="gs-progress"><div class="gs-progress-bar" style="width:' + ((currentStep + 1) / questions.length * 100) + '%"></div></div>';
        }
        if (progressStyle === 'counter' || progressStyle === 'both') {
          html += '<div class="gs-progress-counter">Question ' + (currentStep + 1) + ' of ' + questions.length + '</div>';
        }
      }
    } else {
      html += '<div class="gs-center">';
      html += '<div class="gs-headline">' + escapeHtml(thankYouCard.headline || 'Thank you!') + '</div>';
      if (thankYouCard.description) html += '<div class="gs-desc">' + escapeHtml(thankYouCard.description) + '</div>';
      html += '<button class="gs-btn gs-btn-outline" data-action="close" style="margin-top:12px">Close</button>';
      html += '</div>';
    }

    html += '</div></div>';
    container.shadow.innerHTML = html;
    attachEvents();
  }

  render();
}

export function removePageUrlWidgets(): { removed: ActiveWidget[] } {
  const toRemove: ActiveWidget[] = [];
  for (const w of activeWidgets) {
    const triggers = w.survey.triggers || [];
    const hasPageUrl = triggers.some(t => t.type === 'pageUrl');
    if (hasPageUrl) {
      const matches = triggers.some(t => {
        if (t.type !== 'pageUrl') return false;
        const url = window.location.href;
        const pattern = t.urlPattern || '';
        const match = t.urlMatch || 'contains';
        if (match === 'exactMatch') return url === pattern;
        if (match === 'contains') return url.indexOf(pattern) !== -1;
        if (match === 'startsWith') return url.indexOf(pattern) === 0;
        if (match === 'endsWith') return url.substring(url.length - pattern.length) === pattern;
        if (match === 'regex') { try { return new RegExp(pattern).test(url); } catch { return false; } }
        return false;
      });
      if (!matches) toRemove.push(w);
    }
  }
  for (const w of toRemove) {
    const cleanup = (w.host as HTMLDivElement & { __gsCleanup?: () => void }).__gsCleanup;
    if (cleanup) cleanup();
    w.host.remove();
    activeWidgets = activeWidgets.filter(a => a !== w);
  }
  return { removed: toRemove };
}
