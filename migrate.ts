// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** A one off migration script to ensure that modules with a published version
 * in registry 2 are present in apiland.
 *
 * @module
 */

import dax from "dax";
import { DatastoreError } from "google_datastore";
import type { Mutation } from "google_datastore/types";
import {
  addNodes,
  type DocNode,
  type DocNodeNull,
  generateDocNodes,
  getImportMapSpecifier,
} from "./docs.ts";
import { getModuleMetaVersions, loadModule } from "./modules.ts";
import { getDatastore } from "./store.ts";
import { assert } from "./util.ts";

const modulesEndpoint = new URL("https://api.deno.land/modules");
modulesEndpoint.searchParams.set("limit", "100");

interface APIModule {
  name: string;
  description: string;
  star_count: string;
}

interface APIResponseData {
  total_count: number;
  options: { limit: number; page: number; sort: string };
  results: APIModule[];
}

interface APIResponse {
  success: boolean;
  data: APIResponseData;
}

dax.logStep("Fetching registry2 modules...");

let hasMore = true;
let page = 1;
const moduleNames = new Set<string>();

while (hasMore) {
  modulesEndpoint.searchParams.set("page", String(page++));
  const res = await fetch(modulesEndpoint);
  if (res.status !== 200) {
    throw new Error(`Unexpected response status: ${res.status}`);
  }
  const payload: APIResponse = await res.json();
  hasMore = payload.data.results.length === 100;
  dax.logLight(`  fetched ${payload.data.results.length} modules`);
  for (const { name } of payload.data.results) {
    moduleNames.add(name);
  }
}

dax.logStep("Removing existing datastore modules...");

const datastore = await getDatastore();
const query = datastore.createQuery("module").select("__key__");

for await (const entity of datastore.streamQuery(query)) {
  assert(entity.key);
  const { name } = entity.key.path[0];
  assert(name);
  moduleNames.delete(name);
}

dax.logStep("Loading absent modules...");

async function doc(
  [[module, version, paths]]: [string, string, Set<string>][],
  mutations: Mutation[],
) {
  dax.logStep(`  Documenting ${module}@${version}...`);
  const importMap = await getImportMapSpecifier(module, version);
  for (const path of paths) {
    dax.logLight(`    documenting ${path}...`);
    let docNodes: (DocNode | DocNodeNull)[] = [];
    try {
      docNodes = await generateDocNodes(
        module,
        version,
        path.slice(1),
        importMap,
      );
    } catch (err) {
      const msg = err instanceof Error
        ? `${err.message}\n\n${err.stack}`
        : String(err);
      dax.logWarn(
        `Error generating doc nodes for "${module}@${version}${path}`,
        msg,
      );
    }
    addNodes(
      datastore,
      mutations,
      docNodes.length ? docNodes : [{ kind: "null" }],
      [
        ["module", module],
        ["module_version", version],
        ["module_entry", path],
      ],
    );
  }
}

for (const moduleName of moduleNames) {
  const versionData = await getModuleMetaVersions(moduleName);
  if (versionData && versionData.latest) {
    let mutations: Mutation[];
    let toDoc: [string, string, Set<string>][];
    try {
      [mutations, , , , toDoc] = await loadModule(
        moduleName,
        versionData.latest,
      );
    } catch (err) {
      dax.logWarn(`Skipping module "${moduleName}", cannot load.`, err);
      continue;
    }
    if (toDoc && toDoc.length) {
      await doc(toDoc, mutations);
    } else {
      dax.logWarn(`  Nothing to document.`);
    }
    let remaining = mutations.length;
    dax.logStep(`  Committing to datastore ${remaining} changes...`);
    try {
      for await (
        const res of datastore.commit(mutations, { transactional: false })
      ) {
        remaining -= res.mutationResults.length;
        dax.logLight(
          `    ${res.mutationResults.length} committed. ${remaining} to go.`,
        );
      }
    } catch (err) {
      if (err instanceof DatastoreError) {
        dax.logError(
          "DatastoreError",
          err.statusText,
          JSON.stringify(err.statusInfo, undefined, "  "),
        );
      } else {
        throw err;
      }
    }
  }
}

dax.logStep("Done.");
