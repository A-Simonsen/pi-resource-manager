import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getDefaultEnv } from "./resource-discovery.js";

export { discoverResources, getDefaultEnv } from "./resource-discovery.js";

const SKILL_LOCK_FILE = ".skill-lock.json";

export async function quarantineResource(resource, env = getDefaultEnv()) {
  if (!resource?.path) {
    throw new Error(`Resource ${resource?.name ?? "<unknown>"} has no filesystem path to quarantine`);
  }

  await assertPathExists(resource.path);
  const safeName = slug(resource.name || basename(resource.path));
  const kind = slug(resource.kind || "resource");
  const baseDir = join(env.quarantineRoot, kind);
  await mkdir(baseDir, { recursive: true });

  let target = join(baseDir, `${env.now()}-${safeName}`);
  let suffix = 2;
  while (existsSync(target)) {
    target = join(baseDir, `${env.now()}-${safeName}-${suffix}`);
    suffix += 1;
  }

  await rename(resource.path, target);
  const manifest = {
    name: resource.name,
    kind: resource.kind,
    scope: resource.scope,
    originalPath: resource.path,
    quarantinedAt: new Date().toISOString(),
  };
  await writeFile(join(target, "resource-manager-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { path: target, manifest };
}

export async function restoreQuarantinedResource(resource, env = getDefaultEnv()) {
  if (resource?.enabled !== false) {
    throw new Error(`Resource ${resource?.name ?? "<unknown>"} is not quarantined`);
  }
  const manifest = resource.manifest || await readJson(join(resource.path, "resource-manager-manifest.json"), undefined);
  if (!manifest?.originalPath) {
    throw new Error(`Quarantined resource ${resource.name} has no originalPath in its manifest`);
  }
  if (existsSync(manifest.originalPath)) {
    throw new Error(`Cannot restore ${resource.name}: original path already exists: ${manifest.originalPath}`);
  }
  await mkdir(dirname(manifest.originalPath), { recursive: true });
  await rename(resource.path, manifest.originalPath);
  return { path: manifest.originalPath, manifest };
}

export function buildPackageCommand(action, source) {
  if (!source || typeof source !== "string") {
    throw new Error("Package source is required");
  }
  if (action === "update") {
    return { command: "pi", args: ["update", source] };
  }
  if (action === "remove") {
    return { command: "pi", args: ["remove", source] };
  }
  throw new Error(`Unsupported package action: ${action}`);
}

export function getSkillUpdatePlan(resource, discovery, env = getDefaultEnv()) {
  const entry = discovery?.lock?.skills?.[resource?.name];
  if (entry?.sourceUrl && entry?.skillPath) {
    const remoteSkillPath = dirname(entry.skillPath).replaceAll("\\", "/");
    return {
      updateable: true,
      strategy: "copy-from-clone",
      name: resource.name,
      localPath: resource.path,
      sourceUrl: entry.sourceUrl,
      remoteSkillPath,
      lockEntry: entry,
      lockPath: join(env.agentsDir, SKILL_LOCK_FILE),
    };
  }

  const discovered = discovery?.skills?.find((skill) => skill.name === resource?.name && normalizePath(skill.path) === normalizePath(resource?.path));
  if (discovered?.git?.remoteUrl && discovered?.git?.repoPath) {
    return {
      updateable: true,
      strategy: "git-pull",
      name: resource.name,
      localPath: resource.path,
      sourceUrl: discovered.git.remoteUrl,
      repoPath: discovered.git.repoPath,
    };
  }

  return {
    updateable: false,
    reason: "No trusted source metadata exists for this skill. Resource Manager will not infer update sources.",
  };
}

export function describeResource(resource) {
  const parts = [resource.kind, resource.scope];
  if (resource.trusted) parts.push("trusted source");
  if (resource.updateStatus) parts.push(resource.updateStatus);
  if (resource.source) parts.push(resource.source);
  return parts.filter(Boolean).join(" · ");
}

export function formatActionFailure(action, resource, error) {
  const resourceName = resource?.name ? ` for ${resource.name}` : "";
  return `${action} failed${resourceName}: ${getErrorMessage(error)}`;
}

export function formatCommandFailure(action, source, result) {
  const output = String(result?.stderr || result?.stdout || `exit code ${result?.code ?? "unknown"} with no output`).trim();
  return `${action} failed for ${source}: ${output}`;
}

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
}

export function calculateVisibleRange(totalItems, selectedIndex, maxVisibleItems) {
  const total = Math.max(0, Number(totalItems) || 0);
  if (total === 0) return { start: 0, end: 0 };

  const visible = Math.max(1, Math.min(total, Math.floor(Number(maxVisibleItems) || 1)));
  const selected = Math.max(0, Math.min(total - 1, Math.floor(Number(selectedIndex) || 0)));
  const start = Math.max(0, Math.min(selected - visible + 1, total - visible));
  return { start, end: start + visible };
}

const DETAIL_ACTION_LABELS = ["Update", "Delete", "Read", "Locate", "Back"];

export function getDetailActionLabels() {
  return [...DETAIL_ACTION_LABELS];
}

export function moveDetailActionSelection(currentIndex, direction) {
  const total = DETAIL_ACTION_LABELS.length;
  const current = Math.max(0, Math.min(total - 1, Math.floor(Number(currentIndex) || 0)));
  const delta = direction < 0 ? -1 : 1;
  return (current + delta + total) % total;
}

export function buildResourceDetailPanel(resource, options = {}) {
  const mode = options.mode || "summary";
  const selectedAction = Math.max(0, Math.min(DETAIL_ACTION_LABELS.length - 1, Math.floor(Number(options.selectedAction) || 0)));
  const lines = [
    "Resource details",
    `Name: ${resource?.name || "<unknown>"}`,
    `Kind: ${resource?.kind || "unknown"}`,
    `Status: ${resource?.enabled === false ? "disabled/quarantined" : "enabled"}`,
  ];

  const summary = describeResource(resource || {});
  if (summary) lines.push(`Summary: ${summary}`);
  if (resource?.description) lines.push(`Description: ${resource.description}`);
  if (resource?.source) lines.push(`Source: ${resource.source}`);
  if (resource?.path) lines.push(`Path: ${resource.path}`);
  if (resource?.originalPath) lines.push(`Original path: ${resource.originalPath}`);
  if (resource?.skillFile) lines.push(`Skill file: ${resource.skillFile}`);

  if (mode === "read") {
    lines.push("", "Read", summary || "No additional readable metadata is available for this resource.");
  }

  if (mode === "locate") {
    lines.push("", "Location", resource?.path || resource?.source || resource?.originalPath || "No path or source is available for this resource.");
  }

  lines.push("", `Actions: ${DETAIL_ACTION_LABELS.map((label, index) => `${index === selectedAction ? "> " : "  "}[ ${label} ]`).join(" ")}`);
  lines.push("Use ←/→ to choose an action, Enter to run it, Esc to close Resource Manager.");
  return lines;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function assertPathExists(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Path does not exist: ${path}`);
    }
    throw error;
  }
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/").toLowerCase();
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "resource";
}
