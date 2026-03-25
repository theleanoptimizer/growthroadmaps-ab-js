import { CachedConfig } from './types';

const CACHE_TTL_MS = 60000;

export function getStorageKey(projectKey: string): string {
  return 'ab_cfg_' + projectKey;
}

export function getCachedConfig(projectKey: string): CachedConfig | null {
  try {
    const raw = localStorage.getItem(getStorageKey(projectKey));
    if (!raw) return null;
    const parsed: CachedConfig = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

export function setCachedConfig(projectKey: string, config: CachedConfig): void {
  try {
    localStorage.setItem(getStorageKey(projectKey), JSON.stringify(config));
  } catch {}
}

export function isCacheFresh(config: CachedConfig): boolean {
  return Date.now() - config.timestamp < CACHE_TTL_MS;
}
