// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Utilities for uploading and managing algolia indexes.
 *
 * @module
 */

import { type MultipleBatchRequest } from "@algolia/client-search";
import { createFetchRequester } from "@algolia/requester-fetch";
import algoliasearch, { SearchClient } from "algoliasearch";
import dax from "dax";
import { JsDocTagTags } from "deno_doc/types";
import { type Datastore, objectGetKey } from "google_datastore";
import { type Entity } from "google_datastore/types";

import { algoliaKeys, getDatastore, readyPromise } from "./auth.ts";
import { indexes } from "./consts.ts";
import { DocNodeKind, entitiesToDocNodes, getModuleEntries } from "./docs.ts";
import type { DocNode, Module, ModuleEntry, ModuleVersion } from "./types.d.ts";

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

export enum Source {
  Library = 100,
  StandardLibraryDefault = 200,
  StandardLibraryOther = 220,
  DenoOfficialDefault = 300,
  ThirdPartyDefault = 400,
  DenoOfficialOther = 530,
  ThirdPartyOther = 540,
}

function filteredDocNode(
  namespace: string | undefined,
  docNode: DocNode,
): boolean {
  return (ALLOWED_DOC_KINDS.includes(docNode.kind) ||
    (!namespace && docNode.kind === "moduleDoc")) && !isDeprecated(docNode);
}

function docNodeToRequest(
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
  const tags = docNode.jsDoc?.tags
    ?.find((tag): tag is JsDocTagTags => tag.kind === "tags")?.tags;
  return {
    action: "updateObject",
    indexName: indexes.SYMBOL_INDEX,
    body: {
      objectID,
      name,
      source,
      sourceId,
      popularity_score,
      version,
      path,
      doc: docNode.jsDoc?.doc,
      tags,
      kind: docNode.kind,
      location: docNode.location,
    },
  };
}

function isDeprecated(docNode: DocNode): boolean {
  return docNode.jsDoc?.tags?.some(({ kind }) => kind === "deprecated") ??
    false;
}

export function appendDocNodes(
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
        docNodeToRequest(
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

export function moduleToRequest(module: Module): MultipleBatchRequest {
  return {
    action: "updateObject",
    indexName: indexes.MODULE_INDEX,
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

async function getDenoLandApp(): Promise<SearchClient> {
  if (denoLandApp) {
    return denoLandApp;
  }
  const requester = createFetchRequester();
  await readyPromise;
  return denoLandApp = algoliasearch(
    algoliaKeys.appId,
    algoliaKeys.apiKey,
    { requester },
  );
}

export async function clearDocNodes(module: string): Promise<void> {
  const denoLandApp = await getDenoLandApp();
  const index = denoLandApp.initIndex(indexes.SYMBOL_INDEX);
  await index.deleteBy({ filters: `sourceId:${module}` }).wait();
}

/** Upload batch requests to Algolia. */
export async function upload(
  requests: MultipleBatchRequest[],
): Promise<unknown> {
  try {
    const denoLandApp = await getDenoLandApp();
    return await denoLandApp.multipleBatch(requests).wait();
  } catch (err) {
    if (err instanceof Error) {
      dax.logError(err.message);
    } else {
      throw err;
    }
  }
}
