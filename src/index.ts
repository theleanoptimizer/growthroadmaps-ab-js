import {
  ABTestingConfig,
  ExperimentConfig,
  CachedConfig,
  ProjectInfo,
  TrackOptions,
  Variant,
  UrlRule,
  Goal,
  TargetingRule,
} from './types';
import { assignVariant, fnv1a } from './hasher';
import { getCachedConfig, setCachedConfig, isCacheFresh } from './storage';
import { EventBatcher } from './batcher';
import { getAntiFlickerSnippet, revealPage } from './anti-flicker';

const AB_VID_COOKIE = '_ab_vid';

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, maxAgeDays: number): void {
  if (typeof document === 'undefined') return;
  const maxAge = maxAgeDays * 24 * 60 * 60;
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${maxAge};SameSite=Lax`;
}

function getOrCreateVisitorId(): string {
  const existing = getCookie(AB_VID_COOKIE);
  if (existing) return existing;
  const id = generateUUID();
  setCookie(AB_VID_COOKIE, id, 365);
  return id;
}

export { getAntiFlickerSnippet } from './anti-flicker';
export type { ABTestingConfig, ExperimentConfig, Variant, TrackOptions } from './types';

function matchesUrl(url: string, rule: UrlRule): boolean {
  switch (rule.match_type) {
    case 'exact':
    case 'equals':
      return url === rule.value;
    case 'contains':
      return url.includes(rule.value);
    case 'starts_with':
      return url.startsWith(rule.value);
    case 'regex':
      try {
        return new RegExp(rule.value).test(url);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function getDeviceType(): string {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobi|Android/i.test(ua)) return 'mobile';
  return 'desktop';
}

function getQueryParam(key: string): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(key);
}

function getCookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(name + '='));
  return match ? match.split('=').slice(1).join('=') : null;
}

function getBrowserName(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Safari/i.test(ua)) return 'Safari';
  if (/Opera|OPR/i.test(ua)) return 'Opera';
  return '';
}

function getOSName(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  if (/Android/i.test(ua)) return 'Android';
  if (/iOS|iPhone|iPad/i.test(ua)) return 'iOS';
  return '';
}

function getLanguage(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.language || '';
}

function evaluateTargetingRule(
  rule: TargetingRule,
  _clientKey: string,
  customAttributes?: Record<string, string>
): boolean {
  let attrValue: string | null | undefined;

  switch (rule.attribute) {
    case 'device':
      attrValue = getDeviceType();
      break;
    case 'browser':
      attrValue = getBrowserName();
      break;
    case 'os':
      attrValue = getOSName();
      break;
    case 'language':
      attrValue = getLanguage();
      break;
    case 'country':
      attrValue = customAttributes?.['country'] ?? undefined;
      break;
    case 'query_param': {
      const parts = rule.value.split('=');
      const paramKey = parts[0];
      const paramExpected = parts.slice(1).join('=');
      const paramActual = getQueryParam(paramKey);
      if (rule.operator === 'exists' || rule.operator === 'not_exists') {
        return rule.operator === 'exists' ? paramActual !== null : paramActual === null;
      }
      attrValue = paramActual;
      if (parts.length > 1) {
        return evaluateOperator(rule.operator, paramActual, paramExpected);
      }
      break;
    }
    case 'cookie': {
      const cookieParts = rule.value.split('=');
      const cookieName = cookieParts[0];
      const cookieExpected = cookieParts.slice(1).join('=');
      const cookieActual = getCookieValue(cookieName);
      if (rule.operator === 'exists' || rule.operator === 'not_exists') {
        return rule.operator === 'exists' ? cookieActual !== null : cookieActual === null;
      }
      attrValue = cookieActual;
      if (cookieParts.length > 1) {
        return evaluateOperator(rule.operator, cookieActual, cookieExpected);
      }
      break;
    }
    case 'custom': {
      const customParts = rule.value.split('=');
      const customKey = customParts[0];
      attrValue = customAttributes?.[customKey] ?? undefined;
      if (customParts.length > 1 && rule.operator !== 'exists' && rule.operator !== 'not_exists') {
        const customExpected = customParts.slice(1).join('=');
        return evaluateOperator(rule.operator, attrValue, customExpected);
      }
      break;
    }
    default:
      return true;
  }

  return evaluateOperator(rule.operator, attrValue, rule.value);
}

function evaluateOperator(
  operator: string,
  actual: string | null | undefined,
  expected: string
): boolean {
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'contains':
      return typeof actual === 'string' && actual.includes(expected);
    case 'not_contains':
      return typeof actual === 'string' ? !actual.includes(expected) : true;
    case 'regex':
      try {
        return typeof actual === 'string' && new RegExp(expected).test(actual);
      } catch {
        return false;
      }
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'not_exists':
      return actual === undefined || actual === null || actual === '';
    default:
      return true;
  }
}

export class ABTesting {
  private config: ABTestingConfig;
  private experiments: ExperimentConfig[] = [];
  private project: ProjectInfo | null = null;
  private batcher: EventBatcher;
  private exposedExperiments: Set<string> = new Set();
  private assignedVariants: Map<string, Variant> = new Map();
  private executedVariantCode: Set<string> = new Set();
  private goalCleanups: (() => void)[] = [];
  private firedGoals: Set<string> = new Set();
  private gaFiredExperiments: Set<string> = new Set();
  private isPreviewMode = false;
  private lastUrl: string = typeof window !== 'undefined' ? window.location.href : '';
  private routeChangeCleanup: (() => void) | null = null;
  private injectedExperimentStyles: Map<string, HTMLStyleElement> = new Map();

  constructor(config: ABTestingConfig) {
    if (config.clientKey && !config.projectKey) {
      console.warn('[ABTesting] clientKey is deprecated. Please use projectKey instead.');
      config.projectKey = config.clientKey;
    }
    if (!config.userId && !config.sessionId && typeof document !== 'undefined') {
      config.userId = getOrCreateVisitorId();
    }
    this.config = config;
    this.batcher = new EventBatcher(config.apiHost, config.projectKey || config.clientKey || '');
  }

  private getProjectKey(): string {
    return this.config.projectKey || this.config.clientKey || '';
  }

  private getPreviewToken(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('_ab_preview') || null;
    } catch {
      return null;
    }
  }

  private async handlePreviewMode(token: string): Promise<boolean> {
    try {
      const res = await fetch(this.config.apiHost + '/api/ab/preview/' + encodeURIComponent(token));
      if (!res.ok) return false;
      const data = await res.json();

      this.isPreviewMode = true;

      if (data.mode === 'client') {
        const previewVariant: Variant = {
          id: data.variant_id,
          name: data.variant_name,
          weight: 100,
          js: data.js,
          css: data.css,
        };
        this.injectVariantCode(previewVariant);
      }

      console.info('[ABTesting] Preview mode active — variant: ' + data.variant_name + ' (experiment: ' + data.experiment_name + ')');
      return true;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    try {
      const previewToken = this.getPreviewToken();
      if (previewToken) {
        const handled = await this.handlePreviewMode(previewToken);
        if (handled) return;
      }

      const projectKey = this.getProjectKey();
      const cached = getCachedConfig(projectKey);

      if (cached && isCacheFresh(cached)) {
        this.experiments = cached.experiments;
        this.project = cached.project || null;
        return;
      }

      try {
        const res = await fetch(
          this.config.apiHost + '/api/ab/experiments/all-configs?pk=' + encodeURIComponent(projectKey)
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data.experiments && data.project) {
          this.project = data.project;
          this.experiments = Object.values(data.experiments) as ExperimentConfig[];
        } else {
          this.experiments = Array.isArray(data) ? data : Object.values(data);
        }
        const newCache: CachedConfig = {
          experiments: this.experiments,
          project: this.project || undefined,
          timestamp: Date.now(),
        };
        setCachedConfig(projectKey, newCache);
      } catch {
        if (cached) {
          this.experiments = cached.experiments;
          this.project = cached.project || null;
        } else {
          this.experiments = [];
        }
      }
    } catch {
      this.experiments = [];
    } finally {
      if (this.config.antiFlicker) {
        revealPage();
      }
      this.batcher.start();
      if (!this.isPreviewMode) {
        this.startAllGoalTracking();
        this.installRouteChangeDetection();
      }
    }
  }

  getProject(): ProjectInfo | null {
    return this.project;
  }

  private startAllGoalTracking(): void {
    for (const cleanup of this.goalCleanups) {
      cleanup();
    }
    this.goalCleanups = [];
    this.firedGoals.clear();

    if (typeof window === 'undefined') return;

    const clickGoals: { experimentName: string; goalName: string; selector: string }[] = [];
    for (const experiment of this.experiments) {
      if (experiment.status === 'running' && experiment.goals && experiment.goals.length > 0) {
        for (const goal of experiment.goals) {
          if (goal.goal_type === 'click' && goal.value && typeof document !== 'undefined') {
            clickGoals.push({
              experimentName: experiment.name,
              goalName: this.getGoalName(goal),
              selector: goal.value,
            });
          }
        }
      }
    }

    const delegateClicks = clickGoals.length >= 3;

    for (const experiment of this.experiments) {
      if (
        experiment.status === 'running' &&
        experiment.goals &&
        experiment.goals.length > 0
      ) {
        this.startGoalTracking(experiment.name, experiment.goals, delegateClicks);
      }
    }

    if (delegateClicks && typeof document !== 'undefined') {
      const handler = (e: Event) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        for (const cg of clickGoals) {
          try {
            if (target.closest(cg.selector)) {
              this.trackFor(cg.experimentName, cg.goalName);
            }
          } catch {}
        }
      };
      document.addEventListener('click', handler);
      this.goalCleanups.push(() => {
        document.removeEventListener('click', handler);
      });
    }
  }

  private getGoalName(goal: Goal): string {
    return goal.goal_type + (goal.value ? ':' + goal.value : '');
  }

  private startGoalTracking(experimentName: string, goals: Goal[], delegateClicks: boolean): void {
    for (const goal of goals) {
      const goalName = this.getGoalName(goal);
      switch (goal.goal_type) {
        case 'url_match': {
          this.checkUrlGoal(experimentName, goalName, goal);
          break;
        }
        case 'click': {
          if (!delegateClicks && goal.value && typeof document !== 'undefined') {
            const handler = (e: Event) => {
              const target = e.target;
              if (target instanceof Element && target.closest(goal.value!)) {
                this.trackFor(experimentName, goalName);
              }
            };
            document.addEventListener('click', handler);
            this.goalCleanups.push(() => {
              document.removeEventListener('click', handler);
            });
          }
          break;
        }
        case 'custom':
          break;
      }
    }
  }

  getVariant(experimentName: string, fallback: string): string {
    if (this.isPreviewMode) return fallback;

    const userId = this.config.userId || this.config.sessionId;
    if (!userId) return fallback;

    const experiment = this.experiments.find(
      (e) => e.name === experimentName && e.status === 'running'
    );
    if (!experiment || !experiment.variants || experiment.variants.length === 0) {
      return fallback;
    }

    if (experiment.url_rules && experiment.url_rules.length > 0) {
      if (typeof window !== 'undefined') {
        const currentUrl = window.location.href;
        const excludeRules = experiment.url_rules.filter(r => r.action === 'exclude');
        const includeRules = experiment.url_rules.filter(r => r.action !== 'exclude');

        // Exclude rules: if any match, return fallback
        if (excludeRules.length > 0) {
          const anyExcludeMatch = excludeRules.some(rule => matchesUrl(currentUrl, rule));
          if (anyExcludeMatch) return fallback;
        }

        // Include rules: if any exist and none match, return fallback
        if (includeRules.length > 0) {
          const anyIncludeMatch = includeRules.some(rule => matchesUrl(currentUrl, rule));
          if (!anyIncludeMatch) return fallback;
        }
      }
    }

    if (experiment.targeting_rules && experiment.targeting_rules.length > 0) {
      const allPass = experiment.targeting_rules.every((rule) =>
        evaluateTargetingRule(rule, this.getProjectKey(), this.config.customAttributes)
      );
      if (!allPass) return fallback;
    }

    const trafficPct = experiment.traffic_percentage ?? 100;
    const isExcluded = trafficPct < 100 && !this.isInTraffic(experiment.id, userId, trafficPct);

    let variant = this.assignedVariants.get(experiment.id);
    if (!variant) {
      if (isExcluded) {
        const controlVariant = experiment.variants.find((v) => v.is_control) ||
          experiment.variants.find((v) => v.name.toLowerCase() === 'control') ||
          experiment.variants[0];
        variant = controlVariant;
      } else {
        variant = assignVariant(experiment.id, userId, experiment.variants);
      }
      this.assignedVariants.set(experiment.id, variant);
    }

    if (!this.exposedExperiments.has(experiment.id)) {
      this.exposedExperiments.add(experiment.id);
      this.batcher.push({
        type: 'exposure',
        experiment_id: experiment.id,
        variant_id: variant.id,
        user_id: userId,
        session_id: this.config.sessionId,
        timestamp: new Date().toISOString(),
        ...(isExcluded ? { metadata: { traffic_excluded: true } } : {}),
      });
    }

    if (isExcluded) {
      return variant.name;
    }

    if (experiment.ga) {
      this.fireGaEvent(experiment, variant);
    }

    if (experiment.mode === 'client' && !this.executedVariantCode.has(variant.id)) {
      this.executedVariantCode.add(variant.id);
      this.injectVariantCode(variant, experiment.id);
    }

    return variant.name;
  }

  private isInTraffic(experimentId: string, userId: string, percentage: number): boolean {
    const bucket = fnv1a(experimentId + '::traffic::' + userId) % 100;
    return bucket < percentage;
  }

  private fireGaEvent(experiment: ExperimentConfig, variant: Variant): void {
    if (this.gaFiredExperiments.has(experiment.id)) return;
    try {
      if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
        window.gtag('event', 'ab_assignment', {
          send_to: experiment.ga!.measurement_id,
          [experiment.ga!.dimension_name]: variant.name,
          experiment_id: experiment.id,
          experiment_name: experiment.name,
        });
        this.gaFiredExperiments.add(experiment.id);
      }
    } catch {
    }
  }

  private injectVariantCss(variant: Variant, experimentId: string): void {
    if (typeof document === 'undefined' || !variant.css) return;
    const attrKey = 'data-ab-variant-css';
    const existing = document.querySelector(`style[${attrKey}="${variant.id}"]`);
    if (!existing) {
      const style = document.createElement('style');
      style.setAttribute(attrKey, variant.id);
      style.textContent = variant.css;
      document.head.appendChild(style);
      this.injectedExperimentStyles.set(experimentId, style);
    }
  }

  private injectVariantCode(variant: Variant, experimentId?: string): void {
    if (typeof document === 'undefined') return;

    if (variant.css) {
      const attrKey = 'data-ab-variant-css';
      const existing = document.querySelector(`style[${attrKey}="${variant.id}"]`);
      if (!existing) {
        const style = document.createElement('style');
        style.setAttribute(attrKey, variant.id);
        style.textContent = variant.css;
        document.head.appendChild(style);
        if (experimentId) {
          this.injectedExperimentStyles.set(experimentId, style);
        }
      }
    }

    if (variant.js) {
      try {
        new Function(variant.js)();
      } catch (err) {
        console.error('[ABTesting] Error executing variant JS for ' + variant.name + ':', err);
      }
    }
  }

  track(goalName: string, options?: TrackOptions): void {
    if (this.isPreviewMode) return;
    const userId = this.config.userId || this.config.sessionId;
    if (!userId) return;

    for (const experimentId of this.exposedExperiments) {
      const experiment = this.experiments.find((e) => e.id === experimentId);
      if (!experiment) continue;
      const variant = this.assignedVariants.get(experimentId);
      if (!variant) continue;
      this.batcher.push({
        type: 'conversion',
        experiment_id: experiment.id,
        variant_id: variant.id,
        user_id: userId,
        session_id: this.config.sessionId,
        goal_name: goalName,
        goal_value: options?.value,
        metadata: options?.metadata,
        timestamp: new Date().toISOString(),
      });
    }
  }

  trackFor(experimentName: string, goalName: string, options?: { value?: number }): void {
    if (this.isPreviewMode) return;
    const userId = this.config.userId || this.config.sessionId;
    if (!userId) return;

    const experiment = this.experiments.find((e) => e.name === experimentName);
    if (!experiment) return;
    const variant = this.assignedVariants.get(experiment.id);
    if (!variant) return;

    this.batcher.push({
      type: 'conversion',
      experiment_id: experiment.id,
      variant_id: variant.id,
      user_id: userId,
      session_id: this.config.sessionId,
      goal_name: goalName,
      goal_value: options?.value,
      timestamp: new Date().toISOString(),
    });
  }

  private checkUrlGoal(experimentName: string, goalName: string, goal: Goal): void {
    const goalKey = experimentName + '::' + goalName;
    if (this.firedGoals.has(goalKey)) return;
    if (!goal.value) return;
    const url = window.location.href;
    const goalMatchType = goal.url_match_type || 'contains';
    let matched = false;
    switch (goalMatchType) {
      case 'exact':
      case 'equals':
        matched = url === goal.value;
        break;
      case 'contains':
        matched = url.includes(goal.value);
        break;
      case 'starts_with':
        matched = url.startsWith(goal.value);
        break;
      case 'regex':
        try { matched = new RegExp(goal.value).test(url); } catch { matched = false; }
        break;
      default:
        matched = url.includes(goal.value);
    }
    if (matched) {
      this.firedGoals.add(goalKey);
      this.trackFor(experimentName, goalName);
    }
  }

  private checkAllUrlGoals(): void {
    for (const experiment of this.experiments) {
      if (experiment.status !== 'running' || !experiment.goals) continue;
      for (const goal of experiment.goals) {
        if (goal.goal_type === 'url_match') {
          this.checkUrlGoal(experiment.name, this.getGoalName(goal), goal);
        }
      }
    }
  }

  private experimentMatchesUrl(experiment: ExperimentConfig): boolean {
    if (!experiment.url_rules || experiment.url_rules.length === 0) return true;
    if (typeof window === 'undefined') return true;
    const currentUrl = window.location.href;
    const excludeRules = experiment.url_rules.filter(r => r.action === 'exclude');
    const includeRules = experiment.url_rules.filter(r => r.action !== 'exclude');
    if (excludeRules.length > 0 && excludeRules.some(rule => matchesUrl(currentUrl, rule))) return false;
    if (includeRules.length > 0 && !includeRules.some(rule => matchesUrl(currentUrl, rule))) return false;
    return true;
  }

  private reevaluateClientExperiments(): void {
    const userId = this.config.userId || this.config.sessionId;
    if (!userId) return;

    for (const experiment of this.experiments) {
      if (experiment.status !== 'running' || experiment.mode !== 'client') continue;
      if (!experiment.variants || experiment.variants.length === 0) continue;

      const nowMatches = this.experimentMatchesUrl(experiment);
      const styleTag = this.injectedExperimentStyles.get(experiment.id);

      if (!nowMatches && styleTag) {
        styleTag.remove();
        this.injectedExperimentStyles.delete(experiment.id);
      }

      if (nowMatches && !styleTag) {
        if (experiment.targeting_rules && experiment.targeting_rules.length > 0) {
          const allPass = experiment.targeting_rules.every((rule) =>
            evaluateTargetingRule(rule, this.getProjectKey(), this.config.customAttributes)
          );
          if (!allPass) continue;
        }

        const trafficPct = experiment.traffic_percentage ?? 100;
        const isExcluded = trafficPct < 100 && !this.isInTraffic(experiment.id, userId, trafficPct);
        if (isExcluded) continue;

        let variant = this.assignedVariants.get(experiment.id);
        if (!variant) {
          variant = assignVariant(experiment.id, userId, experiment.variants);
          this.assignedVariants.set(experiment.id, variant);
        }

        if (variant) {
          if (variant.css) {
            this.injectVariantCss(variant, experiment.id);
          }
          if (variant.js && !this.executedVariantCode.has(variant.id)) {
            this.executedVariantCode.add(variant.id);
            try {
              new Function(variant.js)();
            } catch (err) {
              console.error('[ABTesting] Error executing variant JS for ' + variant.name + ':', err);
            }
          }
        }
      }
    }
  }

  private onRouteChange(): void {
    const newUrl = window.location.href;
    if (newUrl === this.lastUrl) return;
    this.lastUrl = newUrl;

    this.checkAllUrlGoals();
    this.reevaluateClientExperiments();
  }

  private installRouteChangeDetection(): void {
    if (typeof window === 'undefined') return;
    if (this.routeChangeCleanup) return;

    const handler = () => this.onRouteChange();

    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function(...args: Parameters<typeof history.pushState>) {
      const result = origPushState.apply(this, args);
      handler();
      return result;
    };

    history.replaceState = function(...args: Parameters<typeof history.replaceState>) {
      const result = origReplaceState.apply(this, args);
      handler();
      return result;
    };

    window.addEventListener('popstate', handler);

    this.routeChangeCleanup = () => {
      history.pushState = origPushState;
      history.replaceState = origReplaceState;
      window.removeEventListener('popstate', handler);
    };
  }

  pageChanged(): void {
    this.lastUrl = '';
    this.onRouteChange();
  }

  destroy(): void {
    this.batcher.destroy();
    for (const cleanup of this.goalCleanups) {
      cleanup();
    }
    this.goalCleanups = [];
    if (this.routeChangeCleanup) {
      this.routeChangeCleanup();
      this.routeChangeCleanup = null;
    }
  }
}

if (typeof window !== 'undefined') {
  window.ABTesting = ABTesting;
  window.getAntiFlickerSnippet = getAntiFlickerSnippet;
  try {
    window.dispatchEvent(new CustomEvent('ab:ready'));
  } catch {}
}
