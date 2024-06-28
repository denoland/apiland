// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Utilities which cache information from the datastore in memory to help
 * increase performance.
 *
 * @module
 */

import { type Datastore, entityToObject } from "google_datastore";
import type { Key } from "google_datastore/types";

import { getDatastore } from "./auth.ts";
import { kinds, SYMBOL_REGEX } from "./consts.ts";
import { entityToDocPage } from "./docs.ts";
import {
  DocPage,
  InfoPage,
  Module,
  ModuleEntry,
  ModuleVersion,
  SourcePage,
} from "./types.d.ts";
import { assert } from "./util.ts";

const CACHED_MODULE_COUNT =
  parseInt(Deno.env.get("CACHED_MODULE_COUNT") ?? "", 10) ||
  100;

const cachedModules = new Map<string, Module>();
const cachedVersions = new WeakMap<Module, Map<string, ModuleVersion>>();
const cachedEntries = new WeakMap<ModuleVersion, Map<string, ModuleEntry>>();
const cachedInfoPages = new WeakMap<Module, Map<string, InfoPage>>();
const cachedDocPages = new WeakMap<ModuleEntry, Map<string, DocPage>>();
const cachedSourcePages = new WeakMap<ModuleVersion, Map<string, SourcePage>>();

/** The "LRU" for modules names. */
const cachedModuleNames = new Set<string>();

let bc: BroadcastChannel | undefined;

if ("BroadcastChannel" in globalThis) {
  console.log(
    "%cStarting%c cache broadcast channel.",
    "color:green",
    "color:none",
  );
  bc = new BroadcastChannel("cache_clear");

  bc.addEventListener("message", ({ data }) => {
    const module = String(data);
    console.log(
      `%cReceived%c clear cache for module: %c"${module}"%c.`,
      "color:green",
      "color:none",
      "color:cyan",
      "color:none",
    );
    cachedModules.delete(module);
    cachedModuleNames.delete(module);
  });
}

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

export function clear(module?: string) {
  if (module) {
    cachedModules.delete(module);
    cachedModuleNames.delete(module);
    bc?.postMessage(module);
  } else {
    cachedModules.clear();
    cachedModuleNames.clear();
  }
}

export async function lookupSourcePage(
  module: string,
  version: string,
  path: string,
): Promise<SourcePage | undefined> {
  let moduleItem = cachedModules.get(module);
  let versionItem = moduleItem && cachedVersions.get(moduleItem)?.get(version);
  let sourcePageItem = versionItem &&
    cachedSourcePages.get(versionItem)?.get(path);
  if (!sourcePageItem) {
    datastore = datastore || await getDatastore();
    const keys: Key[] = [];
    if (!moduleItem) {
      keys.push(datastore.key([kinds.MODULE_KIND, module]));
    }
    if (!versionItem) {
      keys.push(datastore.key(
        [kinds.MODULE_KIND, module],
        [kinds.MODULE_VERSION_KIND, version],
      ));
    }
    keys.push(datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
      [kinds.CODE_PAGE_KIND, path],
    ));

    const res = await datastore.lookup(keys);
    if (res.found) {
      for (const { entity } of res.found) {
        assert(
          entity.key,
          "Entity assertion failed for " + JSON.stringify(res.found),
        );
        const entityKind = entity.key.path[entity.key.path.length - 1].kind;
        switch (entityKind) {
          case kinds.MODULE_KIND: {
            moduleItem = entityToObject(entity);
            cachedModules.set(module, moduleItem);
            break;
          }
          case kinds.MODULE_VERSION_KIND: {
            versionItem = entityToObject(entity);
            assert(
              moduleItem,
              "ModuleItem assertion failed for " + JSON.stringify(res.found),
            );
            if (!cachedVersions.has(moduleItem)) {
              cachedVersions.set(moduleItem, new Map());
            }
            const versions = cachedVersions.get(moduleItem)!;
            versions.set(version, versionItem);
            break;
          }
          case kinds.CODE_PAGE_KIND: {
            sourcePageItem = entityToObject(entity);
            assert(
              versionItem,
              "sourcePageItem assertion failed for " +
                JSON.stringify(res.found),
            );
            if (!cachedSourcePages.has(versionItem)) {
              cachedSourcePages.set(versionItem, new Map());
            }
            const sourcePages = cachedSourcePages.get(versionItem)!;
            sourcePages.set(path, sourcePageItem);
            break;
          }
          default:
            throw new TypeError(`Unexpected kind "${entityKind}".`);
        }
      }
    }
  }
  if (moduleItem) {
    cachedModuleNames.add(module);
    enqueuePrune();
  }
  return sourcePageItem;
}

