// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** A command line utility to migrate data from the "legacy" APIs to the Google
 * Datastore.
 *
 * ### Example
 *
 * ```
 * > deno task load oak all
 * ```
 *
 * @module
 */

import { parse } from "https://deno.land/std@0.140.0/flags/mod.ts";

import {
  Datastore,
  objectSetKey,
  objectToEntity,
} from "https://deno.land/x/google_datastore@0.0.10/mod.ts";
import type {
  Mutation,
  PathElement,
} from "https://deno.land/x/google_datastore@0.0.10/types.d.ts";

import { keys } from "./auth.ts";
import type { Module, ModuleVersion } from "./types.d.ts";

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
  }[];
}

const S3_BUCKET =
  "http://deno-registry2-prod-storagebucket-b3a31d16.s3-website-us-east-1.amazonaws.com/";
const DENO_API = "https://api.deno.land/modules/";

const args = parse(Deno.args, { boolean: ["doc", "dry-run"] });

function assert(cond: unknown, message = "Assertion failed."): asserts cond {
  if (!cond) {
    throw new Error(message);
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

const module = String(args["_"][0]);

assert(module, "A module name was not provided.");

console.log(
  `%cLoading %c${module}%c...`,
  "color:green",
  "color:yellow",
  "color:white",
);

const moduleData = await getModuleData(module);
assert(moduleData, "Module data missing");
const moduleMetaVersion = await getModuleMetaVersions(module);
assert(moduleMetaVersion, "Module version data missing");

const mutations: Mutation[] = [];

const moduleItem: Module = {
  name: module,
  description: moduleData.data.description,
  versions: moduleMetaVersion.versions,
  latest_version: moduleMetaVersion.latest,
};
const path: PathElement[] = [{ kind: "module", name: moduleItem.name }];
objectSetKey(moduleItem, { path });

mutations.push({ upsert: objectToEntity(moduleItem) });

const versionArg: string | undefined = String(args["_"][1]);

if (versionArg) {
  let versions: string[] = [];
  if (versionArg === "all") {
    versions = moduleItem.versions;
  } else if (versionArg === "latest") {
    versions = [moduleItem.latest_version];
  } else {
    versions = moduleItem.versions.filter((v) => v.includes(versionArg!));
  }
  for (const version of versions) {
    console.log(
      `%cLoading %c${module}@${version}%c...`,
      "color:green",
      "color:yellow",
      "color:white",
    );
    const versionMeta = await getVersionMeta(module, version);
    assert(versionMeta, `Unable to load meta data for ${module}@${version}.`);
    const moduleVersion: ModuleVersion = {
      name: module,
      description: moduleItem.description,
      version,
      uploaded_at: new Date(versionMeta.uploaded_at),
      upload_options: versionMeta.upload_options,
    };
    const versionPath: PathElement[] = [...path, {
      kind: "module_version",
      name: version,
    }];
    objectSetKey(moduleVersion, { path: versionPath });
    mutations.push({ upsert: objectToEntity(moduleVersion) });
    for (const moduleEntry of versionMeta.directory_listing) {
      if (moduleEntry.path === "") {
        moduleEntry.path = "/";
      }
      objectSetKey(moduleEntry, {
        path: [...versionPath, {
          kind: "module_entry",
          name: moduleEntry.path,
        }],
      });
      mutations.push({ upsert: objectToEntity(moduleEntry) });
    }
  }
}

if (args["dry-run"]) {
  console.log(
    `%cWould have committed ${mutations.length} changes.`,
    "color:yellow",
  );
  console.log("%cDone.", "color:green");
  Deno.exit();
}

const datastore = new Datastore(keys);
let remaining = mutations.length;
console.log(
  `%cCommitting %c${remaining}%c changes...`,
  "color:green",
  "color:yellow",
  "color:white",
);
for await (const res of datastore.commit(mutations, { transactional: false })) {
  remaining -= res.mutationResults.length;
  console.log(
    `%cCommitted %c${res.mutationResults.length}%c changes. %c${remaining}%c to go.`,
    "color:green",
    "color:yellow",
    "color:white",
    "color:yellow",
    "color:white",
  );
}

console.log("%cDone.", "color:green");
