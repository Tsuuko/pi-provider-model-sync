import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig
} from "@earendil-works/pi-coding-agent";
import {
  buildResolvedModel,
  cloneJson,
  getConfigReference,
  isRecord,
  mergeCatalog,
  mergeModelIds,
  normalizeFullCatalog,
  normalizeProviderCatalog,
  parseModelIds,
  validateSourceProvider,
  type JsonObject,
  type ModelSourcesFile,
  type PiCatalog,
  type SourceProvider
} from "./core.ts";
import {
  getConfigPaths,
  loadModelSources,
  loadNativeModels,
  loadPiCache,
  writeJsonAtomic,
  type ConfigPaths,
  type NativeModelsFile,
  type NativeProviderConfig
} from "./config.ts";

const PI_MODELS_URL = "https://pi.dev/api/models";
const EXTENSION_LABEL = "pi-provider-model-sync";

type RegisterTarget = Pick<ExtensionAPI, "registerProvider">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function stringHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") headers[key] = entry;
  }
  return headers;
}

async function requestJson(
  url: string,
  headers: Record<string, string>
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...headers
    }
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`GET ${url} returned invalid JSON: ${errorMessage(error)}`);
  }
}

async function requestHeaders(
  providerName: string,
  nativeProvider: NativeProviderConfig,
  ctx: ExtensionContext
): Promise<Record<string, string>> {
  const provider = ctx.modelRegistry.getProvider(providerName);
  const headers = {
    ...stringHeaders(nativeProvider.headers),
    ...stringHeaders(provider?.headers)
  };

  const auth = await ctx.modelRegistry.getProviderAuth(providerName);
  if (auth?.auth.headers) {
    Object.assign(headers, stringHeaders(auth.auth.headers));
  }

  if (
    nativeProvider.authHeader &&
    auth?.auth.apiKey &&
    !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
  ) {
    headers.Authorization = `Bearer ${auth.auth.apiKey}`;
  }

  return headers;
}

function getBaseUrl(
  providerName: string,
  nativeProvider: NativeProviderConfig,
  ctx: ExtensionContext
): string {
  const baseUrl = nativeProvider.baseUrl ?? ctx.modelRegistry.getProvider(providerName)?.baseUrl;
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new Error(`Provider ${providerName}: baseUrl is required.`);
  }
  return baseUrl;
}

function getApi(
  providerName: string,
  nativeProvider: NativeProviderConfig
): NonNullable<ProviderConfig["api"]> {
  if (!nativeProvider.api || nativeProvider.api.trim().length === 0) {
    throw new Error(`Provider ${providerName}: api is required.`);
  }
  return nativeProvider.api as NonNullable<ProviderConfig["api"]>;
}

async function fetchCustomModelIds(
  providerName: string,
  nativeProvider: NativeProviderConfig,
  ctx: ExtensionContext
): Promise<string[]> {
  const baseUrl = getBaseUrl(providerName, nativeProvider, ctx);
  const headers = await requestHeaders(providerName, nativeProvider, ctx);
  const payload = await requestJson(appendPath(baseUrl, "models"), headers);
  return parseModelIds(payload);
}

async function fetchFullPiCatalog(): Promise<PiCatalog> {
  const payload = await requestJson(PI_MODELS_URL, {});
  return normalizeFullCatalog(payload);
}

async function fetchPiProviderCatalog(provider: string): Promise<PiCatalog> {
  const url = `${PI_MODELS_URL}/providers/${encodeURIComponent(provider)}`;
  const payload = await requestJson(url, {});
  return normalizeProviderCatalog(provider, payload);
}

async function refreshFullPiCatalog(
  current: PiCatalog,
  paths: ConfigPaths,
  ctx: ExtensionContext
): Promise<PiCatalog> {
  try {
    const catalog = await fetchFullPiCatalog();
    await writeJsonAtomic(paths.cache, catalog);
    return catalog;
  } catch (error) {
    ctx.ui.notify(
      `${EXTENSION_LABEL}: Pi models cache refresh failed: ${errorMessage(error)}`,
      "warning"
    );
    return current;
  }
}

async function ensurePiModel(
  cache: PiCatalog,
  sourceProvider: string,
  sourceModelId: string,
  paths: ConfigPaths
): Promise<PiCatalog> {
  if (cache[sourceProvider]?.[sourceModelId]) return cache;

  const incoming = await fetchPiProviderCatalog(sourceProvider);
  const merged = mergeCatalog(cache, incoming);
  await writeJsonAtomic(paths.cache, merged);

  if (!merged[sourceProvider]?.[sourceModelId]) {
    throw new Error(
      `Pi model ${sourceProvider}/${sourceModelId} was not found.`
    );
  }
  return merged;
}

function sourceProviderConfig(
  providerName: string,
  native: NativeProviderConfig,
  models: readonly JsonObject[]
): ProviderConfig {
  const baseUrl = native.baseUrl;
  const api = getApi(providerName, native);
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new Error(`Provider ${providerName}: baseUrl is required.`);
  }

  return {
    baseUrl,
    api,
    ...(native.apiKey !== undefined ? { apiKey: native.apiKey } : {}),
    ...(native.authHeader !== undefined ? { authHeader: native.authHeader } : {}),
    ...(native.headers !== undefined ? { headers: native.headers } : {}),
    models: models as unknown as NonNullable<ProviderConfig["models"]>
  };
}

