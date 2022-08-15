// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Script to upload modules, doc nodes, and copy the manual index to algolia.
 *
 * @module
 */

import { accountCopyIndex } from "@algolia/client-account";
import { type MultipleBatchRequest } from "@algolia/client-search";
import { createFetchRequester } from "@algolia/requester-fetch";
import algoliasearch from "algoliasearch";
import dax from "dax";
import { parse } from "std/flags/mod.ts";
import { type Datastore, entityToObject, objectGetKey } from "google_datastore";
import { type Entity } from "google_datastore/types";

import { algoliaKeys, denoManualAlgoliaKeys, readyPromise } from "./auth.ts";
import { lookup } from "./cache.ts";
import { entitiesToDocNodes } from "./docs.ts";
import { getDatastore } from "./store.ts";
import type { DocNode, Module, ModuleVersion } from "./types.d.ts";

const DOC_NODE_INDEX = "doc_nodes";
const MODULES_INDEX = "modules";

const STD_POPULARITY_SCORE = 1000000;
const ALLOWED_DOCNODES = [
  "function",
  "variable",
  "enum",
  "class",
  "typeAlias",
  "interface",
];

let datastore: Datastore | undefined;

function main() {
  const args = parse(Deno.args, {
    boolean: ["update-manual", "update-modules"],
  });
  if (args["update-manual"]) {
    return updateManual();
  }
  if (args["update-modules"]) {
    return updateModules();
  }
  const module = args["_"][0] as string;
  if (module) {
    return loadModule(module);
  }
}

if (import.meta.main) {
  await main();
}

function getPath(docNode: DocNode): string | undefined {
  return objectGetKey(docNode)
    ?.path
    .find(({ kind }) => kind === "module_entry")
    ?.name;
}

export function filteredDocNode(path: string, node: DocNode): boolean {
  return !ALLOWED_DOCNODES.includes(node.kind) ||
    !node.location.filename.endsWith(path);
}

/** Convert a doc node to a batch request for algolia. */
export function docNodeToRequest(
  module: string,
  path: string,
  publishedAt: number,
  popularityScore: number | undefined,
  docNode: DocNode,
): MultipleBatchRequest {
  const objectID = `${module}${path}:${docNode.kind}:${docNode.name}`;
  const { name, kind, jsDoc, location } = docNode;
  return {
    action: "updateObject",
    indexName: DOC_NODE_INDEX,
    body: {
      name,
      kind,
      jsDoc,
      location,
      objectID,
      publishedAt,
      popularityScore,
    },
  };
}

async function loadModule(module: string, version?: string) {
  dax.logStep(`Loading doc nodes for module "${module}"...`);
  let moduleItem: Module | undefined;
  let moduleVersion: ModuleVersion | undefined;
  if (version) {
    [moduleItem, moduleVersion] = await lookup(module, version);
  } else {
    [moduleItem] = await lookup(module);
    if (moduleItem && moduleItem.latest_version) {
      version = moduleItem.latest_version;
      [, moduleVersion] = await lookup(module, version);
    }
  }
  if (version && moduleVersion && moduleItem) {
    dax.logLight(`  using version ${version}.`);
    datastore = datastore ?? await getDatastore();
    const ancestor = datastore.key(
      ["module", module],
      ["module_version", version],
    );
    const query = datastore
      .createQuery("doc_node")
      .hasAncestor(ancestor);
    const entities: Entity[] = [];
    for await (const entity of datastore.streamQuery(query)) {
      entities.push(entity);
    }
    const docNodes = entitiesToDocNodes(ancestor, entities);
    dax.logLight(`  loaded ${entities.length} doc nodes.`);
    const requests: MultipleBatchRequest[] = [];
    requests.push(moduleToRequest(moduleItem));
    const publishedAt = moduleVersion.uploaded_at.getTime();
    const popularityScore = moduleItem.name === "std"
      ? STD_POPULARITY_SCORE
      : moduleItem.popularity_score;
    for (const docNode of docNodes) {
      const path = getPath(docNode);
      if (path && !filteredDocNode(path, docNode)) {
        requests.push(
          docNodeToRequest(module, path, publishedAt, popularityScore, docNode),
        );
      }
    }
    dax.logStep(
      `Uploading ${requests.length} index items to algolia...`,
    );
    await upload(requests);
    dax.logStep(`Success.`);
    Deno.exit(0);
  } else {
    dax.logError("Unable to find latest version of module.");
  }
}

export function moduleToRequest(module: Module): MultipleBatchRequest {
  return {
    action: "updateObject",
    indexName: MODULES_INDEX,
    body: {
      objectID: module.name,
      popularity_score: module.name === "std"
        ? STD_POPULARITY_SCORE
        : module.popularity_score,
      popularity_tag: module.tags?.find(({ kind }) => kind === "popularity")
        ?.value,
      description: module.description,
      name: module.name,
    },
  };
}

async function updateModules() {
  dax.logStep("Updating modules...");
  const modules = await getAllModules();
  dax.logStep(`Fetched ${modules.length} modules.`);
  const requests: MultipleBatchRequest[] = [];
  for (const module of modules) {
    requests.push(moduleToRequest(module));
  }
  dax.logStep(`Uploading ${modules.length} modules to algolia...`);
  await upload(requests);
  dax.logStep(`Success.`);
  Deno.exit(0);
}

async function updateManual() {
  await readyPromise;
  dax.logStep("Updating manual...");
  const requester = createFetchRequester();
  const denoManualApp = algoliasearch(
    denoManualAlgoliaKeys.appId,
    denoManualAlgoliaKeys.apiKey,
    { requester },
  );
  const denoLandApp = algoliasearch(
    algoliaKeys.appId,
    algoliaKeys.apiKey,
    { requester },
  );
  const sourceIndex = denoManualApp.initIndex("deno_manual");
  const destinationIndex = denoLandApp.initIndex("destination_index");

  // Why copy and move?
  // We cannot copy to an existing index, but move
  // a new index to an existing index's place.
  try {
    await accountCopyIndex(sourceIndex, destinationIndex).wait();
  } catch (error) {
    // RetryErrors seem to be expected, as it is really a long running process
    // so we just only fail if it is something we don't expect
    if (
      !(error && typeof error === "object" && "name" in error &&
        error.name === "RetryError")
    ) {
      dax.logStep("Failed to update the manual index");
      console.log(error);
      Deno.exit(1);
    }
  }
  try {
    await denoLandApp.moveIndex("destination_index", "manual").wait();
  } catch (error) {
    dax.logError("Failed to update manual index");
    console.log(error);
    Deno.exit(1);
  }
  dax.logStep("Successfully updated manual index.");
  Deno.exit(0);
}

/** Upload batch requests to Algolia. */
export async function upload(requests: MultipleBatchRequest[]): Promise<void> {
  const requester = createFetchRequester();
  const denoLandApp = algoliasearch(
    algoliaKeys.appId,
    algoliaKeys.apiKey,
    { requester },
  );
  await denoLandApp.multipleBatch(requests);
}

/** Get all modules from Datastore. */
async function getAllModules() {
  const modules: Module[] = [];
  datastore = datastore ?? await getDatastore();
  const query = datastore.createQuery("module");
  for await (const entity of datastore.streamQuery(query)) {
    modules.push(entityToObject(entity));
  }
  return modules;
}
