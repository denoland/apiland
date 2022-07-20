// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { entityToObject, objectSetKey, objectToEntity } from "google_datastore";
import type { Mutation } from "google_datastore/types";

import { getDatastore } from "./store.ts";
import type { Module, ModuleEntry, ModuleVersion } from "./types.d.ts";
import { assert } from "./util.ts";

interface ApiModuleData {
  data: {
    name: string;
    description: string;
    star_count: number;
  };
}

interface ModuleMetaVersionsJson {
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

function getIndexedModules(
  path: string,
  list: PackageMetaListing[],
): string[] {
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
  return modules;
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

async function getModuleData(
  module: string,
): Promise<ApiModuleData | undefined> {
  const res = await fetch(`${DENO_API}${module}`);
  if (res.status !== 200) {
    return undefined;
  }
  return res.json();
}

async function getModuleMetaVersions(
  module: string,
): Promise<ModuleMetaVersionsJson | undefined> {
  const res = await fetch(`${S3_BUCKET}${module}/meta/versions.json`);
  if (res.status !== 200) {
    return undefined;
  }
  return res.json();
}

function getSubdirs(path: string, list: PackageMetaListing[]): string[] {
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

async function getVersionMeta(
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

function isIndexedDir(item: PackageMetaListing): boolean {
  return item.type === "dir" && !item.path.match(RE_PRIVATE_PATH);
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
  ]
> {
  const moduleData = await getModuleData(module);
  assert(moduleData, "Module data missing");
  const moduleMetaVersion = await getModuleMetaVersions(module);
  assert(moduleMetaVersion, "Module version data missing");

  const mutations: Mutation[] = [];
  const datastore = await getDatastore();
  const moduleKey = datastore.key(["module", module]);

  let moduleItem: Module;
  const lookupResult = await datastore.lookup(moduleKey);
  if (lookupResult.found) {
    assert(lookupResult.found.length === 1, "More than one item found.");
    moduleItem = entityToObject<Module>(lookupResult.found[0].entity);
    moduleItem.description = moduleData.data.description;
    moduleItem.versions = moduleMetaVersion.versions;
    moduleItem.latest_version = moduleMetaVersion.latest;
    moduleItem.star_count = moduleData.data.star_count;
  } else {
    moduleItem = {
      name: module,
      description: moduleData.data.description,
      versions: moduleMetaVersion.versions,
      latest_version: moduleMetaVersion.latest,
    };
    objectSetKey(moduleItem, moduleKey);
  }
  mutations.push({ upsert: objectToEntity(moduleItem) });

  let moduleVersion: ModuleVersion | undefined;
  let foundModuleEntry: ModuleEntry | undefined;
  if (version) {
    let versions: string[] = [];
    if (version === "all") {
      versions = moduleItem.versions;
    } else if (version === "latest") {
      versions = [moduleItem.latest_version];
    } else {
      versions = moduleItem.versions.filter((v) => v.includes(version!));
    }
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
      mutations.push({ upsert: objectToEntity(moduleVersion) });
      const { directory_listing: listing } = versionMeta;
      for (const moduleEntry of versionMeta.directory_listing) {
        if (moduleEntry.path === "") {
          moduleEntry.path = "/";
        }
        if (moduleEntry.type === "dir") {
          moduleEntry.dirs = getSubdirs(moduleEntry.path, listing);
        }
        if (isIndexedDir(moduleEntry)) {
          moduleEntry.index = getIndexedModules(moduleEntry.path, listing);
        }
        objectSetKey(
          moduleEntry,
          datastore.key(
            ["module", moduleItem.name],
            ["module_version", version],
            ["module_entry", moduleEntry.path],
          ),
        );
        if (moduleEntry.path === path) {
          foundModuleEntry = moduleEntry;
        }
        mutations.push({ upsert: objectToEntity(moduleEntry) });
      }
    }
  }

  return [mutations, moduleItem, moduleVersion, foundModuleEntry];
}
