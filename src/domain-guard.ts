import type { ProjectInfo } from './types';

const W = typeof window !== 'undefined' ? window : undefined;

export function normalizeHostname(input: string): string {
  let host = input.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '');
  host = host.replace(/^www\./, '');
  const slash = host.indexOf('/');
  if (slash >= 0) host = host.slice(0, slash);
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  return host;
}

export function hostnameMatchesProjectDomain(hostname: string, projectDomain: string): boolean {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedDomain = normalizeHostname(projectDomain);
  if (!normalizedHost || !normalizedDomain) return false;
  if (normalizedHost === normalizedDomain) return true;
  return normalizedHost.endsWith('.' + normalizedDomain);
}

export function isHostnameAuthorizedForProject(
  hostname: string,
  project: Pick<ProjectInfo, 'domain' | 'tracking_authorized_domains'>,
): boolean {
  if (hostnameMatchesProjectDomain(hostname, project.domain)) return true;
  const normalizedHost = normalizeHostname(hostname);
  for (const entry of project.tracking_authorized_domains ?? []) {
    const normalizedEntry = normalizeHostname(entry);
    if (!normalizedEntry) continue;
    if (normalizedHost === normalizedEntry) return true;
    if (normalizedHost.endsWith('.' + normalizedEntry)) return true;
  }
  return false;
}

export function isCurrentHostnameAuthorized(
  project: Pick<ProjectInfo, 'domain' | 'tracking_authorized_domains'> | null | undefined,
): boolean {
  if (!project?.domain || !W) return true;
  const hostname = normalizeHostname(W.location.hostname);
  if (!hostname) return false;
  return isHostnameAuthorizedForProject(hostname, project);
}
