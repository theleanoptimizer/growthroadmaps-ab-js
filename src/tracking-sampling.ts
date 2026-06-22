/**
 * Sticky per-session sampling for heatmaps + session analysis.
 * One random draw per tab session — included sessions emit all heatmap and
 * session events; excluded sessions emit neither.
 */

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
