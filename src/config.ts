import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  errorMessage,
  isRecord,
  type ModelSourcesFile,
  type PiCatalog,
  type SourceProvider,
} from "./core.ts";

export interface NativeProviderConfig extends Record<string, unknown> {
  baseUrl?: string;
  modelsUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: unknown[];
}

export interface NativeModelsFile extends Record<string, unknown> {
  providers: Record<string, NativeProviderConfig>;
}

export interface ConfigPaths {
  models: string;
  sources: string;
  cache: string;
}

export function getConfigPaths(): ConfigPaths {
  const root = resolve(getAgentDir(), "extensions", "pi-provider-model-sync");
  return {
    models: join(getAgentDir(), "models.json"),
    sources: join(root, "model-sources.json"),
    cache: join(root, "cache", "models.json"),
  };
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += char;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (char === "\n") {
        result += char;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      result += char;
    }
  }

  return result;
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(stripJsonComments(text)) as T;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new Error(`Failed to read ${path}: ${errorMessage(error)}`);
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let target = path;
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode & 0o777;
    target = await realpath(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadNativeModels(): Promise<NativeModelsFile> {
  const path = getConfigPaths().models;
  const parsed = await readJsonFile<unknown>(path);
  if (parsed === undefined) return { providers: {} };
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new Error(`Invalid models.json: ${path}`);
  }

  const providers: Record<string, NativeProviderConfig> = {};
  for (const [name, value] of Object.entries(parsed.providers)) {
    if (!isRecord(value)) {
      throw new Error(`Invalid provider ${name} in models.json.`);
    }
    providers[name] = value as NativeProviderConfig;
  }
  return { ...parsed, providers };
}

export async function loadModelSources(path: string): Promise<ModelSourcesFile> {
  const parsed = await readJsonFile<unknown>(path);
  if (parsed === undefined) return { providers: {} };
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new Error(`Invalid model-sources.json: ${path}`);
  }

  const providers: Record<string, SourceProvider> = {};
  for (const [name, value] of Object.entries(parsed.providers)) {
    if (!isRecord(value) || !Array.isArray(value.models)) {
      throw new Error(`Provider ${name}: models must be an array.`);
    }
    providers[name] = { ...value, models: structuredClone(value.models) } as SourceProvider;
  }
  return { ...parsed, providers };
}

export async function loadPiCache(path: string): Promise<PiCatalog> {
  const parsed = await readJsonFile<unknown>(path);
  if (parsed === undefined) return {};
  if (!isRecord(parsed)) throw new Error(`Invalid Pi model cache: ${path}`);

  const cache: PiCatalog = {};
  for (const [provider, models] of Object.entries(parsed)) {
    if (!isRecord(models)) continue;
    cache[provider] = {};
    for (const [modelId, model] of Object.entries(models)) {
      if (isRecord(model)) {
        cache[provider][modelId] = structuredClone(model) as PiCatalog[string][string];
      }
    }
  }
  return cache;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
