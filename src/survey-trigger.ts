import { SurveyData, SurveyTrigger } from './types';

const W = typeof window !== 'undefined' ? window : undefined;

function getStorageKey(teamId: string, key: string): string {
  return 'gs_' + teamId + '_' + key;
}

function getStorage(teamId: string, key: string): any {
  try { return JSON.parse(localStorage.getItem(getStorageKey(teamId, key))!); } catch { return null; }
}

function setStorage(teamId: string, key: string, value: any): void {
  try { localStorage.setItem(getStorageKey(teamId, key), JSON.stringify(value)); } catch {}
}

export function markSurveyShown(teamId: string, surveyId: string): void {
  setStorage(teamId, 'shown_' + surveyId, new Date().toISOString());
}

export function shouldShowToUser(
  survey: SurveyData,
  teamId: string,
  shownSurveys: Set<string>,
  userAttributes: Record<string, string>
): boolean {
  if (survey.projectDomain) {
    const hostname = W ? W.location.hostname.replace(/^www\./, '') : '';
    const domain = survey.projectDomain.replace(/^www\./, '');
    if (hostname !== domain && hostname.indexOf('.' + domain) === -1) return false;
  }
  const targeting = survey.targeting || {};
  const pct = targeting.percentage != null ? targeting.percentage : 100;
  if (pct < 100) {
    let rand = getStorage(teamId, 'rand_' + survey.id);
    if (rand == null) { rand = Math.random() * 100; setStorage(teamId, 'rand_' + survey.id, rand); }
    if (rand > pct) return false;
  }
  const freq = targeting.frequency || 'once';
  const shown = getStorage(teamId, 'shown_' + survey.id);
  if (freq === 'once' && shown) return false;
  if (freq === 'oncePerSession' && shownSurveys.has(survey.id)) return false;
  const recontactDays = targeting.recontactDays || 0;
  if (recontactDays > 0 && shown) {
    const lastShown = new Date(shown).getTime();
    if (Date.now() - lastShown < recontactDays * 86400000) return false;
  }
  const attrs = targeting.attributes || [];
  for (const attr of attrs) {
    const val = userAttributes[attr.key];
    if (attr.operator === 'equals' && val !== attr.value) return false;
    if (attr.operator === 'notEquals' && val === attr.value) return false;
    if (attr.operator === 'contains' && (!val || val.indexOf(attr.value) === -1)) return false;
  }
  return true;
}

export function matchTrigger(trigger: SurveyTrigger): boolean {
  if (trigger.type === 'pageUrl') {
    if (!W) return false;
    const url = W.location.href;
    const pattern = trigger.urlPattern || '';
    const match = trigger.urlMatch || 'contains';
    if (match === 'exactMatch') return url === pattern;
    if (match === 'contains') return url.indexOf(pattern) !== -1;
    if (match === 'startsWith') return url.indexOf(pattern) === 0;
    if (match === 'endsWith') return url.substring(url.length - pattern.length) === pattern;
    if (match === 'regex') { try { return new RegExp(pattern).test(url); } catch { return false; } }
    return false;
  }
  return true;
}

export function surveyHasPageUrlTrigger(survey: SurveyData): boolean {
  const triggers = survey.triggers || [];
  for (const t of triggers) {
    if (t.type === 'pageUrl') return true;
  }
  return false;
}

export function surveyPageUrlMatches(survey: SurveyData): boolean {
  const triggers = survey.triggers || [];
  for (const t of triggers) {
    if (t.type === 'pageUrl' && matchTrigger(t)) return true;
  }
  return false;
}