export async function lookupInfoPage(
  module: string,
  version: string,
): Promise<InfoPage | undefined> {
  let moduleItem = cachedModules.get(module);
  let infoPageItem = moduleItem &&
    cachedInfoPages.get(moduleItem)?.get(version);
  if (!infoPageItem) {
    datastore = datastore || await getDatastore();
    const keys: Key[] = [];
    if (!moduleItem) {
      keys.push(datastore.key([kinds.MODULE_KIND, module]));
    }
    keys.push(datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.INFO_PAGE_KIND, version],
    ));

    const res = await datastore.lookup(keys);
    if (res.found) {
      for (const { entity } of res.found) {
        assert(entity.key);
        const entityKind = entity.key.path[entity.key.path.length - 1].kind;
        switch (entityKind) {
          case kinds.MODULE_KIND:
            moduleItem = entityToObject(entity);
            cachedModules.set(module, moduleItem);
            break;
          case kinds.INFO_PAGE_KIND: {
            infoPageItem = entityToObject(entity);
            assert(moduleItem);
            if (!cachedInfoPages.has(moduleItem)) {
              cachedInfoPages.set(moduleItem, new Map());
            }
            const infoPages = cachedInfoPages.get(moduleItem)!;
            infoPages.set(version, infoPageItem);
            break;
          }
        }
      }
    }
  }
  if (moduleItem) {
    cachedModuleNames.add(module);
    enqueuePrune();
  }
  return infoPageItem;
}

export async function lookupDocPage(
  module: string,
  version: string,
  path: string,
  symbol: string,
): Promise<DocPage | undefined> {
  if (!SYMBOL_REGEX.test(symbol)) {
    return undefined;
  }

  let moduleItem = cachedModules.get(module);
  let versionItem = moduleItem && cachedVersions.get(moduleItem)?.get(version);
  let entryItem = versionItem && cachedEntries.get(versionItem)?.get(path);
  let docPageItem = entryItem && cachedDocPages.get(entryItem)?.get(symbol);
  if (!docPageItem) {
    datastore = datastore || await getDatastore();
    const keys: Key[] = [];
    if (!moduleItem) {
      keys.push(datastore.key(
        [kinds.MODULE_KIND, module],
      ));
    }
    if (!versionItem) {
      keys.push(datastore.key(
        [kinds.MODULE_KIND, module],
        [kinds.MODULE_VERSION_KIND, version],
      ));
    }
    if (!entryItem) {
      keys.push(datastore.key(
        [kinds.MODULE_KIND, module],
        [kinds.MODULE_VERSION_KIND, version],
        [kinds.MODULE_ENTRY_KIND, path],
      ));
    }
    keys.push(datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
      [kinds.MODULE_ENTRY_KIND, path],
      [kinds.DOC_PAGE_KIND, symbol],
    ));

    try {
      const res = await datastore.lookup(keys);
      if (res.found) {
        let foundModuleVersion: ModuleVersion | undefined;
        let foundModuleEntry: ModuleEntry | undefined;
        let foundModuleDocPage: DocPage | undefined;
        for (const { entity } of res.found) {
          assert(entity.key);
          const entityKind = entity.key.path[entity.key.path.length - 1].kind;
          switch (entityKind) {
            case kinds.MODULE_KIND:
              moduleItem = entityToObject(entity);
              cachedModules.set(module, moduleItem);
              break;
            case kinds.MODULE_VERSION_KIND: {
              foundModuleVersion = versionItem = entityToObject(entity);
              break;
            }
            case kinds.MODULE_ENTRY_KIND: {
              foundModuleEntry = entryItem = entityToObject(entity);
              break;
            }
            case kinds.DOC_PAGE_KIND: {
              const docPage = entityToDocPage(entity);
              if (
                !((docPage.kind === "module" || docPage.kind === "symbol") &&
                  !docPage.symbols)
              ) {
                foundModuleDocPage = docPageItem = entityToDocPage(entity);
              }
              break;
            }
            default:
              throw new TypeError(`Unexpected kind "${entityKind}".`);
          }
        }

        if (foundModuleVersion) {
          assert(moduleItem);
          if (!cachedVersions.has(moduleItem)) {
            cachedVersions.set(moduleItem, new Map());
          }
          const versions = cachedVersions.get(moduleItem)!;
          versions.set(version, foundModuleVersion);
        }
        if (foundModuleEntry) {
          assert(versionItem);
          if (!cachedEntries.has(versionItem)) {
            cachedEntries.set(versionItem, new Map());
          }
          const entries = cachedEntries.get(versionItem)!;
          entries.set(path, foundModuleEntry);
        }
        if (foundModuleDocPage) {
          assert(entryItem);
          if (!cachedDocPages.has(entryItem)) {
            cachedDocPages.set(entryItem, new Map());
          }
          const docPages = cachedDocPages.get(entryItem)!;
          docPages.set(symbol, foundModuleDocPage);
        }
      }
    } catch (e) {
      console.error(keys, e);
    }
  }
  if (moduleItem) {
    cachedModuleNames.add(module);
    enqueuePrune();
  }
  return docPageItem;
}

