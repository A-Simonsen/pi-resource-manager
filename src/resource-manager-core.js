export { discoverResources, getDefaultEnv } from "./resource-discovery.js";
export {
  buildPackageCommand,
  getSkillUpdatePlan,
  performResourceAction,
  quarantineResource,
  restoreQuarantinedResource,
} from "./resource-operations.js";

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
