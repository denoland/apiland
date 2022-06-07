import { doc, type LoadResponse } from "deno_doc";
import type {
  DocNode,
  DocNodeInterface,
  DocNodeNamespace,
} from "deno_doc/types";
export type { DocNode, DocNodeNamespace } from "deno_doc/types";
import {
  type Datastore,
  DatastoreError,
  entityToObject,
  type KeyInit,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type {
  Key,
  Mutation,
  PartitionId,
  PathElement,
} from "google_datastore/types";
import { errors } from "oak_commons/http_errors.ts";

import { assert } from "./util.ts";

const MAX_CACHE_SIZE = parseInt(Deno.env.get("MAX_CACHE_SIZE") ?? "", 10) ||
  25_000_000;

const cachedSpecifiers = new Set<string>();
const cachedResources = new Map<string, LoadResponse | undefined>();
let cacheCheckQueued = false;
let cacheSize = 0;

async function load(specifier: string): Promise<LoadResponse | undefined> {
  if (cachedResources.has(specifier)) {
    cachedSpecifiers.delete(specifier);
    cachedSpecifiers.add(specifier);
    return cachedResources.get(specifier);
  }
  try {
    const url = new URL(specifier);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const response = await fetch(specifier, { redirect: "follow" });
      if (response.status !== 200) {
        cachedResources.set(specifier, undefined);
        cachedSpecifiers.add(specifier);
        await response.arrayBuffer();
        return undefined;
      }
      const content = await response.text();
      const loadResponse: LoadResponse = {
        kind: "module",
        specifier: response.url,
        headers: { ...response.headers },
        content,
      };
      cachedResources.set(specifier, loadResponse);
      cachedSpecifiers.add(specifier);
      cacheSize += content.length;
      enqueueCheck();
      return loadResponse;
    }
  } catch {
    cachedResources.set(specifier, undefined);
    cachedSpecifiers.add(specifier);
  }
}

function checkCache() {
  if (cacheSize > MAX_CACHE_SIZE) {
    const toEvict: string[] = [];
    for (const specifier of cachedSpecifiers) {
      const loadResponse = cachedResources.get(specifier);
      toEvict.push(specifier);
      if (loadResponse && loadResponse.kind === "module") {
        cacheSize -= loadResponse.content.length;
        if (cacheSize <= MAX_CACHE_SIZE) {
          break;
        }
      }
    }
    console.log(
      `%cEvicting %c${toEvict.length}%c responses from cache.`,
      "color:green",
      "color:yellow",
      "color:none",
    );
    for (const evict of toEvict) {
      cachedResources.delete(evict);
      cachedSpecifiers.delete(evict);
    }
  }
  cacheCheckQueued = false;
}

function enqueueCheck() {
  if (!cacheCheckQueued) {
    cacheCheckQueued = true;
    queueMicrotask(checkCache);
  }
}

export async function generateDocNodes(
  module: string,
  version: string,
  path: string,
): Promise<DocNode[]> {
  const url = `https://deno.land/x/${module}@${version}/${path}`;
  try {
    const entries = mergeEntries(
      await doc(url, { load }),
    );
    return entries;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("Unable to load specifier")) {
        throw new errors.NotFound(`The module "${url}" cannot be found`);
      } else {
        throw new errors.BadRequest(`Bad request: ${error.message}`);
      }
    } else {
      throw new errors.InternalServerError("Unexpected object.");
    }
  }
}

/** Namespaces and interfaces are open ended. This function will merge these
 * together, so that you have single entries per symbol. */
function mergeEntries(entries: DocNode[]): DocNode[] {
  const merged: DocNode[] = [];
  const namespaces = new Map<string, DocNodeNamespace>();
  const interfaces = new Map<string, DocNodeInterface>();
  for (const node of entries) {
    if (node.kind === "namespace") {
      const namespace = namespaces.get(node.name);
      if (namespace) {
        namespace.namespaceDef.elements.push(...node.namespaceDef.elements);
        if (!namespace.jsDoc) {
          namespace.jsDoc = node.jsDoc;
        }
      } else {
        namespaces.set(node.name, node);
        merged.push(node);
      }
    } else if (node.kind === "interface") {
      const int = interfaces.get(node.name);
      if (int) {
        int.interfaceDef.callSignatures.push(
          ...node.interfaceDef.callSignatures,
        );
        int.interfaceDef.indexSignatures.push(
          ...node.interfaceDef.indexSignatures,
        );
        int.interfaceDef.methods.push(...node.interfaceDef.methods);
        int.interfaceDef.properties.push(...node.interfaceDef.properties);
        if (!int.jsDoc) {
          int.jsDoc = node.jsDoc;
        }
      } else {
        interfaces.set(node.name, node);
        merged.push(node);
      }
    } else {
      merged.push(node);
    }
  }
  return merged;
}

