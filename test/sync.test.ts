import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import {
  getConfigPaths,
  loadModelSources,
  loadNativeModels,
  writeJsonAtomic,
} from "../src/config.ts";
import { buildDefaultModel } from "../src/core.ts";
import { applyModelConfig, modelChoices, reloadProvider } from "../src/sync.ts";

let dir: string;
let previousDir: string | undefined;
const kept = { id: "kept", name: "Hand edited", maxTokens: 123, compat: { custom: true } };
const native = {
  $schema: "https://pi.dev/schemas/models.schema.json",
  custom: { preserved: true },
  providers: {
    p1: {
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      apiKey: "$TEST_KEY",
      headers: { "X-Custom": "value" },
      compat: { supportsStore: false },
      modelOverrides: { untouched: { maxTokens: 1 } },
      models: [kept, { id: "gone", maxTokens: 5 }, { id: "remove" }],
    },
    other: { baseUrl: "https://other.example/v1", models: [{ id: "other" }] },
  },
};

beforeEach(async () => {
  previousDir = process.env.PI_CODING_AGENT_DIR;
  dir = await mkdtemp(join(tmpdir(), "pi-model-sync-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const paths = getConfigPaths();
  await writeJsonAtomic(paths.models, native);
  await writeJsonAtomic(paths.sources, {
    providers: {
      p1: {
        models: [
          { id: "kept", config: "openai/reference" },
          { id: "new", config: "" },
        ],
      },
    },
  });
  await writeJsonAtomic(paths.cache, {
    openai: { reference: { id: "reference", maxTokens: 999, reasoning: true } },
  });
  mock.method(
    globalThis,
    "fetch",
    async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).includes("pi.dev")
            ? {
                openai: {
                  reference: {
                    id: "reference",
                    maxTokens: 999,
                    reasoning: true,
                    baseUrl: "https://source.example",
                    api: "openai-responses",
                  },
                },
              }
            : { data: [{ id: "kept" }, { id: "new" }] },
        ),
      ),
  );
});

afterEach(async () => {
  mock.restoreAll();
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  await rm(dir, { recursive: true, force: true });
});

type DialogStep = { screen: string; value: string | string[] | undefined };

function context(
  options: {
    selected?: string[] | undefined;
    cancel?: boolean;
    provider?: string | undefined;
    confirm?: boolean;
    onSelection?: () => Promise<void>;
    dialogs?: DialogStep[];
  } = {},
) {
  let refreshes = 0;
  const notifications: string[] = [];
  const prompts: string[][] = [];
  const inputListeners = new Set<Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0]>();
  const pressKey = (data: string) => {
    for (const listener of inputListeners) {
      if (listener(data)?.consume) return true;
    }
    return false;
  };
  const nextDialog = (screen: string) => {
    const dialog = options.dialogs?.shift();
    assert.equal(dialog?.screen, screen);
    return dialog?.value;
  };
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      onTerminalInput: (listener: Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0]) => {
        inputListeners.add(listener);
        return () => {
          inputListeners.delete(listener);
        };
      },
      select: async (title: string, choices: string[]) => {
        assert.deepEqual(choices, [
          "Apply model settings",
          "Manage models",
          "Open model-sources.json",
        ]);
        return options.dialogs ? (nextDialog(title) as string | undefined) : undefined;
      },
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const component = await factory(
          { terminal: { rows: 24 }, requestRender: () => {} } as unknown as Parameters<
            typeof factory
          >[0],
          { fg: (_color: string, label: string) => label } as Parameters<typeof factory>[1],
          {} as Parameters<typeof factory>[2],
          () => {},
        );
        try {
          const lines = component.render(200);
          if (options.dialogs) return nextDialog(lines[0] ?? "");
          if (lines[0] === "Select a provider") {
            prompts.push(lines.slice(1, -2).map((line) => line.slice(2)));
            return "provider" in options ? options.provider : "p1";
          }
          await options.onSelection?.();
          return options.cancel ? undefined : (options.selected ?? ["kept", "gone", "new"]);
        } finally {
          component.dispose?.();
        }
      },
      confirm: () => Promise.resolve(options.confirm ?? true),
    },
    modelRegistry: {
      getProvider: () => undefined,
      getProviderAuth: async () => undefined,
      refresh: async (options: { allowNetwork: boolean }) => {
        assert.equal(options.allowNetwork, false);
        refreshes += 1;
      },
      getError: () => undefined,
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    notifications,
    prompts,
    pressKey,
    listeners: () => inputListeners.size,
    refreshes: () => refreshes,
  };
}

async function rawModels(): Promise<string> {
  return readFile(getConfigPaths().models, "utf8");
}

