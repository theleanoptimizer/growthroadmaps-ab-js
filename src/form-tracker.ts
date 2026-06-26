import { EventBatcher } from './batcher';
import { HeatmapFormEvent, HeatmapUrlRule } from './types';

interface FormRefillExample {
  from: string;
  to: string;
}

const SENSITIVE_FIELD_TYPES = new Set(['password', 'hidden']);
const MAX_REFILL_VALUE_LENGTH = 80;

function displayRefillValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '(empty)';
  if (trimmed.length <= MAX_REFILL_VALUE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_REFILL_VALUE_LENGTH)}…`;
}

function sanitizeRefillPair(from: string, to: string, fieldType: string): FormRefillExample | null {
  if (SENSITIVE_FIELD_TYPES.has(fieldType.toLowerCase())) return null;
  if (from === to) return null;
  return { from: displayRefillValue(from), to: displayRefillValue(to) };
}

interface CompiledUrlRule {
  match_type: string;
  value: string;
  regex?: RegExp;
}

interface CompiledFormConfig {
  captureMode: string;
  urlRules: CompiledUrlRule[];
  formSelectors: string[];
}

const MAX_FIELD_LABEL_LENGTH = 120;

function normalizeLabelText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LABEL_LENGTH);
}

/** Resolve a human-readable label for a form field (exported for tests). */
export function getFieldLabel(field: Element): string {
  const input = field as HTMLInputElement;
  if (field.id) {
    const labelFor = field.ownerDocument?.querySelector(`label[for="${CSS.escape(field.id)}"]`);
    if (labelFor?.textContent) {
      const text = normalizeLabelText(labelFor.textContent);
      if (text) return text;
    }
  }

  const wrappingLabel = field.closest('label');
  if (wrappingLabel?.textContent) {
    const text = normalizeLabelText(wrappingLabel.textContent);
    if (text) return text;
  }

  const ariaLabel = field.getAttribute('aria-label');
  if (ariaLabel) {
    const text = normalizeLabelText(ariaLabel);
    if (text) return text;
  }

  const labelledBy = field.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => field.ownerDocument?.getElementById(id)?.textContent ?? '')
      .filter(Boolean);
    if (parts.length > 0) {
      const text = normalizeLabelText(parts.join(' '));
      if (text) return text;
    }
  }

  if (input.name) return input.name;
  if (input.placeholder) return input.placeholder;
  return getSelector(field);
}

interface FieldMetrics {
  selector: string;
  name: string;
  label: string;
  type: string;
  index: number;
  interactions: number;
  focusTime: number;
  totalHesitation: number;
  refills: number;
  refillExamples: FormRefillExample[];
  visitOrder: number;
  valueOnBlur: string;
  hasCompleted: boolean;
  changedSinceReentry: boolean;
  hasFocused: boolean;
  focusStart: number;
}

interface FormState {
  selector: string;
  action: string;
  fields: Map<string, FieldMetrics>;
  visitCounter: number;
  submitted: boolean;
}

export interface FormConfigInput {
  capture_mode: string;
  url_rules: HeatmapUrlRule[];
  form_selectors?: string[];
}

function getSelector(el: Element): string {
  if (el.id) return '#' + el.id;
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).slice(0, 3).join('.');
  const parent = el.parentElement;
  if (!parent) return cls ? `${tag}.${cls}` : tag;
  const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
  const idx = siblings.length > 1 ? `:nth-child(${Array.from(parent.children).indexOf(el) + 1})` : '';
  return cls ? `${tag}.${cls}${idx}` : `${tag}${idx}`;
}

function getFormSelector(form: HTMLFormElement): string {
  if (form.id) return '#' + form.id;
  if (form.name) return `form[name="${form.name}"]`;
  return getSelector(form);
}

function isFormField(el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const tag = el.tagName;
  if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'image';
  }
  return false;
}

import { getDeviceType } from './session-context';
function urlMatch(url: string, type: string, val: string, compiledRegex?: RegExp): boolean {
  switch (type) {
    case 'exact': case 'equals': return url === val;
    case 'contains': return url.includes(val);
    case 'starts_with': return url.startsWith(val);
    case 'regex':
      if (compiledRegex) return compiledRegex.test(url);
      try { return new RegExp(val).test(url); } catch { return false; }
    default: return url.includes(val);
  }
}

export class FormTracker {
  #batcher: EventBatcher;
  #userId: string;
  #sessionId?: string;
  #variantId?: string;
  #consent: () => boolean;
  #currentPageUrl: string;
  #configs: CompiledFormConfig[];
  #tracking = false;
  #sessionSampled: boolean;
  #activeSelectors: string[];
  #forms = new Map<HTMLFormElement, FormState>();
  #flushedForms = new Set<string>();
  #activeField: { form: HTMLFormElement; field: Element } | null = null;
  #cleanups: (() => void)[] = [];

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string | undefined,
    consentCheck: () => boolean,
    formConfigs: FormConfigInput[],
    sessionSampled = true,
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#consent = consentCheck;
    this.#sessionSampled = sessionSampled;
    this.#currentPageUrl = window.location.href;
    this.#activeSelectors = [];

    this.#configs = formConfigs.map(cfg => ({
      captureMode: cfg.capture_mode,
      formSelectors: (cfg.form_selectors || []) as string[],
      urlRules: (cfg.url_rules || []).map(rule => {
        const compiled: CompiledUrlRule = { match_type: rule.match_type, value: rule.value };
        if (rule.match_type === 'regex') {
          try { compiled.regex = new RegExp(rule.value); } catch {}
        }
        return compiled;
      }),
    }));

    if (this.#configs.length === 0) return;

    this.#tracking = this.#shouldTrack();
    this.#attachListeners();
    if (this.#tracking) {
      this.#discoverForms();
    }
  }

  #shouldTrack(): boolean {
    const url = this.#currentPageUrl;
    this.#activeSelectors = [];
    let anyMatch = false;
    let hasUnscopedMatch = false;

    for (const cfg of this.#configs) {
      if (cfg.captureMode === 'all_forms') {
        anyMatch = true;
        hasUnscopedMatch = true;
        continue;
      }
      let urlMatches = false;
      if (cfg.urlRules.length === 0) {
        urlMatches = true;
      } else {
        for (const rule of cfg.urlRules) {
          if (urlMatch(url, rule.match_type, rule.value, rule.regex)) {
            urlMatches = true;
            break;
          }
        }
      }
      if (urlMatches) {
        anyMatch = true;
        if (cfg.formSelectors.length > 0) {
          this.#activeSelectors.push(...cfg.formSelectors);
        } else {
          hasUnscopedMatch = true;
        }
      }
    }

    if (hasUnscopedMatch) {
      this.#activeSelectors = [];
    }

    return anyMatch;
  }

  setVariantId(vid: string): void {
    this.#variantId = vid;
  }

  setSessionSampled(sampled: boolean): void {
    this.#sessionSampled = sampled;
  }

  #matchesSelectors(form: HTMLFormElement): boolean {
    if (this.#activeSelectors.length === 0) return true;
    return this.#activeSelectors.some(sel => {
      try { return form.matches(sel); } catch { return false; }
    });
  }

  #discoverForms(): void {
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
      if (!this.#matchesSelectors(form)) return;
      this.#registerForm(form);
    });
  }

  #registerForm(form: HTMLFormElement): void {
    if (this.#forms.has(form)) return;
    if (!this.#matchesSelectors(form)) return;
    const state: FormState = {
      selector: getFormSelector(form),
      action: form.action || '',
      fields: new Map(),
      visitCounter: 0,
      submitted: false,
    };

    const fields = form.querySelectorAll('input, select, textarea');
    let fieldIndex = 0;
    fields.forEach(field => {
      if (!isFormField(field)) return;
      const sel = getSelector(field);
      state.fields.set(sel, {
        selector: sel,
        name: (field as HTMLInputElement).name || (field as HTMLInputElement).placeholder || sel,
        label: getFieldLabel(field),
        type: field.tagName === 'SELECT' ? 'select' : field.tagName === 'TEXTAREA' ? 'textarea' : (field as HTMLInputElement).type || 'text',
        index: fieldIndex++,
        interactions: 0,
        focusTime: 0,
        totalHesitation: 0,
        refills: 0,
        refillExamples: [],
        visitOrder: 0,
        valueOnBlur: '',
        hasCompleted: false,
        changedSinceReentry: false,
        hasFocused: false,
        focusStart: 0,
      });
    });

    this.#forms.set(form, state);
  }

  #getFieldMetrics(form: HTMLFormElement, field: Element): FieldMetrics | null {
    const state = this.#forms.get(form);
    if (!state) return null;
    const sel = getSelector(field);
    return state.fields.get(sel) || null;
  }

  #attachListeners(): void {
    const onFocus = (e: FocusEvent) => {
      if (!this.#tracking) return;
      const target = e.target;
      if (!(target instanceof Element) || !isFormField(target)) return;
      const form = target.closest('form') as HTMLFormElement | null;
      if (!form) return;
      this.#registerForm(form);
      const metrics = this.#getFieldMetrics(form, target);
      if (!metrics) return;

      metrics.interactions++;
      metrics.hasFocused = true;
      metrics.focusStart = Date.now();

      const state = this.#forms.get(form)!;
      if (metrics.visitOrder === 0) {
        state.visitCounter++;
        metrics.visitOrder = state.visitCounter;
      }

      this.#activeField = { form, field: target };
    };

    const onBlur = (e: FocusEvent) => {
      if (!this.#tracking || !this.#activeField) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const form = target.closest('form') as HTMLFormElement | null;
      if (!form) return;
      const metrics = this.#getFieldMetrics(form, target);
      if (!metrics || !metrics.focusStart) return;

      const duration = Date.now() - metrics.focusStart;
      metrics.totalHesitation += duration;
      metrics.focusStart = 0;
      metrics.valueOnBlur = isFormField(target) ? (target as HTMLInputElement).value || '' : '';
      metrics.hasCompleted = true;
      metrics.changedSinceReentry = false;
      this.#activeField = null;
    };

    const onInput = (e: Event) => {
      if (!this.#tracking) return;
      const target = e.target;
      if (!(target instanceof Element) || !isFormField(target)) return;
      const form = target.closest('form') as HTMLFormElement | null;
      if (!form) return;
      const metrics = this.#getFieldMetrics(form, target);
      if (!metrics) return;

      if (metrics.hasCompleted && !metrics.changedSinceReentry) {
        const currentValue = (target as HTMLInputElement).value || '';
        if (currentValue !== metrics.valueOnBlur) {
          metrics.refills++;
          metrics.changedSinceReentry = true;
          if (metrics.refillExamples.length < 5) {
            const example = sanitizeRefillPair(
              metrics.valueOnBlur,
              currentValue,
              metrics.type,
            );
            if (example) metrics.refillExamples.push(example);
          }
        }
      }
    };

    const onSubmit = (e: Event) => {
      if (!this.#tracking) return;
      const form = e.target as HTMLFormElement;
      if (!(form instanceof HTMLFormElement)) return;
      this.#registerForm(form);
      const state = this.#forms.get(form);
      if (state) {
        state.submitted = true;
        this.#flushForm(form);
      }
    };

    document.addEventListener('focusin', onFocus, { passive: true, capture: true });
    document.addEventListener('focusout', onBlur, { passive: true, capture: true });
    document.addEventListener('input', onInput, { passive: true, capture: true });
    document.addEventListener('submit', onSubmit, { capture: true });

    this.#cleanups.push(() => {
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onBlur, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('submit', onSubmit, true);
    });

    const observer = new MutationObserver(() => {
      if (this.#tracking) this.#discoverForms();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.#cleanups.push(() => observer.disconnect());

    const onHidden = () => {
      if (document.visibilityState === 'hidden') this.#flushAll();
    };
    const onUnload = () => this.#flushAll();

    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('beforeunload', onUnload);
    this.#cleanups.push(() => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('beforeunload', onUnload);
    });
  }

  #flushForm(form: HTMLFormElement): void {
    const state = this.#forms.get(form);
    if (!state) return;

    const dedupeKey = `${this.#sessionId}||${state.selector}||${state.action}`;
    if (this.#flushedForms.has(dedupeKey)) {
      this.#forms.delete(form);
      return;
    }

    const interactedFields = Array.from(state.fields.values()).filter(f => f.interactions > 0 || f.hasFocused);
    if (interactedFields.length === 0) return;

    let lastFocusedField: FieldMetrics | null = null;
    if (!state.submitted) {
      let maxVisitOrder = 0;
      for (const field of interactedFields) {
        if (field.visitOrder > maxVisitOrder) {
          maxVisitOrder = field.visitOrder;
          lastFocusedField = field;
        }
      }
    }

    const fields = interactedFields.map(field => ({
      field_selector: field.selector,
      field_name: field.name,
      field_label: field.label,
      field_type: field.type,
      field_index: field.index,
      interactions: field.interactions,
      is_dropoff: !state.submitted && field === lastFocusedField,
      hesitation_ms: field.totalHesitation,
      refills: field.refills,
      refill_examples: field.refillExamples.length > 0 ? field.refillExamples : undefined,
      visit_order: field.visitOrder,
    }));

    const evt: HeatmapFormEvent = {
      type: 'heatmap_form',
      variant_id: this.#variantId || '',
      user_id: this.#userId,
      session_id: this.#sessionId,
      timestamp: new Date().toISOString(),
      metadata: {
        page_url: this.#currentPageUrl,
        form_selector: state.selector,
        form_action: state.action,
        submitted: state.submitted,
        device_type: getDeviceType(),
        fields,
      },
    };

    if (this.#consent() && this.#sessionSampled) {
      this.#batcher.push(evt);
    }

    this.#flushedForms.add(dedupeKey);
    this.#forms.delete(form);
  }

  #flushAll(): void {
    for (const [form] of this.#forms) {
      this.#flushForm(form);
    }
  }

  pageChanged(): void {
    this.#flushAll();
    this.#currentPageUrl = window.location.href;
    this.#forms.clear();
    this.#flushedForms.clear();
    this.#activeField = null;
    this.#tracking = this.#shouldTrack();
    if (this.#tracking) {
      this.#discoverForms();
    }
  }

  destroy(): void {
    this.#flushAll();
    for (const fn of this.#cleanups) fn();
    this.#cleanups = [];
  }
}
