// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Script to upload modules, doc nodes, and copy the manual index to algolia.
 *
 * @module
 */

import { accountCopyIndex } from "@algolia/client-account";
import { type MultipleBatchRequest } from "@algolia/client-search";
import { createFetchRequester } from "@algolia/requester-fetch";
import algoliasearch, { SearchClient } from "algoliasearch";
import dax from "dax";
import { parse } from "std/flags/mod.ts";
import { type Datastore, entityToObject, objectGetKey } from "google_datastore";
import { type Entity } from "google_datastore/types";

import { algoliaKeys, denoManualAlgoliaKeys, readyPromise } from "./auth.ts";
import { lookup, lookupLib } from "./cache.ts";
import { DocNodeKind, entitiesToDocNodes, getModuleEntries } from "./docs.ts";
import { getDatastore } from "./store.ts";
import type {
  DocNode,
  Library,
  LibraryVersion,
  Module,
  ModuleEntry,
  ModuleVersion,
} from "./types.d.ts";
import { assert } from "./util.ts";

const DOC_NODE_INDEX = "doc_nodes";
const DOC_NODE_NEW_INDEX = "doc_nodes_new";
const MODULES_INDEX = "modules";

const ALLOWED_DOCNODES = [
  "function",
  "variable",
  "enum",
  "class",
  "typeAlias",
  "interface",
];
const ALLOWED_DOC_KINDS: DocNodeKind[] = [
  "class",
  "enum",
  "interface",
  "function",
  "typeAlias",
  "variable",
];

let datastore: Datastore | undefined;
let denoLandApp: SearchClient | undefined;
let uid = 0;

enum Source {
  Library = 100,
  StandardLibraryDefault = 200,
  StandardLibraryOther = 220,
  DenoOfficialDefault = 300,
  ThirdPartyDefault = 400,
  DenoOfficialOther = 530,
  ThirdPartyOther = 540,
}

function main() {
  const args = parse(Deno.args, {
    boolean: [
      "update-manual",
      "update-modules",
      "update-library",
    ],
  });
  if (args["update-manual"]) {
    return updateManual();
  }
  if (args["update-modules"]) {
    return updateModules();
  }
  if (args["update-library"]) {
    return updateLibrary();
  }
  const module = args["_"][0] as string;
  if (module) {
    return loadModuleDocNodes(module);
    // return loadModule(module);
  }
}

if (import.meta.main) {
  await main();
}

// TODO(@kitsonk) remove after finishing refactor
// function getPath(docNode: DocNode): string | undefined {
//   return objectGetKey(docNode)
//     ?.path
//     .find(({ kind }) => kind === "module_entry")
//     ?.name;
// }

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

function docNodeToRequestNew(
  source: Source,
  sourceId: string,
  popularity_score: number,
  version: string,
  path: string | undefined,
  namespace: string | undefined,
  docNode: DocNode,
  id: number,
): MultipleBatchRequest {
  const name = namespace ? `${namespace}.${docNode.name}` : docNode.name;
  const objectID = `${sourceId}:${path}:${name}:${id}`;
  return {
    action: "updateObject",
    indexName: DOC_NODE_NEW_INDEX,
    body: {
      objectID,
      name,
      source,
      sourceId,
      popularity_score,
      version,
      path,
      doc: docNode.jsDoc?.doc,
      kind: docNode.kind,
      location: docNode.location,
    },
  };
}

