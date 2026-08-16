/**
 * Post-build step for the growthroadmaps-ab-js Cloudflare Pages project.
 *
 * Git-based Pages deploys replace the entire site with dist/. This script:
 *   1. Acquires the shared CDN deploy lock (same Redis key as Heroku wrangler)
 *   2. Asserts required SDK bundles exist in dist/
 *   3. Copies prior production *.min.js gaps into dist/ (new build wins)
 *   4. Copies /configs/*.json so SDK deploys do not wipe configs
 *   5. Heartbeats the lock so Heroku cannot race Pages upload/activate
 *
 * Discovery order for configs:
 *   1. Recent Cloudflare Pages deployment manifests (needs CF env vars)
 *   2. Fallback: GET growthroadmaps.com/api/sdk/config-keys.json
 *
 * Optional Cloudflare Pages build env vars:
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SDK_CONFIG_KEYS_TOKEN
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  manifestHash,
  minJsGapsToStage,
  pickConfigHashes,
  pickMinJsPaths,
  projectKeyFromConfigPath,
  shouldFailOnConfigWipe,
  isRetryableLockStatus,
  shouldSkipConfigStaging,
} from "./stage-configs-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "dist");
const CONFIG_OUT_DIR = join(DIST_DIR, "configs");
const REQUIRED_BUNDLES_PATH = join(__dirname, "..", "required-bundles.json");

const PAGES_PROJECT_NAME = "growthroadmaps-ab-js";
const CONFIG_API_BASE = "https://growthroadmaps.com/api/sdk/config/";
const CONFIG_KEYS_API = "https://growthroadmaps.com/api/sdk/config-keys.json";
const CONFIG_CDN_BASE = "https://js.growthroadmaps.com/configs/";
const SDK_CDN_BASE = "https://js.growthroadmaps.com";
const LOCK_API_BASE = "https://growthroadmaps.com/api/sdk/cdn-deploy-lock";
const FETCH_CONCURRENCY = 4;
const LOCK_RETRY_MS = 120_000;
const LOCK_RETRY_INTERVAL_MS = 5_000;
const LOCK_ACQUIRE_TTL_SEC = 600;
const LOCK_ACTIVATE_TTL_SEC = 600;

/** Refuse Pages deploys that would ship growth.min.js without lazy chunks. */
async function assertRequiredBundlesInDist() {
  const required = JSON.parse(await readFile(REQUIRED_BUNDLES_PATH, "utf8"));
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error(
      "[stage-configs] required-bundles.json is empty or invalid — refusing deploy that could wipe lazy chunks",
    );
  }
  const missing = [];
  for (const name of required) {
    try {
      const s = await stat(join(DIST_DIR, name));
      if (!s.size) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  if (missing.length) {
    throw new Error(
      `[stage-configs] Required SDK bundles missing from dist/ — refusing deploy: ${missing.join(", ")}. ` +
        `Preview panel (gr-panels.min.js) and other lazy features will 404 on js.growthroadmaps.com without these files.`,
    );
  }
  return required;
}

function authHeaders() {
  const token = process.env.SDK_CONFIG_KEYS_TOKEN?.trim();
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquireDeployLock(holder) {
  if (!process.env.SDK_CONFIG_KEYS_TOKEN?.trim()) {
    console.warn(
      "[stage-configs] SDK_CONFIG_KEYS_TOKEN not set — skipping CDN deploy lock (local/dev only)",
    );
    return null;
  }

  const deadline = Date.now() + LOCK_RETRY_MS;
  let lastMessage = "lock unavailable";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(LOCK_API_BASE, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ holder, ttlSec: LOCK_ACQUIRE_TTL_SEC }),
      });
      if (res.ok) {
        console.log(`[stage-configs] Acquired CDN deploy lock as ${holder}`);
        return holder;
      }
      const body = await res.json().catch(() => ({}));
      lastMessage = body.message || `HTTP ${res.status}`;
      if (res.status === 401) {
        throw new Error(
          `[stage-configs] CDN deploy lock unauthorized — check SDK_CONFIG_KEYS_TOKEN on Pages`,
        );
      }
      if (!isRetryableLockStatus(res.status)) {
        throw new Error(`[stage-configs] CDN deploy lock failed: ${lastMessage}`);
      }
      console.warn(
        `[stage-configs] CDN deploy lock held (${lastMessage}) — retrying…`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("[stage-configs]")) throw err;
      lastMessage = err instanceof Error ? err.message : String(err);
      console.warn(`[stage-configs] CDN deploy lock request failed: ${lastMessage}`);
    }
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }

  throw new Error(
    `[stage-configs] Could not acquire CDN deploy lock within ${LOCK_RETRY_MS / 1000}s — ${lastMessage}. ` +
      `Refusing deploy to avoid racing a Heroku wrangler full-site replace.`,
  );
}

