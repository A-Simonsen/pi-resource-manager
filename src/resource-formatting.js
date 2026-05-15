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
