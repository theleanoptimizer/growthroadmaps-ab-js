/**
 * Post-build step for the growthroadmaps-ab-js Cloudflare Pages project.
 *
 * Git-based Pages deploys replace the entire site with dist/. SDK-only builds
 * were wiping /configs/*.json published by the main app. This script copies
 * existing configs into dist/configs/ so SDK deploys keep them.
 *
 * Discovery order:
 *   1. Recent Cloudflare Pages deployment manifests (needs CF env vars)
 *   2. Fallback: GET growthroadmaps.com/api/sdk/config-keys.json
 *
 * File bodies are downloaded from growthroadmaps.com/api/sdk/config/ (auto-generates
 * from DB when missing). CDN is used as a secondary source.
 *
 * Optional Cloudflare Pages build env vars:
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "dist");
const CONFIG_OUT_DIR = join(DIST_DIR, "configs");
const REQUIRED_BUNDLES_PATH = join(__dirname, "..", "required-bundles.json");

/** Refuse Pages deploys that would ship growth.min.js without lazy chunks (e.g. gr-panels.min.js). */
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
}

const PAGES_PROJECT_NAME = "growthroadmaps-ab-js";
const CONFIG_API_BASE = "https://growthroadmaps.com/api/sdk/config/";
const CONFIG_KEYS_API = "https://growthroadmaps.com/api/sdk/config-keys.json";
const CONFIG_CDN_BASE = "https://js.growthroadmaps.com/configs/";
const FETCH_CONCURRENCY = 4;

function manifestHash(fullHash) {
  return fullHash.slice(0, 32);
}

function pickConfigHashes(files) {
  if (!files) return {};
  return Object.fromEntries(
    Object.entries(files).filter(([path]) => path.startsWith("/configs/")),
  );
}

async function fetchPreservedConfigHashesFromCloudflare() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.warn(
      "[stage-configs] CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set — manifest discovery skipped",
    );
    return {};
  }

  const headers = { Authorization: `Bearer ${apiToken}` };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${PAGES_PROJECT_NAME}`;

  try {
    const listRes = await fetch(`${base}/deployments?env=production&per_page=25`, { headers });
    if (!listRes.ok) {
      console.warn(`[stage-configs] Cloudflare deployment list failed (${listRes.status})`);
      return {};
    }

    const listJson = await listRes.json();
    const merged = {};

    for (const dep of listJson.result ?? []) {
      const detailRes = await fetch(`${base}/deployments/${dep.id}`, { headers });
      if (!detailRes.ok) continue;
      const detailJson = await detailRes.json();
      const configHashes = pickConfigHashes(detailJson.result?.files);
      for (const [path, hash] of Object.entries(configHashes)) {
        merged[path] ??= hash;
      }
    }

    return merged;
  } catch (err) {
    console.warn("[stage-configs] Could not fetch config hashes from Cloudflare:", err);
  }

  return {};
}

async function fetchProjectKeysFromApi() {
  try {
    const token = process.env.SDK_CONFIG_KEYS_TOKEN?.trim();
    const headers = {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch(CONFIG_KEYS_API, { headers });
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

function projectKeyFromConfigPath(configPath) {
  const name = configPath.replace(/^\/configs\//, "").replace(/\.json$/, "");
  return decodeURIComponent(name);
}

class ConfigDownloadError extends Error {
  constructor(message, { status, unavailable } = {}) {
    super(message);
    this.name = "ConfigDownloadError";
    this.status = status;
    this.unavailable = unavailable;
  }
}

async function fetchConfigText(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
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
      return await fetchConfigText(url);
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

async function main() {
  // Always verify lazy chunks before Pages publish — config staging is optional,
  // but shipping growth.min.js without gr-panels.min.js breaks preview panel.
  await assertRequiredBundlesInDist();

  if (process.env.SKIP_CONFIG_STAGING === "1") {
    console.log("[stage-configs] SKIP_CONFIG_STAGING=1 — skipping config copy");
    return;
  }

  const configHashes = await fetchPreservedConfigHashesFromCloudflare();
  let entries = Object.entries(configHashes);
  let discoverySource = "cloudflare-manifest";

  if (entries.length === 0) {
    console.warn(
      "[stage-configs] No /configs/*.json hashes in recent CF deployments — falling back to config-keys API",
    );
    const keys = await fetchProjectKeysFromApi();
    if (keys.length === 0) {
      console.warn("[stage-configs] No project keys from API — SDK build will not include configs");
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
    process.exitCode = 1;
  } else if (skipped > 0 && staged === 0) {
    console.warn(
      "[stage-configs] No configs could be preserved — continuing SDK deploy without /configs/",
    );
  }
}

main().catch((err) => {
  console.error("[stage-configs] Fatal error:", err);
  process.exit(1);
});
