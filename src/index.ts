import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildPackageCommand,
  buildResourceDetailPanel,
  calculateVisibleRange,
  describeResource,
  discoverResources,
  getDefaultEnv,
  getDetailActionLabels,
  getSkillUpdatePlan,
  moveDetailActionSelection,
  quarantineResource,
  restoreQuarantinedResource,
} from "./resource-manager-core.js";

type Tab = "extensions" | "skills";
type ManagerAction = "inspect" | "toggle" | "update" | "delete" | "reload" | "close";
type DetailMode = "summary" | "read" | "locate";
type ManagerResult = { action: ManagerAction; tab: Tab; resource?: any };

export default function resourceManagerExtension(pi: ExtensionAPI) {
  pi.registerCommand("resources", {
    description: "Manage Pi extensions, packages, and skills",
    handler: async (_args, ctx) => openResourceManager(pi, ctx, "extensions"),
  });

  pi.registerCommand("skills", {
    description: "Manage Pi skills",
    handler: async (_args, ctx) => openResourceManager(pi, ctx, "skills"),
  });

  pi.registerCommand("resource-extensions", {
    description: "Manage Pi extensions and packages",
    handler: async (_args, ctx) => openResourceManager(pi, ctx, "extensions"),
  });
}

async function openResourceManager(pi: ExtensionAPI, ctx: ExtensionCommandContext, startTab: Tab) {
  if (!ctx.hasUI) {
    ctx.ui.notify("Resource Manager requires interactive UI mode.", "error");
    return;
  }

  let tab = startTab;

  while (true) {
    const env = getDefaultEnv();
    const discovery = await discoverResources(env);
    const result = await ctx.ui.custom<ManagerResult | null>((tui, theme, _keybindings, done) => {
      const component = new ResourceManagerComponent(discovery, tab, theme, done);
      return {
        render: (width: number) => component.render(width, tui.terminal.rows),
        invalidate: () => component.invalidate(),
        handleInput: (data: string) => {
          component.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (!result || result.action === "close") return;
    tab = result.tab;

    const shouldContinue = await handleAction(pi, ctx, env, discovery, result);
    if (!shouldContinue) return;
  }
}

class ResourceManagerComponent {
  private selected = 0;
  private view: "list" | "detail" = "list";
  private detailAction = 0;
  private detailMode: DetailMode = "summary";
  private cacheKey?: string;
  private cacheLines?: string[];

  constructor(
    private discovery: any,
    private tab: Tab,
    private theme: any,
    private done: (value: ManagerResult | null) => void,
  ) {}

  render(width: number, terminalRows = 24): string[] {
    const cacheKey = `${width}:${terminalRows}`;
    if (this.cacheLines && this.cacheKey === cacheKey) return this.cacheLines;

    const items = this.items();
    if (this.selected >= items.length) this.selected = Math.max(0, items.length - 1);

    if (this.view === "detail") return this.renderDetail(width, items[this.selected]);

    const maxVisibleItems = this.maxVisibleItems(terminalRows);
    const range = calculateVisibleRange(items.length, this.selected, maxVisibleItems);
    const visibleItems = items.slice(range.start, range.end);

    const lines = [
      this.theme.fg("accent", this.theme.bold("Resource Manager")),
      this.renderTabs(),
      "",
    ];

    if (items.length === 0) {
      lines.push(this.theme.fg("muted", `No ${this.tab} found.`));
    } else {
      for (let offset = 0; offset < visibleItems.length; offset += 1) {
        const index = range.start + offset;
        const item = visibleItems[offset];
        const selected = index === this.selected;
        const icon = item.enabled === false ? "○" : "●";
        const label = `${selected ? ">" : " "} ${icon} ${item.name}`;
        const detail = `  ${describeResource(item)}`;
        const labelColor = item.enabled === false ? "muted" : item.kind === "package" ? "warning" : "text";
        lines.push(truncateToWidth(selected ? this.theme.fg("accent", label) : this.theme.fg(labelColor, label), width));
        lines.push(truncateToWidth(this.theme.fg("dim", detail), width));
      }

      if (items.length > visibleItems.length) {
        lines.push(this.theme.fg("dim", `Showing ${range.start + 1}-${range.end} of ${items.length}`));
      }
    }

    lines.push("");
    lines.push(this.theme.fg("dim", "Tab switch tabs • ↑↓ navigate • Enter details • x enable/disable • u update • d quarantine/remove • r reload • Esc close"));

    this.cacheKey = cacheKey;
    this.cacheLines = lines.map((line) => truncateToWidth(line, width));
    return this.cacheLines;
  }

  handleInput(data: string): void {
    const items = this.items();
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }
    if (this.view === "detail") {
      this.handleDetailInput(data, items[this.selected]);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.tab = this.tab === "extensions" ? "skills" : "extensions";
      this.selected = 0;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected -= 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) && this.selected < items.length - 1) {
      this.selected += 1;
      this.invalidate();
      return;
    }

    const resource = items[this.selected];
    if (!resource) return;

    if (matchesKey(data, Key.enter)) {
      this.view = "detail";
      this.detailAction = 0;
      this.detailMode = "summary";
      this.invalidate();
      return;
    }
    if (data === "x" || matchesKey(data, Key.alt("x"))) this.done({ action: "toggle", tab: this.tab, resource });
    if (data === "u" || matchesKey(data, Key.alt("u"))) this.done({ action: "update", tab: this.tab, resource });
    if (data === "d" || matchesKey(data, Key.alt("d"))) this.done({ action: "delete", tab: this.tab, resource });
    if (data === "r" || matchesKey(data, Key.alt("r"))) this.done({ action: "reload", tab: this.tab, resource });
  }

  invalidate(): void {
    this.cacheKey = undefined;
    this.cacheLines = undefined;
  }

  private renderDetail(width: number, resource: any): string[] {
    if (!resource) {
      this.view = "list";
      return this.render(width);
    }

    const lines = [
      this.theme.fg("accent", this.theme.bold("Resource Manager")),
      this.renderTabs(),
      "",
      ...buildResourceDetailPanel(resource, {
        mode: this.detailMode,
        selectedAction: this.detailAction,
      }),
    ];

    this.cacheKey = `${width}:detail:${this.selected}:${this.detailAction}:${this.detailMode}`;
    this.cacheLines = lines.map((line) => truncateToWidth(line, width));
    return this.cacheLines;
  }

  private handleDetailInput(data: string, resource: any): void {
    if (!resource) {
      this.view = "list";
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.detailAction = moveDetailActionSelection(this.detailAction, -1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.detailAction = moveDetailActionSelection(this.detailAction, 1);
      this.invalidate();
      return;
    }
    if (!matchesKey(data, Key.enter)) return;

    const action = getDetailActionLabels()[this.detailAction]?.toLowerCase();
    if (action === "back") {
      this.view = "list";
      this.detailMode = "summary";
      this.invalidate();
      return;
    }
    if (action === "read") {
      this.detailMode = "read";
      this.invalidate();
      return;
    }
    if (action === "locate") {
      this.detailMode = "locate";
      this.invalidate();
      return;
    }
    if (action === "update" || action === "delete") {
      this.done({ action, tab: this.tab, resource });
    }
  }

  private items(): any[] {
    if (this.tab === "skills") return this.discovery.skills;
    return [...this.discovery.packages, ...this.discovery.extensions];
  }

  private maxVisibleItems(terminalRows: number): number {
    const reservedRows = 6;
    return Math.max(1, Math.floor((terminalRows - reservedRows) / 2));
  }

  private renderTabs(): string {
    const extensions = this.tab === "extensions" ? this.theme.fg("accent", "[ Extensions ]") : this.theme.fg("muted", "  Extensions  ");
    const skills = this.tab === "skills" ? this.theme.fg("accent", "[ Skills ]") : this.theme.fg("muted", "  Skills  ");
    return `${extensions} ${skills}`;
  }
}

async function handleAction(pi: ExtensionAPI, ctx: ExtensionCommandContext, env: any, discovery: any, result: ManagerResult): Promise<boolean> {
  const resource = result.resource;

  if (result.action === "reload") {
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

function isSelfExtension(resource: any): boolean {
  return resource?.kind === "extension" && resource?.name === "resource-manager";
}

async function runPackageCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, action: "update" | "remove", source: string): Promise<boolean> {
  const ok = await ctx.ui.confirm(`${action === "update" ? "Update" : "Remove"} package?`, `${action} ${source}?`);
  if (!ok) return true;
  const command = buildPackageCommand(action, source);
  const result = await pi.exec(command.command, command.args, { timeout: 120000 });
  if (result.code === 0) {
    ctx.ui.notify(`${action} completed for ${source}.`, "success");
    return await maybeReload(ctx);
  }
  ctx.ui.notify(`${action} failed for ${source}: ${result.stderr || result.stdout}`, "error");
  return true;
}

async function updateTrustedSkill(pi: ExtensionAPI, ctx: ExtensionCommandContext, env: any, discovery: any, resource: any): Promise<boolean> {
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
  } catch (error: any) {
    ctx.ui.notify(`Skill update failed: ${error.message}`, "error");
    return true;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function maybeReload(ctx: ExtensionCommandContext): Promise<boolean> {
  const reload = await ctx.ui.confirm("Reload Pi resources?", "Changes may not take effect until /reload. Reload now?");
  if (reload) {
    await ctx.reload();
    return false;
  }
  return true;
}
