import { SurveyData, SurveyTrigger, ExperimentAttachment } from './types';
import { shouldShowToUser, matchTrigger, surveyHasPageUrlTrigger, surveyPageUrlMatches } from './survey-trigger';

interface SurveyWidgetModule {
  renderSurveyWidget: (
    survey: SurveyData,
    apiHost: string,
    userId: string | null,
    teamId: string,
    shown: Set<string>,
    sessionId?: string | null,
  ) => void;
  removePageUrlWidgets: () => void;
  __lazyLoad?: () => Promise<SurveyWidgetModule>;
}

const W = typeof window !== 'undefined' ? window : undefined;
const D = typeof document !== 'undefined' ? document : undefined;

export interface AssignmentInfo { variantId: string; exposedAt: number | null }
export type GetAssignments = () => Map<string, AssignmentInfo>;

export class SurveyManager {
  #apiHost: string;
  #teamId: string;
  #userId: string | null = null;
  #configUserId: string | null = null;
  #sessionId: string | null = null;
  #attrs: Record<string, string> = {};
  #surveys: SurveyData[] = [];
  #shown = new Set<string>();
  #scrollFlags: Array<{ fired: boolean; survey: SurveyData; trigger: SurveyTrigger }> = [];
  #getAssignments: GetAssignments | null = null;
  #routeChangeListeners: Array<() => void> = [];

  constructor(
    apiHost: string,
    teamId: string,
    configUserId?: string,
    getAssignments?: GetAssignments,
    sessionId?: string | null,
  ) {
    this.#apiHost = apiHost;
    this.#teamId = teamId;
    this.#configUserId = configUserId || null;
    this.#sessionId = sessionId || null;
    this.#getAssignments = getAssignments || null;
  }

  async load(): Promise<void> {
    try {
      const r = await fetch(this.#apiHost + '/api/public/surveys/widget/' + this.#teamId);
      if (!r.ok) return;
      this.#surveys = await r.json() || [];
      this.#firePendingPageViews();
      this.#checkTriggers();
    } catch {}
  }

  loadFromData(surveys: SurveyData[]): void {
    this.#surveys = surveys || [];
    this.#firePendingPageViews();
    this.#checkTriggers();
  }

  #pendingKey(): string {
    return '__sm_pv_' + this.#teamId;
  }

