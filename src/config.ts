import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  errorMessage,
  isRecord,
  type ModelSourcesFile,
  type PiCatalog,
  type SourceProvider,
} from "./core.ts";

export interface NativeProviderConfig {
  baseUrl?: string;
  modelsUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: unknown[];
}

export interface NativeModelsFile {
  providers: Record<string, NativeProviderConfig>;
}

export interface ConfigPaths {
  sources: string;
  cache: string;
}

export function getConfigPaths(): ConfigPaths {
  const root = resolve(getAgentDir(), "extensions", "pi-provider-model-sync");
  return {
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

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function loadNativeModels(): Promise<NativeModelsFile> {
  const path = join(getAgentDir(), "models.json");
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
  return { providers };
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
    providers[name] = {
      models: structuredClone(value.models) as SourceProvider["models"],
      ...(typeof value.config === "string" && value.config.trim().length > 0
        ? { config: value.config }
        : {}),
      ...(isRecord(value.override) ? { override: structuredClone(value.override) } : {}),
    };
  }
  return { providers };
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
