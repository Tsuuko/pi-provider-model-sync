import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getConfigPaths, loadModelSources, loadPiCache, writeJsonAtomic } from "../src/config.ts";

describe("getConfigPaths", () => {
  it("resolves sources and cache under the agent dir", () => {
    const agentDir = "C:/Users/test/.pi/agent";
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const paths = getConfigPaths();
      const normalize = (p: string) => p.replace(/\\/g, "/");
      assert.equal(normalize(paths.models), normalize(join(agentDir, "models.json")));
      assert.equal(
        normalize(paths.sources),
        normalize(join(agentDir, "extensions", "pi-provider-model-sync", "model-sources.json")),
      );
      assert.equal(
        normalize(paths.cache),
        normalize(join(agentDir, "extensions", "pi-provider-model-sync", "cache", "models.json")),
      );
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});

describe("writeJsonAtomic and loaders", () => {
  it("retains a private file mode and removes temporary files after serialization failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-model-sync-"));
    const path = join(dir, "models.json");
    await writeJsonAtomic(path, { original: true });
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      await chmod(path, 0o640);
      await writeJsonAtomic(path, { original: true });
      assert.equal((await stat(path)).mode & 0o777, 0o640);
    }
    await assert.rejects(writeJsonAtomic(path, { cannotSerialize: 1n }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { original: true });
    assert.deepEqual(await readdir(dir), ["models.json"]);
  });

  it(
    "updates the target without replacing a configuration symlink",
    { skip: process.platform === "win32" },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-model-sync-"));
      const target = join(dir, "target.json");
      const link = join(dir, "models.json");
      await writeJsonAtomic(target, {});
      await symlink(target, link);
      await writeJsonAtomic(link, { updated: true });
      assert.equal((await lstat(link)).isSymbolicLink(), true);
      assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { updated: true });
    },
  );
  it("writes and reloads model sources with comments stripped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-model-sync-"));
    const sourcesPath = join(dir, "model-sources.json");
    const content = `
{
  // provider override
  "providers": {
    "p1": {
      "override": { "maxTokens": 100 },
      "models": [
        { "id": "a", "config": "" }
      ]
    }
  }
}
`;
    await writeFile(sourcesPath, content);
    const loaded = await loadModelSources(sourcesPath);
    assert.equal(loaded.providers.p1?.override?.maxTokens, 100);
    assert.equal(loaded.providers.p1?.models?.[0]?.id, "a");
  });

  it("writes atomic JSON and reloads the Pi cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-model-sync-"));
    const cachePath = join(dir, "cache", "models.json");
    await writeJsonAtomic(cachePath, {
      openai: {
        "gpt-5.6-sol": { id: "gpt-5.6-sol", contextWindow: 272000 },
      },
    });
    const cache = await loadPiCache(cachePath);
    assert.equal(cache.openai?.["gpt-5.6-sol"]?.contextWindow, 272000);

    const raw = await readFile(cachePath, "utf8");
    assert.deepEqual(JSON.parse(raw), {
      openai: {
        "gpt-5.6-sol": { id: "gpt-5.6-sol", contextWindow: 272000 },
      },
    });
  });
});