/** Recursively add doc nodes to the mutations, serializing the definition
 * fields and breaking out namespace entries as their own entities.
 *
 * The definition fields are serialized, because Datastore only supports 20
 * nested entities, which can occur in doc nodes with complex types.
 */
function addNodes(
  datastore: Datastore,
  mutations: Mutation[],
  docNodes: DocNode[],
  keyInit: KeyInit[],
) {
  let id = 1;
  for (const docNode of docNodes) {
    const paths: KeyInit[] = [...keyInit, ["doc_node", id++]];
    // deno-lint-ignore no-explicit-any
    let node: any;
    switch (docNode.kind) {
      case "namespace": {
        const { namespaceDef, ...namespaceNode } = docNode;
        objectSetKey(namespaceNode, datastore.key(...paths));
        mutations.push({ upsert: objectToEntity(namespaceNode) });
        addNodes(datastore, mutations, namespaceDef.elements, paths);
        continue;
      }
      case "class": {
        const { classDef, ...rest } = docNode;
        node = { classDef: JSON.stringify(classDef), ...rest };
        break;
      }
      case "enum": {
        const { enumDef, ...rest } = docNode;
        node = { enumDef: JSON.stringify(enumDef), ...rest };
        break;
      }
      case "function": {
        const { functionDef, ...rest } = docNode;
        node = { functionDef: JSON.stringify(functionDef), ...rest };
        break;
      }
      case "import": {
        const { importDef, ...rest } = docNode;
        node = { importDef: JSON.stringify(importDef), ...rest };
        break;
      }
      case "interface": {
        const { interfaceDef, ...rest } = docNode;
        node = { interfaceDef: JSON.stringify(interfaceDef), ...rest };
        break;
      }
      case "moduleDoc": {
        node = docNode;
        break;
      }
      case "typeAlias": {
        const { typeAliasDef, ...rest } = docNode;
        node = { typeAliasDef: JSON.stringify(typeAliasDef), ...rest };
        break;
      }
      case "variable": {
        const { variableDef, ...rest } = docNode;
        node = { variableDef: JSON.stringify(variableDef), ...rest };
        break;
      }
    }
    objectSetKey(node, datastore.key(...paths));
    mutations.push({ upsert: objectToEntity(node) });
  }
}

/** Given a set of doc nodes, commit them to the datastore. */
export async function commitDocNodes(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
  docNodes: DocNode[],
) {
  const mutations: Mutation[] = [];
  const keyInit = [["module", module], ["module_version", version], [
    "module_entry",
    `/${path}`,
  ]] as KeyInit[];
  addNodes(datastore, mutations, docNodes, keyInit);
  console.log(
    `  Committing ${mutations.length} doc nodes for ${module}@${version}/${path}...`,
  );
  try {
    for await (
      const _result of datastore.commit(mutations, { transactional: false })
    ) {
      console.log(`  Committed batch for ${module}@${version}/${path}.`);
    }
  } catch (error) {
    if (error instanceof DatastoreError) {
      console.log("Datastore Error:");
      console.log(`${error.status} ${error.message}`);
      console.log(error.statusInfo);
    } else {
      console.log("Unexpected Error:");
      console.log(error);
    }
    return;
  }
  console.log(`  Done.`);
}

function isPartitionIdEqual(
  a: PartitionId | undefined,
  b: PartitionId | undefined,
): boolean {
  if (!a || !b) {
    return true;
  }
  return a.namespaceId === b.namespaceId && a.projectId === b.projectId;
}

