export type JsonObject = Record<string, unknown>;

export interface SourceModel {
  id: string;
  config?: string;
  override?: JsonObject;
}

export interface SourceProvider {
  models: SourceModel[];
  config?: string;
  override?: JsonObject;
}

export interface ModelSourcesFile {
  providers: Record<string, SourceProvider>;
}

export type PiModel = JsonObject & {
  id: string;
};

export type PiCatalog = Record<string, Record<string, PiModel>>;

export const DEFAULT_MODEL_VALUES = {
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0
  },
  contextWindow: 128000,
  maxTokens: 16384
} as const;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function deepMerge(
  base: JsonObject,
  override: JsonObject
): JsonObject {
  const result = cloneJson(base);

  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = cloneJson(value);
    }
  }

  return result;
}

export function parseConfigReference(value: string): {
  provider: string;
  modelId: string;
} | undefined {
  const reference = value.trim();
  if (reference.length === 0) return undefined;

  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(
      `Invalid config reference "${value}". Expected provider/model.`
    );
  }

  return {
    provider: reference.slice(0, separator),
    modelId: reference.slice(separator + 1)
  };
}

export function getConfigReference(model: SourceModel): string | undefined {
  if (model.config === undefined) return undefined;
  const config = model.config.trim();
  return config.length === 0 ? undefined : config;
}

export function validateProviderConfig(value: string): void {
  const name = value.trim();
  if (name.length === 0) {
    throw new Error("Provider config must not be empty.");
  }
  if (name.includes("/")) {
    throw new Error(
      `Provider config must be a provider name, got "${value}".`
    );
  }
}

export function resolveSourceReference(
  model: SourceModel,
  providerConfig: string | undefined
): { provider: string; modelId: string } | undefined {
  const modelRef = getConfigReference(model);
  if (modelRef !== undefined) {
    return parseConfigReference(modelRef);
  }
  if (providerConfig !== undefined) {
    validateProviderConfig(providerConfig);
    return { provider: providerConfig, modelId: model.id };
  }
  return undefined;
}

export function validateSourceModel(model: SourceModel): void {
  if (model.id.trim().length === 0) {
    throw new Error("Model id must not be empty.");
  }

  if (model.override && ("id" in model.override || "config" in model.override)) {
    throw new Error(
      `Model ${model.id}: override cannot contain id or config.`
    );
  }

  if (model.config !== undefined) {
    parseConfigReference(model.config);
  }
}

export function validateSourceProvider(
  providerName: string,
  provider: SourceProvider
): void {
  if (!Array.isArray(provider.models)) {
    throw new Error(`Provider ${providerName}: models must be an array.`);
  }

  const ids = new Set<string>();
  for (const model of provider.models) {
    validateSourceModel(model);
    if (ids.has(model.id)) {
      throw new Error(`Provider ${providerName}: duplicate model id ${model.id}.`);
    }
    ids.add(model.id);
  }

  if (provider.override && ("id" in provider.override || "config" in provider.override)) {
    throw new Error(
      `Provider ${providerName}: override cannot contain id or config.`
    );
  }

  if (provider.config !== undefined) {
    validateProviderConfig(provider.config);
  }
}

export function mergeModelIds(
  existing: SourceModel[],
  ids: readonly string[]
): SourceModel[] {
  const result = existing.map(cloneJson);
  const known = new Set<string>();

  for (const model of result) {
    validateSourceModel(model);
    if (known.has(model.id)) {
      throw new Error(`Duplicate model id ${model.id}.`);
    }
    known.add(model.id);
  }

  for (const id of ids) {
    if (id.trim().length === 0) {
      throw new Error("Model id from /models must not be empty.");
    }
    if (known.has(id)) continue;
    result.push({ id });
    known.add(id);
  }

  return result;
}

export function parseModelIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("The /models response must contain a data array.");
  }
  if (payload.data.length === 0) {
    throw new Error("The /models response contains no models.");
  }

  const ids: string[] = [];
  const known = new Set<string>();
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error("Every /models entry must contain a non-empty id.");
    }
    if (known.has(item.id)) {
      throw new Error(`The /models response contains duplicate id ${item.id}.`);
    }
    known.add(item.id);
    ids.push(item.id);
  }

  return ids;
}

function stripBaseUrl(model: JsonObject): PiModel {
  const result = cloneJson(model);
  delete result.baseUrl;
  return {
    ...result,
    id: typeof result.id === "string" ? result.id : ""
  };
}

export function normalizeFullCatalog(payload: unknown): PiCatalog {
  if (!isRecord(payload)) {
    throw new Error("The Pi models response must be an object.");
  }

  const catalog: PiCatalog = {};
  for (const [provider, models] of Object.entries(payload)) {
    if (!isRecord(models)) continue;

    const normalized: Record<string, PiModel> = {};
    for (const [modelId, model] of Object.entries(models)) {
      if (!isRecord(model)) continue;
      const normalizedModel = stripBaseUrl({ ...model, id: model.id ?? modelId });
      if (normalizedModel.id.length === 0) continue;
      normalized[modelId] = normalizedModel;
    }
    if (Object.keys(normalized).length > 0) {
      catalog[provider] = normalized;
    }
  }

  if (Object.keys(catalog).length === 0) {
    throw new Error("The Pi models response contains no provider models.");
  }
  return catalog;
}

export function buildDefaultModel(id: string): JsonObject {
  return {
    id,
    name: id,
    reasoning: DEFAULT_MODEL_VALUES.reasoning,
    input: [...DEFAULT_MODEL_VALUES.input],
    cost: cloneJson(DEFAULT_MODEL_VALUES.cost),
    contextWindow: DEFAULT_MODEL_VALUES.contextWindow,
    maxTokens: DEFAULT_MODEL_VALUES.maxTokens
  };
}

export function stripSourceTransportFields(model: JsonObject): JsonObject {
  const result = cloneJson(model);
  delete result.id;
  delete result.api;
  delete result.baseUrl;
  delete result.provider;
  return result;
}

export function buildResolvedModel(
  targetId: string,
  sourceModel: JsonObject | undefined,
  providerOverride: JsonObject | undefined,
  modelOverride: JsonObject | undefined
): JsonObject {
  const base = sourceModel
    ? { ...buildDefaultModel(targetId), ...stripSourceTransportFields(sourceModel), id: targetId }
    : buildDefaultModel(targetId);
  const withProviderOverride = providerOverride
    ? deepMerge(base, providerOverride)
    : base;
  const resolved = modelOverride
    ? deepMerge(withProviderOverride, modelOverride)
    : withProviderOverride;

  resolved.id = targetId;
  delete resolved.config;
  return resolved;
}
