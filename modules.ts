// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Functions for handling modules and other registry integrations.
 *
 * @module
 */

import {
  type Datastore,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Key, Mutation } from "google_datastore/types";

import { getDatastore } from "./auth.ts";
import {
  cacheModule,
  cacheModuleEntry,
  cacheModuleVersion,
  lookup,
} from "./cache.ts";
import { kinds } from "./consts.ts";
import { isDocable } from "./docs.ts";
import type {
  Module,
  ModuleEntry,
  ModuleMetaVersionsJson,
  ModuleVersion,
  ModuleVersionMetaJson,
  PackageMetaListing,
  PageNoVersions,
} from "./types.d.ts";
import { assert } from "./util.ts";
import { ApiModuleData } from "./types.d.ts";

const DENO_CDN = "https://cdn.deno.land/";
export const RE_IGNORED_MODULE =
  /(\/[_.].|(test|.+_test)\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$)/i;
const RE_MODULE_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
export const RE_PRIVATE_PATH = /\/([_.][^/]+|testdata)/;
const EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_MODULES = ["mod", "lib", "main", "index"].flatMap((idx) =>
  EXT.map((ext) => `${idx}${ext}`)
);

export function getIndexedModules(
  path: string,
  list: PackageMetaListing[],
): [string[], string | undefined] {
  const modules: string[] = [];
  for (const { path: p, type } of list) {
    const slice = path !== "/" ? p.slice(path.length) : p;
    if (
      p.startsWith(path) && type === "file" && slice.lastIndexOf("/") === 0 &&
      p.match(RE_MODULE_EXT) && !RE_IGNORED_MODULE.test(slice)
    ) {
      modules.push(p);
    }
  }
  return [modules, getIndexModule(modules)];
}

/** Given a set of paths which are expected to be siblings within a folder/dir
 * return what appears to be the "index" module. If none can be identified,
 * `undefined` is returned. */
export function getIndexModule(paths?: string[]): string | undefined {
  if (!paths) {
    return undefined;
  }
  for (const index of INDEX_MODULES) {
    const item = paths.find((file) => file.toLowerCase().endsWith(`/${index}`));
    if (item) {
      return item;
    }
  }
}

export async function getModuleMetaVersions(
  module: string,
): Promise<ModuleMetaVersionsJson | undefined> {
  const res = await fetch(`${DENO_CDN}${module}/meta/versions.json`);
  if (res.status !== 200) {
    return undefined;
  }
  return res.json();
}

export function getSubdirs(path: string, list: PackageMetaListing[]): string[] {
  const dirs: string[] = [];
  for (const { path: p, type } of list) {
    const slice = path !== "/" ? p.slice(path.length) : p;
    if (
      p.startsWith(path) && p !== path && type === "dir" &&
      slice.lastIndexOf("/") === 0 && !slice.match(RE_PRIVATE_PATH)
    ) {
      dirs.push(p);
    }
  }
  return dirs;
}

export async function getVersionMeta(
  module: string,
  version: string,
): Promise<ModuleVersionMetaJson | undefined> {
  const res = await fetch(
    `${DENO_CDN}${module}/versions/${version}/meta/meta.json`,
  );
  if (res.status !== 200) {
    return undefined;
  }
  return res.json();
}

export async function getModuleLatestVersion(
  module: string,
): Promise<string | null | undefined> {
  const datastore = await getDatastore();
  const result = await datastore.lookup(
    datastore.key([kinds.MODULE_KIND, module]),
  );
  if (result.found && result.found.length) {
    const moduleItem = entityToObject<Module>(result.found[0].entity);
    return moduleItem.latest_version;
  }
}

/** For a given module, lookup the latest version in the database and redirect
 * the requested URL to the latest version (or return `undefined` if the module
 * is not located).
 *
 * If the module has no versions, then a {@linkcode PageNoVersions} is returned.
 */
export async function redirectToLatest(
  url: URL,
  module: string,
): Promise<Response | PageNoVersions | undefined> {
  const latest = await getModuleLatestVersion(module);
  if (latest === undefined) {
    return undefined;
  }
  if (latest === null) {
    return { kind: "no-versions", module };
  }
  const location = `${
    url.pathname.replace("/__latest__", `/${latest}`)
  }${url.search}`;
  return new Response(null, {
    status: 302,
    statusText: "Found",
    headers: {
      location,
      "X-Deno-Module": module,
      "X-Deno-Latest-Version": latest,
    },
  });
}

export function isIgnoredPath(path: string): boolean {
  return RE_IGNORED_MODULE.test(path) || RE_PRIVATE_PATH.test(path);
}

export function isIndexedDir(item: PackageMetaListing): boolean {
  return item.type === "dir" && !item.path.match(RE_PRIVATE_PATH);
}

const MODULE_KINDS = [
  kinds.DOC_PAGE_KIND,
  kinds.INFO_PAGE_KIND,
  kinds.CODE_PAGE_KIND,
];
const VERSION_KINDS = [
  kinds.DOC_NODE_KIND,
  kinds.MODULE_INDEX_KIND,
  kinds.NAV_INDEX_KIND,
  kinds.SYMBOL_INDEX_KIND,
];

export async function clearAppend(
  datastore: Datastore,
  mutations: Mutation[],
  kinds: string[],
  ancestor: Key,
) {
  for (const kind of kinds) {
    const query = datastore
      .createQuery(kind)
      .hasAncestor(ancestor)
      .select("__key__");

    for await (const { key } of datastore.streamQuery(query)) {
      if (key) {
        mutations.push({ delete: key });
      }
    }
  }
}

