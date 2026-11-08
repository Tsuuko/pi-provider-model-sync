import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildResolvedModel,
  errorMessage,
  isRecord,
  mergeModelIds,
  normalizeFullCatalog,
  parseModelIds,
  resolveSourceReference,
  validateSourceProvider,
  type JsonObject,
  type PiCatalog,
  type SourceModel,
  type SourceProvider,
} from "./core.ts";
import {
  getConfigPaths,
  loadModelSources,
  loadNativeModels,
  loadPiCache,
  writeJsonAtomic,
  type NativeModelsFile,
  type NativeProviderConfig,
} from "./config.ts";
import { selectProvider, selectProviderModels, type ModelChoice } from "./ui.ts";

const PI_MODELS_URL = "https://pi.dev/api/models";
const LABEL = "pi-provider-model-sync";

type NativeModel = JsonObject & { id: string };

function stringHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`GET ${url} returned invalid JSON: ${errorMessage(error)}`);
  }
}

async function fetchCustomModelIds(
  providerName: string,
  provider: NativeProviderConfig,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const url =
    provider.modelsUrl?.trim() ||
    (provider.baseUrl ? `${provider.baseUrl.replace(/\/+$/, "")}/models` : undefined);
  if (!url) throw new Error(`Provider ${providerName}: baseUrl or modelsUrl is required.`);
  const registered = ctx.modelRegistry.getProvider(providerName);
  const headers = new Headers(stringHeaders(provider.headers));
  const auth = await abortable(ctx.modelRegistry.getProviderAuth(providerName), signal);
  for (const values of [registered?.headers, auth?.auth.headers]) {
    for (const [name, value] of Object.entries(stringHeaders(values))) {
      headers.set(name, value);
    }
  }
  if (provider.authHeader && auth?.auth.apiKey && !headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${auth.auth.apiKey}`);
  }
  return parseModelIds(await requestJson(url, Object.fromEntries(headers.entries()), signal));
}

function nativeModels(providerName: string, provider: NativeProviderConfig): NativeModel[] {
  if (provider.models === undefined) return [];
  if (!Array.isArray(provider.models))
    throw new Error(`Provider ${providerName}: models must be an array.`);
  const ids = new Set<string>();
  return provider.models.map((model) => {
    if (!isRecord(model) || typeof model.id !== "string" || model.id.trim().length === 0) {
      throw new Error(`Provider ${providerName}: every model must have a non-empty id.`);
    }
    if (ids.has(model.id))
      throw new Error(`Provider ${providerName}: duplicate model id ${model.id}.`);
    ids.add(model.id);
    return model as NativeModel;
  });
}

function resolveModel(model: SourceModel, source: SourceProvider, cache: PiCatalog): NativeModel {
  const reference = resolveSourceReference(model, source.config);
  const catalogModel = reference ? cache[reference.provider]?.[reference.modelId] : undefined;
  if (reference && !catalogModel) {
    throw new Error(
      `Pi model ${reference.provider}/${reference.modelId} was not found in the catalog.`,
    );
  }
  return buildResolvedModel(model.id, catalogModel, source.override, model.override) as NativeModel;
}

async function loadCatalog(
  models: readonly { model: SourceModel; source: SourceProvider }[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<PiCatalog> {
  signal?.throwIfAborted();
  if (!models.some(({ model, source }) => resolveSourceReference(model, source.config))) return {};
  const paths = getConfigPaths();
  const cache = await loadPiCache(paths.cache);
  ctx.ui.notify(`${LABEL}: refreshing Pi catalog...`, "info");
  try {
    const catalog = normalizeFullCatalog(await requestJson(PI_MODELS_URL, {}, signal));
    signal?.throwIfAborted();
    await writeJsonAtomic(paths.cache, catalog);
    return catalog;
  } catch (error) {
    signal?.throwIfAborted();
    ctx.ui.notify(
      `${LABEL}: Pi catalog refresh failed; using cache: ${errorMessage(error)}`,
      "warning",
    );
    return cache;
  }
}

async function ensureUnchanged(expected: NativeModelsFile): Promise<void> {
  if (JSON.stringify(await loadNativeModels()) !== JSON.stringify(expected)) {
    throw new Error("models.json changed during this operation. Reopen the command and try again.");
  }
}

async function refreshRegistry(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
  try {
    await ctx.modelRegistry.refresh(
      signal ? { allowNetwork: false, signal } : { allowNetwork: false },
    );
    signal?.throwIfAborted();
    const error = ctx.modelRegistry.getError();
    if (error) throw new Error(error);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`models.json was saved, but Pi could not reload it: ${errorMessage(error)}`);
  }
}

export function modelChoices(
  ids: readonly string[],
  existing: readonly NativeModel[],
  sources: readonly SourceModel[],
): ModelChoice[] {
  const available = new Set(ids);
  const selected = new Set(existing.map((model) => model.id));
  return [...new Set([...ids, ...selected, ...sources.map((model) => model.id)])]
    .map((id) => ({
      id,
      checked: selected.has(id),
      available: available.has(id),
    }))
    .sort(
      (left, right) =>
        Number(right.checked) - Number(left.checked) ||
        Number(left.available) - Number(right.available),
    );
}

export async function reloadProvider(
  ctx: ExtensionContext,
  providerName = "",
  signal?: AbortSignal,
): Promise<{ provider: string; total: number; added: number; removed: number } | undefined> {
  if (!ctx.hasUI) throw new Error("/provider-models requires interactive UI.");
  signal?.throwIfAborted();
  const native = await loadNativeModels();
  const names = Object.keys(native.providers);
  if (names.length === 0) throw new Error("No providers are configured in models.json.");
  const name = providerName.trim() || (await selectProvider(ctx, names, signal));
  if (!name) return undefined;
  const provider = native.providers[name];
  if (!provider) throw new Error(`Provider ${name} was not found in models.json.`);
  const existing = nativeModels(name, provider);
  const paths = getConfigPaths();
  const sources = await loadModelSources(paths.sources);
  const source = sources.providers[name] ?? { models: [] };
  validateSourceProvider(name, source);
  ctx.ui.notify(`${LABEL}: ${name}: fetching /models...`, "info");
  const ids = await fetchCustomModelIds(name, provider, ctx, signal);
  const choices = modelChoices(ids, existing, source.models);
  const selected = await selectProviderModels(ctx, name, choices, signal);
  if (selected === undefined) return undefined;
  const known = new Map(existing.map((model) => [model.id, model]));
  const sourceModels = new Map(source.models.map((model) => [model.id, model]));
  const added = selected.filter((id) => !known.has(id));
  const selectedSet = new Set(selected);
  const removed = new Set(
    [...existing, ...source.models]
      .filter((model) => !selectedSet.has(model.id))
      .map((model) => model.id),
  ).size;
  if (
    removed > 0 &&
    !(await ctx.ui.confirm(
      "Save model selection",
      `Provider: ${name.replace(/\p{Cc}/gu, " ")}\nAdd: ${added.length}\nRemove: ${removed}\n\nRemoving models also deletes their source settings and overrides.`,
      signal ? { signal } : undefined,
    ))
  )
    return undefined;
  const cache = await loadCatalog(
    added.map((id) => ({ model: sourceModels.get(id) ?? { id }, source })),
    ctx,
    signal,
  );
  const models = [
    ...existing.filter((model) => selectedSet.has(model.id)),
    ...added.map((id) => resolveModel(sourceModels.get(id) ?? { id }, source, cache)),
  ];
  if (JSON.stringify(await loadModelSources(paths.sources)) !== JSON.stringify(sources)) {
    throw new Error(
      "model-sources.json changed during this operation. Reopen the command and try again.",
    );
  }
  sources.providers[name] = {
    ...source,
    models: mergeModelIds(
      source.models.filter((model) => selectedSet.has(model.id)),
      selected,
    ),
  };
  await ensureUnchanged(native);
  signal?.throwIfAborted();
  provider.models = models;
  await writeJsonAtomic(paths.models, native);
  try {
    await writeJsonAtomic(paths.sources, sources);
  } catch (error) {
    throw new Error(
      `models.json was saved, but model-sources.json could not be saved: ${errorMessage(error)}`,
    );
  }
  await refreshRegistry(ctx, signal);
  return {
    provider: name,
    total: models.length,
    added: added.length,
    removed,
  };
}

export async function applyModelConfig(
  ctx: ExtensionContext,
  providerName = "",
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (!ctx.hasUI) throw new Error("/provider-models requires interactive UI.");
  signal?.throwIfAborted();
  const paths = getConfigPaths();
  const [native, sources] = await Promise.all([
    loadNativeModels(),
    loadModelSources(paths.sources),
  ]);
  const name = providerName.trim();
  if (name && !native.providers[name])
    throw new Error(`Provider ${name} was not found in models.json.`);
  if (name && !sources.providers[name])
    throw new Error(`Provider ${name} has no model-sources.json configuration.`);
  const pending: {
    provider: NativeProviderConfig;
    model: SourceModel;
    source: SourceProvider;
    index: number;
  }[] = [];
  for (const [providerId, provider] of Object.entries(native.providers)) {
    if (name && name !== providerId) continue;
    const source = sources.providers[providerId];
    if (!source) continue;
    validateSourceProvider(providerId, source);
    const indices = new Map(
      nativeModels(providerId, provider).map((model, index) => [model.id, index]),
    );
    for (const model of source.models) {
      pending.push({
        provider,
        model,
        source,
        index: indices.get(model.id) ?? -1,
      });
    }
  }
  if (pending.length === 0) return 0;
  if (
    !(await ctx.ui.confirm(
      "Apply model settings",
      `Add or update ${pending.length} models from model-sources.json? Existing settings for these models will be replaced.`,
      signal ? { signal } : undefined,
    ))
  )
    return undefined;
  const cache = await loadCatalog(pending, ctx, signal);
  const expected = structuredClone(native);
  for (const { provider, model, source, index } of pending) {
    const models = (provider.models ??= []);
    const resolved = resolveModel(model, source, cache);
    if (index < 0) models.push(resolved);
    else models[index] = resolved;
  }
  await ensureUnchanged(expected);
  signal?.throwIfAborted();
  await writeJsonAtomic(paths.models, native);
  await refreshRegistry(ctx, signal);
  return pending.length;
}
