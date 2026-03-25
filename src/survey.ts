import { SurveyData, SurveyTrigger } from './types';
import { shouldShowToUser, matchTrigger } from './survey-trigger';

interface SurveyWidgetModule {
  renderSurveyWidget: (survey: SurveyData, apiHost: string, userId: string | null, teamId: string, shown: Set<string>) => void;
  removePageUrlWidgets: () => void;
  __lazyLoad?: () => Promise<SurveyWidgetModule>;
}

const W = typeof window !== 'undefined' ? window : undefined;
const D = typeof document !== 'undefined' ? document : undefined;

export class SurveyManager {
  #apiHost: string;
  #teamId: string;
  #userId: string | null = null;
  #configUserId: string | null = null;
  #attrs: Record<string, string> = {};
  #surveys: SurveyData[] = [];
  #shown = new Set<string>();
  #scrollFlags: Array<{ fired: boolean; survey: SurveyData; trigger: SurveyTrigger }> = [];

  constructor(apiHost: string, teamId: string, configUserId?: string) {
    this.#apiHost = apiHost;
    this.#teamId = teamId;
    this.#configUserId = configUserId || null;
  }

  async load(): Promise<void> {
    try {
      const r = await fetch(this.#apiHost + '/api/public/surveys/widget/' + this.#teamId);
      if (!r.ok) return;
      this.#surveys = await r.json() || [];
      this.#checkTriggers();
    } catch {}
  }

  async #loadWidget(): Promise<SurveyWidgetModule> {
    const mod = await import('./survey-widget') as SurveyWidgetModule;
    return typeof mod.__lazyLoad === 'function' ? mod.__lazyLoad() : mod;
  }

  async #showSurvey(survey: SurveyData): Promise<void> {
    try {
      const widget = await this.#loadWidget();
      widget.renderSurveyWidget(survey, this.#apiHost, this.#userId || this.#configUserId, this.#teamId, this.#shown);
    } catch {}
  }

  #checkTriggers(): void {
    for (const survey of this.#surveys) {
      if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
      const triggers = survey.triggers || [];
      if (triggers.length === 0) continue;
      for (const trigger of triggers) {
        if (!matchTrigger(trigger)) continue;
        switch (trigger.type) {
          case 'pageLoad': {
            const delay = (trigger.delay || 0) * 1000;
            setTimeout(() => this.#showSurvey(survey), delay);
            break;
          }
          case 'exitIntent':
            if (D) {
              const handler = (e: MouseEvent) => {
                if (e.clientY < 0) { D!.removeEventListener('mouseleave', handler); this.#showSurvey(survey); }
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
                if ((e.target as Element)?.matches?.(trigger.cssSelector!)) this.#showSurvey(survey);
              });
            }
            break;
          case 'pageUrl':
            this.#showSurvey(survey);
            break;
        }
      }
    }
  }

  async onRouteChange(): Promise<void> {
    try {
      const widget = await this.#loadWidget();
      widget.removePageUrlWidgets();
    } catch {}

    for (const flag of this.#scrollFlags) flag.fired = false;

    for (const survey of this.#surveys) {
      if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
      const triggers = survey.triggers || [];
      if (triggers.length === 0) continue;
      for (const trigger of triggers) {
        if (!matchTrigger(trigger)) continue;
        if (trigger.type === 'pageLoad' && trigger.triggerOnRouteChange !== false) {
          const delay = (trigger.delay || 0) * 1000;
          setTimeout(() => this.#showSurvey(survey), delay);
        } else if (trigger.type === 'pageUrl') {
          this.#showSurvey(survey);
        }
      }
    }
  }

  trackAction(actionName: string): void {
    for (const survey of this.#surveys) {
      if (!shouldShowToUser(survey, this.#teamId, this.#shown, this.#attrs)) continue;
      for (const trigger of (survey.triggers || [])) {
        if (trigger.type === 'code' && trigger.actionName === actionName) {
          this.#showSurvey(survey);
        }
      }
    }
  }

  setUserId(id: string): void { this.#userId = id; }
  setAttribute(key: string, value: string): void { this.#attrs[key] = value; }
  setEmail(email: string): void { this.#attrs.email = email; }
  hasSurveys(): boolean { return this.#surveys.length > 0; }
}
