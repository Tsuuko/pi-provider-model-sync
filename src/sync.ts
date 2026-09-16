import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
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
  type ModelSourcesFile,
  type PiCatalog,
  type SourceProvider,
} from "./core.ts";
import {
  fileExists,
  getConfigPaths,
  loadModelSources,
  loadNativeModels,
  loadPiCache,
  writeJsonAtomic,
  type ConfigPaths,
  type NativeModelsFile,
  type NativeProviderConfig,
} from "./config.ts";

const PI_MODELS_URL = "https://pi.dev/api/models";
const EXTENSION_LABEL = "pi-provider-model-sync";

type RegisterTarget = Pick<ExtensionAPI, "registerProvider">;

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
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...headers,
    },
    // ponytail: 起動を止めないための固定上限。環境変数で調整したくなったら定数化する
    signal: AbortSignal.timeout(10_000),
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
  ctx: ExtensionContext,
): Promise<Record<string, string>> {
  const provider = ctx.modelRegistry.getProvider(providerName);
  const headers = {
    ...stringHeaders(nativeProvider.headers),
    ...stringHeaders(provider?.headers),
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
): string {
  const baseUrl = nativeProvider.baseUrl;
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new Error(`Provider ${providerName}: baseUrl is required.`);
  }
  return baseUrl;
}

function getApi(
  providerName: string,
  nativeProvider: NativeProviderConfig,
): NonNullable<ProviderConfig["api"]> {
  if (!nativeProvider.api || nativeProvider.api.trim().length === 0) {
    throw new Error(`Provider ${providerName}: api is required.`);
  }
  return nativeProvider.api as NonNullable<ProviderConfig["api"]>;
}

async function fetchCustomModelIds(
  providerName: string,
  nativeProvider: NativeProviderConfig,
  ctx: ExtensionContext,
): Promise<string[]> {
  const url =
    nativeProvider.modelsUrl?.trim() ||
    appendPath(getBaseUrl(providerName, nativeProvider), "models");
  const headers = await requestHeaders(providerName, nativeProvider, ctx);
  const payload = await requestJson(url, headers);
  return parseModelIds(payload);
}

async function fetchFullPiCatalog(): Promise<PiCatalog> {
  const payload = await requestJson(PI_MODELS_URL, {});
  return normalizeFullCatalog(payload);
}

function getCachedPiModel(
  cache: PiCatalog,
  sourceProvider: string,
  sourceModelId: string,
): JsonObject {
  const model = cache[sourceProvider]?.[sourceModelId];
  if (!model) {
    throw new Error(
      `Pi model ${sourceProvider}/${sourceModelId} is not cached. Run /reload-provider to refresh.`,
    );
  }
  return model;
}

async function refreshFullPiCatalog(
  current: PiCatalog,
  paths: ConfigPaths,
  ctx: ExtensionContext,
): Promise<PiCatalog> {
  try {
    const catalog = await fetchFullPiCatalog();
    await writeJsonAtomic(paths.cache, catalog);
    return catalog;
  } catch (error) {
    ctx.ui.notify(
      `${EXTENSION_LABEL}: Pi models cache refresh failed: ${errorMessage(error)}`,
      "warning",
    );
    return current;
  }
}

function sourceProviderConfig(
  providerName: string,
  native: NativeProviderConfig,
  models: readonly JsonObject[],
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
    ...(native.authHeader !== undefined
      ? { authHeader: native.authHeader }
      : {}),
    ...(native.headers !== undefined ? { headers: native.headers } : {}),
    // SAFETY: models は buildResolvedModel / Pi カタログ正規化済みのモデル JSON で、ProviderConfig のモデル形状と実行時に一致する
    models: models as unknown as NonNullable<ProviderConfig["models"]>,
  };
}

async function resolveAndRegisterProvider(
  pi: RegisterTarget,
  providerName: string,
  native: NativeProviderConfig,
  source: SourceProvider,
  cache: PiCatalog,
): Promise<void> {
  validateSourceProvider(providerName, source);
  const models: JsonObject[] = [];

  for (const sourceModel of source.models) {
    const reference = resolveSourceReference(sourceModel, source.config);
    let catalogModel: JsonObject | undefined;

    if (reference) {
      catalogModel = getCachedPiModel(
        cache,
        reference.provider,
        reference.modelId,
      );
    }

    models.push(
      buildResolvedModel(
        sourceModel.id,
        catalogModel,
        source.override,
        sourceModel.override,
      ),
    );
  }

  const providerConfig = sourceProviderConfig(providerName, native, models);
  pi.registerProvider(providerName, providerConfig);
}

function isDynamicProvider(provider: NativeProviderConfig): boolean {
  return Array.isArray(provider.models) && provider.models.length === 0;
}