export async function lookup(
  module: string,
): Promise<[Module | undefined, undefined, undefined]>;
export async function lookup(
  module: string,
  version: string,
): Promise<[Module | undefined, ModuleVersion | undefined, undefined]>;
export async function lookup(
  module: string,
  version: string,
  path: string,
): Promise<
  [Module | undefined, ModuleVersion | undefined, ModuleEntry | undefined]
>;
export async function lookup(
  module: string,
  version?: string,
  path?: string,
) {
  let moduleItem = cachedModules.get(module);
  let versionItem = version && moduleItem &&
      cachedVersions.get(moduleItem)?.get(version) || undefined;
  let entryItem = path && versionItem &&
      cachedEntries.get(versionItem)?.get(path) || undefined;
  datastore = datastore || await getDatastore();
  const keys: Key[] = [];
  if (!moduleItem) {
    keys.push(datastore.key(
      [kinds.MODULE_KIND, module],
    ));
  }
  if (version && !versionItem) {
    keys.push(datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
    ));
  }
  if (path && !entryItem) {
    assert(version);
    keys.push(datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
      [kinds.MODULE_ENTRY_KIND, path],
    ));
  }
  if (keys.length) {
    const res = await datastore.lookup(keys);
    if (res.found) {
      for (const { entity } of res.found) {
        assert(entity.key);
        const entityKind = entity.key.path[entity.key.path.length - 1].kind;
        switch (entityKind) {
          case kinds.MODULE_KIND:
            moduleItem = entityToObject(entity);
            cachedModules.set(module, moduleItem);
            break;
          case kinds.MODULE_VERSION_KIND: {
            versionItem = entityToObject(entity);
            queueMicrotask(() => {
              assert(versionItem);
              assert(moduleItem);
              assert(version);
              if (!cachedVersions.has(moduleItem)) {
                cachedVersions.set(moduleItem, new Map());
              }
              const versions = cachedVersions.get(moduleItem)!;
              versions.set(version, versionItem);
            });
            break;
          }
          case kinds.MODULE_ENTRY_KIND: {
            entryItem = entityToObject(entity);
            queueMicrotask(() => {
              assert(entryItem);
              assert(versionItem);
              assert(path);
              if (!cachedEntries.has(versionItem)) {
                cachedEntries.set(versionItem, new Map());
              }
              const entries = cachedEntries.get(versionItem)!;
              entries.set(path, entryItem);
            });
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
  return [moduleItem, versionItem, entryItem];
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

export function cacheSourcePage(
  module: string,
  version: string,
  path: string,
  sourcePage: SourcePage,
): void {
  const moduleItem = cachedModules.get(module);
  if (moduleItem) {
    const versionItem = cachedVersions.get(moduleItem)?.get(version);
    if (versionItem) {
      if (!cachedSourcePages.has(versionItem)) {
        cachedSourcePages.set(versionItem, new Map());
      }
      const sourcePages = cachedSourcePages.get(versionItem)!;
      sourcePages.set(path, sourcePage);
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
        // the original doc page can get partially serialized after added to
        // the cache, which causes problems when revisiting the page in the
        // same isolate, so we do a structured clone when caching here.
        docPages.set(symbol, structuredClone(docPage));
        cachedModuleNames.add(module);
      }
    }
  }
}

export function cacheInfoPage(
  module: string,
  version: string,
  infoPage: InfoPage,
): void {
  const moduleItem = cachedModules.get(module);
  if (moduleItem) {
    if (!cachedInfoPages.has(moduleItem)) {
      cachedInfoPages.set(moduleItem, new Map());
    }
    const infoPages = cachedInfoPages.get(moduleItem)!;
    infoPages.set(version, infoPage);
    cachedModuleNames.add(module);
  }
}
