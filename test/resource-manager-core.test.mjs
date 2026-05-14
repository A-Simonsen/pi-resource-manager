import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  buildPackageCommand,
  buildResourceDetailPanel,
  calculateVisibleRange,
  discoverResources,
  getDetailActionLabels,
  getSkillUpdatePlan,
  moveDetailActionSelection,
  restoreQuarantinedResource,
  quarantineResource,
} from "../src/resource-manager-core.js";

async function makeEnv() {
  const root = await mkdir(join(tmpdir(), `pi-rm-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const piAgentDir = join(root, ".pi", "agent");
  const agentsDir = join(root, ".agents");
  await mkdir(piAgentDir, { recursive: true });
  await mkdir(join(piAgentDir, "extensions"), { recursive: true });
  await mkdir(join(piAgentDir, "skills"), { recursive: true });
  await mkdir(join(agentsDir, "skills"), { recursive: true });
  return {
    homeDir: root,
    piAgentDir,
    agentsDir,
    settingsPath: join(piAgentDir, "settings.json"),
    skillRoots: [join(piAgentDir, "skills"), join(agentsDir, "skills")],
    extensionRoot: join(piAgentDir, "extensions"),
    quarantineRoot: join(piAgentDir, "resource-manager-quarantine"),
    now: () => "20260514-120000",
  };
}

async function writeSkill(root, name, description = "Test skill") {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return dir;
}

test("exposes a named Resource Manager extension entrypoint", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(pkg.pi?.extensions, ["./extensions/resource-manager/index.ts"]);

  const entrypoint = await readFile("extensions/resource-manager/index.ts", "utf8");
  assert.match(entrypoint, /src\/index/);
});

test("builds a visible detail panel with action buttons", () => {
  const resource = {
    kind: "skill",
    name: "example-skill",
    path: "/tmp/example-skill",
    enabled: true,
    trusted: true,
    updateStatus: "trusted-lock",
    scope: "global-agents",
  };

  assert.deepEqual(getDetailActionLabels(), ["Update", "Delete", "Read", "Locate", "Back"]);
  assert.equal(moveDetailActionSelection(0, -1), 4);
  assert.equal(moveDetailActionSelection(4, 1), 0);

  const summary = buildResourceDetailPanel(resource, { selectedAction: 2 });
  assert.match(summary.join("\n"), /example-skill/);
  assert.match(summary.join("\n"), /\[ Read \]/);
  assert.match(summary.join("\n"), /Path: \/tmp\/example-skill/);

  const locate = buildResourceDetailPanel(resource, { mode: "locate" });
  assert.match(locate.join("\n"), /Location/);
  assert.match(locate.join("\n"), /\/tmp\/example-skill/);
});

test("calculates a scrolling viewport that keeps the selected resource visible", () => {
  assert.deepEqual(calculateVisibleRange(31, 0, 9), { start: 0, end: 9 });
  assert.deepEqual(calculateVisibleRange(31, 8, 9), { start: 0, end: 9 });
  assert.deepEqual(calculateVisibleRange(31, 9, 9), { start: 1, end: 10 });
  assert.deepEqual(calculateVisibleRange(31, 20, 9), { start: 12, end: 21 });
  assert.deepEqual(calculateVisibleRange(31, 30, 9), { start: 22, end: 31 });
});

test("discovers loose skills, package settings, extensions, and trusted skill metadata", async () => {
  const env = await makeEnv();
  const agentsSkillRoot = join(env.agentsDir, "skills");
  await writeSkill(agentsSkillRoot, "grill-me");
  await writeSkill(agentsSkillRoot, "local-only");
  await writeFile(env.settingsPath, JSON.stringify({ packages: ["npm:@scope/example"] }, null, 2));
  await writeFile(join(env.extensionRoot, "hello.ts"), "export default function () {}\n");
  await writeFile(join(env.agentsDir, ".skill-lock.json"), JSON.stringify({
    skills: {
      "grill-me": {
        sourceUrl: "https://github.com/example/skills.git",
        skillPath: "skills/grill-me/SKILL.md",
      },
    },
  }, null, 2));

  const result = await discoverResources(env);

  assert.equal(result.skills.find((skill) => skill.name === "grill-me")?.trusted, true);
  assert.equal(result.skills.find((skill) => skill.name === "local-only")?.trusted, false);
  assert.equal(result.skills.find((skill) => skill.name === "local-only")?.updateStatus, "local-only");
  assert.equal(result.extensions.find((extension) => extension.name === "hello")?.enabled, true);
  assert.equal(result.packages.find((pkg) => pkg.name === "npm:@scope/example")?.source, "npm:@scope/example");
});

test("quarantines loose resources with a manifest", async () => {
  const env = await makeEnv();
  const skillPath = await writeSkill(join(env.agentsDir, "skills"), "old-skill");
  const resource = {
    kind: "skill",
    name: "old-skill",
    path: skillPath,
    scope: "global-agents",
    enabled: true,
  };

  const result = await quarantineResource(resource, env);

  await assert.rejects(() => stat(skillPath));
  assert.match(result.path, /resource-manager-quarantine/);
  const manifest = JSON.parse(await readFile(join(result.path, "resource-manager-manifest.json"), "utf8"));
  assert.equal(manifest.name, "old-skill");
  assert.equal(manifest.originalPath, skillPath);
});

test("discovers quarantined resources as disabled and restores them", async () => {
  const env = await makeEnv();
  const skillPath = await writeSkill(join(env.agentsDir, "skills"), "disabled-skill");
  const quarantined = await quarantineResource({
    kind: "skill",
    name: "disabled-skill",
    path: skillPath,
    scope: "global-agents",
    enabled: true,
  }, env);

  const result = await discoverResources(env);
  const disabled = result.skills.find((skill) => skill.name === "disabled-skill");
  assert.equal(disabled?.enabled, false);
  assert.equal(disabled?.path, quarantined.path);

  const restored = await restoreQuarantinedResource(disabled, env);
  assert.equal(restored.path, skillPath);
  await stat(skillPath);
});

test("builds safe pi package commands", () => {
  assert.deepEqual(buildPackageCommand("update", "npm:@scope/example"), {
    command: "pi",
    args: ["update", "npm:@scope/example"],
  });
  assert.deepEqual(buildPackageCommand("remove", "npm:@scope/example"), {
    command: "pi",
    args: ["remove", "npm:@scope/example"],
  });
  assert.throws(() => buildPackageCommand("install", "npm:@scope/example"), /Unsupported package action/);
});

test("discovers skills inside git repositories as git-managed trusted sources", async () => {
  const env = await makeEnv();
  const repo = join(env.agentsDir, "skills", "git-skills");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/example/git-skills.git\n');
  await writeSkill(join(repo, "skills"), "git-skill");

  const result = await discoverResources(env);
  const skill = result.skills.find((item) => item.name === "git-skill");

  assert.equal(skill?.trusted, true);
  assert.equal(skill?.updateStatus, "git-managed");
  assert.equal(skill?.git?.remoteUrl, "https://github.com/example/git-skills.git");
});

test("creates trusted skill update plans without inferring unknown sources", async () => {
  const env = await makeEnv();
  const skillPath = await writeSkill(join(env.agentsDir, "skills"), "trusted-skill");
  const unknownPath = await writeSkill(join(env.agentsDir, "skills"), "unknown-skill");
  await writeFile(join(env.agentsDir, ".skill-lock.json"), JSON.stringify({
    skills: {
      "trusted-skill": {
        sourceUrl: "https://github.com/example/skills.git",
        skillPath: "skills/trusted-skill/SKILL.md",
      },
    },
  }, null, 2));

  const trusted = getSkillUpdatePlan({ kind: "skill", name: "trusted-skill", path: skillPath }, await discoverResources(env), env);
  assert.equal(trusted.updateable, true);
  assert.equal(trusted.sourceUrl, "https://github.com/example/skills.git");
  assert.equal(trusted.remoteSkillPath, "skills/trusted-skill");

  const unknown = getSkillUpdatePlan({ kind: "skill", name: "unknown-skill", path: unknownPath }, await discoverResources(env), env);
  assert.equal(unknown.updateable, false);
  assert.match(unknown.reason, /No trusted source metadata/);
});

test("creates git pull update plans for git-managed skills", async () => {
  const env = await makeEnv();
  const repo = join(env.agentsDir, "skills", "git-skills");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/example/git-skills.git\n');
  const skillPath = await writeSkill(join(repo, "skills"), "git-skill");

  const discovery = await discoverResources(env);
  const plan = getSkillUpdatePlan({ kind: "skill", name: "git-skill", path: skillPath }, discovery, env);

  assert.equal(plan.updateable, true);
  assert.equal(plan.strategy, "git-pull");
  assert.equal(plan.sourceUrl, "https://github.com/example/git-skills.git");
  assert.equal(plan.repoPath.replaceAll("\\\\?\\", ""), repo.replaceAll("\\\\?\\", ""));
});