// TODO(@kitsonk): remove when refactoring complete
// async function loadModule(module: string, version?: string) {
//   dax.logStep(`Loading doc nodes for module "${module}"...`);
//   let moduleItem: Module | undefined;
//   let moduleVersion: ModuleVersion | undefined;
//   if (version) {
//     [moduleItem, moduleVersion] = await lookup(module, version);
//   } else {
//     [moduleItem] = await lookup(module);
//     if (moduleItem && moduleItem.latest_version) {
//       version = moduleItem.latest_version;
//       [, moduleVersion] = await lookup(module, version);
//     }
//   }
//   if (version && moduleVersion && moduleItem) {
//     dax.logLight(`  using version ${version}.`);
//     datastore = datastore ?? await getDatastore();
//     const ancestor = datastore.key(
//       ["module", module],
//       ["module_version", version],
//     );
//     const query = datastore
//       .createQuery("doc_node")
//       .hasAncestor(ancestor);
//     const entities: Entity[] = [];
//     for await (const entity of datastore.streamQuery(query)) {
//       entities.push(entity);
//     }
//     const docNodes = entitiesToDocNodes(ancestor, entities);
//     dax.logLight(`  loaded ${entities.length} doc nodes.`);
//     const requests: MultipleBatchRequest[] = [];
//     requests.push(moduleToRequest(moduleItem));
//     const publishedAt = moduleVersion.uploaded_at.getTime();
//     const popularityScore = moduleItem.name === "std"
//       ? STD_POPULARITY_SCORE
//       : moduleItem.popularity_score;
//     for (const docNode of docNodes) {
//       const path = getPath(docNode);
//       if (path && !filteredDocNode(path, docNode)) {
//         requests.push(
//           docNodeToRequest(module, path, publishedAt, popularityScore, docNode),
//         );
//       }
//     }
//     dax.logStep(
//       `Uploading ${requests.length} index items to algolia...`,
//     );
//     await upload(requests);
//     dax.logStep(`Success.`);
//     Deno.exit(0);
//   } else {
//     dax.logError("Unable to find latest version of module.");
//   }
// }

function isDeprecated(docNode: DocNode): boolean {
  return docNode.jsDoc?.tags?.some(({ kind }) => kind === "deprecated") ??
    false;
}

function appendDocNodes(
  requests: MultipleBatchRequest[],
  source: Source,
  sourceId: string,
  docNodes: DocNode[],
  popularityScore: number,
  version: string,
  path?: string,
  namespace?: string,
) {
  if (!namespace) {
    uid = 0;
  }
  for (const docNode of docNodes) {
    if (
      (ALLOWED_DOC_KINDS.includes(docNode.kind) ||
        (!namespace && docNode.kind === "moduleDoc")) && !isDeprecated(docNode)
    ) {
      requests.push(
        docNodeToRequestNew(
          source,
          sourceId,
          popularityScore,
          version,
          path,
          namespace,
          docNode,
          uid++,
        ),
      );
    } else if (docNode.kind === "namespace") {
      const ns = namespace ? `${namespace}.${docNode.name}` : docNode.name;
      appendDocNodes(
        requests,
        source,
        sourceId,
        docNode.namespaceDef.elements,
        popularityScore,
        version,
        path,
        ns,
      );
    }
  }
}

function getSource(
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
  defaultEntriesPaths: string[],
): Source {
  const isStandard = module.name === "std";
  const isOfficial = version.upload_options.repository.startsWith("denoland/");
  const isDefault = defaultEntriesPaths.includes(entry.path);
  if (isStandard) {
    return isDefault
      ? Source.StandardLibraryDefault
      : Source.StandardLibraryOther;
  }
  if (isOfficial) {
    return isDefault ? Source.DenoOfficialDefault : Source.DenoOfficialOther;
  }
  return isDefault ? Source.ThirdPartyDefault : Source.ThirdPartyOther;
}

async function loadModuleDocNodes(module: string, version?: string) {
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
    dax.logStep(`Deleting old doc nodes...`);
    await clearDocNodes(`mod/${moduleItem.name}`);
    dax.logStep(`Retrieving module entries...`);
    let entries = await getModuleEntries(module, version);
    const defaultEntryPaths = entries
      .flatMap(({ default: def }) => def ? [def] : []);
    entries = entries.filter(({ docable, path }) =>
      docable && !(path.includes("/_") || path.includes("/."))
    );
    dax.logLight(`  retrieved ${entries.length} docable modules.`);
    datastore = datastore ?? await getDatastore();
    const requests: MultipleBatchRequest[] = [];
    for (const entry of entries) {
      const ancestor = objectGetKey(entry);
      if (ancestor) {
        const query = datastore
          .createQuery("doc_node")
          .hasAncestor(ancestor);
        const entities: Entity[] = [];
        for await (const entity of datastore.streamQuery(query)) {
          entities.push(entity);
        }
        const docNodes = entitiesToDocNodes(ancestor, entities);
        if (!docNodes.length) {
          continue;
        }
        dax.logLight(
          `  loaded ${entities.length} doc nodes for ${entry.path}.`,
        );
        const source = getSource(
          moduleItem,
          moduleVersion,
          entry,
          defaultEntryPaths,
        );
        appendDocNodes(
          requests,
          source,
          `mod/${moduleItem.name}`,
          docNodes,
          moduleItem.popularity_score ?? 0,
          moduleVersion.version,
          entry.path,
        );
      }
    }
    dax.logStep(`Uploading ${requests.length} doc nodes to algolia...`);
    await upload(requests);
    dax.logStep(`Success.`);
    Deno.exit(0);
  } else {
    dax.logError("unable to find latest version of module.");
  }
}

