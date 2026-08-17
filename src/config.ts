import {
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  cloneJson,
  isRecord,
  type ModelSourcesFile,
  type PiCatalog,
  type SourceProvider
} from "./core.ts";

export interface NativeProviderConfig {
  baseUrl?: string;
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
  root: string;
  sources: string;
  cache: string;
}

export function getConfigPaths(cwd: string): ConfigPaths {
  const root = resolve(cwd, ".pi", "agent", "extensions", "pi-provider-model-sync");
  return {
    root,
    sources: join(root, "model-sources.json"),
    cache: join(root, "cache", "models.json")
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
      models: cloneJson(value.models) as SourceProvider["models"],
      ...(isRecord(value.override) ? { override: cloneJson(value.override) } : {})
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
        cache[provider][modelId] = cloneJson(model) as PiCatalog[string][string];
      }
    }
  }
  return cache;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