  #readPending(): Set<string> {
    try {
      if (!W) return new Set();
      const raw = W.localStorage.getItem(this.#pendingKey());
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr) : new Set();
    } catch { return new Set(); }
  }

  #writePending(s: Set<string>): void {
    try {
      if (!W) return;
      if (s.size === 0) W.localStorage.removeItem(this.#pendingKey());
      else W.localStorage.setItem(this.#pendingKey(), JSON.stringify(Array.from(s)));
    } catch {}
  }

  #markPendingPageView(surveyId: string): void {
    const s = this.#readPending();
    s.add(surveyId);
    this.#writePending(s);
  }

  #clearPendingPageView(surveyId: string): void {
    const s = this.#readPending();
    if (s.delete(surveyId)) this.#writePending(s);
  }

  #firePendingPageViews(): void {
    const pending = this.#readPending();
    if (pending.size === 0) return;
    for (const survey of this.#surveys) {
      if (!pending.has(survey.id)) continue;
      const attachment = this.#matchAttachment(survey);
      if (!attachment || attachment.triggerType !== 'pageView') continue;
      if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
      this.#clearPendingPageView(survey.id);
      this.#showSurvey(survey, attachment);
    }
  }

  async #loadWidget(): Promise<SurveyWidgetModule> {
    const mod = await import('./survey-widget') as SurveyWidgetModule;
    return typeof mod.__lazyLoad === 'function' ? mod.__lazyLoad() : mod;
  }

  /**
   * Returns the matching experiment attachment for the current user, or undefined
   * if the survey is attached to experiments but the user is not in any matching variant.
   * Returns null if the survey has no experiment attachments (always-eligible).
   */
  #matchAttachment(survey: SurveyData): ExperimentAttachment | null | undefined {
    const atts = survey.experimentAttachments || [];
    if (atts.length === 0) return null;
    if (!this.#getAssignments) return undefined;
    const assignments = this.#getAssignments();
    for (const att of atts) {
      const info = assignments.get(att.experimentId);
      if (!info) continue;
      if (att.variantIds && att.variantIds.length > 0 && att.variantIds.indexOf(info.variantId) === -1) continue;
      // Only show to users who were exposed AFTER the attachment was created.
      // This avoids backfilling previously exposed users.
      if (att.createdAt) {
        const attCreated = Date.parse(att.createdAt);
        if (!info.exposedAt || isNaN(attCreated) || info.exposedAt < attCreated) continue;
      }
      return att;
    }
    return undefined;
  }

  async #showSurvey(survey: SurveyData, attachment?: ExperimentAttachment): Promise<void> {
    try {
      const widget = await this.#loadWidget();
      // Inject experiment/variant meta so responses can be grouped per variant.
      if (attachment) {
        const info = this.#getAssignments ? this.#getAssignments().get(attachment.experimentId) : undefined;
        survey.meta = { ...(survey.meta || {}), experiment_id: attachment.experimentId, variant_id: info?.variantId || null };
      }
      widget.renderSurveyWidget(
        survey,
        this.#apiHost,
        this.#userId || this.#configUserId,
        this.#teamId,
        this.#shown,
        this.#sessionId,
      );
    } catch {}
  }

  #scheduleAttachmentTrigger(survey: SurveyData, attachment: ExperimentAttachment): void {
    if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) return;
    switch (attachment.triggerType) {
      case 'delay': {
        const delay = (attachment.delaySeconds || 0) * 1000;
        setTimeout(() => this.#showSurvey(survey, attachment), delay);
        break;
      }
      case 'pageView': {
        // Persist a pending flag so the survey fires on the very next page load,
        // including full (non-SPA) navigations that drop in-memory listeners.
        this.#markPendingPageView(survey.id);
        // Also fire on SPA route change within this session.
        const handler = () => {
          this.#routeChangeListeners = this.#routeChangeListeners.filter((h) => h !== handler);
          this.#clearPendingPageView(survey.id);
          this.#showSurvey(survey, attachment);
        };
        this.#routeChangeListeners.push(handler);
        break;
      }
      case 'exitIntent':
        if (D) {
          const handler = (e: MouseEvent) => {
            if (e.clientY < 0) { D!.removeEventListener('mouseleave', handler); this.#showSurvey(survey, attachment); }
          };
          D.addEventListener('mouseleave', handler);
        }
        break;
      case 'event':
        // event-driven attachments fire via trackAction()
        break;
      case 'conversion':
        // conversion-driven attachments fire via onConversion()
        break;
    }
  }

  /**
   * Called by the experiment client when a conversion is recorded for a
   * specific experiment+goal. Fires any attached survey whose
   * triggerType === 'conversion' and goalId matches, using the same
   * eligibility checks as the event trigger.
   */
  onConversion(experimentId: string, goalId: string): void {
    if (!goalId) return;
    for (const survey of this.#surveys) {
      const atts = survey.experimentAttachments || [];
      for (const att of atts) {
        if (att.triggerType !== 'conversion') continue;
        if (att.experimentId !== experimentId) continue;
        if (att.goalId !== goalId) continue;
        if (!this.#getAssignments) continue;
        const info = this.#getAssignments().get(att.experimentId);
        if (!info) continue;
        if (att.variantIds && att.variantIds.length > 0 && att.variantIds.indexOf(info.variantId) === -1) continue;
        if (att.createdAt) {
          const attCreated = Date.parse(att.createdAt);
          if (!info.exposedAt || isNaN(attCreated) || info.exposedAt < attCreated) continue;
        }
        if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
        this.#showSurvey(survey, att);
      }
    }
  }

  #checkTriggers(): void {
    for (const survey of this.#surveys) {
      const attachment = this.#matchAttachment(survey);
      if (attachment === undefined) continue; // attached but no matching assignment yet
      if (attachment) {
        this.#scheduleAttachmentTrigger(survey, attachment);
        continue;
      }
      // Standard (non-experiment) trigger flow
      if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
      const triggers = survey.triggers || [];
      if (triggers.length === 0) continue;
      const hasPageUrl = surveyHasPageUrlTrigger(survey);
      // URL match acts as a filter for immediate-fire triggers (pageLoad, pageUrl).
      // For event-based triggers (click, scroll, exit) we always register the
      // listener so they survive SPA navigation, and gate at fire-time below.
      const urlMatchesNow = hasPageUrl ? surveyPageUrlMatches(survey) : true;
      const onlyPageUrl = hasPageUrl && triggers.every(t => t.type === 'pageUrl');
      for (const trigger of triggers) {
        if (trigger.type === 'pageUrl') {
          // Preserve legacy behavior: when pageUrl is the ONLY trigger, fire on load.
          if (onlyPageUrl && urlMatchesNow) this.#showSurvey(survey);
          continue;
        }
        if (!matchTrigger(trigger)) continue;
        switch (trigger.type) {
          case 'pageLoad': {
            if (!urlMatchesNow) break;
            const delay = (trigger.delay || 0) * 1000;
            setTimeout(() => this.#showSurvey(survey), delay);
            break;
          }
          case 'exitIntent':
            if (D) {
              const handler = (e: MouseEvent) => {
                if (e.clientY < 0) {
                  D!.removeEventListener('mouseleave', handler);
                  if (hasPageUrl && !surveyPageUrlMatches(survey)) return;
                  this.#showSurvey(survey);
                }
              };
              D.addEventListener('mouseleave', handler);
            }
            break;
          case 'scrollDepth': {
            const flag = { fired: false, survey, trigger };
            this.#scrollFlags.push(flag);
            if (W) {
              let rafPending = false;
              W.addEventListener('scroll', () => {
                if (flag.fired || rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                  rafPending = false;
                  if (flag.fired) return;
                  if (!shouldShowToUser(flag.survey, this.#teamId, this.#shown, this.#attrs)) return;
                  if (surveyHasPageUrlTrigger(flag.survey) && !surveyPageUrlMatches(flag.survey)) return;
                  if (!matchTrigger(flag.trigger)) return;
                  const scrollPct = (W!.scrollY + W!.innerHeight) / D!.documentElement.scrollHeight * 100;
                  if (scrollPct >= 50) { flag.fired = true; this.#showSurvey(flag.survey); }
                });
              });
            }
            break;
          }
          case 'clickElement':
            if (trigger.cssSelector && D) {
              D.addEventListener('click', (e: Event) => {
                if (!(e.target as Element)?.matches?.(trigger.cssSelector!)) return;
                if (hasPageUrl && !surveyPageUrlMatches(survey)) return;
                const delay = (trigger.delay || 0) * 1000;
                setTimeout(() => {
                  if (hasPageUrl && !surveyPageUrlMatches(survey)) return;
                  this.#showSurvey(survey);
                }, delay);
              });
            }
            break;
        }
      }
    }
  }

  /**
   * Re-evaluate experiment-attached surveys after a new exposure so that
   * surveys waiting for a variant assignment can fire.
   */
  onExposure(): void {
    for (const survey of this.#surveys) {
      if ((survey.experimentAttachments || []).length === 0) continue;
      if (this.#shown.has(survey.id)) continue;
      const attachment = this.#matchAttachment(survey);
      if (attachment) this.#scheduleAttachmentTrigger(survey, attachment);
    }
  }

  async onRouteChange(): Promise<void> {
    try {
      const widget = await this.#loadWidget();
      widget.removePageUrlWidgets();
    } catch {}

    for (const flag of this.#scrollFlags) flag.fired = false;

    // Fire any pageView attachment listeners
    const listeners = this.#routeChangeListeners.slice();
    for (const h of listeners) try { h(); } catch {}

    for (const survey of this.#surveys) {
      const attachment = this.#matchAttachment(survey);
      if (attachment === undefined) continue;
      if (attachment) continue; // already scheduled
      if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
      const triggers = survey.triggers || [];
      if (triggers.length === 0) continue;
      const hasPageUrl = surveyHasPageUrlTrigger(survey);
      if (hasPageUrl && !surveyPageUrlMatches(survey)) continue;
      const onlyPageUrl = hasPageUrl && triggers.every(t => t.type === 'pageUrl');
      for (const trigger of triggers) {
        if (trigger.type === 'pageLoad' && trigger.triggerOnRouteChange !== false) {
          const delay = (trigger.delay || 0) * 1000;
          setTimeout(() => this.#showSurvey(survey), delay);
        } else if (trigger.type === 'pageUrl' && onlyPageUrl) {
          this.#showSurvey(survey);
        }
      }
    }
  }

  trackAction(actionName: string): void {
    for (const survey of this.#surveys) {
      const attachment = this.#matchAttachment(survey);
      if (attachment === undefined) continue;
      if (attachment) {
        if (attachment.triggerType === 'event' && attachment.eventName === actionName) {
          if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
          this.#showSurvey(survey, attachment);
        }
        continue;
      }
      if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
      if (surveyHasPageUrlTrigger(survey) && !surveyPageUrlMatches(survey)) continue;
      for (const trigger of (survey.triggers || [])) {
        if (trigger.type === 'code' && trigger.actionName === actionName) {
          this.#showSurvey(survey);
        }
      }
    }
  }

  setUserId(id: string): void { this.#userId = id; }
  setSessionId(id: string | null): void { this.#sessionId = id; }
  setAttribute(key: string, value: string): void { this.#attrs[key] = value; }
  setEmail(email: string): void { this.#attrs.email = email; }
  hasSurveys(): boolean { return this.#surveys.length > 0; }
}
