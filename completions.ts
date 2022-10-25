// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Utility functions related to completions.
 *
 * @module
 */

import type { DocNodeModuleDoc } from "deno_doc/types";

import {
  type Datastore,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import { getDatastore } from "./auth.ts";
import { lookup } from "./cache.ts";
import { kinds } from "./consts.ts";
import { enqueue } from "./process.ts";
import type {
  CompletionItems,
  ModuleEntry,
  PathCompletion,
  PathCompletions,
} from "./types.d.ts";
import { assert } from "./util.ts";

const completionCache = new Map<string, PathCompletions>();

function isImportable(path: string) {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/i.test(path);
}

function isHidden(path: string) {
  return /\/\./.test(path);
}

function hasModules(
  map: Map<string, PathCompletion>,
  entry: PathCompletion,
): boolean {
  if (entry.modules.length) {
    return true;
  }
  if (entry.dirs) {
    for (const dir of entry.dirs) {
      const e = map.get(dir);
      if (e) {
        return hasModules(map, e);
      }
    }
  }
  return false;
}

function toCompletions(
  module: string,
  version: string,
  entries: ModuleEntry[],
): PathCompletions {
  const completionMap = new Map<string, PathCompletion>();
  for (const entry of entries) {
    if (isHidden(entry.path)) {
      continue;
    }
    if (entry.type === "dir") {
      let path = entry.path;
      if (path !== "/") {
        path = `${path}/`;
      }
      if (!completionMap.has(path)) {
        completionMap.set(path, {
          path,
          default: entry.default,
          dirs: entry.dirs?.map((p) => `${p}/`),
          modules: [],
        });
      }
    } else {
      if (isImportable(entry.path)) {
        const parts = entry.path.split("/");
        parts.pop();
        const parent = `${parts.join("/")}/`;
        const completionItem = completionMap.get(parent);
        if (!completionItem) {
          console.error("Missing parent:", parent);
          continue;
        }
        completionItem.modules.push({ path: entry.path });
      }
    }
  }
  const items: PathCompletion[] = [];
  for (const value of completionMap.values()) {
    if (hasModules(completionMap, value)) {
      items.push(value);
    }
  }
  return { name: module, version, items };
}

let datastore: Datastore | undefined;

export function getCompletionItems(
  completions: PathCompletions,
  path: string,
): CompletionItems | undefined {
  const parts = path.split("/");
  const last = parts.pop();
  const dir = last ? `${parts.join("/")}/` : path;
  const pathCompletion = completions.items.find(({ path }) => path === dir);
  if (pathCompletion) {
    const items: string[] = [];
    let hasDir = false;
    if (pathCompletion.dirs) {
      for (const dir of pathCompletion.dirs) {
        if (dir.startsWith(path)) {
          hasDir = true;
          items.push(dir);
        }
      }
    }
    for (const { path: mod } of pathCompletion.modules) {
      if (mod.startsWith(path)) {
        items.push(mod);
      }
    }
    // when the client queries a sub path, it will omit the trailing `/`, here
    // we check if that if the path with a trailing `/` is the only possible
    // result, we will return that instead.
    if (items.length === 1 && items.includes(`${path}/`)) {
      return getCompletionItems(completions, `${path}/`);
    }
    let preselect: string | undefined;
    if (pathCompletion.default && items.includes(pathCompletion.default)) {
      preselect = pathCompletion.default.slice(1);
    }
    return {
      // we need to strip the leading `/` from the completions as the client
      // isn't expecting them.
      items: items.map((path) => path.slice(1)),
      isIncomplete: hasDir,
      preselect,
    };
  }
}

/** Resolve with a collection of directories and paths for a module and version
 * for building completion items. */
export async function getCompletions(
  module: string,
  version: string,
): Promise<PathCompletions | undefined> {
  if (version === "__latest__") {
    const [moduleItem] = await lookup(module);
    if (!moduleItem || !moduleItem.latest_version) {
      return;
    }
    version = moduleItem.latest_version;
  }
  const key = `${module}@${version}`;
  let pathCompletions = completionCache.get(key);
  if (!pathCompletions) {
    datastore = datastore ?? await getDatastore();
    const res = await datastore.lookup(datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.PATH_COMPLETIONS_KIND, version],
    ));
    if (res.found && res.found.length === 1) {
      const [{ entity }] = res.found;
      pathCompletions = entityToObject(entity);
      completionCache.set(key, pathCompletions);
    }
    if (!pathCompletions) {
      const entries = await datastore.query<ModuleEntry>(
        datastore.createQuery(kinds.MODULE_ENTRY_KIND).hasAncestor(
          datastore.key(
            [kinds.MODULE_KIND, module],
            [kinds.MODULE_VERSION_KIND, version],
          ),
        ),
      );
      if (entries.length) {
        pathCompletions = toCompletions(module, version, entries);
        objectSetKey(
          pathCompletions,
          datastore.key(
            [kinds.MODULE_KIND, module],
            [kinds.PATH_COMPLETIONS_KIND, version],
          ),
        );
        completionCache.set(key, pathCompletions);
        enqueue({
          kind: "commitMutations",
          mutations: [{ upsert: objectToEntity(pathCompletions) }],
        });
      }
    }
  }
  return pathCompletions;
}

async function getModDoc(
  module: string,
  version: string,
  path: string,
): Promise<string> {
  datastore = datastore ?? await getDatastore();
  const docNodeQuery = datastore
    .createQuery(kinds.DOC_NODE_KIND)
    .filter("kind", "moduleDoc")
    .hasAncestor(datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
      [kinds.MODULE_ENTRY_KIND, path],
    ));
  for await (const entity of datastore.streamQuery(docNodeQuery)) {
    assert(entity.key);
    // this ensure we only find moduleDoc for the module, not from a re-exported
    // namespace which might have module doc as well.
    if (entity.key.path.length !== 4) {
      continue;
    }
    const obj = entityToObject<DocNodeModuleDoc>(entity);
    return obj.jsDoc.doc ?? "";
  }
  return "";
}

/** Attempt to resolve any JSDoc associated with a path. */
export async function getPathDoc(
  completions: PathCompletions,
  dir: string,
  path: string,
): Promise<string | undefined> {
  const pathCompletion = completions.items.find(({ path }) => path === dir);
  if (pathCompletion) {
    const search = path === dir ? pathCompletion.default : path;
    if (search) {
      const mod = pathCompletion.modules.find(({ path }) => path === search);
      if (mod) {
        if (mod.doc == null) {
          mod.doc = await getModDoc(
            completions.name,
            completions.version,
            search,
          );
          enqueue({
            kind: "commitMutations",
            mutations: [{ upsert: objectToEntity(completions) }],
          });
        }
        return mod.doc || "";
      }
    }
  }
}
