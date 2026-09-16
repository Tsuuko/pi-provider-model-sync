import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  reloadProvider,
  registerCachedProviders,
  synchronizeAllProviders,
} from "./sync.ts";

const LABEL = "pi-provider-model-sync";

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerCommand("reload-provider", {
    description: "Refresh a custom provider's models and Pi catalog cache",
    handler: async (args, ctx) => {
      try {
        await reloadProvider(pi, ctx, args);
        ctx.ui.notify(`${LABEL}: provider reloaded.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `${LABEL}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    try {
      await synchronizeAllProviders(pi, ctx);
    } catch (error) {
      ctx.ui.notify(
        `${LABEL}: startup sync failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });

  await registerCachedProviders(pi);
}
