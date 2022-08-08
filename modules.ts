// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import {
  type Datastore,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Mutation } from "google_datastore/types";
import {
  cacheModule,
  cacheModuleEntry,
  cacheModuleVersion,
  lookup,
} from "./cache.ts";
import { isDocable } from "./docs.ts";

import { getDatastore } from "./store.ts";
import type {
  Module,
  ModuleEntry,
  ModuleVersion,
  PageNoVersions,
} from "./types.d.ts";
import { assert } from "./util.ts";

interface ApiModuleData {
  data: {
    name: string;
    description: string;
    star_count: number;
  };
}

export interface ModuleMetaVersionsJson {
  latest: string;
  versions: string[];
}

interface ModuleVersionMetaJson {
  uploaded_at: string;
  upload_options: {
    type: string;
    repository: string;
    ref: string;
  };
  directory_listing: {
    path: string;
    size: number;
    type: "file" | "dir";
    default?: string;
    docable?: boolean;
    dirs?: string[];
    index?: string[];
  }[];
}

interface PackageMetaListing {
  path: string;
  size: number;
  type: "file" | "dir";
}

const S3_BUCKET =
  "http://deno-registry2-prod-storagebucket-b3a31d16.s3-website-us-east-1.amazonaws.com/";
const DENO_API = "https://api.deno.land/modules/";
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

export async function getModuleData(
  module: string,
): Promise<ApiModuleData | undefined> {
  const res = await fetch(`${DENO_API}${module}`);
  if (res.status !== 200) {
    return undefined;
  }
  return res.json();
}

export async function getModuleMetaVersions(
  module: string,
): Promise<ModuleMetaVersionsJson | undefined> {
  const res = await fetch(`${S3_BUCKET}${module}/meta/versions.json`);
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
    `${S3_BUCKET}${module}/versions/${version}/meta/meta.json`,
  );
  if (res.status !== 200) {
    return undefined;
  }
  return res.json();
}

async function getModuleLatestVersion(
  module: string,
): Promise<string | null | undefined> {
  const datastore = await getDatastore();
  const result = await datastore.lookup(datastore.key(["module", module]));
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

export function isIndexedDir(item: PackageMetaListing): boolean {
  return item.type === "dir" && !item.path.match(RE_PRIVATE_PATH);
}

/** A function which */
export async function clearModule(
  datastore: Datastore,
  mutations: Mutation[],
  module: string,
  version: string,
): Promise<void> {
  const kinds = [
    "doc_node",
    "module_index",
    "symbol_index",
    "doc_page",
    "nav_index",
  ];

  for (const kind of kinds) {
    const query = datastore
      .createQuery(kind)
      .hasAncestor(datastore.key(
        ["module", module],
        ["module_version", version],
      ))
      .select("__key__");

    for await (const { key } of datastore.streamQuery(query)) {
      if (key) {
        mutations.push({ delete: key });
      }
    }
  }
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
  ]
> {
  const moduleData = await getModuleData(module);
  assert(moduleData, "Module data missing");
  const moduleMetaVersion = await getModuleMetaVersions(module);

  const mutations: Mutation[] = [];
  const datastore = await getDatastore();
  const moduleKey = datastore.key(["module", module]);

  let [moduleItem] = await lookup(module);
  if (moduleItem) {
    moduleItem.description = moduleData.data.description;
    // for some reason, the version.json contains multiple versions, so we do a
    // quick de-dupe of them here
    moduleItem.versions = [...new Set(moduleMetaVersion?.versions ?? [])];
    moduleItem.latest_version = moduleMetaVersion?.latest ?? null;
    moduleItem.star_count = moduleData.data.star_count;
  } else {
    moduleItem = {
      name: module,
      description: moduleData.data.description,
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
        ["module", moduleItem.name],
        ["module_version", version],
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
          if (
            !RE_IGNORED_MODULE.test(moduleEntry.path) &&
            !RE_PRIVATE_PATH.test(moduleEntry.path)
          ) {
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
            ["module", moduleItem.name],
            ["module_version", version],
            ["module_entry", moduleEntry.path],
          ),
        );
        cacheModuleEntry(module, version, moduleEntry.path, moduleEntry);
        if (moduleEntry.path === path) {
          foundModuleEntry = moduleEntry;
        }
        mutations.push({ upsert: objectToEntity(moduleEntry) });
      }
      // we skip any module which has > 2000 modules to document
      if (toDocPaths.size && toDocPaths.size <= 2000) {
        toDoc.push([moduleItem.name, version, toDocPaths]);
      }
    }
  }

  return [mutations, moduleItem, moduleVersion, foundModuleEntry, toDoc];
}
