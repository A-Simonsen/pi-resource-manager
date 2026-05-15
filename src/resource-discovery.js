import { access, readFile, realpath, stat } from "node:fs/promises";
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

function isTrustedPackageSource(source) {
  return typeof source === "string" && (/^(npm:|git:|https:\/\/|ssh:\/\/|file:|\.\/|\.\.\/|\/)/.test(source));
}

function timestamp() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sepAgnostic(path) {
  return path.replaceAll("/", resolve("/").includes("\\") ? "\\" : "/");
}
