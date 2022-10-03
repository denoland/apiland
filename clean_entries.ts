// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** A one off script for reloading modules with legacy formats.
 *
 * @module
 */

import dax from "dax";
import {
  DatastoreError,
  entityToObject,
  objectToEntity,
} from "google_datastore";
import type { Mutation } from "google_datastore/types";
import {
  addNodes,
  type DocNode,
  type DocNodeNull,
  generateDocNodes,
  getImportMapSpecifier,
} from "./docs.ts";
import { loadModule } from "./modules.ts";
import { getDatastore } from "./store.ts";
import type { Module, ModuleEntry, ModuleVersion } from "./types.d.ts";
import { assert } from "./util.ts";

const toReload = new Set<string>();
const datastore = await getDatastore();

const query = datastore.createQuery("module_entry").filter("type", "=", "dir");

dax.logStep(`Finding legacy module entries...`);

for await (const entity of datastore.streamQuery(query)) {
  const entry = entityToObject<ModuleEntry>(entity);
  if (!entry.dirs) {
    assert(entity.key);
    const module = entity.key.path[0].name;
    assert(module);
    const version = entity.key.path[1].name;
    assert(version);
    const entry = `${module}@${version}`;
    if (!toReload.has(entry)) {
      dax.logLight(`  adding ${entry} to reload.`);
      toReload.add(entry);
    }
  }
}

dax.logStep(`Reloading ${toReload.size} modules...`);

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

for (const ver of toReload) {
  const [module, ...rest] = ver.split("@");
  const version = rest.join("@");
  let mutations: Mutation[];
  let toDoc: [string, string, Set<string>][];
  let moduleItem: Module | undefined;
  let moduleVersion: ModuleVersion | undefined;
  try {
    [mutations, moduleItem, moduleVersion, , toDoc] = await loadModule(
      module,
      version,
    );
  } catch (err) {
    dax.logWarn(`Skipping module "${module}@${version}", cannot load.`, err);
    continue;
  }
  if (toDoc && toDoc.length && moduleItem.latest_version === version) {
    await doc(toDoc, mutations);
    if (moduleVersion) {
      moduleVersion.has_doc = true;
      mutations.push({ upsert: objectToEntity(moduleVersion) });
    }
  } else {
    dax.logLight(`  not documenting...`);
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