async function runUpdateCommand(ctx: ExtensionContext, exec?: ExtensionAPI["exec"]): Promise<void> {
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  extension({
    exec,
    registerCommand: (name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      assert.equal(name, "provider-models");
      command = value;
    },
  } as unknown as ExtensionAPI);
  assert.ok(command);
  await command.handler("", ctx as never);
}

describe("command registration", () => {
  it("only registers commands without reading configuration, fetching or registering providers", () => {
    process.env.PI_CODING_AGENT_DIR = join(dir, "does-not-exist");
    const commands: string[] = [];
    extension({
      registerCommand: (name: string) => commands.push(name),
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, ["provider-models"]);
  });
});

describe("/provider-models open sources", () => {
  it("opens the configured file with the OS default app and returns to the menu", async () => {
    process.env.PI_CODING_AGENT_DIR = join(dir, "spaces & user's %TEMP%");
    const path = getConfigPaths().sources;
    await writeJsonAtomic(path, { providers: {} });
    const before = await readFile(path, "utf8");
    const originalPlatform = process.platform;
    try {
      for (const [platform, command, args] of [
        ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", path]],
        ["darwin", "open", [path]],
        ["linux", "xdg-open", [path]],
      ] as const) {
        Object.defineProperty(process, "platform", { value: platform });
        const dialogs: DialogStep[] = [
          { screen: "Provider models", value: "Open model-sources.json" },
          { screen: "Provider models", value: undefined },
        ];
        const { ctx, notifications, refreshes, listeners } = context({ dialogs });
        let calls = 0;
        await runUpdateCommand(ctx, async (actualCommand, actualArgs, options) => {
          calls++;
          assert.equal(actualCommand, command);
          assert.deepEqual(actualArgs, args);
          assert.ok(options?.signal);
          assert.equal(options.signal.aborted, false);
          return { code: 0, stdout: "", stderr: "", killed: false };
        });
        assert.equal(calls, 1);
        assert.deepEqual(notifications, [`pi-provider-model-sync: opened ${path}.`]);
        assert.equal(dialogs.length, 0);
        assert.equal(refreshes(), 0);
        assert.equal(listeners(), 0);
        assert.equal(await readFile(path, "utf8"), before);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("reports missing files and launcher failures without writing settings", async () => {
    const before = await rawModels();
    const path = getConfigPaths().sources;
    const beforeSources = await readFile(path, "utf8");
    for (const failure of ["exit", "spawn", "missing"]) {
      if (failure === "missing") await rm(path);
      const dialogs: DialogStep[] = [
        { screen: "Provider models", value: "Open model-sources.json" },
        { screen: "Provider models", value: undefined },
      ];
      const { ctx, notifications, listeners } = context({ dialogs });
      let calls = 0;
      await runUpdateCommand(ctx, async () => {
        calls++;
        if (failure === "spawn") throw new Error("launcher failed");
        return { code: 1, stdout: "", stderr: "launcher failed", killed: false };
      });
      assert.equal(calls, failure === "missing" ? 0 : 1);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0] ?? "", failure === "missing" ? /ENOENT/ : /launcher failed/);
      assert.equal(dialogs.length, 0);
      assert.equal(listeners(), 0);
      assert.equal(await rawModels(), before);
      if (failure === "missing") await assert.rejects(readFile(path), { code: "ENOENT" });
      else assert.equal(await readFile(path, "utf8"), beforeSources);
    }
  });

  it("forwards Ctrl+C to the launcher and exits without reopening the menu", async () => {
    const before = await rawModels();
    const path = getConfigPaths().sources;
    const beforeSources = await readFile(path, "utf8");
    const dialogs: DialogStep[] = [{ screen: "Provider models", value: "Open model-sources.json" }];
    const { ctx, notifications, pressKey, listeners } = context({ dialogs });
    let calls = 0;
    await runUpdateCommand(ctx, async (_command, _args, options) => {
      calls++;
      assert.ok(options?.signal);
      assert.equal(pressKey("\x03"), true);
      assert.equal(options.signal.aborted, true);
      return { code: 130, stdout: "", stderr: "", killed: true };
    });
    assert.equal(calls, 1);
    assert.deepEqual(notifications, []);
    assert.equal(dialogs.length, 0);
    assert.equal(listeners(), 0);
    assert.equal(await rawModels(), before);
    assert.equal(await readFile(path, "utf8"), beforeSources);
  });
});

describe("/provider-models navigation", () => {
  it("restores the selected provider after Escape, a fetch error, or saving models", async () => {
    for (const outcome of ["escape", "save", "error"]) {
      const fails = outcome === "error";
      const before = await rawModels();
      const dialogs: DialogStep[] = [
        { screen: "Provider models", value: "Manage models" },
        { screen: "Provider models", value: undefined },
      ];
      const { ctx, listeners, notifications, refreshes } = context({ dialogs });
      let providerScreens = 0;
      let modelScreens = 0;
      let restoredProviderRow: string | undefined;
      type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
      mock.method(
        ctx.ui,
        "custom",
        (factory: Factory) =>
          new Promise((resolve) => {
            const component = factory(
              {
                terminal: { rows: 24 },
                requestRender: () => {},
              } as unknown as Parameters<Factory>[0],
              { fg: (_color: string, label: string) => label } as Parameters<Factory>[1],
              {} as Parameters<Factory>[2],
              resolve,
            );
            assert.ok(!("then" in component));
            const lines = component.render(200);
            if (lines[0] === "Select a provider") {
              providerScreens++;
              if (providerScreens === 1) {
                component.handleInput?.("\x1b[B");
                component.handleInput?.("\r");
              } else {
                restoredProviderRow = lines[2];
                component.handleInput?.("\x1b");
              }
            } else {
              assert.equal(lines[0], "Models: other");
              modelScreens++;
              if (outcome === "save") {
                component.handleInput?.("\x1b[B");
                component.handleInput?.("\x1b[B");
                component.handleInput?.(" ");
                component.handleInput?.("\x13");
              } else component.handleInput?.("\x1b");
            }
            component.dispose?.();
          }),
      );
      if (fails)
        mock.method(globalThis, "fetch", async () => {
          throw new Error("offline");
        });
      await runUpdateCommand(ctx);
      assert.equal(providerScreens, 2);
      assert.equal(restoredProviderRow, "> other");
      assert.equal(modelScreens, fails ? 0 : 1);
      assert.equal(dialogs.length, 0);
      assert.equal(listeners(), 0);
      if (outcome === "save") {
        assert.deepEqual((await loadNativeModels()).providers.other?.models, [
          { id: "other" },
          buildDefaultModel("new"),
        ]);
        assert.ok(notifications.some((message) => message.includes("other saved")));
        assert.equal(refreshes(), 1);
      } else assert.equal(await rawModels(), before);
    }
  });

  it("returns from model Escape to providers and allows saving a different provider", async () => {
    const dialogs: DialogStep[] = [
      { screen: "Provider models", value: "Manage models" },
      { screen: "Select a provider", value: "p1" },
      { screen: "Models: p1", value: undefined },
      { screen: "Select a provider", value: "other" },
      { screen: "Models: other", value: ["other"] },
      { screen: "Select a provider", value: undefined },
      { screen: "Provider models", value: undefined },
    ];
    const { ctx, notifications } = context({ dialogs });
    await runUpdateCommand(ctx);
    assert.equal(dialogs.length, 0);
    assert.deepEqual((await loadNativeModels()).providers.p1, native.providers.p1);
    assert.ok(notifications.some((message) => message.includes("other saved")));
  });

  it("returns to providers after timeout, reports the error, and allows retrying", async () => {
    const dialogs: DialogStep[] = [
      { screen: "Provider models", value: "Manage models" },
      { screen: "Select a provider", value: "p1" },
      { screen: "Select a provider", value: "p1" },
      { screen: "Models: p1", value: ["kept"] },
      { screen: "Select a provider", value: undefined },
      { screen: "Provider models", value: undefined },
    ];
    let attempts = 0;
    mock.method(globalThis, "fetch", async () => {
      attempts++;
      if (attempts === 1)
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return new Response(JSON.stringify({ data: [{ id: "kept" }] }));
    });
    const { ctx, notifications } = context({ dialogs });
    await runUpdateCommand(ctx);
    assert.equal(dialogs.length, 0);
    assert.equal(attempts, 2);
    assert.ok(
      notifications.some((message) =>
        message.includes("p1: The operation was aborted due to timeout"),
      ),
    );
    assert.deepEqual((await loadNativeModels()).providers.p1?.models, [kept]);
  });

  it("returns from provider Escape to the menu, then exits without saving", async () => {
    const dialogs: DialogStep[] = [
      { screen: "Provider models", value: "Manage models" },
      { screen: "Select a provider", value: undefined },
      { screen: "Provider models", value: undefined },
    ];
    const before = await rawModels();
    await runUpdateCommand(context({ dialogs }).ctx);
    assert.equal(dialogs.length, 0);
    assert.equal(await rawModels(), before);
  });

  it("applies existing model config through the menu", async () => {
    const dialogs: DialogStep[] = [{ screen: "Provider models", value: "Apply model settings" }];
    const { ctx, notifications } = context({ dialogs });
    await runUpdateCommand(ctx);
    assert.equal(dialogs.length, 0);
    assert.ok(notifications.some((message) => message.includes("applied settings to 2 models")));
    assert.deepEqual((await loadNativeModels()).providers.p1?.models?.[0], {
      ...buildDefaultModel("kept"),
      maxTokens: 999,
      reasoning: true,
    });
  });

  it("returns to the menu when apply confirmation is cancelled", async () => {
    const dialogs: DialogStep[] = [
      { screen: "Provider models", value: "Apply model settings" },
      { screen: "Provider models", value: undefined },
    ];
    const before = await rawModels();
    mock.method(globalThis, "fetch", async () => {
      throw new Error("must not fetch");
    });
    await runUpdateCommand(context({ dialogs, confirm: false }).ctx);
    assert.equal(dialogs.length, 0);
    assert.equal(await rawModels(), before);
  });

  it("exits from the initial menu without touching settings", async () => {
    const dialogs: DialogStep[] = [{ screen: "Provider models", value: undefined }];
    const before = await rawModels();
    await runUpdateCommand(context({ dialogs }).ctx);
    assert.equal(dialogs.length, 0);
    assert.equal(await rawModels(), before);
  });
});

describe("/provider-models Ctrl+C", () => {
  it("cancels the deletion confirmation without saving or reopening a parent screen", async () => {
    const before = await rawModels();
    const beforeSources = await readFile(getConfigPaths().sources, "utf8");
    const dialogs: DialogStep[] = [
      { screen: "Provider models", value: "Manage models" },
      { screen: "Select a provider", value: "p1" },
      { screen: "Models: p1", value: ["kept"] },
    ];
    const { ctx, pressKey, listeners } = context({ dialogs });
    mock.method(
      ctx.ui,
      "confirm",
      async (title: string, _message: string, options?: { signal?: AbortSignal }) => {
        assert.equal(title, "Save model selection");
        assert.ok(options?.signal);
        assert.equal(pressKey("\x03"), true);
        assert.equal(options.signal.aborted, true);
        return false;
      },
    );
    await runUpdateCommand(ctx);
    assert.equal(dialogs.length, 0);
    assert.equal(listeners(), 0);
    assert.equal(await rawModels(), before);
    assert.equal(await readFile(getConfigPaths().sources, "utf8"), beforeSources);
  });

  it("dismisses the main menu or apply confirmation and removes the input listener", async () => {
    for (const stage of ["menu", "confirmation"]) {
      const before = await rawModels();
      const { ctx, pressKey, listeners, notifications } = context();
      let commandSignal: AbortSignal | undefined;
      mock.method(
        ctx.ui,
        "select",
        async (_title: string, _choices: string[], options?: { signal?: AbortSignal }) => {
          commandSignal = options?.signal;
          assert.ok(commandSignal);
          assert.equal(listeners(), 1);
          assert.equal(pressKey("a"), false);
          if (stage === "confirmation") return "Apply model settings";
          assert.equal(pressKey("\x03"), true);
          return undefined;
        },
      );
      mock.method(
        ctx.ui,
        "confirm",
        async (_title: string, _message: string, options?: { signal?: AbortSignal }) => {
          assert.equal(options?.signal, commandSignal);
          assert.equal(pressKey("\x03"), true);
          return false;
        },
      );
      await runUpdateCommand(ctx);
      assert.equal(commandSignal?.aborted, true);
      assert.equal(listeners(), 0);
      assert.equal(await rawModels(), before);
      assert.deepEqual(notifications, []);
    }
  });

  it("closes either list without returning to a parent dialog or saving", async () => {
    for (const stage of ["Select a provider", "Models: p1"]) {
      const before = await rawModels();
      const beforeSources = await readFile(getConfigPaths().sources, "utf8");
      const dialogs: DialogStep[] = [{ screen: "Provider models", value: "Manage models" }];
      const { ctx, pressKey, listeners } = context({ dialogs });
      const screens: string[] = [];
      type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
      mock.method(
        ctx.ui,
        "custom",
        (factory: Factory) =>
          new Promise((resolve) => {
            const component = factory(
              {
                terminal: { rows: 24 },
                requestRender: () => {},
              } as unknown as Parameters<Factory>[0],
              { fg: (_color: string, label: string) => label } as Parameters<Factory>[1],
              {} as Parameters<Factory>[2],
              resolve,
            );
            assert.ok(!("then" in component));
            const title = component.render(200)[0] ?? "";
            screens.push(title);
            if (stage === "Models: p1" && title === "Select a provider") {
              component.handleInput?.("\r");
            } else {
              assert.equal(title, stage);
              assert.equal(pressKey("\x03"), true);
            }
            component.dispose?.();
          }),
      );
      await runUpdateCommand(ctx);
      assert.deepEqual(
        screens,
        stage === "Models: p1" ? ["Select a provider", "Models: p1"] : ["Select a provider"],
      );
      assert.equal(dialogs.length, 0);
      assert.equal(listeners(), 0);
      assert.equal(await rawModels(), before);
      assert.equal(await readFile(getConfigPaths().sources, "utf8"), beforeSources);
    }
  });

  it("aborts provider and catalog fetches without saving or falling back to cache", async () => {
    for (const action of ["Manage models", "Apply model settings"]) {
      const before = await rawModels();
      const beforeSources = await readFile(getConfigPaths().sources, "utf8");
      const dialogs: DialogStep[] = [{ screen: "Provider models", value: action }];
      if (action === "Manage models") dialogs.push({ screen: "Select a provider", value: "p1" });
      const { ctx, pressKey, listeners, notifications } = context({ dialogs });
      let requestAborted = false;
      mock.method(
        globalThis,
        "fetch",
        (_url: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = options.signal;
            assert.ok(signal);
            signal.addEventListener(
              "abort",
              () => {
                requestAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
            assert.equal(pressKey("\x03"), true);
          }),
      );
      await runUpdateCommand(ctx);
      assert.equal(requestAborted, true);
      assert.equal(dialogs.length, 0);
      assert.equal(listeners(), 0);
      assert.equal(await rawModels(), before);
      assert.equal(await readFile(getConfigPaths().sources, "utf8"), beforeSources);
      assert.ok(
        !notifications.some(
          (message) => message.includes("using cache") || message.includes("aborted"),
        ),
      );
    }
  });

  it("can leave a pending authentication lookup without fetching or saving", async () => {
    const before = await rawModels();
    const dialogs: DialogStep[] = [
      { screen: "Provider models", value: "Manage models" },
      { screen: "Select a provider", value: "p1" },
    ];
    const { ctx, pressKey, listeners } = context({ dialogs });
    mock.method(ctx.modelRegistry, "getProviderAuth", () => {
      queueMicrotask(() => {
        assert.equal(pressKey("\x03"), true);
      });
      return new Promise<never>(() => {});
    });
    mock.method(globalThis, "fetch", () => assert.fail("must not fetch"));
    await runUpdateCommand(ctx);
    assert.equal(dialogs.length, 0);
    assert.equal(listeners(), 0);
    assert.equal(await rawModels(), before);
  });
});

describe("modelChoices", () => {
  it("groups checked models first, then unavailable models, preserving order within each group", () => {
    const ids = ["api-b", "api-a", "api-c", "api-d"];
    const existing = [{ id: "missing-b" }, { id: "api-a" }, { id: "missing-a" }, { id: "api-d" }];
    const sources = [
      { id: "missing-c" },
      { id: "missing-b" },
      { id: "api-b" },
      { id: "missing-d" },
    ];
    const original = structuredClone({ ids, existing, sources });
    assert.deepEqual(
      modelChoices(ids, existing, sources).map((model) => model.id),
      ["missing-b", "missing-a", "api-a", "api-d", "missing-c", "missing-d", "api-b", "api-c"],
    );
    assert.deepEqual({ ids, existing, sources }, original);
  });

  it("includes source-only IDs unchecked, marks missing API entries, and deduplicates", () => {
    const id = "deepseek/deepseek-v4-flash";
    assert.deepEqual(
      modelChoices(["kept", "new"], [kept], [{ id: "kept" }, { id }, { id: "new" }]),
      [
        { id: "kept", checked: true, available: true },
        { id, checked: false, available: false },
        { id: "new", checked: false, available: true },
      ],
    );
    assert.deepEqual(modelChoices([], [], [{ id }]), [{ id, checked: false, available: false }]);
  });

  it("uses the union, with existing models checked and missing API models unavailable", () => {
    assert.deepEqual(modelChoices(["kept", "new"], [kept, { id: "gone" }], []), [
      { id: "gone", checked: true, available: false },
      { id: "kept", checked: true, available: true },
      { id: "new", checked: false, available: true },
    ]);
    assert.deepEqual(modelChoices([], [{ id: "gone" }], []), [
      { id: "gone", checked: true, available: false },
    ]);
  });
});

describe("reloadProvider", () => {
  it("confirms source and native deletions before resolving catalog metadata, and cancels safely", async () => {
    await writeJsonAtomic(getConfigPaths().sources, {
      providers: {
        p1: {
          models: [
            { id: "kept", config: "" },
            { id: "new", config: "openai/reference" },
            { id: "remove", config: "" },
            { id: "legacy-only", config: "" },
          ],
        },
      },
    });
    const before = await rawModels();
    const beforeSources = await readFile(getConfigPaths().sources, "utf8");
    const { ctx } = context();
    let confirmations = 0;
    let catalogRequests = 0;
    mock.method(ctx.ui, "confirm", async (title: string, message: string) => {
      confirmations++;
      assert.equal(title, "Save model selection");
      assert.match(message, /Add: 1/);
      assert.match(message, /Remove: 2/);
      assert.match(message, /source settings and overrides/);
      return false;
    });
    mock.method(globalThis, "fetch", async (url: string) => {
      if (url.includes("pi.dev")) catalogRequests++;
      return new Response(JSON.stringify({ data: [{ id: "kept" }, { id: "new" }] }));
    });
    assert.equal(await reloadProvider(ctx, "p1"), undefined);
    assert.equal(confirmations, 1);
    assert.equal(catalogRequests, 0);
    assert.equal(await rawModels(), before);
    assert.equal(await readFile(getConfigPaths().sources, "utf8"), beforeSources);
  });

  it("confirms source-only deletions even when every registered model stays selected", async () => {
    const before = await rawModels();
    const beforeSources = await readFile(getConfigPaths().sources, "utf8");
    const { ctx } = context({ selected: ["kept", "gone", "remove"] });
    let confirmations = 0;
    mock.method(ctx.ui, "confirm", async (_title: string, message: string) => {
      confirmations++;
      assert.match(message, /Add: 0/);
      assert.match(message, /Remove: 1/);
      return false;
    });
    assert.equal(await reloadProvider(ctx, "p1"), undefined);
    assert.equal(confirmations, 1);
    assert.equal(await rawModels(), before);
    assert.equal(await readFile(getConfigPaths().sources, "utf8"), beforeSources);
  });

  it("does not request confirmation when adding models without deleting any", async () => {
    const { ctx } = context({ selected: ["kept", "gone", "remove", "new"] });
    mock.method(ctx.ui, "confirm", () => assert.fail("no deletions to confirm"));
    assert.deepEqual(await reloadProvider(ctx, "p1"), {
      provider: "p1",
      total: 4,
      added: 1,
      removed: 0,
    });
  });

  it("shows a source-only legacy model in yellow and resolves its config when selected", async () => {
    const id = "deepseek/deepseek-v4-flash";
    await writeJsonAtomic(getConfigPaths().sources, {
      providers: { p1: { models: [{ id, config: "openai/reference" }] } },
    });
    const { ctx } = context();
    type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
    mock.method(ctx.ui, "custom", async (factory: Factory) => {
      let selection: unknown;
      const component = await factory(
        { terminal: { rows: 24 }, requestRender: () => {} } as unknown as Parameters<Factory>[0],
        {
          fg: (color: string, label: string) => (color === "warning" ? `yellow(${label})` : label),
        } as Parameters<Factory>[1],
        {} as Parameters<Factory>[2],
        (value) => {
          selection = value;
        },
      );
      assert.ok(
        component
          .render(200)
          .some((line) => line.includes(`yellow(  [ ] ${id} (Not listed by API))`)),
      );
      for (let index = 0; index < 3; index++) component.handleInput?.("\x1b[B");
      component.handleInput?.(" ");
      component.handleInput?.("\x13");
      return selection;
    });
    assert.deepEqual(await reloadProvider(ctx, "p1"), {
      provider: "p1",
      total: 4,
      added: 1,
      removed: 0,
    });
    assert.deepEqual((await loadNativeModels()).providers.p1?.models?.[3], {
      ...buildDefaultModel(id),
      maxTokens: 999,
      reasoning: true,
    });
  });

  it("selects a provider, preserves existing settings, adds defaults, and removes unchecked models", async () => {
    const { ctx, prompts, refreshes } = context();
    assert.deepEqual(await reloadProvider(ctx), { provider: "p1", total: 3, added: 1, removed: 1 });
    assert.deepEqual(prompts, [["p1", "other"]]);
    const saved = await loadNativeModels();
    assert.deepEqual(saved, {
      ...native,
      providers: {
        ...native.providers,
        p1: {
          ...native.providers.p1,
          models: [kept, { id: "gone", maxTokens: 5 }, buildDefaultModel("new")],
        },
      },
    });
    assert.equal(refreshes(), 1);
    const sources = await loadModelSources(getConfigPaths().sources);
    assert.equal(
      sources.providers.p1?.models.find((model) => model.id === "kept")?.config,
      "openai/reference",
    );
    assert.equal(sources.providers.p1?.models.find((model) => model.id === "gone")?.config, null);
  });

  it("removes unchecked native and source-only metadata while preserving selected config", async () => {
    const retained = { id: "kept", config: "openai/reference", override: { maxTokens: 77 } };
    const source = {
      override: { contextWindow: 64000 },
      models: [retained, { id: "remove", config: "" }, { id: "legacy-only", config: "" }],
    };
    const other = { models: [{ id: "other", config: "" }] };
    await writeJsonAtomic(getConfigPaths().sources, { providers: { p1: source, other } });
    assert.deepEqual(await reloadProvider(context().ctx, "p1"), {
      provider: "p1",
      total: 3,
      added: 1,
      removed: 2,
    });
    assert.deepEqual(await loadModelSources(getConfigPaths().sources), {
      providers: {
        p1: {
          ...source,
          models: [retained, { id: "gone", config: null }, { id: "new", config: null }],
        },
        other,
      },
    });
    assert.deepEqual((await loadNativeModels()).providers.p1?.models?.[0], kept);
  });

  it("allows clearing every model and does not repopulate from sources", async () => {
    const { ctx } = context({ selected: [] });
    await reloadProvider(ctx, "p1");
    assert.deepEqual((await loadNativeModels()).providers.p1?.models, []);
    assert.deepEqual((await loadModelSources(getConfigPaths().sources)).providers.p1?.models, []);
    assert.equal(await applyModelConfig(ctx, "p1"), 0);
    assert.deepEqual((await loadNativeModels()).providers.p1?.models, []);
  });

  it("accepts an empty API list and retains checked models missing from it", async () => {
    mock.method(globalThis, "fetch", async () => new Response('{"data":[]}'));
    await reloadProvider(context({ selected: ["kept", "gone"] }).ctx, "p1");
    assert.deepEqual((await loadNativeModels()).providers.p1?.models, [
      kept,
      { id: "gone", maxTokens: 5 },
    ]);
  });

  it("does not write on provider or model selection cancellation", async () => {
    const before = await rawModels();
    assert.equal(await reloadProvider(context({ provider: undefined }).ctx), undefined);
    assert.equal(await reloadProvider(context({ cancel: true }).ctx, "p1"), undefined);
    assert.equal(await rawModels(), before);
  });

  it("does not save if the API fails or returns malformed entries", async () => {
    const before = await rawModels();
    for (const response of [
      new Response("denied", { status: 401 }),
      new Response('{"data":[{}]}'),
      new Response("invalid JSON"),
    ]) {
      mock.method(globalThis, "fetch", async () => response);
      await assert.rejects(reloadProvider(context().ctx, "p1"));
      assert.equal(await rawModels(), before);
    }
  });

  it("does not overwrite changes made while the UI was open", async () => {
    const beforeSources = await readFile(getConfigPaths().sources, "utf8");
    const changed = { ...native, custom: { preserved: false } };
    const { ctx } = context({
      onSelection: () => writeJsonAtomic(getConfigPaths().models, changed),
    });
    await assert.rejects(reloadProvider(ctx, "p1"), /changed during/);
    assert.deepEqual(await loadNativeModels(), changed);
    assert.equal(await readFile(getConfigPaths().sources, "utf8"), beforeSources);
  });

  it("resolves config and overrides only for newly added models", async () => {
    await writeJsonAtomic(getConfigPaths().sources, {
      providers: {
        p1: {
          override: { maxTokens: 50 },
          models: [{ id: "new", config: "openai/reference", override: { contextWindow: 42 } }],
        },
      },
    });
    await reloadProvider(context().ctx, "p1");
    const models = (await loadNativeModels()).providers.p1?.models;
    assert.deepEqual(models?.[0], kept);
    assert.deepEqual(models?.[2], {
      ...buildDefaultModel("new"),
      maxTokens: 50,
      reasoning: true,
      contextWindow: 42,
    });
  });

  it("merges auth headers case-insensitively and does not duplicate Authorization", async () => {
    const provider = {
      ...native.providers.p1,
      authHeader: true,
      headers: { authorization: "Bearer explicit", "x-shared": "native" },
    };
    await writeJsonAtomic(getConfigPaths().models, { providers: { p1: provider } });
    const { ctx } = context({ cancel: true });
    mock.method(
      ctx.modelRegistry,
      "getProvider",
      () => ({ headers: { "X-Shared": "registered" } }) as never,
    );
    mock.method(ctx.modelRegistry, "getProviderAuth", async () => ({
      auth: { apiKey: "stored", headers: { "X-Auth": "auth" } },
    }));
    let received: Headers | undefined;
    mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      received = new Headers(init.headers);
      return new Response('{"data":[]}');
    });
    await reloadProvider(ctx, "p1");
    assert.equal(received?.get("authorization"), "Bearer explicit");
    assert.equal(received?.get("x-auth"), "auth");
    assert.equal(received?.get("x-shared"), "registered");
  });

  it("reports that a save succeeded if refreshing the registry subsequently fails", async () => {
    const { ctx } = context();
    mock.method(ctx.modelRegistry, "refresh", async () => {
      throw new Error("reload failed");
    });
    await assert.rejects(reloadProvider(ctx, "p1"), /was saved, but Pi could not reload/);
    assert.equal((await loadNativeModels()).providers.p1?.models?.length, 3);
  });
});

describe("applyModelConfig", () => {
  it("adds llm-host source models to empty or omitted models without duplicating them", async () => {
    const id = "deepseek-v4-flash";
    const referenceId = "deepseek/deepseek-v4-flash-0731";
    const source = {
      providers: { "llm-host": { models: [{ id, config: `openrouter/${referenceId}` }] } },
    };
    await writeJsonAtomic(getConfigPaths().sources, source);
    mock.method(globalThis, "fetch", async (url: string) => {
      assert.equal(url, "https://pi.dev/api/models");
      return new Response(
        JSON.stringify({
          openrouter: { [referenceId]: { id: referenceId, reasoning: true, maxTokens: 999 } },
        }),
      );
    });
    for (const models of [[], undefined]) {
      await writeJsonAtomic(getConfigPaths().models, {
        ...native,
        providers: { ...native.providers, "llm-host": { ...native.providers.p1, models } },
      });
      const { ctx } = context();
      assert.equal(await applyModelConfig(ctx, "llm-host"), 1);
      assert.equal(await applyModelConfig(ctx, "llm-host"), 1);
      const saved = await loadNativeModels();
      assert.deepEqual(saved.providers["llm-host"], {
        ...native.providers.p1,
        models: [{ ...buildDefaultModel(id), reasoning: true, maxTokens: 999 }],
      });
      assert.deepEqual(saved.providers.p1, native.providers.p1);
      assert.deepEqual(await loadModelSources(getConfigPaths().sources), source);
    }
  });

  it("adds and updates source models while preserving transport and models absent from sources", async () => {
    await writeJsonAtomic(getConfigPaths().sources, {
      providers: {
        p1: {
          override: { contextWindow: 64000 },
          models: [
            { id: "kept", config: "openai/reference", override: { maxTokens: 77 } },
            { id: "added", config: "" },
          ],
        },
      },
    });
    const { ctx, refreshes } = context();
    assert.equal(await applyModelConfig(ctx), 2);
    const saved = await loadNativeModels();
    assert.deepEqual(saved.providers.p1, {
      ...native.providers.p1,
      models: [
        { ...buildDefaultModel("kept"), maxTokens: 77, reasoning: true, contextWindow: 64000 },
        { id: "gone", maxTokens: 5 },
        { id: "remove" },
        { ...buildDefaultModel("added"), contextWindow: 64000 },
      ],
    });
    assert.deepEqual(saved.providers.other, native.providers.other);
    assert.equal(saved.$schema, native.$schema);
    assert.equal(refreshes(), 1);
  });

  it("supports provider-level inheritance and explicit model defaults", async () => {
    await writeJsonAtomic(getConfigPaths().sources, {
      providers: {
        p1: {
          config: "openai",
          override: { maxTokens: 50 },
          models: [
            { id: "kept", config: "openai/reference" },
            { id: "gone", config: "" },
            { id: "remove", config: "" },
          ],
        },
      },
    });
    assert.equal(await applyModelConfig(context().ctx, "p1"), 3);
    const models = (await loadNativeModels()).providers.p1?.models;
    assert.deepEqual(models?.[0], { ...buildDefaultModel("kept"), maxTokens: 50, reasoning: true });
    assert.deepEqual(models?.[1], { ...buildDefaultModel("gone"), maxTokens: 50 });
  });

  it("cancels without saving or fetching the catalog", async () => {
    const before = await rawModels();
    mock.method(globalThis, "fetch", async () => {
      throw new Error("must not fetch");
    });
    assert.equal(await applyModelConfig(context({ confirm: false }).ctx), undefined);
    assert.equal(await rawModels(), before);
  });

  it("uses cached metadata offline", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("offline");
    });
    const { ctx, notifications } = context();
    assert.equal(await applyModelConfig(ctx, "p1"), 2);
    assert.ok(notifications.some((message) => message.includes("using cache")));
  });

  it("does not partially save if any referenced model is missing", async () => {
    await writeJsonAtomic(getConfigPaths().sources, {
      providers: {
        p1: {
          models: [
            { id: "kept", config: "" },
            { id: "gone", config: "openai/missing" },
          ],
        },
      },
    });
    const before = await rawModels();
    await assert.rejects(applyModelConfig(context().ctx), /not found in the catalog/);
    assert.equal(await rawModels(), before);
  });

  it("rejects an unknown provider without saving", async () => {
    const before = await rawModels();
    await assert.rejects(applyModelConfig(context().ctx, "missing"), /not found/);
    assert.equal(await rawModels(), before);
  });
});
