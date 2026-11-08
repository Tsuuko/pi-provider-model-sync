import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getConfigPaths, loadNativeModels } from "./config.ts";
import { errorMessage } from "./core.ts";
import { applyModelConfig, reloadProvider } from "./sync.ts";
import { selectProvider, type ProviderListState } from "./ui.ts";

const LABEL = "pi-provider-model-sync";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("provider-models", {
    description: "Apply model settings, manage models, or open model sources",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(`${LABEL}: /provider-models requires interactive UI.`, "error");
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      const providerListState: ProviderListState = { selected: undefined, firstVisible: 0 };
      const unsubscribe = ctx.ui.onTerminalInput((data) => {
        if (!matchesKey(data, Key.ctrl("c"))) return undefined;
        controller.abort();
        return { consume: true };
      });
      try {
        while (!signal.aborted) {
          const action = await ctx.ui.select(
            "Provider models",
            ["Apply model settings", "Manage models", "Open model-sources.json"],
            { signal },
          );
          if (action === undefined || signal.aborted) return;
          try {
            if (action === "Open model-sources.json") {
              const path = getConfigPaths().sources;
              await access(path);
              signal.throwIfAborted();
              const windows = process.platform === "win32";
              const result = await pi.exec(
                windows ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open",
                windows ? ["url.dll,FileProtocolHandler", path] : [path],
                { signal },
              );
              signal.throwIfAborted();
              if (result.code !== 0) {
                throw new Error(
                  `Could not open model-sources.json: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`,
                );
              }
              ctx.ui.notify(`${LABEL}: opened ${path}.`, "info");
              continue;
            }
            if (action === "Apply model settings") {
              const count = await applyModelConfig(ctx, "", signal);
              if (signal.aborted) return;
              if (count === undefined) continue;
              ctx.ui.notify(`${LABEL}: applied settings to ${count} models.`, "info");
              return;
            }
            while (!signal.aborted) {
              const native = await loadNativeModels();
              signal.throwIfAborted();
              const providers = Object.keys(native.providers);
              if (providers.length === 0)
                throw new Error("No providers are configured in models.json.");
              const provider = await selectProvider(ctx, providers, signal, providerListState);
              if (signal.aborted) return;
              if (provider === undefined) break;
              try {
                const result = await reloadProvider(ctx, provider, signal);
                if (signal.aborted) return;
                if (result === undefined) continue;
                ctx.ui.notify(
                  `${LABEL}: ${result.provider} saved (${result.total} models, ${result.added} added, ${result.removed} removed).`,
                  "info",
                );
                continue;
              } catch (error) {
                if (signal.aborted && error === signal.reason) return;
                ctx.ui.notify(`${LABEL}: ${provider}: ${errorMessage(error)}`, "error");
              }
            }
          } catch (error) {
            if (signal.aborted && error === signal.reason) return;
            ctx.ui.notify(`${LABEL}: ${errorMessage(error)}`, "error");
          }
        }
      } catch (error) {
        if (!signal.aborted || error !== signal.reason) {
          ctx.ui.notify(`${LABEL}: ${errorMessage(error)}`, "error");
        }
      } finally {
        unsubscribe();
      }
    },
  });
}
