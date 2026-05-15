# Resource Operations Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Resource Manager action orchestration into a focused Resource Operations Module while preserving existing public imports and behavior.

**Architecture:** `src/resource-operations.js` owns the operation seam: action dispatch, quarantine/restore, package commands, trusted skill updates, git-managed skill updates, self-extension protection, and reload prompts. `src/resource-manager-core.js` re-exports operations for compatibility and keeps presentation helpers. `src/index.ts` keeps command registration and interactive UI state, delegating action execution to `performResourceAction`.

**Tech Stack:** Node.js ESM, TypeScript entrypoint, built-in `node:test`, fake Pi/context adapters for operation tests.

---

### Task 1: Add operation-seam tests before production code

**Files:**
- Modify: `test/resource-manager-core.test.mjs`
- Create later: `src/resource-operations.js`
- Modify later: `src/resource-manager-core.js`

- [ ] **Step 1: Add `performResourceAction` to the test imports**

In `test/resource-manager-core.test.mjs`, extend the existing import from `../src/resource-manager-core.js` with:

```js
  performResourceAction,
```

- [ ] **Step 2: Add fake adapter helpers below `writeSkill`**

Add this test helper code below the existing `writeSkill` helper:

```js
function makeOperationHarness({ confirms = [], execResults = [] } = {}) {
  const notifications = [];
  const reloads = [];
  const execCalls = [];
  const confirmCalls = [];

  return {
    pi: {
      exec: async (command, args, options) => {
        execCalls.push({ command, args, options });
        return execResults.shift() || { code: 0, stdout: "", stderr: "" };
      },
    },
    ctx: {
      ui: {
        confirm: async (title, message) => {
          confirmCalls.push({ title, message });
          return confirms.shift() ?? true;
        },
        notify: (message, level) => {
          notifications.push({ message, level });
        },
      },
      reload: async () => {
        reloads.push(true);
      },
    },
    notifications,
    reloads,
    execCalls,
    confirmCalls,
  };
}
```

- [ ] **Step 3: Add package update success test**

Append this test near the package command tests:

```js
test("performs package update actions through the operations seam", async () => {
  const env = await makeEnv();
  const harness = makeOperationHarness({ confirms: [true, true] });
  const keepOpen = await performResourceAction({
    pi: harness.pi,
    ctx: harness.ctx,
    env,
    discovery: {},
    result: {
      action: "update",
      tab: "extensions",
      resource: { kind: "package", name: "npm:@scope/example", source: "npm:@scope/example" },
    },
  });

  assert.equal(keepOpen, false);
  assert.deepEqual(harness.execCalls.map((call) => [call.command, call.args]), [["pi", ["update", "npm:@scope/example"]]]);
  assert.deepEqual(harness.notifications, [{ message: "update completed for npm:@scope/example.", level: "success" }]);
  assert.equal(harness.reloads.length, 1);
});
```

- [ ] **Step 4: Add package remove failure test**

Append this test near the package command tests:

```js
test("reports package remove failures through the operations seam", async () => {
  const env = await makeEnv();
  const harness = makeOperationHarness({
    confirms: [true],
    execResults: [{ code: 2, stdout: "", stderr: "permission denied" }],
  });
  const keepOpen = await performResourceAction({
    pi: harness.pi,
    ctx: harness.ctx,
    env,
    discovery: {},
    result: {
      action: "delete",
      tab: "extensions",
      resource: { kind: "package", name: "npm:@scope/example", source: "npm:@scope/example" },
    },
  });

  assert.equal(keepOpen, true);
  assert.deepEqual(harness.execCalls.map((call) => [call.command, call.args]), [["pi", ["remove", "npm:@scope/example"]]]);
  assert.deepEqual(harness.notifications, [{ message: "remove failed for npm:@scope/example: permission denied", level: "error" }]);
  assert.equal(harness.reloads.length, 0);
});
```

- [ ] **Step 5: Add skill warning and self-extension guard tests**

Append these tests near the trusted skill update plan tests:

```js
test("warns instead of updating skills without trusted source metadata", async () => {
  const env = await makeEnv();
  const skillPath = await writeSkill(join(env.agentsDir, "skills"), "unknown-skill");
  const discovery = await discoverResources(env);
  const harness = makeOperationHarness();
  const keepOpen = await performResourceAction({
    pi: harness.pi,
    ctx: harness.ctx,
    env,
    discovery,
    result: {
      action: "update",
      tab: "skills",
      resource: { kind: "skill", name: "unknown-skill", path: skillPath },
    },
  });

  assert.equal(keepOpen, true);
  assert.deepEqual(harness.execCalls, []);
  assert.deepEqual(harness.notifications, [{
    message: "No trusted source metadata exists for this skill. Resource Manager will not infer update sources.",
    level: "warning",
  }]);
});

test("refuses to quarantine Resource Manager itself through the operations seam", async () => {
  const env = await makeEnv();
  const harness = makeOperationHarness();
  const keepOpen = await performResourceAction({
    pi: harness.pi,
    ctx: harness.ctx,
    env,
    discovery: {},
    result: {
      action: "delete",
      tab: "extensions",
      resource: { kind: "extension", name: "resource-manager", path: join(env.extensionRoot, "resource-manager") },
    },
  });

  assert.equal(keepOpen, true);
  assert.deepEqual(harness.confirmCalls, []);
  assert.deepEqual(harness.notifications, [{
    message: "Resource Manager will not quarantine itself in v1. Remove it manually if needed.",
    level: "warning",
  }]);
});
```

