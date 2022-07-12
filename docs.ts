// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { doc, type LoadResponse } from "deno_doc";
import type {
  DocNode as DenoDocNode,
  DocNodeInterface,
  DocNodeKind,
  DocNodeModuleDoc,
  DocNodeNamespace,
  JsDoc,
} from "deno_doc/types";
export type {
  DocNode,
  DocNodeModuleDoc,
  DocNodeNamespace,
  JsDoc,
} from "deno_doc/types";
import {
  Datastore,
  DatastoreError,
  entityToObject,
  type KeyInit,
  objectGetKey,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import { type Query } from "google_datastore/query";
import type {
  Entity,
  Key,
  Mutation,
  PartitionId,
  PathElement,
} from "google_datastore/types";
import * as JSONC from "jsonc-parser";
import { errors } from "oak_commons/http_errors.ts";

import { loadModule } from "./modules.ts";
import { enqueue } from "./process.ts";
import { getDatastore } from "./store.ts";
import { Module, ModuleEntry, ModuleVersion } from "./types.d.ts";
import { assert } from "./util.ts";

/** Used only in APIland to represent a module without any exported symbols in
 * the datastore.
 */
export interface DocNodeNull {
  kind: "null";
}

export interface LegacyIndex {
  name: string;
  description: string;
  version: string;
  star_count?: number;
  uploaded_at: string;
  upload_options: {
    type: string;
    repository: string;
    ref: string;
  };
  files: ModuleEntry[];
}

export interface ModuleIndex {
  index: Record<string, string[]>;
  docs: Record<string, JsDoc>;
}

interface SymbolIndexItem {
  path: string;
  items: SymbolItem[];
}

interface SymbolItem {
  name: string;
  kind: DocNodeKind;
  jsDoc?: JsDoc;
}

type NullableSymbolItem = SymbolItem | { kind: "null" };

export interface SymbolIndex {
  items: SymbolIndexItem[];
}

type DocNode = DenoDocNode | DocNodeNull;

interface ConfigFileJson {
  importMap?: string;
}

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
      const response = await fetch(url, { redirect: "follow" });
      if (response.status !== 200) {
        cachedResources.set(specifier, undefined);
        cachedSpecifiers.add(specifier);
        await response.arrayBuffer();
        return undefined;
      }
      const content = await response.text();
      const headers: Record<string, string> = {};
      for (const [key, value] of response.headers) {
        headers[key.toLowerCase()] = value;
      }
      const loadResponse: LoadResponse = {
        kind: "module",
        specifier: response.url,
        headers,
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

const CONFIG_FILES = ["deno.jsonc", "deno.json"] as const;

/** Given a module and version, attempt to resolve an import map specifier from
 * a Deno configuration file. If none can be resolved, `undefined` is
 * resolved. */
export async function getImportMapSpecifier(
  module: string,
  version: string,
): Promise<string | undefined> {
  let result;
  for (const configFile of CONFIG_FILES) {
    result = await load(
      `https://deno.land/x/${module}@${version}/${configFile}`,
    );
    if (result) {
      break;
    }
  }
  if (result?.kind === "module") {
    const { specifier, content } = result;
    const configFileJson: ConfigFileJson = JSONC.parse(content);
    if (configFileJson.importMap) {
      return new URL(configFileJson.importMap, specifier).toString();
    }
    return undefined;
  }
}

export async function generateDocNodes(
  module: string,
  version: string,
  path: string,
  importMap?: string,
): Promise<DenoDocNode[]> {
  const url = `https://deno.land/x/${module}@${version}/${path}`;
  try {
    return mergeEntries(await doc(url, { load, importMap }));
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

async function appendQuery(
  datastore: Datastore,
  results: Record<string, string[]>,
  query: Query,
  path: string,
): Promise<boolean> {
  let any = false;
  for await (const entity of datastore.streamQuery(query)) {
    any = true;
    const obj: ModuleEntry = entityToObject(entity);
    if (obj.path.startsWith(path) && obj.index) {
      results[obj.path] = obj.index;
    }
  }
  return any;
}

export async function checkMaybeLoad(
  datastore: Datastore,
  module: string,
  version: string,
  path?: string,
): Promise<boolean> {
  const moduleVersionKey = datastore.key(
    ["module", module],
    ["module_version", version],
  );
  const result = await datastore.lookup(moduleVersionKey);
  const moduleVersionExists = !!result.found;
  if (!moduleVersionExists) {
    try {
      const [mutations] = await loadModule(module, version);
      if (mutations.length <= 1) {
        return false;
      }
      console.log(
        `  adding ${module}@${version}. Committing ${mutations.length} changes...`,
      );
      for await (
        const batch of datastore.commit(mutations, { transactional: false })
      ) {
        console.log(`  committed ${batch.mutationResults.length} changes.`);
      }
    } catch {
      return false;
    }
  }
  if (path) {
    const pathKey = datastore.key(
      ["module", module],
      ["module_version", version],
      ["module_entry", `/${path}`],
    );
    const result = await datastore.lookup(pathKey);
    return !!result.found;
  } else {
    return true;
  }
}

export async function generateLegacyIndex(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
): Promise<LegacyIndex | undefined> {
  const moduleKey = datastore.key(["module", module]);
  const moduleVersionKey = datastore.key(
    ["module", module],
    ["module_version", version],
  );
  const moduleResult = await datastore.lookup([moduleKey, moduleVersionKey]);
  let moduleItem: Module | undefined;
  let moduleVersion: ModuleVersion | undefined;
  if (!(moduleResult.found && moduleResult.found.length == 2)) {
    let mutations: Mutation[];
    [mutations, moduleItem, moduleVersion] = await loadModule(module, version);
    enqueue({ kind: "commitMutations", mutations });
  } else {
    const [
      { entity: moduleEntity },
      { entity: moduleVersionEntity },
    ] = moduleResult.found;
    moduleItem = entityToObject(moduleEntity);
    moduleVersion = entityToObject(moduleVersionEntity);
  }
  if (moduleItem && moduleVersion) {
    const query = datastore
      .createQuery("module_entry")
      .hasAncestor(moduleVersionKey);
    const files: ModuleEntry[] = [];
    for await (const entity of datastore.streamQuery(query)) {
      const moduleEntry = entityToObject<ModuleEntry>(entity);
      if (
        moduleEntry.path.startsWith(path) &&
        moduleEntry.path.slice(path.length).lastIndexOf("/") <= 0
      ) {
        files.push(moduleEntry);
      }
    }
    if (files.length) {
      const index: LegacyIndex = {
        name: moduleItem.name,
        description: moduleItem.description,
        version: moduleVersion.version,
        star_count: moduleItem.star_count,
        uploaded_at: moduleVersion.uploaded_at.toISOString(),
        upload_options: moduleVersion.upload_options,
        files,
      };
      return index;
    }
  }
}

export async function generateModuleIndex(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
): Promise<ModuleIndex | undefined> {
  const moduleKey = datastore.key(
    ["module", module],
    ["module_version", version],
  );
  const query = datastore
    .createQuery("module_entry")
    .filter("type", "dir")
    .hasAncestor(moduleKey);
  const results: Record<string, string[]> = {};
  const any = await appendQuery(datastore, results, query, path);
  if (!any) {
    if (await checkMaybeLoad(datastore, module, version)) {
      await appendQuery(datastore, results, query, path);
    }
  }
  if (Object.keys(results).length) {
    const docNodeQuery = datastore
      .createQuery("doc_node")
      .filter("kind", "moduleDoc")
      .hasAncestor(moduleKey);
    const docs: Record<string, JsDoc> = {};
    for await (const entity of datastore.streamQuery(docNodeQuery)) {
      assert(entity.key);
      // this ensure we only find moduleDoc for the module, not from a re-exported
      // namespace which might have module doc as well.
      if (entity.key.path.length !== 4) {
        continue;
      }
      const key = entity.key.path[2]?.name;
      assert(key);
      if (key.startsWith(path)) {
        const obj: DocNodeModuleDoc = entityToObject(entity);
        docs[key] = obj.jsDoc;
      }
    }
    return { index: results, docs };
  }
}

function entitiesToSymbolItems(
  ancestor: Key,
  entities: Entity[],
): SymbolItem[] {
  const results: SymbolItem[] = [];
  for (const entity of entities) {
    const item = entityToObject<NullableSymbolItem>(entity);
    if (item.kind === "null") {
      continue;
    }
    assert(entity.key);
    if (!descendentNotChild(ancestor, entity.key)) {
      const { name, kind, jsDoc } = item;
      results.push({ name, kind, jsDoc });
    }
  }
  return results;
}

function docNodesToSymbolItems(
  ancestor: Key,
  docNodes: DenoDocNode[],
): SymbolItem[] {
  const results: SymbolItem[] = [];
  for (const docNode of docNodes) {
    const key = objectGetKey(docNode);
    assert(key);
    if (!descendentNotChild(ancestor, key)) {
      results.push({
        name: docNode.name,
        kind: docNode.kind,
        jsDoc: docNode.jsDoc,
      });
    }
  }
  return results;
}

export async function generateSymbolIndex(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
): Promise<SymbolIndex | undefined> {
  const moduleKey = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_entry", path],
  );
  let result = await datastore.lookup(moduleKey);
  if (!result.found) {
    if (!await checkMaybeLoad(datastore, module, version, path)) {
      return undefined;
    }
    result = await datastore.lookup(moduleKey);
    if (!result.found) {
      return undefined;
    }
  }
  if (result.found.length !== 1) {
    throw new errors.InternalServerError(
      "Unexpected length of results when looking up module entry.",
    );
  }
  const entry = entityToObject<ModuleEntry>(result.found[0].entity);
  if (!entry.index) {
    return;
  }
  const missing: string[] = [];
  const items: SymbolIndexItem[] = [];
  for (const path of entry.index) {
    const ancestor = datastore.key(
      ["module", module],
      ["module_version", version],
      ["module_entry", path],
    );
    const query = datastore
      .createQuery("doc_node")
      .hasAncestor(ancestor);
    const entities: Entity[] = [];
    try {
      for await (const entity of datastore.streamQuery(query)) {
        entities.push(entity);
      }
    } catch (e) {
      if (e instanceof DatastoreError) {
        console.log(JSON.stringify(e.statusInfo, undefined, "  "));
      }
      throw e;
    }
    if (entities.length) {
      items.push({ path, items: entitiesToSymbolItems(ancestor, entities) });
    } else {
      missing.push(path);
    }
  }
  if (missing.length) {
    const importMap = await getImportMapSpecifier(module, version);
    for (const path of missing) {
      try {
        const docNodes = await generateDocNodes(
          module,
          version,
          path,
          importMap,
        );
        // Upload docNodes to algolia.
        if (docNodes.length) {
          enqueue({ kind: "algolia", module, version, path, docNodes });
        }
        // if a module doesn't generate any doc nodes, we need to commit a null
        // node to the datastore, see we don't continue to try to generate doc
        // nodes for a module that doesn't export anything.
        enqueue({
          kind: "commit",
          module,
          version,
          path,
          docNodes: docNodes.length ? docNodes : [{ kind: "null" }],
        });
        const ancestor = datastore.key(
          ["module", module],
          ["module_version", version],
          ["module_entry", path],
        );
        items.push({ path, items: docNodesToSymbolItems(ancestor, docNodes) });
      } catch {
        // just swallow errors here
      }
    }
  }
  if (items.length) {
    console.log("has items");
    return { items };
  } else {
    console.log("no items");
    return undefined;
  }
}

/** Namespaces and interfaces are open ended. This function will merge these
 * together, so that you have single entries per symbol. */
function mergeEntries(entries: DenoDocNode[]): DenoDocNode[] {
  const merged: DenoDocNode[] = [];
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
      case "moduleDoc":
      case "null":
        node = docNode;
        break;
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
  id: number,
  module: string,
  version: string,
  path: string,
  docNodes: DocNode[],
) {
  const mutations: Mutation[] = [];
  const keyInit = [
    ["module", module],
    ["module_version", version],
    ["module_entry", `/${path}`],
  ] as KeyInit[];
  const datastore = await getDatastore();
  addNodes(datastore, mutations, docNodes, keyInit);
  try {
    for await (
      const _result of datastore.commit(mutations, { transactional: false })
    ) {
      console.log(
        `[${id}]: %cCommitted %cbatch for %c${module}@${version}/${path}%c.`,
        "color:green",
        "color:none",
        "color:yellow",
        "color:none",
      );
    }
  } catch (error) {
    if (error instanceof DatastoreError) {
      console.log(`[${id}] Datastore Error:`);
      console.log(`${error.status} ${error.message}`);
      console.log(error.statusInfo);
    } else {
      console.log("Unexpected Error:");
      console.log(error);
    }
    return;
  }
}

export async function commitModuleIndex(
  id: number,
  module: string,
  version: string,
  path: string,
  index: ModuleIndex,
) {
  const datastore = await getDatastore();
  const key = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_index", path],
  );
  objectSetKey(index, key);
  const mutations = [{ upsert: objectToEntity(index) }];
  try {
    for await (
      const _result of datastore.commit(mutations, { transactional: false })
    ) {
      console.log(
        `[${id}]: %cCommitted %cbatch for %c${module}@${version}/${path}%c.`,
        "color:green",
        "color:none",
        "color:yellow",
        "color:none",
      );
    }
  } catch (error) {
    if (error instanceof DatastoreError) {
      console.log(`[${id}] Datastore Error:`);
      console.log(`${error.status} ${error.message}`);
      console.log(error.statusInfo);
    } else {
      console.log("Unexpected Error:");
      console.log(error);
    }
    return;
  }
}

export async function commitSymbolIndex(
  id: number,
  module: string,
  version: string,
  path: string,
  index: SymbolIndex,
) {
  const datastore = await getDatastore();
  const key = datastore.key(
    ["module", module],
    ["module_version", version],
    ["symbol_index", path],
  );
  objectSetKey(index, key);
  const mutations = [{ upsert: objectToEntity(index) }];
  try {
    for await (
      const _result of datastore.commit(mutations, { transactional: false })
    ) {
      console.log(
        `[${id}]: %cCommitted %cbatch for %c${module}@${version}/${path}%c.`,
        "color:green",
        "color:none",
        "color:yellow",
        "color:none",
      );
    }
  } catch (error) {
    if (error instanceof DatastoreError) {
      console.log(`[${id}] Datastore Error:`);
      console.log(`${error.status} ${error.message}`);
      console.log(error.statusInfo);
    } else {
      console.log("Unexpected Error:");
      console.log(error);
    }
    return;
  }
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

/** Determines if a file path can be doc'ed or not. */
export function isDocable(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(path);
}

function isDocNodeNull(node: DocNode): node is DocNodeNull {
  return node.kind === "null";
}

export function entitiesToDocNodes(
  ancestor: Key,
  entities: Entity[],
): DenoDocNode[] {
  const results: DenoDocNode[] = [];
  const namespaceElements = new KeyMap<DenoDocNode[]>();
  const namespaces = new KeyMap<DocNodeNamespace>();
  for (const entity of entities) {
    const docNode: DocNode = entityToObject(entity);
    if (isDocNodeNull(docNode)) {
      continue;
    }
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
        if (typeof docNode.classDef === "string") {
          docNode.classDef = JSON.parse(docNode.classDef);
        }
        break;
      case "enum":
        if (typeof docNode.enumDef === "string") {
          docNode.enumDef = JSON.parse(docNode.enumDef);
        }
        break;
      case "function":
        if (typeof docNode.functionDef === "string") {
          docNode.functionDef = JSON.parse(
            docNode.functionDef as unknown as string,
          );
        }
        break;
      case "import":
        if (typeof docNode.importDef === "string") {
          docNode.importDef = JSON.parse(
            docNode.importDef as unknown as string,
          );
        }
        break;
      case "interface":
        if (typeof docNode.interfaceDef === "string") {
          docNode.interfaceDef = JSON.parse(
            docNode.interfaceDef as unknown as string,
          );
        }
        break;
      case "typeAlias":
        if (typeof docNode.typeAliasDef === "string") {
          docNode.typeAliasDef = JSON.parse(
            docNode.typeAliasDef as unknown as string,
          );
        }
        break;
      case "variable":
        if (typeof docNode.variableDef === "string") {
          docNode.variableDef = JSON.parse(
            docNode.variableDef as unknown as string,
          );
        }
    }
  }
  for (const [key, namespace] of namespaces) {
    namespace.namespaceDef = { elements: namespaceElements.get(key) ?? [] };
  }
  return results;
}

export async function getDocNodes(
  module: string,
  version: string,
  entry: string,
): Promise<[entry: string, nodes: DenoDocNode[]] | undefined> {
  const datastore = await getDatastore();
  const ancestor = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_entry", entry],
  );
  const query = datastore
    .createQuery("doc_node")
    .hasAncestor(ancestor);
  const entities: Entity[] = [];
  for await (const entity of datastore.streamQuery(query)) {
    entities.push(entity);
  }
  if (entities.length) {
    return [entry, entitiesToDocNodes(ancestor, entities)];
  } else {
    try {
      const importMap = await getImportMapSpecifier(module, version);
      const response = await datastore.lookup(ancestor);
      if (response.found && response.found.length) {
        const path = entry.slice(1);
        const docNodes = await generateDocNodes(
          module,
          version,
          path,
          importMap,
        );
        // Upload docNodes to algolia.
        if (docNodes.length) {
          enqueue({ kind: "algolia", module, version, path, docNodes });
        }
        // if a module doesn't generate any doc nodes, we need to commit a null
        // node to the datastore, see we don't continue to try to generate doc
        // nodes for a module that doesn't export anything.
        enqueue({
          kind: "commit",
          module,
          version,
          path,
          docNodes: docNodes.length ? docNodes : [{ kind: "null" }],
        });
        return [entry, docNodes];
      }
    } catch {
      // just swallow errors here
    }
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
  const entities: Entity[] = [];
  for await (const entity of datastore.streamQuery(query)) {
    entities.push(entity);
  }
  return entitiesToDocNodes(ancestor, entities);
}
