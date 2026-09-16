import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  fileExists,
  getConfigPaths,
  loadModelSources,
  loadPiCache,
  writeJsonAtomic,
} from "../src/config.ts";

describe("getConfigPaths", () => {
  it("resolves sources and cache under the agent dir", () => {
    const agentDir = "C:/Users/test/.pi/agent";
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const paths = getConfigPaths();
      const normalize = (p: string) => p.replace(/\\/g, "/");
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

describe("fileExists", () => {
  it("returns false before creation and true after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-model-sync-"));
    const path = join(dir, "flag.json");
    assert.equal(await fileExists(path), false);
    await writeFile(path, "{}\n");
    assert.equal(await fileExists(path), true);
  });
});

describe("writeJsonAtomic and loaders", () => {
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
