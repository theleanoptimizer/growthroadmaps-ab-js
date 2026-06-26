import { fnv1a } from './hasher';
import type { ExperimentConfig, TargetingRule, UrlRule } from './types';

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
  isTrackingSessionSampled: (projectKey: string, rate: number) => boolean,
): boolean {
  if (rate >= 1) return true;
  if (shouldBypassTrackingSamplingForExperiments(experiments, assignments, bypassCtx)) {
    return true;
  }
  return isTrackingSessionSampled(projectKey, rate);
}