/** A function which */
export function clearModule(
  datastore: Datastore,
  mutations: Mutation[],
  module: string,
  version: string,
): Promise<unknown> {
  const pModules = clearAppend(
    datastore,
    mutations,
    MODULE_KINDS,
    datastore.key([kinds.MODULE_KIND, module]),
  );
  const pVersions = clearAppend(
    datastore,
    mutations,
    VERSION_KINDS,
    datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
    ),
  );
  return Promise.all([pModules, pVersions]);
}

export async function loadModule(
  module: string,
  version?: string,
  path?: string,
  quiet = false,
): Promise<
  [
    mutations: Mutation[],
    module: Module,
    moduleVersion: ModuleVersion | undefined,
    moduleEntry: ModuleEntry | undefined,
    toDoc: [string, string, Set<string>][],
    moduleEntries: ModuleEntry[],
  ]
> {
  const datastore = await getDatastore();
  const moduleDataKey = datastore.key([kinds.LEGACY_MODULES, module]);
  const result = await datastore.lookup(moduleDataKey);
  const entity = result.found?.[0].entity;
  assert(entity, "Module data missing");
  const moduleData = entityToObject<ApiModuleData>(result.found![0].entity);
  const moduleMetaVersion = await getModuleMetaVersions(module);

  const mutations: Mutation[] = [];
  const moduleKey = datastore.key([kinds.MODULE_KIND, module]);

  let [moduleItem] = await lookup(module);
  if (moduleItem) {
    moduleItem.description = moduleData.description;
    // for some reason, the version.json contains multiple versions, so we do a
    // quick de-dupe of them here
    moduleItem.versions = [...new Set(moduleMetaVersion?.versions ?? [])];
    moduleItem.latest_version = moduleMetaVersion?.latest ?? null;
  } else {
    moduleItem = {
      name: module,
      description: moduleData.description,
      // sometimes there are duplicates in the versions, so dedupe
      versions: [...new Set(moduleMetaVersion?.versions) ?? []],
      latest_version: moduleMetaVersion?.latest ?? null,
    };
    objectSetKey(moduleItem, moduleKey);
    cacheModule(module, moduleItem);
  }
  mutations.push({ upsert: objectToEntity(moduleItem) });

  let moduleVersion: ModuleVersion | undefined;
  let foundModuleEntry: ModuleEntry | undefined;
  const toDoc: [string, string, Set<string>][] = [];
  const moduleEntries: ModuleEntry[] = [];
  if (version) {
    let versions: string[] = [];
    if (version === "all") {
      versions = moduleItem.versions;
    } else if (version === "latest") {
      assert(moduleItem.latest_version, "There is no latest version");
      versions = [moduleItem.latest_version];
    } else {
      assert(moduleItem.versions.includes(version));
      versions = [version];
    }
    assert(versions.length, "No valid version specified.");
    for (const version of versions) {
      if (!quiet) {
        console.log(
          `%cLoading %c${module}@${version}%c...`,
          "color:green",
          "color:yellow",
          "color:none",
        );
      }
      const versionMeta = await getVersionMeta(module, version);
      assert(versionMeta, `Unable to load meta data for ${module}@${version}.`);
      moduleVersion = {
        name: module,
        description: moduleItem.description,
        version,
        uploaded_at: new Date(versionMeta.uploaded_at),
        upload_options: versionMeta.upload_options,
      };
      const versionKey = datastore.key(
        [kinds.MODULE_KIND, moduleItem.name],
        [kinds.MODULE_VERSION_KIND, version],
      );
      objectSetKey(moduleVersion, versionKey);
      cacheModuleVersion(module, version, moduleVersion);
      mutations.push({ upsert: objectToEntity(moduleVersion) });
      await clearModule(datastore, mutations, moduleItem.name, version);
      const { directory_listing: listing } = versionMeta;
      const toDocPaths = new Set<string>();
      for (const moduleEntry of versionMeta.directory_listing) {
        if (moduleEntry.path === "") {
          moduleEntry.path = "/";
        }
        if (moduleEntry.type === "dir") {
          moduleEntry.dirs = getSubdirs(moduleEntry.path, listing);
        } else if (isDocable(moduleEntry.path)) {
          moduleEntry.docable = true;
          if (!isIgnoredPath(moduleEntry.path)) {
            toDocPaths.add(moduleEntry.path);
          }
        }
        if (isIndexedDir(moduleEntry)) {
          [moduleEntry.index, moduleEntry.default] = getIndexedModules(
            moduleEntry.path,
            listing,
          );
        } else {
          moduleEntry.index = [];
        }
        objectSetKey(
          moduleEntry,
          datastore.key(
            [kinds.MODULE_KIND, moduleItem.name],
            [kinds.MODULE_VERSION_KIND, version],
            [kinds.MODULE_ENTRY_KIND, moduleEntry.path],
          ),
        );
        cacheModuleEntry(module, version, moduleEntry.path, moduleEntry);
        if (moduleEntry.path === path) {
          foundModuleEntry = moduleEntry;
        }
        moduleEntries.push(moduleEntry);
        mutations.push({ upsert: objectToEntity(moduleEntry) });
      }
      // we skip any module which has > 2000 modules to document
      if (toDocPaths.size && toDocPaths.size <= 2000) {
        toDoc.push([moduleItem.name, version, toDocPaths]);
      }
    }
  }

  return [
    mutations,
    moduleItem,
    moduleVersion,
    foundModuleEntry,
    toDoc,
    moduleEntries,
  ];
}
