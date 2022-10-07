// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Utility functions to generate documentation pages.
 *
 * @module
 */

import type { JsDocTagDoc } from "deno_doc/types";
import {
  type Datastore,
  DatastoreError,
  entityToObject,
  type KeyInit,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type {
  Entity,
  Key,
  Mutation,
  PathElement,
} from "google_datastore/types";

import { getDatastore } from "./auth.ts";
import { cacheLibDocPage, cacheSymbolItems, lookupLib } from "./cache.ts";
import { ROOT_SYMBOL } from "./consts.ts";
import {
  dehydrateDocNodes,
  entitiesToDocNodes,
  getNamespaceKeyInit,
  isKeyEqual,
  isNamespace,
} from "./docs.ts";
import { enqueue } from "./process.ts";
import type {
  DocNode,
  DocPageLibrary,
  DocPageLibrarySymbol,
  LibDocPage,
  SymbolItem,
} from "./types.d.ts";
import { assert } from "./util.ts";

let datastore: Datastore | undefined;

function getAncestorId(path: PathElement[]): string | undefined {
  const ancestorPath = path.flatMap(({ kind, id }) =>
    kind === "doc_node" ? [id!] : []
  );
  ancestorPath.pop();
  return ancestorPath.length ? ancestorPath.join(".") : undefined;
}

function getCategory(node: DocNode): string | undefined {
  return node.jsDoc?.tags
    ?.find((tag): tag is JsDocTagDoc => tag.kind === "category")?.doc;
}

function getId(path: PathElement[]): string {
  return path
    .flatMap(({ kind, id }) => kind === "doc_node" ? [id!] : []).join(".");
}

function isUnstable(node: DocNode): boolean {
  return !!node.jsDoc?.tags?.some((tag) =>
    tag.kind === "tags" && tag.tags.includes("unstable")
  );
}

function entitiesToSymbolItems(entities: Entity[]): SymbolItem[] {
  const collection = new Map<string, SymbolItem>();
  const namespaces = new Map<string, string>();
  for (const entity of entities) {
    const docNode = entityToObject<DocNode>(entity);
    assert(entity.key);
    const ancestorId = getAncestorId(entity.key.path);
    const id = getId(entity.key.path);
    const name = ancestorId
      ? `${namespaces.get(ancestorId)}.${docNode.name}`
      : docNode.name;
    if (docNode.kind === "namespace") {
      namespaces.set(id, name);
    }
    const itemId = `${name}_${docNode.kind}`;
    const category = getCategory(docNode);
    const { kind, jsDoc } = docNode;
    if (!collection.has(itemId)) {
      collection.set(itemId, { name, kind, jsDoc, category });
    } else {
      const item = collection.get(itemId)!;
      if (isUnstable(docNode) || (!item.jsDoc && jsDoc)) {
        item.jsDoc = jsDoc;
      }
      if (category) {
        item.category = category;
      }
    }
  }
  return [...collection.values()];
}

async function createSymbolItems(
  mutations: Mutation[],
  lib: string,
  version: string,
) {
  datastore = datastore ?? await getDatastore();
  const ancestor = datastore.key(
    ["library", lib],
    ["library_version", version],
  );
  const query = datastore
    .createQuery("doc_node")
    .hasAncestor(ancestor);
  const entities: Entity[] = [];
  try {
    for await (const entity of datastore.streamQuery(query)) {
      entities.push(entity);
    }
  } catch (err) {
    if (err instanceof DatastoreError) {
      console.error(
        `Datastore Error: ${err.status} ${err.message}\n\n${
          JSON.stringify(err.statusInfo, undefined, "  ")
        }`,
      );
    }
    throw err;
  }
  const items = entitiesToSymbolItems(entities);
  const symbolItems = { items };
  objectSetKey(
    symbolItems,
    datastore.key(
      ["library", lib],
      ["symbol_items", version],
    ),
  );
  mutations.push({ upsert: objectToEntity(symbolItems) });
  cacheSymbolItems(lib, version, symbolItems);
  return items;
}

async function queryLibDocNodesBySymbol(
  lib: string,
  version: string,
  symbol: string,
): Promise<DocNode[]> {
  const keyInit: KeyInit[] = [
    ["library", lib],
    ["library_version", version],
  ];
  let name = symbol;
  datastore = datastore ?? await getDatastore();
  if (symbol.includes(".")) {
    const parts = symbol.split(".");
    name = parts.pop()!;
    while (parts.length) {
      const namespace = parts.shift();
      if (!namespace) {
        return [];
      }
      const namespaceKeyInit = await getNamespaceKeyInit(
        datastore,
        keyInit,
        namespace,
      );
      if (!namespaceKeyInit) {
        return [];
      }
      keyInit.push(namespaceKeyInit);
    }
  }
  const ancestor = datastore.key(...keyInit);
  const query = datastore
    .createQuery("doc_node")
    .hasAncestor(ancestor)
    .filter("name", name);
  const entities: Entity[] = [];
  const namespaceKeys: Key[] = [];
  for await (const entity of datastore.streamQuery(query)) {
    entities.push(entity);
    if (isNamespace(entity)) {
      assert(entity.key);
      namespaceKeys.push(entity.key);
    }
  }
  if (namespaceKeys.length) {
    for (const key of namespaceKeys) {
      const query = datastore
        .createQuery("doc_node")
        .hasAncestor(key);
      for await (const entity of datastore.streamQuery(query)) {
        assert(entity.key);
        if (!isKeyEqual(key, entity.key)) {
          entities.push(entity);
        }
      }
    }
  }
  return entitiesToDocNodes(ancestor, entities);
}

function docPageToEntity(
  docPage: DocPageLibrary | DocPageLibrarySymbol,
  key: Key,
): Entity {
  const obj = { ...docPage };
  if ("docNodes" in obj && obj.docNodes) {
    obj.docNodes = dehydrateDocNodes(obj.docNodes);
  }
  objectSetKey(obj, key);
  return objectToEntity(obj);
}

/** Generate a library documentation page. */
export async function generateLibDocPage(
  lib: string,
  version: string,
  symbol: string,
): Promise<LibDocPage | undefined> {
  const [libItem, versionItem, symbolItems] = await lookupLib(lib, version);
  if (!libItem) {
    // will result in a 404 not found
    return undefined;
  }
  if (!versionItem) {
    return {
      kind: "libraryInvalidVersion",
      name: libItem.name,
      versions: libItem.versions,
      latest_version: libItem.latest_version,
    };
  }
  const mutations: Mutation[] = [];
  const items = symbolItems
    ? symbolItems.items
    : await createSymbolItems(mutations, libItem.name, versionItem.version);
  datastore = datastore ?? await getDatastore();
  const docPageKey = datastore.key(
    ["library", libItem.name],
    ["library_version", versionItem.version],
    ["doc_page", symbol],
  );
  const docPage = {
    kind: symbol !== ROOT_SYMBOL ? "librarySymbol" : "library",
    name: libItem.name,
    version: versionItem.version,
    versions: libItem.versions,
    latest_version: libItem.latest_version,
    items,
    docNodes: symbol !== ROOT_SYMBOL
      ? await queryLibDocNodesBySymbol(
        libItem.name,
        versionItem.version,
        symbol,
      )
      : undefined,
  } as DocPageLibrary | DocPageLibrarySymbol;
  if (docPage.kind === "librarySymbol") {
    docPage.name = symbol;
  }
  cacheLibDocPage(libItem.name, versionItem.version, symbol, docPage);
  mutations.push({ upsert: docPageToEntity(docPage, docPageKey) });
  enqueue({ kind: "commitMutations", mutations });
  return docPage;
}
