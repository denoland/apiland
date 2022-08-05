// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** A script for ensuring that the latest version of a module in registry2
 * is loaded in the datastore.
 *
 * @module
 */

import dax from "dax";
import { DatastoreError, entityToObject } from "google_datastore";
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
import type { Module } from "./types.d.ts";

dax.logStep("Finding out of date modules...");

const datastore = await getDatastore();
const toUpdate = new Map<string, string>();
const query = datastore.createQuery("module");

for await (const entity of datastore.streamQuery(query)) {
  const module = entityToObject<Module>(entity);
  try {
    const versionData = await getModuleMetaVersions(module.name);
    if (versionData && module.latest_version !== versionData.latest) {
      dax.logLight(`  add ${module.name}`);
      toUpdate.set(module.name, versionData.latest);
    }
  } catch (e) {
    if (e instanceof Error) {
      dax.logError(e.message, e.stack);
    } else {
      dax.logError(String(e));
    }
  }
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

for (const [moduleName, version] of toUpdate) {
  let mutations: Mutation[];
  let toDoc: [string, string, Set<string>][];
  try {
    [mutations, , , , toDoc] = await loadModule(moduleName, version);
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

dax.logStep("Done.");
