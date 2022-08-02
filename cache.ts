// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { type Datastore, entityToObject } from "google_datastore";
import type { Key } from "google_datastore/types";
import { getDatastore } from "./store.ts";
import type { DocPage, Module, ModuleEntry, ModuleVersion } from "./types.d.ts";
import { assert } from "./util.ts";

const CACHED_MODULE_COUNT =
  parseInt(Deno.env.get("CACHED_MODULE_COUNT") ?? "", 10) ||
  100;

const cachedModules = new Map<string, Module>();
const cachedVersions = new WeakMap<Module, Map<string, ModuleVersion>>();
const cachedEntries = new WeakMap<ModuleVersion, Map<string, ModuleEntry>>();
const cachedDocPages = new WeakMap<ModuleEntry, Map<string, DocPage>>();

/** The "LRU" for modules names. */
const cachedModuleNames = new Set<string>();

/** Lazily set datastore. */
let datastore: Datastore | undefined;

let pruneQueued = false;

function prune() {
  const evictionCount = cachedModuleNames.size - CACHED_MODULE_COUNT;
  if (evictionCount > 0) {
    const toEvict: string[] = [];
    for (const moduleName of cachedModuleNames) {
      toEvict.push(moduleName);
      if (toEvict.length >= evictionCount) {
        break;
      }
    }
    for (const moduleName of toEvict) {
      cachedModuleNames.delete(moduleName);
      cachedModules.delete(moduleName);
      console.log(
        `%cEvicting%c module %c"${moduleName}"%c from cache.`,
        "color:green",
        "color:none",
        "color:cyan",
        "color:none",
      );
    }
  }
  pruneQueued = false;
}

function enqueuePrune() {
  if (!pruneQueued) {
    pruneQueued = true;
    queueMicrotask(prune);
  }
}

export function clear() {
  cachedModules.clear();
  cachedModuleNames.clear();
}

export async function lookup(module: string): Promise<[Module | undefined]>;
export async function lookup(
  module: string,
  version: string,
): Promise<[Module | undefined, ModuleVersion | undefined]>;
export async function lookup(
  module: string,
  version: string,
  path: string,
): Promise<
  [Module | undefined, ModuleVersion | undefined, ModuleEntry | undefined]
>;
export async function lookup(
  module: string,
  version: string,
  path: string,
  symbol: string,
): Promise<
  [
    Module | undefined,
    ModuleVersion | undefined,
    ModuleEntry | undefined,
    DocPage | undefined,
  ]
>;
export async function lookup(
  module: string,
  version?: string,
  path?: string,
  symbol?: string,
) {
  const keys: Key[] = [];
  let moduleItem = cachedModules.get(module);
  let versionItem = version && moduleItem &&
      cachedVersions.get(moduleItem)?.get(version) || undefined;
  let entryItem = path != null && versionItem &&
      cachedEntries.get(versionItem)?.get(path) || undefined;
  let docPageItem = symbol != null && entryItem &&
      cachedDocPages.get(entryItem)?.get(symbol) || undefined;
  datastore = datastore || await getDatastore();
  if (module && !moduleItem) {
    keys.push(datastore.key(
      ["module", module],
    ));
  }
  if (version && !versionItem) {
    keys.push(datastore.key(
      ["module", module],
      ["module_version", version],
    ));
  }
  if (path && !entryItem) {
    assert(version);
    keys.push(datastore.key(
      ["module", module],
      ["module_version", version],
      ["module_entry", path],
    ));
  }
  if (symbol && !docPageItem) {
    assert(version);
    assert(path);
    keys.push(datastore.key(
      ["module", module],
      ["module_version", version],
      ["module_entry", path],
      ["doc_page", symbol],
    ));
  }
  if (keys.length) {
    const res = await datastore.lookup(keys);
    if (res.found) {
      for (const { entity } of res.found) {
        assert(entity.key);
        const entityKind = entity.key.path[entity.key.path.length - 1].kind;
        switch (entityKind) {
          case "module":
            moduleItem = entityToObject(entity);
            cachedModules.set(module, moduleItem);
            break;
          case "module_version": {
            versionItem = entityToObject(entity);
            assert(moduleItem);
            assert(version);
            if (!cachedVersions.has(moduleItem)) {
              cachedVersions.set(moduleItem, new Map());
            }
            const versions = cachedVersions.get(moduleItem)!;
            versions.set(version, versionItem);
            break;
          }
          case "module_entry": {
            entryItem = entityToObject(entity);
            assert(versionItem);
            assert(path);
            if (!cachedEntries.has(versionItem)) {
              cachedEntries.set(versionItem, new Map());
            }
            const entries = cachedEntries.get(versionItem)!;
            entries.set(path, entryItem);
            break;
          }
          case "doc_page": {
            docPageItem = entityToObject(entity);
            assert(entryItem);
            assert(symbol);
            if (!cachedDocPages.has(entryItem)) {
              cachedDocPages.set(entryItem, new Map());
            }
            const docPages = cachedDocPages.get(entryItem)!;
            docPages.set(symbol, docPageItem);
            break;
          }
          default:
            throw new TypeError(`Unexpected kind "${entityKind}"`);
        }
      }
    }
  }
  if (moduleItem) {
    cachedModuleNames.add(module);
    enqueuePrune();
  }
  return [moduleItem, versionItem, entryItem, docPageItem];
}

export function cacheModule(module: string, moduleItem: Module): void {
  cachedModules.set(module, moduleItem);
  cachedModuleNames.add(module);
}

export function cacheModuleVersion(
  module: string,
  version: string,
  versionItem: ModuleVersion,
): void {
  const moduleItem = cachedModules.get(module);
  if (moduleItem) {
    if (!cachedVersions.has(moduleItem)) {
      cachedVersions.set(moduleItem, new Map());
    }
    const versions = cachedVersions.get(moduleItem)!;
    versions.set(version, versionItem);
    cachedModuleNames.add(module);
  }
}

export function cacheModuleEntry(
  module: string,
  version: string,
  path: string,
  entry: ModuleEntry,
): void {
  const moduleItem = cachedModules.get(module);
  if (moduleItem) {
    const versionItem = cachedVersions.get(moduleItem)?.get(version);
    if (versionItem) {
      if (!cachedEntries.has(versionItem)) {
        cachedEntries.set(versionItem, new Map());
      }
      const entries = cachedEntries.get(versionItem)!;
      entries.set(path, entry);
      cachedModuleNames.add(module);
    }
  }
}

export function cacheDocPage(
  module: string,
  version: string,
  path: string,
  symbol: string,
  docPage: DocPage,
): void {
  const moduleItem = cachedModules.get(module);
  if (moduleItem) {
    const versionItem = cachedVersions.get(moduleItem)?.get(version);
    if (versionItem) {
      const entryItem = cachedEntries.get(versionItem)?.get(path);
      if (entryItem) {
        if (!cachedDocPages.has(entryItem)) {
          cachedDocPages.set(entryItem, new Map());
        }
        const docPages = cachedDocPages.get(entryItem)!;
        docPages.set(symbol, docPage);
        cachedModuleNames.add(module);
      }
    }
  }
}