async function heartbeatDeployLock(holder) {
  if (!holder) return;
  try {
    const res = await fetch(`${LOCK_API_BASE}/heartbeat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ holder, ttlSec: LOCK_ACTIVATE_TTL_SEC }),
    });
    if (res.ok) {
      console.log(
        `[stage-configs] Heartbeat CDN deploy lock (${LOCK_ACTIVATE_TTL_SEC}s activate window)`,
      );
      return;
    }
    const body = await res.json().catch(() => ({}));
    console.warn(
      `[stage-configs] Lock heartbeat failed (${res.status}): ${body.message || "unknown"}`,
    );
  } catch (err) {
    console.warn("[stage-configs] Lock heartbeat error:", err);
  }
}

async function releaseDeployLock(holder) {
  if (!holder) return;
  try {
    const res = await fetch(
      `${LOCK_API_BASE}?holder=${encodeURIComponent(holder)}`,
      { method: "DELETE", headers: authHeaders() },
    );
    if (res.ok) {
      console.log("[stage-configs] Released CDN deploy lock after failure");
    }
  } catch (err) {
    console.warn("[stage-configs] Lock release error:", err);
  }
}

async function fetchRecentDeploymentDetails() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.warn(
      "[stage-configs] CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set — manifest discovery skipped",
    );
    return [];
  }

  const headers = { Authorization: `Bearer ${apiToken}` };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${PAGES_PROJECT_NAME}`;

  try {
    const listRes = await fetch(`${base}/deployments?env=production&per_page=25`, {
      headers,
    });
    if (!listRes.ok) {
      console.warn(`[stage-configs] Cloudflare deployment list failed (${listRes.status})`);
      return [];
    }

    const listJson = await listRes.json();
    const details = [];

    for (const dep of listJson.result ?? []) {
      const detailRes = await fetch(`${base}/deployments/${dep.id}`, { headers });
      if (!detailRes.ok) continue;
      const detailJson = await detailRes.json();
      details.push({
        id: dep.id,
        url: dep.url || detailJson.result?.url,
        files: detailJson.result?.files,
      });
    }

    return details;
  } catch (err) {
    console.warn("[stage-configs] Could not fetch deployments from Cloudflare:", err);
    return [];
  }
}

async function fetchPreservedConfigHashesFromCloudflare(deployments) {
  const merged = {};
  for (const dep of deployments) {
    for (const [path, hash] of Object.entries(pickConfigHashes(dep.files))) {
      merged[path] ??= hash;
    }
  }
  return merged;
}

async function fetchPriorMinJsPaths(deployments) {
  const paths = new Set();
  for (const dep of deployments) {
    for (const path of pickMinJsPaths(dep.files)) {
      paths.add(path);
    }
  }
  return [...paths];
}

async function fetchProjectKeysFromApi() {
  try {
    const res = await fetch(CONFIG_KEYS_API, { headers: authHeaders() });
    if (!res.ok) {
      console.warn(`[stage-configs] config-keys API failed (${res.status})`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.keys) ? data.keys : [];
  } catch (err) {
    console.warn("[stage-configs] Could not fetch config keys from API:", err);
    return [];
  }
}

class ConfigDownloadError extends Error {
  constructor(message, { status, unavailable } = {}) {
    super(message);
    this.name = "ConfigDownloadError";
    this.status = status;
    this.unavailable = unavailable;
  }
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: "*/*" } });
  if (!res.ok) {
    throw new ConfigDownloadError(`HTTP ${res.status}`, { status: res.status });
  }
  return res.text();
}

/** Prefer live API config; fall back to CDN copy from the previous Pages deploy. */
async function downloadConfig(projectKey) {
  const encodedKey = encodeURIComponent(projectKey);
  const sources = [
    `${CONFIG_API_BASE}${encodedKey}.json`,
    `${CONFIG_CDN_BASE}${encodedKey}.json`,
  ];

  const errors = [];
  for (const url of sources) {
    try {
      return await fetchText(url);
    } catch (err) {
      errors.push(err);
    }
  }

  const statuses = errors
    .filter((err) => err instanceof ConfigDownloadError && err.status != null)
    .map((err) => err.status);
  const allSourcesUnavailable =
    statuses.length === 0 ||
    statuses.every((status) => status >= 400 && status < 500) ||
    statuses.some((status) => status === 404 || status === 410);

  if (allSourcesUnavailable) {
    throw new ConfigDownloadError("Config unavailable on API and CDN", {
      status: 404,
      unavailable: true,
    });
  }

  throw errors[0] ?? new ConfigDownloadError("Config download failed");
}

