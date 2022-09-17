// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Script to upload modules, doc nodes, and copy the manual index to algolia.
 *
 * @module
 */

import { type MultipleBatchRequest } from "@algolia/client-search";
import { createFetchRequester } from "@algolia/requester-fetch";
import algoliasearch, { SearchClient } from "algoliasearch";
import dax from "dax";
import { parse } from "std/flags/mod.ts";
import { type Datastore, entityToObject, objectGetKey } from "google_datastore";
import { type Entity } from "google_datastore/types";

import { algoliaKeys } from "./auth.ts";
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

const SYMBOL_INDEX = "doc_nodes";
const MODULES_INDEX = "modules";

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

export function filteredDocNode(
  namespace: string | undefined,
  docNode: DocNode,
): boolean {
  return (ALLOWED_DOC_KINDS.includes(docNode.kind) ||
    (!namespace && docNode.kind === "moduleDoc")) && !isDeprecated(docNode);
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
    indexName: SYMBOL_INDEX,
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
    if (filteredDocNode(namespace, docNode)) {
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

export function getSource(
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

export async function loadDocNodes(
  requests: MultipleBatchRequest[],
  module: Module,
  version: ModuleVersion,
) {
  dax.logStep(`Deleting old doc nodes...`);
  await clearDocNodes(`mod/${module.name}`);
  dax.logStep(`Retrieving module entries...`);
  let entries = await getModuleEntries(module.name, version.version);
  const defaultEntryPaths = entries
    .flatMap(({ default: def }) => def ? [def] : []);
  entries = entries.filter(({ docable, path }) =>
    docable && !(path.includes("/_") || path.includes("/."))
  );
  dax.logLight(`  retrieved ${entries.length} docable modules.`);
  datastore = datastore ?? await getDatastore();
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
        dax.logLight(`  skipping ${entry.path}, no nodes.`);
        continue;
      }
      dax.logLight(
        `  loaded ${entities.length} doc nodes for ${entry.path}.`,
      );
      const source = getSource(
        module,
        version,
        entry,
        defaultEntryPaths,
      );
      appendDocNodes(
        requests,
        source,
        `mod/${module.name}`,
        docNodes,
        module.popularity_score ?? 0,
        version.version,
        entry.path,
      );
    }
  }
}

export async function loadModuleDocNodes(module: string, version?: string) {
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
    const requests: MultipleBatchRequest[] = [];
    await loadDocNodes(requests, moduleItem, moduleVersion);
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
      source: module.name === "std"
        ? Source.StandardLibraryDefault
        : Source.ThirdPartyDefault,
      popularity_score: module.popularity_score,
      popularity_tag: module.tags?.find(({ kind }) => kind === "popularity")
        ?.value,
    },
  };
}

async function appendStdSubModules(requests: MultipleBatchRequest[]) {
  dax.logStep("Loading std sub modules...");
  const [module] = await lookup("std");
  assert(module);
  assert(module.latest_version);
  const [, version] = await lookup("std", module.latest_version);
  assert(version);
  const ancestor = objectGetKey(version);
  assert(ancestor);
  datastore = datastore ?? await getDatastore();
  let query = datastore
    .createQuery("module_entry")
    .hasAncestor(ancestor);
  const subModules: ModuleEntry[] = [];
  for await (const entity of datastore.streamQuery(query)) {
    const moduleEntry = entityToObject<ModuleEntry>(entity);
    if (moduleEntry.type === "dir" && moduleEntry.path.lastIndexOf("/") === 0) {
      subModules.push(moduleEntry);
    }
  }
  const defaultModules = subModules
    .flatMap(({ default: def }) => def ? [def] : []);
  const modDoc = new Map<string, string>();
  query = datastore
    .createQuery("doc_node")
    .filter("kind", "moduleDoc")
    .hasAncestor(ancestor);
  for await (const entity of datastore.streamQuery(query)) {
    assert(entity.key);
    // this ensure we only find moduleDoc for the module, not from a re-exported
    // namespace which might have module doc as well.
    if (entity.key.path.length !== 4) {
      continue;
    }
    const modName = entity.key.path[2]?.name;
    assert(modName);
    if (defaultModules.includes(modName)) {
      const docNode = entityToObject<DocNode>(entity);
      const doc = docNode.jsDoc?.doc;
      if (doc) {
        modDoc.set(modName, doc.split("\n\n")[0]);
      }
    }
  }
  let count = 0;
  for (const subModule of subModules) {
    const name = `std${subModule.path}`;
    const description = subModule.default
      ? modDoc.get(subModule.default)
      : undefined;
    count++;
    requests.push({
      action: "updateObject",
      indexName: MODULES_INDEX,
      body: {
        objectID: name,
        name,
        description,
        third_party: false,
        source: Source.StandardLibraryDefault,
        popularity_score: 0,
        popularity_tag: undefined,
      },
    });
  }
  dax.logLight(`  added ${count} std submodules.`);
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
  await appendStdSubModules(requests);
  dax.logStep(`Uploading ${requests.length} modules to algolia...`);
  await upload(requests);
  dax.logStep(`Success.`);
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
  const index = denoLandApp.initIndex(SYMBOL_INDEX);
  await index.deleteBy({ filters: `sourceId:${module}` }).wait();
}

/** Upload batch requests to Algolia. */
export async function upload(
  requests: MultipleBatchRequest[],
): Promise<unknown> {
  try {
    return await getDenoLandApp().multipleBatch(requests).wait();
  } catch (err) {
    if (err instanceof Error) {
      dax.logError(err.message);
    } else {
      throw err;
    }
  }
}

/** Get all modules from Datastore. */
async function getAllModules() {
  datastore = datastore ?? await getDatastore();
  const query = datastore.createQuery("module");
  return datastore.query<Module>(query);
}

async function loadLatest(cache: string) {
  dax.logStep(`Loading cache "${cache}"...`);
  const uploadCache: string[] = JSON.parse(await Deno.readTextFile(cache));
  dax.logStep("Loading all modules...");
  const modules = (await getAllModules())
    .filter(({ latest_version }) => !!latest_version);
  dax.logLight(`  loaded ${modules.length} modules.`);
  for (const moduleItem of modules) {
    if (uploadCache.includes(moduleItem.name)) {
      dax.logWarn(`Skipping ${moduleItem.name}.`);
      continue;
    }
    const [, moduleVersion] = await lookup(
      moduleItem.name,
      moduleItem.latest_version!,
    );
    if (moduleVersion) {
      dax.logStep(
        `Uploading ${moduleItem.name}@${moduleItem.latest_version}...`,
      );
      const requests: MultipleBatchRequest[] = [];
      await loadDocNodes(requests, moduleItem, moduleVersion);
      dax.logLight(`  ${requests.length} search records to upload.`);
      await upload(requests);
      dax.logStep(`Completed ${moduleItem.name}@${moduleItem.latest_version}.`);
    }
    uploadCache.push(moduleItem.name);
    await Deno.writeTextFile(
      cache,
      JSON.stringify(uploadCache, undefined, "  "),
    );
  }
}

function main() {
  const args = parse(Deno.args, {
    boolean: [
      "update-modules",
      "update-library",
    ],
    string: ["load-latest"],
  });
  if (args["update-modules"]) {
    return updateModules();
  }
  if (args["update-library"]) {
    return updateLibrary();
  }
  if (args["load-latest"]) {
    return loadLatest(args["load-latest"]);
  }
  const module = args["_"][0] as string;
  if (module) {
    return loadModuleDocNodes(module);
  }
}

if (import.meta.main) {
  await main();
}