/** Determine if a datastore key is equal to another one. */
function isKeyEqual(a: Key, b: Key): boolean {
  if (isPartitionIdEqual(a.partitionId, b.partitionId)) {
    return isPathEqual(a.path, b.path);
  }
  return false;
}

/** Return's `true` if the {@linkcode Key}'s path is equal, otherwise `false`.*/
function isPathEqual(a: PathElement[], b: PathElement[]): boolean {
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      const aPathElement = a[i];
      const bPathElement = b[i];
      if (
        aPathElement.kind !== bPathElement.kind ||
        aPathElement.id !== bPathElement.id ||
        aPathElement.name !== bPathElement.name
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** If the `descendent` isn't a direct child of the `parent`, the
 * {@linkcode Key} of the parent is returned. If the `descendent` is a direct
 * child of the `parent`, `undefined` is returned. If the provided key is not
 * a descendent of the parent, the function throws. */
function descendentNotChild(parent: Key, descendent: Key): Key | undefined {
  if (!isPartitionIdEqual(parent.partitionId, descendent.partitionId)) {
    throw new TypeError("Keys are from different partitions.");
  }
  const { path: parentPath } = parent;
  const { path: descendentPath } = descendent;
  const descendentSlice = descendentPath.slice(0, parentPath.length);
  if (!isPathEqual(parentPath, descendentSlice)) {
    throw new TypeError(
      "The provided key is not a descendent of the parent key.",
    );
  }
  if (descendentPath.length === parentPath.length + 1) {
    return undefined;
  }
  return {
    partitionId: descendent.partitionId,
    path: descendentPath.slice(0, -1),
  };
}

/** An extension of {@linkcode Map} that handles comparison of
 * {@linkcode Key}s */
class KeyMap<V> extends Map<Key, V> {
  get(key: Key): V | undefined {
    for (const [k, v] of this) {
      if (isKeyEqual(key, k)) {
        return v;
      }
    }
  }

  has(key: Key): boolean {
    for (const k of this.keys()) {
      if (isKeyEqual(key, k)) {
        return true;
      }
    }
    return false;
  }
}

/** Query the datastore for doc nodes, deserializing the definitions and
 * recursively querying namespaces. */
export async function queryDocNodes(
  datastore: Datastore,
  ancestor: Key,
  kind?: string,
): Promise<DocNode[]> {
  const query = datastore.createQuery("doc_node").hasAncestor(ancestor);
  if (kind) {
    query.filter("kind", kind);
  }
  const results: DocNode[] = [];
  const namespaceElements = new KeyMap<DocNode[]>();
  const namespaces = new KeyMap<DocNodeNamespace>();
  for await (const entity of datastore.streamQuery(query)) {
    const docNode: DocNode = entityToObject(entity);
    assert(entity.key);
    if (!isKeyEqual(ancestor, entity.key)) {
      const parentKey = descendentNotChild(ancestor, entity.key);
      if (parentKey) {
        if (!namespaceElements.has(parentKey)) {
          namespaceElements.set(parentKey, []);
        }
        const elements = namespaceElements.get(parentKey)!;
        elements.push(docNode);
      } else {
        results.push(docNode);
      }
    }
    switch (docNode.kind) {
      case "namespace": {
        namespaces.set(entity.key, docNode);
        break;
      }
      case "class":
        docNode.classDef = JSON.parse(docNode.classDef as unknown as string);
        break;
      case "enum":
        docNode.enumDef = JSON.parse(docNode.enumDef as unknown as string);
        break;
      case "function":
        docNode.functionDef = JSON.parse(
          docNode.functionDef as unknown as string,
        );
        break;
      case "import":
        docNode.importDef = JSON.parse(docNode.importDef as unknown as string);
        break;
      case "interface":
        docNode.interfaceDef = JSON.parse(
          docNode.interfaceDef as unknown as string,
        );
        break;
      case "typeAlias":
        docNode.typeAliasDef = JSON.parse(
          docNode.typeAliasDef as unknown as string,
        );
        break;
      case "variable":
        docNode.variableDef = JSON.parse(
          docNode.variableDef as unknown as string,
        );
    }
  }
  for (const [key, namespace] of namespaces) {
    namespace.namespaceDef = { elements: namespaceElements.get(key) ?? [] };
  }
  return results;
}