function makeSourceProvider(ids: readonly string[]): SourceProvider {
  return {
    config: null,
    models: ids.map((id) => ({ id, config: null })),
  };
}

function updateSourceProvider(
  existing: SourceProvider | undefined,
  ids: readonly string[],
): SourceProvider {
  if (!existing) return makeSourceProvider(ids);
  return {
    ...structuredClone(existing),
    models: mergeModelIds(existing.models, ids),
  };
}

async function saveSources(
  paths: ConfigPaths,
  sources: ModelSourcesFile,
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
    loadPiCache(paths.cache),
  ]);
  return { native, sources, cache };
}

async function registerDynamicProviders(
  pi: RegisterTarget,
  native: NativeModelsFile,
  sources: ModelSourcesFile,
  cache: PiCatalog,
  onError?: (providerName: string, error: unknown) => void,
): Promise<void> {
  for (const [providerName, nativeProvider] of Object.entries(
    native.providers,
  )) {
    if (!isDynamicProvider(nativeProvider)) continue;
    const source = sources.providers[providerName];
    if (!source) continue;
    try {
      await resolveAndRegisterProvider(
        pi,
        providerName,
        nativeProvider,
        source,
        cache,
      );
    } catch (error) {
      onError?.(providerName, error);
    }
  }
}

export async function synchronizeAllProviders(
  pi: RegisterTarget,
  ctx: ExtensionContext,
): Promise<void> {
  const paths = getConfigPaths();
  const [native, sources] = await Promise.all([
    loadNativeModels(),
    loadModelSources(paths.sources),
  ]);
  const newProviders = new Map<string, string[]>();

  // 初回登録対象は並列に取得する。直列だと 1 プロバイダの待ち時間が
  // プロバイダ数だけ積み上がり、起動がその分だけ遅くなる
  const pending = Object.entries(native.providers).filter(
    ([providerName, nativeProvider]) =>
      isDynamicProvider(nativeProvider) && !sources.providers[providerName],
  );

  const cacheMissing = !(await fileExists(paths.cache));

  // 拡張ロード時の registerCachedProviders が model-sources.json の内容を登録済み。
  // ここで毎回全件を登録し直すと起動のたびに同じ処理を二重に走らせることになり、
  // 850KB の cache/models.json の読み直しも無駄になる。
  // 更新が必要なとき（キャッシュ欠落・新規プロバイダ・ロード時登録の失敗）だけ登録する。
  if (!cacheMissing && pending.length === 0 && hasRegisteredCachedProviders()) {
    return;
  }

  let cache = await loadPiCache(paths.cache);
  let refreshedCache = false;
  if (cacheMissing) {
    cache = await refreshFullPiCatalog(cache, paths, ctx);
    refreshedCache = true;
  }
  const fetched = await Promise.all(
    pending.map(async ([providerName, nativeProvider]) => {
      try {
        return [
          providerName,
          await fetchCustomModelIds(providerName, nativeProvider, ctx),
        ] as const;
      } catch (error) {
        ctx.ui.notify(
          `${EXTENSION_LABEL}: ${providerName} initial sync failed: ${errorMessage(error)}`,
          "error",
        );
        return undefined;
      }
    }),
  );
  for (const entry of fetched) {
    if (entry) newProviders.set(entry[0], entry[1]);
  }

  if (newProviders.size > 0) {
    if (!refreshedCache) {
      cache = await refreshFullPiCatalog(cache, paths, ctx);
    }
    for (const [providerName, ids] of newProviders) {
      sources.providers[providerName] = makeSourceProvider(ids);
    }
    await saveSources(paths, sources);
  }

  await registerDynamicProviders(
    pi,
    native,
    sources,
    cache,
    (providerName, error) =>
      ctx.ui.notify(
        `${EXTENSION_LABEL}: ${providerName} registration failed: ${errorMessage(error)}`,
        "error",
      ),
  );
}

let cachedRegistrationDone = false;

export async function registerCachedProviders(
  pi: RegisterTarget,
): Promise<void> {
  const paths = getConfigPaths();
  const { native, sources, cache } = await loadState(paths);
  await registerDynamicProviders(pi, native, sources, cache);
  cachedRegistrationDone = true;
}

/** 拡張ロード時に登録済みか。未登録・失敗時のみ session_start で登録し直すために使う */
function hasRegisteredCachedProviders(): boolean {
  return cachedRegistrationDone;
}

export async function reloadProvider(
  pi: RegisterTarget,
  ctx: ExtensionContext,
  providerName: string,
): Promise<void> {
  const name = providerName.trim();
  if (name.length === 0) {
    throw new Error("Usage: /reload-provider <provider>");
  }

  const paths = getConfigPaths();
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
  );
}
