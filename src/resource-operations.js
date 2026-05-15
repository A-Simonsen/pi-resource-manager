import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getDefaultEnv } from "./resource-discovery.js";
import { describeResource, formatCommandFailure } from "./resource-manager-core.js";

const SKILL_LOCK_FILE = ".skill-lock.json";

export async function performResourceAction({ pi, ctx, env = getDefaultEnv(), discovery, result }) {
  const resource = result?.resource;

  if (result?.action === "reload") {
    await ctx.reload();
    return false;
  }

  if (!resource) return true;

  if (result.action === "inspect") {
    ctx.ui.notify(`${resource.name}: ${describeResource(resource)}${resource.path ? ` (${resource.path})` : ""}`, "info");
    return true;
  }

  if (isSelfExtension(resource)) {
    ctx.ui.notify("Resource Manager will not quarantine itself in v1. Remove it manually if needed.", "warning");
    return true;
  }

  if (result.action === "toggle") {
    if (resource.kind === "package") {
      ctx.ui.notify("Package enable/disable filters are not implemented in v1. Use update/remove actions for packages.", "warning");
      return true;
    }
    if (resource.enabled === false) {
      const ok = await ctx.ui.confirm("Restore resource?", `Restore ${resource.name} to ${resource.originalPath || resource.manifest?.originalPath}?`);
      if (!ok) return true;
      await restoreQuarantinedResource(resource, env);
      ctx.ui.notify(`Restored ${resource.name}.`, "success");
      return await maybeReload(ctx);
    }
    const ok = await ctx.ui.confirm("Disable resource?", `Move ${resource.name} to Resource Manager quarantine? This is reversible.`);
    if (!ok) return true;
    await quarantineResource(resource, env);
    ctx.ui.notify(`Quarantined ${resource.name}.`, "success");
    return await maybeReload(ctx);
  }

  if (result.action === "delete") {
    if (resource.kind === "package") {
      return await runPackageCommand(pi, ctx, "remove", resource.source);
    }
    if (resource.enabled === false) {
      ctx.ui.notify(`${resource.name} is already quarantined. Permanent deletion is intentionally not implemented in v1.`, "warning");
      return true;
    }
    const ok = await ctx.ui.confirm("Quarantine resource?", `Delete is quarantine-first in v1. Move ${resource.name} to quarantine?`);
    if (!ok) return true;
    await quarantineResource(resource, env);
    ctx.ui.notify(`Quarantined ${resource.name}.`, "success");
    return await maybeReload(ctx);
  }

  if (result.action === "update") {
    if (resource.kind === "package") {
      return await runPackageCommand(pi, ctx, "update", resource.source);
    }
    if (resource.kind === "skill") {
      return await updateTrustedSkill(pi, ctx, env, discovery, resource);
    }
    ctx.ui.notify(`${resource.name} is local-only and cannot be updated safely in v1.`, "warning");
  }

  return true;
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

function isSelfExtension(resource) {
  return resource?.kind === "extension" && resource?.name === "resource-manager";
}

async function runPackageCommand(pi, ctx, action, source) {
  const ok = await ctx.ui.confirm(`${action === "update" ? "Update" : "Remove"} package?`, `${action} ${source}?`);
  if (!ok) return true;
  const command = buildPackageCommand(action, source);
  const result = await pi.exec(command.command, command.args, { timeout: 120000 });
  if (result.code === 0) {
    ctx.ui.notify(`${action} completed for ${source}.`, "success");
    return await maybeReload(ctx);
  }
  ctx.ui.notify(formatCommandFailure(action, source, result), "error");
  return true;
}

async function updateTrustedSkill(pi, ctx, env, discovery, resource) {
  const plan = getSkillUpdatePlan(resource, discovery, env);
  if (!plan.updateable) {
    ctx.ui.notify(plan.reason, "warning");
    return true;
  }

  if (plan.strategy === "git-pull") {
    const ok = await ctx.ui.confirm(
      "Update git-managed skills?",
      `Run git pull --ff-only in ${plan.repoPath}? This may update multiple skills from ${plan.sourceUrl}.`,
    );
    if (!ok) return true;
    const status = await pi.exec("git", ["-C", plan.repoPath, "status", "--short"], { timeout: 30000 });
    if (status.code !== 0) {
      ctx.ui.notify(`Git status failed: ${status.stderr || status.stdout}`, "error");
      return true;
    }
    if (status.stdout.trim()) {
      ctx.ui.notify(`Git repository has local changes; refusing to update ${resource.name}.`, "warning");
      return true;
    }
    const pull = await pi.exec("git", ["-C", plan.repoPath, "pull", "--ff-only"], { timeout: 120000 });
    if (pull.code === 0) {
      ctx.ui.notify(`Updated git-managed skill repository for ${resource.name}.`, "success");
      return await maybeReload(ctx);
    }
    ctx.ui.notify(`Git pull failed: ${pull.stderr || pull.stdout}`, "error");
    return true;
  }

  const ok = await ctx.ui.confirm(
    "Update trusted skill?",
    `Update ${resource.name} from ${plan.sourceUrl}? The current local copy will be quarantined first; local edits are not merged.`,
  );
  if (!ok) return true;

  const tempRoot = await mkdtemp(join(tmpdir(), "pi-resource-manager-"));
  const cloneDir = join(tempRoot, "repo");
  try {
    const clone = await pi.exec("git", ["clone", "--quiet", "--depth", "1", "--filter=blob:none", plan.sourceUrl, cloneDir], { timeout: 120000 });
    if (clone.code !== 0) {
      ctx.ui.notify(`Clone failed: ${clone.stderr || clone.stdout}`, "error");
      return true;
    }

    const sourceDir = join(cloneDir, plan.remoteSkillPath);
    await stat(sourceDir);
    await quarantineResource(resource, env);
    await cp(sourceDir, plan.localPath, { recursive: true });
    ctx.ui.notify(`Updated ${resource.name} from trusted source.`, "success");
    return await maybeReload(ctx);
  } catch (error) {
    ctx.ui.notify(`Skill update failed: ${error.message}`, "error");
    return true;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function maybeReload(ctx) {
  const reload = await ctx.ui.confirm("Reload Pi resources?", "Changes may not take effect until /reload. Reload now?");
  if (reload) {
    await ctx.reload();
    return false;
  }
  return true;
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
