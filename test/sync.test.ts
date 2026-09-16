import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  registerCachedProviders,
  synchronizeAllProviders,
} from "../src/sync.ts";

async function prepareAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-model-sync-"));
  const extensionDir = join(agentDir, "extensions", "pi-provider-model-sync");
  await mkdir(join(extensionDir, "cache"), { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        p1: {
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          models: [],
        },
      },
    }),
  );
  await writeFile(
    join(extensionDir, "model-sources.json"),
    JSON.stringify({
      providers: { p1: { models: [{ id: "m1", config: "" }] } },
    }),
  );
  // 空でも存在させておく。無いと起動時に Pi カタログを取りに行く
  await writeFile(join(extensionDir, "cache", "models.json"), "{}\n");
  return agentDir;
}

function createStubs(): { pi: never; ctx: never; registered: string[] } {
  const registered: string[] = [];
  const pi = {
    registerProvider: (name: string) => {
      registered.push(name);
    },
  };
  const ctx = { ui: { notify: () => {} } };
  return { pi: pi as never, ctx: ctx as never, registered };
}

describe("startup registration", () => {
  it("registers on session_start when load-time registration was skipped", async () => {
    process.env.PI_CODING_AGENT_DIR = await prepareAgentDir();
    try {
      const { pi, ctx, registered } = createStubs();
      await synchronizeAllProviders(pi, ctx);
      assert.deepEqual(registered, ["p1"]);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  it("does not register again when the provider was already registered at load time", async () => {
    process.env.PI_CODING_AGENT_DIR = await prepareAgentDir();
    try {
      const { pi, ctx, registered } = createStubs();
      await registerCachedProviders(pi);
      assert.deepEqual(registered, ["p1"]);

      await synchronizeAllProviders(pi, ctx);
      assert.deepEqual(
        registered,
        ["p1"],
        "session_start must not re-register providers registered at load time",
      );
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});
