import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openResourceManager } from "./interactive-manager.js";

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
