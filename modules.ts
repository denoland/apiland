import { entityToObject, objectSetKey, objectToEntity } from "google_datastore";
import type { Mutation } from "google_datastore/types";

import { datastore } from "./store.ts";
import type { Module, ModuleVersion } from "./types.d.ts";
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
const EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_MODULES = ["mod", "lib", "main", "index"].flatMap((idx) =>
  EXT.map((ext) => `${idx}${ext}`)
);
const RE_IGNORED_MODULE =
  /(\/[_.].|(test|.+_test)\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$)/i;
const RE_MODULE_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const RE_PRIVATE_PATH = /\/([_.][^/]+|testdata)/;

function getIndexedModules(
  path: string,
  list: PackageMetaListing[],
): string[] {
  const modules: string[] = [];
  for (const { path: p, type } of list) {
    const slice = path !== "/" ? p.slice(path.length) : p;
    if (
      p.startsWith(path) && type === "file" && slice.lastIndexOf("/") === 0 &&
      p.match(RE_MODULE_EXT) && !slice.match(RE_IGNORED_MODULE)
    ) {
      modules.push(p);
    }
  }
  return modules;
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
  quiet = false,
): Promise<Mutation[]> {
  const moduleData = await getModuleData(module);
  assert(moduleData, "Module data missing");
  const moduleMetaVersion = await getModuleMetaVersions(module);
  assert(moduleMetaVersion, "Module version data missing");

  const mutations: Mutation[] = [];
  const moduleKey = datastore.key(["module", module]);

  let moduleItem: Module;
  const lookupResult = await datastore.lookup(moduleKey);
  if (lookupResult.found) {
    assert(lookupResult.found.length === 1, "More than one item found.");
    moduleItem = entityToObject<Module>(lookupResult.found[0].entity);
    moduleItem.description = moduleData.data.description;
    moduleItem.versions = moduleMetaVersion.versions;
    moduleItem.latest_version = moduleMetaVersion.latest;
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
      const moduleVersion: ModuleVersion = {
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
        mutations.push({ upsert: objectToEntity(moduleEntry) });
      }
    }
  }

  return mutations;
}