async function updateLibrary() {
  dax.logStep(`Loading doc nodes for built-in library...`);
  // deno-lint-ignore prefer-const
  let libraryItem: Library | undefined;
  // deno-lint-ignore prefer-const
  let libraryVersion: LibraryVersion | undefined;
  [libraryItem] = await lookupLib("deno_unstable");
  assert(libraryItem?.latest_version);
  [, libraryVersion] = await lookupLib(
    "deno_unstable",
    libraryItem?.latest_version,
  );
  if (libraryItem && libraryVersion) {
    dax.logLight(`  using version ${libraryVersion.version}.`);
    dax.logStep(`Deleting old doc nodes...`);
    await clearDocNodes(`lib/deno_unstable`);
    datastore = datastore ?? await getDatastore();
    const requests: MultipleBatchRequest[] = [];
    const ancestor = objectGetKey(libraryVersion);
    if (ancestor) {
      const query = datastore
        .createQuery("doc_node")
        .hasAncestor(ancestor);
      const entities: Entity[] = [];
      for await (const entity of datastore.streamQuery(query)) {
        entities.push(entity);
      }
      const docNodes = entitiesToDocNodes(ancestor, entities);
      dax.logLight(`  loaded ${entities.length} doc nodes.`);
      const source = Source.Library;
      appendDocNodes(
        requests,
        source,
        `lib/deno_unstable`,
        docNodes,
        0,
        libraryVersion.version,
      );
    }
    dax.logStep(`Uploading ${requests.length} doc nodes to algolia...`);
    await upload(requests);
    dax.logStep("Success.");
    Deno.exit(0);
  } else {
    dax.logError("unable to find latest version of the library.");
  }
}

export function moduleToRequest(module: Module): MultipleBatchRequest {
  return {
    action: "updateObject",
    indexName: MODULES_INDEX,
    body: {
      objectID: module.name,
      name: module.name,
      description: module.description,
      third_party: module.name !== "std",
      source: module.name === "std" ? 200 : 400,
      popularity_score: module.popularity_score,
      popularity_tag: module.tags?.find(({ kind }) => kind === "popularity")
        ?.value,
    },
  };
}

async function updateModules() {
  dax.logStep("Updating modules...");
  const modules = await getAllModules();
  dax.logStep(`Retrieved ${modules.length} modules.`);
  const requests: MultipleBatchRequest[] = [];
  for (const module of modules) {
    if (module.latest_version) {
      requests.push(moduleToRequest(module));
    }
  }
  dax.logStep(`Uploading ${requests.length} modules to algolia...`);
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
      dax.logError("Failed to update the manual index");
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

function getDenoLandApp(): SearchClient {
  if (denoLandApp) {
    return denoLandApp;
  }
  const requester = createFetchRequester();
  return denoLandApp = algoliasearch(
    algoliaKeys.appId,
    algoliaKeys.apiKey,
    { requester },
  );
}

export async function clearDocNodes(module: string): Promise<void> {
  const denoLandApp = getDenoLandApp();
  const index = denoLandApp.initIndex(DOC_NODE_NEW_INDEX);
  await index.deleteBy({ filters: `sourceId:${module}` });
}

/** Upload batch requests to Algolia. */
export async function upload(requests: MultipleBatchRequest[]): Promise<void> {
  await getDenoLandApp().multipleBatch(requests);
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
