/**
 * Sticky per-session sampling for heatmaps + session analysis.
 * One random draw per tab session — included sessions emit all heatmap and
 * session events; excluded sessions emit neither.
 *
 * Visitors actively bucketed into running A/B tests bypass sampling so
 * experiment session analysis and variant heatmaps have complete data.
 */

import { fnv1a } from './hasher';
import type { ExperimentConfig, TargetingRule, UrlRule } from './types';

const DEFAULT_TRACKING_SAMPLING_RATE = 0.2;

export function trackingSamplingStorageKey(projectKey: string): string {
  return `_gr_track_sample_${projectKey || 'default'}`;
}

/** Project-level rate wins; otherwise min of heatmap config rates; else default 20%. */
export function resolveEffectiveTrackingSamplingRate(
  projectRate: number | undefined,
  heatmapConfigRates: number[],
): number {
  if (typeof projectRate === 'number' && projectRate > 0 && projectRate <= 1) {
    return projectRate;
  }
  if (heatmapConfigRates.length > 0) {
    return Math.min(...heatmapConfigRates);
  }
  return DEFAULT_TRACKING_SAMPLING_RATE;
}

export function isTrackingSessionSampled(projectKey: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  try {
    const key = trackingSamplingStorageKey(projectKey);
    const stored = sessionStorage.getItem(key);
    if (stored === '1') return true;
    if (stored === '0') return false;
    const sampled = Math.random() <= rate;
    sessionStorage.setItem(key, sampled ? '1' : '0');
    return sampled;
  } catch {
    return Math.random() <= rate;
  }
}

export function isTrafficExcludedForExperiment(
  experimentId: string,
  userId: string,
  trafficPercentage: number = 100,
): boolean {
  if (trafficPercentage >= 100) return false;
  return fnv1a(experimentId + '::traffic::' + userId) % 100 >= trafficPercentage;
}

function isActiveExperimentStatus(status: string): boolean {
  return status === 'running' || status === 'rolling_out';
}

export interface ExperimentSamplingBypassContext {
  userId: string;
  passesUrlRules: (rules: UrlRule[] | undefined) => boolean;
  passesTargeting: (rules: TargetingRule[] | undefined) => boolean;
}

/** True when the visitor is in-bucket for at least one active, matching experiment. */
export function shouldBypassTrackingSamplingForExperiments(
  experiments: ExperimentConfig[],
  assignments: ReadonlyMap<string, unknown>,
  ctx: ExperimentSamplingBypassContext,
): boolean {
  if (!ctx.userId) return false;
  for (const [expId] of assignments) {
    const exp = experiments.find((x) => x.id === expId);
    if (!exp || !isActiveExperimentStatus(exp.status)) continue;
    if (!ctx.passesUrlRules(exp.url_rules)) continue;
    if (exp.targeting_rules?.length && !ctx.passesTargeting(exp.targeting_rules)) continue;
    if (isTrafficExcludedForExperiment(exp.id, ctx.userId, exp.traffic_percentage ?? 100)) continue;
    return true;
  }
  return false;
}

export function resolveTrackingSessionSampled(
  projectKey: string,
  rate: number,
  experiments: ExperimentConfig[],
  assignments: ReadonlyMap<string, unknown>,
  bypassCtx: ExperimentSamplingBypassContext,
): boolean {
  if (rate >= 1) return true;
  if (shouldBypassTrackingSamplingForExperiments(experiments, assignments, bypassCtx)) {
    return true;
  }
  return isTrackingSessionSampled(projectKey, rate);
}