- [ ] **Step 6: Run tests and verify RED**

Run: `npm test`
Expected: FAIL with an import/export error for `performResourceAction`, because production code has not been added yet.

### Task 2: Create Resource Operations Module and preserve compatibility

**Files:**
- Create: `src/resource-operations.js`
- Modify: `src/resource-manager-core.js`
- Test: `test/resource-manager-core.test.mjs`

- [ ] **Step 1: Create `src/resource-operations.js`**

Create `src/resource-operations.js` containing these exports and helpers moved from `src/resource-manager-core.js` plus the action orchestration moved from `src/index.ts`:

```js
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
```

- [ ] **Step 2: Re-export operations from `src/resource-manager-core.js`**

Replace the filesystem operation imports and operation implementations in `src/resource-manager-core.js` with:

```js
export { discoverResources, getDefaultEnv } from "./resource-discovery.js";
export {
  buildPackageCommand,
  getSkillUpdatePlan,
  performResourceAction,
  quarantineResource,
  restoreQuarantinedResource,
} from "./resource-operations.js";
```

Keep presentation exports in this file: `describeResource`, `formatActionFailure`, `formatCommandFailure`, `calculateVisibleRange`, `getDetailActionLabels`, `moveDetailActionSelection`, and `buildResourceDetailPanel`.

- [ ] **Step 3: Remove now-unused operation helpers from core**

Remove private helpers from `src/resource-manager-core.js` that only supported moved operations: `readJson`, `assertPathExists`, `normalizePath`, `slug`, and `SKILL_LOCK_FILE`. The file should have no `node:fs` or `node:path` imports after this task.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test`
Expected: all tests pass, including the new operation-seam tests.

### Task 3: Delegate index action handling to operations Module

**Files:**
- Modify: `src/index.ts`
- Test: `test/resource-manager-core.test.mjs`

- [ ] **Step 1: Update imports in `src/index.ts`**

Remove these imports from `src/index.ts`:

```ts
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
```

Remove these named imports from `./resource-manager-core.js`:

```ts
  buildPackageCommand,
  formatCommandFailure,
  getSkillUpdatePlan,
  quarantineResource,
  restoreQuarantinedResource,
```

Add this named import from `./resource-manager-core.js`:

```ts
  performResourceAction,
```

Keep `formatActionFailure`, because `openResourceManager` still catches unexpected operation errors.

- [ ] **Step 2: Replace the action call**

In `openResourceManager`, replace:

```ts
const shouldContinue = await handleAction(pi, ctx, env, discovery, result);
```

with:

```ts
const shouldContinue = await performResourceAction({ pi, ctx, env, discovery, result });
```

- [ ] **Step 3: Remove moved functions from `src/index.ts`**

Delete these functions from `src/index.ts`:

```ts
async function handleAction(...)
function isSelfExtension(...)
async function runPackageCommand(...)
async function updateTrustedSkill(...)
async function maybeReload(...)
```

After deletion, `src/index.ts` should end after the `ResourceManagerComponent` class.

- [ ] **Step 4: Run syntax checks**

Run: `npm run check`
Expected: `node --check src/resource-manager-core.js` exits 0.

Run: `node --check src/resource-operations.js`
Expected: exits 0.

### Task 4: Update architecture TODOs and verify full slice

**Files:**
- Modify: `docs/architecture-todos.md`
- Test: `test/resource-manager-core.test.mjs`

- [ ] **Step 1: Mark Resource Operations Module as complete**

Replace the first item in `docs/architecture-todos.md` with:

```markdown
1. ✅ **Resource operations Module** — action orchestration, quarantine/restore, package update/remove command handling, and trusted skill update planning now live behind `src/resource-operations.js`.
```

Leave the presentation and interactive manager items unchanged.

- [ ] **Step 2: Run full verification**

Run: `npm test`
Expected: all tests pass.

Run: `npm run check`
Expected: syntax check exits 0.

Run: `node --check src/resource-operations.js`
Expected: syntax check exits 0.

- [ ] **Step 3: Review diff for accidental scope creep**

Run: `git diff -- src/index.ts src/resource-manager-core.js src/resource-operations.js test/resource-manager-core.test.mjs docs/architecture-todos.md`
Expected: diff only includes operation extraction, operation seam tests, and architecture TODO update.