async function downloadMinJs(fileName, deployments) {
  const sources = [`${SDK_CDN_BASE}/${fileName}`];
  for (const dep of deployments) {
    const bases = [
      dep.url?.replace(/\/$/, ""),
      dep.id
        ? `https://${dep.id.slice(0, 8)}.${PAGES_PROJECT_NAME}.pages.dev`
        : null,
      dep.id ? `https://${dep.id}.${PAGES_PROJECT_NAME}.pages.dev` : null,
    ].filter(Boolean);
    for (const base of bases) {
      sources.push(`${base}/${fileName}`);
    }
  }

  for (const url of sources) {
    try {
      const content = await fetchText(url);
      if (content.length > 0) return content;
    } catch {
      // try next
    }
  }
  return null;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function stagePriorMinJs(deployments) {
  const priorPaths = await fetchPriorMinJsPaths(deployments);
  if (priorPaths.length === 0) {
    console.log("[stage-configs] No prior *.min.js paths in CF manifests — skip JS backfill");
    return;
  }

  const distNames = await readdir(DIST_DIR);
  const gaps = minJsGapsToStage(priorPaths, distNames);
  if (gaps.length === 0) {
    console.log(
      `[stage-configs] dist/ already has all ${priorPaths.length} prior *.min.js file(s)`,
    );
    return;
  }

  let staged = 0;
  let failed = 0;
  await mapWithConcurrency(gaps, FETCH_CONCURRENCY, async (fileName) => {
    const content = await downloadMinJs(fileName, deployments);
    if (!content) {
      failed++;
      console.warn(`[stage-configs] Could not backfill prior bundle ${fileName}`);
      return;
    }
    await writeFile(join(DIST_DIR, fileName), content, "utf8");
    staged++;
    console.log(`[stage-configs] Backfilled prior bundle ${fileName} into dist/`);
  });

  console.log(
    `[stage-configs] Prior *.min.js backfill: ${staged} staged, ${failed} failed, ${gaps.length} gaps`,
  );
}

async function main() {
  const skipStaging = shouldSkipConfigStaging();
  const lockHolder = `pages-build:${process.env.CF_PAGES_COMMIT_SHA || process.pid}:${Date.now()}`;
  let heldLock = null;

  try {
    if (!skipStaging) {
      heldLock = await acquireDeployLock(lockHolder);
    } else {
      console.log(
        "[stage-configs] Skipping lock + config/JS backfill (Heroku slug compile or SKIP_CONFIG_STAGING=1)",
      );
    }

    // Always verify lazy chunks before Pages publish.
    await assertRequiredBundlesInDist();

    if (skipStaging) {
      return;
    }

    const deployments = await fetchRecentDeploymentDetails();
    await stagePriorMinJs(deployments);
    await assertRequiredBundlesInDist();

    const configHashes = await fetchPreservedConfigHashesFromCloudflare(deployments);
    let entries = Object.entries(configHashes);
    let discoverySource = "cloudflare-manifest";
    const priorConfigCount = entries.length;

    if (entries.length === 0) {
      console.warn(
        "[stage-configs] No /configs/*.json hashes in recent CF deployments — falling back to config-keys API",
      );
      const keys = await fetchProjectKeysFromApi();
      if (keys.length === 0) {
        console.warn(
          "[stage-configs] No project keys from API — SDK build will not include configs",
        );
        await heartbeatDeployLock(heldLock);
        return;
      }
      entries = keys.map((key) => [`/configs/${key}.json`, null]);
      discoverySource = "config-keys-api";
      console.log(`[stage-configs] Discovered ${entries.length} project key(s) via config-keys API`);
    } else {
      console.log(
        `[stage-configs] Discovered ${entries.length} config(s) from Cloudflare deployment manifest`,
      );
    }

    await mkdir(CONFIG_OUT_DIR, { recursive: true });

    let staged = 0;
    let skipped = 0;
    let failed = 0;

    await mapWithConcurrency(entries, FETCH_CONCURRENCY, async ([configPath, expectedHash]) => {
      const projectKey = projectKeyFromConfigPath(configPath);
      const outPath = join(CONFIG_OUT_DIR, `${projectKey}.json`);

      try {
        const payload = await downloadConfig(projectKey);
        const fullHash = createHash("sha256").update(payload).digest("hex");
        if (expectedHash && manifestHash(fullHash) !== expectedHash) {
          console.warn(
            `[stage-configs] Hash mismatch for ${projectKey} — staging latest API payload anyway`,
          );
        }
        await writeFile(outPath, payload, "utf8");
        staged++;
      } catch (err) {
        if (err instanceof ConfigDownloadError && err.unavailable) {
          skipped++;
          console.warn(
            `[stage-configs] Skipping ${projectKey}: config unavailable on API and CDN`,
          );
          return;
        }
        failed++;
        console.warn(`[stage-configs] Failed to stage ${projectKey}:`, err);
      }
    });

    console.log(
      `[stage-configs] Staged ${staged} config file(s) into dist/configs/ via ${discoverySource} (${skipped} skipped, ${failed} failed, ${entries.length} total)`,
    );

    if (failed > 0) {
      throw new Error(
        `[stage-configs] ${failed} config(s) failed to stage — refusing deploy that could ship a partial config set`,
      );
    }

    if (
      shouldFailOnConfigWipe({
        priorConfigCount,
        staged,
        skipped,
        failed,
      })
    ) {
      throw new Error(
        `[stage-configs] Prior production had ${priorConfigCount} config(s) but staged 0 — refusing deploy that would wipe /configs/`,
      );
    }

    // Keep lock through Pages upload/activate; do not release on success.
    await heartbeatDeployLock(heldLock);
  } catch (err) {
    await releaseDeployLock(heldLock);
    throw err;
  }
}

main().catch((err) => {
  console.error("[stage-configs] Fatal error:", err);
  process.exit(1);
});