async function resolveAndRegisterProvider(
  pi: RegisterTarget,
  providerName: string,
  native: NativeProviderConfig,
  source: SourceProvider,
  cache: PiCatalog,
  paths: ConfigPaths
): Promise<PiCatalog> {
  validateSourceProvider(providerName, source);
  let nextCache = cache;
  const models: JsonObject[] = [];

  for (const sourceModel of source.models) {
    const reference = getConfigReference(sourceModel);
    let catalogModel: JsonObject | undefined;

    if (reference) {
      const separator = reference.indexOf("/");
      const sourceProvider = reference.slice(0, separator);
      const sourceModelId = reference.slice(separator + 1);
      nextCache = await ensurePiModel(
        nextCache,
        sourceProvider,
        sourceModelId,
        paths
      );
      catalogModel = nextCache[sourceProvider]?.[sourceModelId];
      if (!catalogModel) {
        throw new Error(`Pi model ${reference} was not found.`);
      }
    }

    models.push(
      buildResolvedModel(
        sourceModel.id,
        catalogModel,
        source.override,
        sourceModel.override
      )
    );
  }

  const providerConfig = sourceProviderConfig(providerName, native, models);
  pi.registerProvider(providerName, providerConfig);
  return nextCache;
}

function isDynamicProvider(provider: NativeProviderConfig): boolean {
  return Array.isArray(provider.models) && provider.models.length === 0;
}

function makeSourceProvider(ids: readonly string[]): SourceProvider {
  return {
    models: ids.map((id) => ({ id, config: "" }))
  };
}

function updateSourceProvider(
  existing: SourceProvider | undefined,
  ids: readonly string[]
): SourceProvider {
  if (!existing) return makeSourceProvider(ids);
  return {
    ...cloneJson(existing),
    models: mergeModelIds(existing.models, ids)
  };
}

async function saveSources(
  paths: ConfigPaths,
  sources: ModelSourcesFile
): Promise<void> {
  await writeJsonAtomic(paths.sources, sources);
}

async function loadState(paths: ConfigPaths): Promise<{
  native: NativeModelsFile;
  sources: ModelSourcesFile;
  cache: PiCatalog;
}> {
  const [native, sources, cache] = await Promise.all([
    loadNativeModels(),
    loadModelSources(paths.sources),
    loadPiCache(paths.cache)
  ]);
  return { native, sources, cache };
}

export async function synchronizeAllProviders(
  pi: RegisterTarget,
  ctx: ExtensionContext
): Promise<void> {
  const paths = getConfigPaths(ctx.cwd);
  let { native, sources, cache } = await loadState(paths);
  const newProviders = new Map<string, string[]>();

  for (const [providerName, nativeProvider] of Object.entries(native.providers)) {
    if (!isDynamicProvider(nativeProvider) || sources.providers[providerName]) {
      continue;
    }

    try {
      newProviders.set(
        providerName,
        await fetchCustomModelIds(providerName, nativeProvider, ctx)
      );
    } catch (error) {
      ctx.ui.notify(
        `${EXTENSION_LABEL}: ${providerName} initial sync failed: ${errorMessage(error)}`,
        "error"
      );
    }
  }

  if (newProviders.size > 0) {
    cache = await refreshFullPiCatalog(cache, paths, ctx);
    for (const [providerName, ids] of newProviders) {
      sources.providers[providerName] = makeSourceProvider(ids);
    }
    await saveSources(paths, sources);
  }

  for (const [providerName, nativeProvider] of Object.entries(native.providers)) {
    if (!isDynamicProvider(nativeProvider)) continue;
    const source = sources.providers[providerName];
    if (!source) continue;

    try {
      cache = await resolveAndRegisterProvider(
        pi,
        providerName,
        nativeProvider,
        source,
        cache,
        paths
      );
    } catch (error) {
      ctx.ui.notify(
        `${EXTENSION_LABEL}: ${providerName} registration failed: ${errorMessage(error)}`,
        "error"
      );
    }
  }
}

export async function reloadProvider(
  pi: RegisterTarget,
  ctx: ExtensionContext,
  providerName: string
): Promise<void> {
  const name = providerName.trim();
  if (name.length === 0) {
    throw new Error("Usage: /reload-provider <provider>");
  }

  const paths = getConfigPaths(ctx.cwd);
  const { native, sources } = await loadState(paths);
  const nativeProvider = native.providers[name];
  if (!nativeProvider || !isDynamicProvider(nativeProvider)) {
    throw new Error(`Dynamic provider ${name} was not found in models.json.`);
  }

  const ids = await fetchCustomModelIds(name, nativeProvider, ctx);
  let cache = await loadPiCache(paths.cache);
  cache = await refreshFullPiCatalog(cache, paths, ctx);

  sources.providers[name] = updateSourceProvider(sources.providers[name], ids);
  await saveSources(paths, sources);

  await resolveAndRegisterProvider(
    pi,
    name,
    nativeProvider,
    sources.providers[name],
    cache,
    paths
  );
}
