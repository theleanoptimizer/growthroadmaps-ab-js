/**
 * Pure helpers for stage-configs-for-pages.mjs (unit-tested).
 */

/** Paths like /growth.min.js from a CF Pages deployment manifest. */
export function pickMinJsPaths(files) {
  if (!files || typeof files !== "object") return [];
  return Object.keys(files).filter(
    (path) => path.startsWith("/") && path.endsWith(".min.js") && !path.includes("/", 1),
  );
}

export function pickConfigHashes(files) {
  if (!files) return {};
  return Object.fromEntries(
    Object.entries(files).filter(([path]) => path.startsWith("/configs/")),
  );
}

/**
 * Decide whether a Pages build must fail because it would wipe all configs.
 * priorConfigCount > 0 means the last production deploy had /configs/*.
 */
export function shouldFailOnConfigWipe({ priorConfigCount, staged, skipped, failed }) {
  if (priorConfigCount <= 0) return false;
  return staged === 0;
}

/** Bundle names that are in required list but missing from present set. */
export function missingRequiredBundles(required, presentNames) {
  const present = new Set(presentNames);
  return required.filter((name) => !present.has(name));
}

/**
 * Which prior CDN min.js files should be downloaded into dist?
 * New build output always wins — only fill gaps.
 */
export function minJsGapsToStage(priorMinJsPaths, distFileNames) {
  const present = new Set(distFileNames);
  const gaps = [];
  for (const path of priorMinJsPaths) {
    const name = path.startsWith("/") ? path.slice(1) : path;
    if (!name.endsWith(".min.js")) continue;
    if (!present.has(name)) gaps.push(name);
  }
  return gaps;
}

export function projectKeyFromConfigPath(configPath) {
  const name = configPath.replace(/^\/configs\//, "").replace(/\.json$/, "");
  return decodeURIComponent(name);
}

export function manifestHash(fullHash) {
  return fullHash.slice(0, 32);
}

/** Lock acquire statuses that mean "wait and try again", not fail the build. */
export function isRetryableLockStatus(status) {
  return status === 409 || status === 429 || status === 503;
}
