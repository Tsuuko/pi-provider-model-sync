import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDefaultModel,
  buildResolvedModel,
  deepMerge,
  getConfigReference,
  mergeModelIds,
  normalizeFullCatalog,
  parseConfigReference,
  parseModelIds,
  stripSourceTransportFields,
  validateSourceProvider
} from "../src/core.ts";

describe("parseConfigReference", () => {
  it("parses provider/model", () => {
    assert.deepEqual(parseConfigReference("openai/gpt-5.6-sol"), {
      provider: "openai",
      modelId: "gpt-5.6-sol"
    });
  });

  it("rejects empty and malformed references", () => {
    assert.throws(() => parseConfigReference("openai/"));
    assert.throws(() => parseConfigReference("/model"));
    assert.throws(() => parseConfigReference("no-slash"));
  });
});

describe("getConfigReference", () => {
  it("treats missing and empty config as undefined", () => {
    assert.equal(getConfigReference({ id: "a" }), undefined);
    assert.equal(getConfigReference({ id: "a", config: "" }), undefined);
    assert.equal(getConfigReference({ id: "a", config: "  " }), undefined);
  });

  it("returns a valid reference", () => {
    assert.equal(
      getConfigReference({ id: "a", config: "openai/gpt-5.6-sol" }),
      "openai/gpt-5.6-sol"
    );
  });
});

describe("validateSourceProvider", () => {
  it("rejects duplicate ids", () => {
    assert.throws(() =>
      validateSourceProvider("p", {
        models: [{ id: "a" }, { id: "a" }]
      })
    );
  });

  it("rejects override of structural fields", () => {
    assert.throws(() =>
      validateSourceProvider("p", {
        models: [{ id: "a", override: { id: "b" } }]
      })
    );
    assert.throws(() =>
      validateSourceProvider("p", {
        models: [{ id: "a" }],
        override: { config: "openai/x" }
      })
    );
  });

  it("rejects invalid config references", () => {
    assert.throws(() =>
      validateSourceProvider("p", {
        models: [{ id: "a", config: "bad" }]
      })
    );
  });

  it("accepts valid sources", () => {
    validateSourceProvider("p", {
      override: { maxTokens: 100 },
      models: [
        { id: "a" },
        { id: "b", config: "" },
        { id: "c", config: "openai/gpt-5.6-sol" }
      ]
    });
  });
});

describe("mergeModelIds", () => {
  it("adds new ids and keeps existing definitions", () => {
    const existing = [{ id: "a", config: "openai/gpt-5.6-sol", override: { maxTokens: 1 } }];
    const merged = mergeModelIds(existing, ["a", "b", "c"]);
    assert.deepEqual(merged, [
      { id: "a", config: "openai/gpt-5.6-sol", override: { maxTokens: 1 } },
      { id: "b", config: "" },
      { id: "c", config: "" }
    ]);
  });

  it("rejects empty ids", () => {
    assert.throws(() => mergeModelIds([], ["", "x"]));
  });
});

describe("parseModelIds", () => {
  it("parses an OpenAI-style /models response", () => {
    assert.deepEqual(
      parseModelIds({
        object: "list",
        data: [{ id: "a" }, { id: "b" }]
      }),
      ["a", "b"]
    );
  });

  it("rejects missing, empty, and duplicate ids", () => {
    assert.throws(() => parseModelIds({}));
    assert.throws(() => parseModelIds({ data: [] }));
    assert.throws(() => parseModelIds({ data: [{ id: "" }] }));
    assert.throws(() => parseModelIds({ data: [{ id: "a" }, { id: "a" }] }));
  });
});

describe("normalizeFullCatalog", () => {
  it("strips baseUrl and keeps model data", () => {
    const catalog = normalizeFullCatalog({
      openai: {
        "gpt-5.6-sol": {
          id: "gpt-5.6-sol",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          name: "GPT-5.6 Sol",
          contextWindow: 272000
        }
      }
    });
    assert.deepEqual(catalog, {
      openai: {
        "gpt-5.6-sol": {
          id: "gpt-5.6-sol",
          api: "openai-responses",
          name: "GPT-5.6 Sol",
          contextWindow: 272000
        }
      }
    });
  });

  it("rejects an empty catalog", () => {
    assert.throws(() => normalizeFullCatalog({}));
    assert.throws(() => normalizeFullCatalog([]));
  });
});

describe("deepMerge", () => {
  it("recursively merges objects and replaces arrays", () => {
    const merged = deepMerge(
      { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] },
      { a: 2, nested: { y: 3, z: 4 }, list: [9] }
    );
    assert.deepEqual(merged, {
      a: 2,
      nested: { x: 1, y: 3, z: 4 },
      list: [9]
    });
  });
});

describe("buildResolvedModel", () => {
  it("uses Pi defaults without a source model", () => {
    const model = buildResolvedModel("terra", undefined, undefined, undefined);
    assert.deepEqual(model, buildDefaultModel("terra"));
  });

  it("inherits capability fields from the source model", () => {
    const model = buildResolvedModel(
      "terra",
      {
        id: "gpt-5.6-sol",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        contextWindow: 999
      },
      undefined,
      undefined
    );
    assert.equal(model.id, "terra");
    assert.equal(model.reasoning, true);
    assert.equal(model.contextWindow, 999);
    assert.equal(model.api, undefined);
    assert.equal(model.baseUrl, undefined);
  });

  it("applies provider override then model override", () => {
    const model = buildResolvedModel(
      "terra",
      { id: "gpt-5.6-sol", contextWindow: 100 },
      { contextWindow: 200, compat: { supportsDeveloperRole: false } },
      { maxTokens: 50, compat: { supportsStrictMode: true } }
    );
    assert.equal(model.contextWindow, 200);
    assert.equal(model.maxTokens, 50);
    assert.deepEqual(model.compat, {
      supportsDeveloperRole: false,
      supportsStrictMode: true
    });
  });
});

describe("stripSourceTransportFields", () => {
  it("removes id, api, baseUrl, and provider", () => {
    assert.deepEqual(
      stripSourceTransportFields({
        id: "x",
        api: "openai-responses",
        baseUrl: "https://x",
        provider: "openai",
        name: "X",
        reasoning: true
      }),
      { name: "X", reasoning: true }
    );
  });
});
