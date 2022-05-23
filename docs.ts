import {
  doc,
  type LoadResponse,
} from "https://deno.land/x/deno_doc@v0.35.0/mod.ts";
import type {
  DocNode,
  DocNodeInterface,
  DocNodeNamespace,
} from "https://deno.land/x/deno_doc@v0.35.0/lib/types.d.ts";
export type {
  DocNode,
  DocNodeNamespace,
} from "https://deno.land/x/deno_doc@v0.35.0/lib/types.d.ts";
import { errors } from "https://deno.land/x/oak_commons@0.3.1/http_errors.ts";

const MAX_CACHE_SIZE = parseInt(Deno.env.get("MAX_CACHE_SIZE") ?? "", 10) ||
  25_000_000;

const cachedSpecifiers = new Set<string>();
const cachedResources = new Map<string, LoadResponse | undefined>();
let cacheCheckQueued = false;
let cacheSize = 0;

async function load(specifier: string): Promise<LoadResponse | undefined> {
  if (cachedResources.has(specifier)) {
    cachedSpecifiers.delete(specifier);
    cachedSpecifiers.add(specifier);
    return cachedResources.get(specifier);
  }
  try {
    const url = new URL(specifier);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const response = await fetch(specifier, { redirect: "follow" });
      if (response.status !== 200) {
        cachedResources.set(specifier, undefined);
        cachedSpecifiers.add(specifier);
        await response.arrayBuffer();
        return undefined;
      }
      const content = await response.text();
      const loadResponse: LoadResponse = {
        kind: "module",
        specifier: response.url,
        headers: { ...response.headers },
        content,
      };
      cachedResources.set(specifier, loadResponse);
      cachedSpecifiers.add(specifier);
      cacheSize += content.length;
      enqueueCheck();
      return loadResponse;
    }
  } catch {
    cachedResources.set(specifier, undefined);
    cachedSpecifiers.add(specifier);
  }
}

function checkCache() {
  if (cacheSize > MAX_CACHE_SIZE) {
    const toEvict: string[] = [];
    for (const specifier of cachedSpecifiers) {
      const loadResponse = cachedResources.get(specifier);
      toEvict.push(specifier);
      if (loadResponse && loadResponse.kind === "module") {
        cacheSize -= loadResponse.content.length;
        if (cacheSize <= MAX_CACHE_SIZE) {
          break;
        }
      }
    }
    console.log(
      `%cEvicting %c${toEvict.length}%c responses from cache.`,
      "color:green",
      "color:yellow",
      "color:white",
    );
    for (const evict of toEvict) {
      cachedResources.delete(evict);
      cachedSpecifiers.delete(evict);
    }
  }
  cacheCheckQueued = false;
}

function enqueueCheck() {
  if (!cacheCheckQueued) {
    cacheCheckQueued = true;
    queueMicrotask(checkCache);
  }
}

export async function generateDocNodes(
  module: string,
  version: string,
  path: string,
): Promise<DocNode[]> {
  const url = `https://deno.land/x/${module}@${version}/${path}`;
  try {
    const entries = mergeEntries(
      await doc(url, { load }),
    );
    return entries;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("Unable to load specifier")) {
        throw new errors.NotFound(`The module "${url}" cannot be found`);
      } else {
        throw new errors.BadRequest(`Bad request: ${error.message}`);
      }
    } else {
      throw new errors.InternalServerError("Unexpected object.");
    }
  }
}

/** Namespaces and interfaces are open ended. This function will merge these
 * together, so that you have single entries per symbol. */
function mergeEntries(entries: DocNode[]): DocNode[] {
  const merged: DocNode[] = [];
  const namespaces = new Map<string, DocNodeNamespace>();
  const interfaces = new Map<string, DocNodeInterface>();
  for (const node of entries) {
    if (node.kind === "namespace") {
      const namespace = namespaces.get(node.name);
      if (namespace) {
        namespace.namespaceDef.elements.push(...node.namespaceDef.elements);
        if (!namespace.jsDoc) {
          namespace.jsDoc = node.jsDoc;
        }
      } else {
        namespaces.set(node.name, node);
        merged.push(node);
      }
    } else if (node.kind === "interface") {
      const int = interfaces.get(node.name);
      if (int) {
        int.interfaceDef.callSignatures.push(
          ...node.interfaceDef.callSignatures,
        );
        int.interfaceDef.indexSignatures.push(
          ...node.interfaceDef.indexSignatures,
        );
        int.interfaceDef.methods.push(...node.interfaceDef.methods);
        int.interfaceDef.properties.push(...node.interfaceDef.properties);
        if (!int.jsDoc) {
          int.jsDoc = node.jsDoc;
        }
      } else {
        interfaces.set(node.name, node);
        merged.push(node);
      }
    } else {
      merged.push(node);
    }
  }
  return merged;
}
