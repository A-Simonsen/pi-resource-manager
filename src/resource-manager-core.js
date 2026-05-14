import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";

const SKILL_LOCK_FILE = ".skill-lock.json";

export function getDefaultEnv() {
  const homeDir = homedir();
  const piAgentDir = join(homeDir, ".pi", "agent");
  const agentsDir = join(homeDir, ".agents");
  return {
    homeDir,
    piAgentDir,
    agentsDir,
    settingsPath: join(piAgentDir, "settings.json"),
    skillRoots: [join(piAgentDir, "skills"), join(agentsDir, "skills")],
    extensionRoot: join(piAgentDir, "extensions"),
    quarantineRoot: join(piAgentDir, "resource-manager-quarantine"),
    now: () => timestamp(),
  };
}

export async function discoverResources(env = getDefaultEnv()) {
  const settings = await readJson(env.settingsPath, {});
  const lock = await readJson(join(env.agentsDir, SKILL_LOCK_FILE), { skills: {} });
  const activeSkills = await discoverSkills(env, lock);
  const activeExtensions = await discoverExtensions(env);
  const quarantined = await discoverQuarantinedResources(env);
  const skills = [...activeSkills, ...quarantined.filter((resource) => resource.kind === "skill")]
    .sort((a, b) => a.name.localeCompare(b.name));
  const extensions = [...activeExtensions, ...quarantined.filter((resource) => resource.kind === "extension")]
    .sort((a, b) => a.name.localeCompare(b.name));
  const packages = discoverPackages(settings);
  return { settings, lock, skills, extensions, packages };
}

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

async function discoverSkills(env, lock) {
  const skills = [];
  for (const root of env.skillRoots || []) {
    const scope = root.includes(`${sepAgnostic(".pi/agent/skills")}`) ? "global-pi" : "global-agents";
    const skillFiles = await findSkillFiles(root);
    for (const skillFile of skillFiles) {
      const path = dirname(skillFile);
      const frontmatter = parseSkillFrontmatter(await readFile(skillFile, "utf8"));
      const name = frontmatter.name || basename(path);
      const lockEntry = lock?.skills?.[name];
      const git = lockEntry?.sourceUrl ? undefined : await findGitInfo(path);
      skills.push({
        kind: "skill",
        name,
        description: frontmatter.description || "",
        path,
        skillFile,
        scope,
        enabled: true,
        trusted: Boolean((lockEntry?.sourceUrl && lockEntry?.skillPath) || git?.remoteUrl),
        updateStatus: lockEntry?.sourceUrl ? "trusted" : git?.remoteUrl ? "git-managed" : "local-only",
        source: lockEntry?.sourceUrl || git?.remoteUrl,
        git,
      });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function discoverQuarantinedResources(env) {
  const resources = [];
  const kindDirs = await readDirSafe(env.quarantineRoot);
  for (const kindDir of kindDirs) {
    if (!kindDir.isDirectory()) continue;
    const kind = kindDir.name;
    const entries = await readDirSafe(join(env.quarantineRoot, kind));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(env.quarantineRoot, kind, entry.name);
      const manifest = await readJson(join(path, "resource-manager-manifest.json"), undefined).catch(() => undefined);
      if (!manifest?.name) continue;
      resources.push({
        kind: manifest.kind || kind,
        name: manifest.name,
        path,
        originalPath: manifest.originalPath,
        scope: manifest.scope || "quarantine",
        enabled: false,
        trusted: false,
        updateStatus: "quarantined",
        manifest,
      });
    }
  }
  return resources;
}

async function findGitInfo(path) {
  let current = await realpath(path).catch(() => path);
  while (current && current !== dirname(current)) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      const remoteUrl = await readGitOriginUrl(gitPath);
      return remoteUrl ? { repoPath: current, remoteUrl } : undefined;
    }
    current = dirname(current);
  }
  return undefined;
}

async function readGitOriginUrl(gitPath) {
  const configPath = existsSync(join(gitPath, "config"))
    ? join(gitPath, "config")
    : undefined;
  if (!configPath) return undefined;
  const config = await readFile(configPath, "utf8").catch(() => "");
  const lines = config.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    if (/^\s*\[remote\s+"origin"\]\s*$/.test(line)) {
      inOrigin = true;
      continue;
    }
    if (/^\s*\[/.test(line)) inOrigin = false;
    if (inOrigin) {
      const match = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (match) return match[1];
    }
  }
  return undefined;
}

async function discoverExtensions(env) {
  const root = env.extensionRoot;
  const entries = await readDirSafe(root);
  const extensions = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && [".ts", ".js", ".mjs", ".cjs"].includes(extname(entry.name))) {
      extensions.push({
        kind: "extension",
        name: basename(entry.name, extname(entry.name)),
        path,
        scope: "global-pi",
        enabled: true,
        trusted: false,
        updateStatus: "local-only",
      });
    }
    if ((entry.isDirectory() || entry.isSymbolicLink()) && (existsSync(join(path, "index.ts")) || existsSync(join(path, "index.js")))) {
      extensions.push({
        kind: "extension",
        name: entry.name,
        path,
        scope: "global-pi",
        enabled: true,
        trusted: false,
        updateStatus: "local-only",
      });
    }
  }
  return extensions.sort((a, b) => a.name.localeCompare(b.name));
}

function discoverPackages(settings) {
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  return packages.map((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return {
      kind: "package",
      name: source || "<unknown package>",
      source,
      packageEntry: entry,
      scope: "global-pi-settings",
      enabled: true,
      trusted: isTrustedPackageSource(source),
      updateStatus: source ? "package-managed" : "unknown",
    };
  }).filter((pkg) => pkg.source);
}

async function findSkillFiles(root) {
  const files = [];
  const rootExists = await exists(root);
  if (!rootExists) return files;

  async function visit(dir) {
    const entries = await readDirSafe(dir);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const pathStat = await stat(path).catch(() => undefined);
        if (pathStat?.isDirectory()) {
          if (existsSync(join(path, "SKILL.md"))) {
            files.push(join(path, "SKILL.md"));
          } else {
            await visit(path);
          }
        }
      } else if (entry.isFile() && entry.name.endsWith(".md") && dirname(path) === root) {
        files.push(path);
      }
    }
  }

  await visit(root);
  return files;
}

function parseSkillFrontmatter(text) {
  if (!text.startsWith("---")) return {};
  const parts = text.split("---", 3);
  if (parts.length < 3) return {};
  const data = {};
  for (const line of parts[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
  }
  return data;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readDirSafe(path) {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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

function isTrustedPackageSource(source) {
  return typeof source === "string" && (/^(npm:|git:|https:\/\/|ssh:\/\/|file:|\.\/|\.\.\/|\/)/.test(source));
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/").toLowerCase();
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "resource";
}

function timestamp() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sepAgnostic(path) {
  return path.replaceAll("/", resolve("/").includes("\\") ? "\\" : "/");
}
