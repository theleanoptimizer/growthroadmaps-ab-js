/**
 * Post-build step for the growthroadmaps-ab-js Cloudflare Pages project.
 *
 * Git-based Pages deploys replace the entire site with dist/. SDK-only builds
 * were wiping /configs/*.json published by the main app. This script copies
 * existing configs into dist/configs/ so SDK deploys keep them.
 *
 * Config paths come from recent Cloudflare Pages deployments (hash manifest).
 * File bodies are downloaded from growthroadmaps.com (source of truth).
 *
 * Optional Cloudflare Pages build env vars:
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "dist");
const CONFIG_OUT_DIR = join(DIST_DIR, "configs");

const PAGES_PROJECT_NAME = "growthroadmaps-ab-js";
const CONFIG_API_BASE = "https://growthroadmaps.com/api/sdk/config/";
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
      "[stage-configs] CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set — skipping config staging",
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

function projectKeyFromConfigPath(configPath) {
  const name = configPath.replace(/^\/configs\//, "").replace(/\.json$/, "");
  return decodeURIComponent(name);
}

async function downloadConfig(projectKey) {
  const url = `${CONFIG_API_BASE}${encodeURIComponent(projectKey)}.json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
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
  if (process.env.SKIP_CONFIG_STAGING === "1") {
    console.log("[stage-configs] SKIP_CONFIG_STAGING=1 — skipping");
    return;
  }

  const configHashes = await fetchPreservedConfigHashesFromCloudflare();
  const entries = Object.entries(configHashes);
  if (entries.length === 0) {
    console.warn(
      "[stage-configs] No /configs/*.json hashes found in recent deployments — SDK build will not include configs",
    );
    return;
  }

  await mkdir(CONFIG_OUT_DIR, { recursive: true });

  let staged = 0;
  let failed = 0;

  await mapWithConcurrency(entries, FETCH_CONCURRENCY, async ([configPath, expectedHash]) => {
    const projectKey = projectKeyFromConfigPath(configPath);
    const outPath = join(CONFIG_OUT_DIR, `${projectKey}.json`);

    try {
      const payload = await downloadConfig(projectKey);
      const fullHash = createHash("sha256").update(payload).digest("hex");
      if (manifestHash(fullHash) !== expectedHash) {
        console.warn(
          `[stage-configs] Hash mismatch for ${projectKey} — staging latest API payload anyway`,
        );
      }
      await writeFile(outPath, payload, "utf8");
      staged++;
    } catch (err) {
      failed++;
      console.warn(`[stage-configs] Failed to stage ${projectKey}:`, err);
    }
  });

  console.log(
    `[stage-configs] Staged ${staged} config file(s) into dist/configs/ (${failed} failed, ${entries.length} in manifest)`,
  );

  if (staged === 0 && entries.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[stage-configs] Fatal error:", err);
  process.exit(1);
});
