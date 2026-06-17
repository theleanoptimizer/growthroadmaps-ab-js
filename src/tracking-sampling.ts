/**
 * Sticky per-session sampling for heatmaps + session analysis.
 * One random draw per tab session — included sessions emit all heatmap and
 * session events; excluded sessions emit neither.
 */

export function trackingSamplingStorageKey(projectKey: string): string {
  return `_gr_track_sample_${projectKey || 'default'}`;
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
