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
  DocNodeKind,
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

import { lookup } from "./cache.ts";
import {
  getIndexModule,
  loadModule,
  RE_IGNORED_MODULE,
  RE_PRIVATE_PATH,
} from "./modules.ts";
import { enqueue } from "./process.ts";
import { getDatastore } from "./store.ts";
import type {
  CodePage,
  CodePageDir,
  CodePageDirEntry,
  CodePageFile,
  DocPage,
  DocPageFile,
  DocPageIndex,
  DocPageModule,
  DocPageNavItem,
  DocPageSymbol,
  IndexItem,
  Module,
  ModuleEntry,
  ModuleVersion,
  PageBase,
  PageInvalidVersion,
  PagePathNotFound,
} from "./types.d.ts";
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

interface SymbolIndexDir {
  path: string;
  kind: "dir";
}

interface SymbolIndexModule {
  path: string;
  kind: "module";
  items: SymbolItem[];
}

type SymbolIndexItem = SymbolIndexDir | SymbolIndexModule;

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
export const ROOT_SYMBOL = "$$root$$";

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

function getPageBase<Kind extends DocPage["kind"] | CodePage["kind"]>(
  kind: Kind,
  { star_count, versions, latest_version, tags }: Module,
  { name: module, version, uploaded_at, upload_options, description }:
    ModuleVersion,
  path: string,
): PageBase & { kind: Kind } {
  return {
    kind,
    module,
    description,
    version,
    path,
    versions,
    latest_version,
    uploaded_at: uploaded_at.toISOString(),
    upload_options,
    star_count,
    tags,
  };
}

async function dbLookup<Value>(
  datastore: Datastore,
  key: Key,
): Promise<Value | undefined> {
  const result = await datastore.lookup(key);
  if (!result.found || result.found.length !== 1) {
    return undefined;
  }
  return entityToObject(result.found[0].entity);
}

export async function getNav(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
): Promise<DocPageNavItem[]> {
  const navKey = datastore.key(
    ["module", module],
    ["module_version", version],
    ["nav_index", path],
  );
  const navIndex: { nav: DocPageNavItem[] } | undefined = await dbLookup(
    datastore,
    navKey,
  );
  if (navIndex) {
    return navIndex.nav;
  }
  const entryKey = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_entry", path],
  );
  const entry: ModuleEntry | undefined = await dbLookup(datastore, entryKey);
  if (!entry || !entry.index || !entry.dirs) {
    throw new errors.InternalServerError(
      `Unable to lookup nav dir module entry: ${path}`,
    );
  }
  const missing: string[] = [];
  const nav: DocPageNavItem[] = [];
  for (const path of entry.dirs) {
    nav.push({ path, kind: "dir" });
  }
  for (const path of entry.index) {
    const ancestor = datastore.key(
      ["module", module],
      ["module_version", version],
      ["module_entry", path],
    );
    const query = datastore.createQuery("doc_node").hasAncestor(ancestor);
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
      nav.push({
        path,
        kind: "module",
        items: entitiesToSymbolItems(ancestor, entities),
      });
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
        nav.push({
          path,
          kind: "module",
          items: docNodesToSymbolItems(ancestor, docNodes),
        });
      } catch {
        // just swallow errors here
      }
    }
  }
  const indexModule = getIndexModule(
    nav.filter(({ kind }) => kind === "module").map(({ path }) => path),
  );
  if (indexModule) {
    for (const item of nav) {
      if (item.path === indexModule) {
        assert(item.kind === "module");
        item.default = true;
      }
    }
  }
  enqueue({ kind: "commitNav", module, version, path, nav });
  return nav;
}

function getPagePathNotFound(
  module: Module,
  version: ModuleVersion,
  path: string,
): PagePathNotFound {
  return getPageBase("notfound", module, version, path);
}

function getPageInvalidVersion(
  { name: module, description, versions, latest_version }: Module,
): PageInvalidVersion {
  return {
    kind: "invalid-version",
    module,
    description,
    versions,
    latest_version,
  };
}

function getCodePageFile(
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
): CodePageFile {
  const codePage = getPageBase(
    "file",
    module,
    version,
    entry.path,
  ) as CodePageFile;
  codePage.size = entry.size;
  codePage.docable = entry.docable;
  return codePage;
}

async function getCodePageDir(
  datastore: Datastore,
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
): Promise<CodePageDir> {
  const entryPath = entry.path;
  const codePage = getPageBase(
    "dir",
    module,
    version,
    entryPath,
  ) as CodePageDir;
  const query = datastore
    .createQuery("module_entry")
    .hasAncestor(datastore.key(
      ["module", module.name],
      ["module_version", version.version],
    ));
  const entries: CodePageDirEntry[] = [];
  for await (const entity of datastore.streamQuery(query)) {
    const {
      type: kind,
      size = 0,
      docable,
      path,
    } = entityToObject<ModuleEntry>(entity);
    const slice = entryPath !== "/" ? path.slice(entryPath.length) : path;
    if (path.startsWith(entryPath) && slice.lastIndexOf("/") === 0) {
      entries.push({ path, kind, size, docable });
    }
  }
  codePage.entries = entries;
  return codePage;
}

export async function generateCodePage(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
): Promise<CodePage | undefined> {
  let [
    moduleItem,
    moduleVersion,
    moduleEntry,
  ] = await lookup(module, version, path);
  if (!moduleItem && !moduleVersion) {
    let mutations: Mutation[];
    try {
      [
        mutations,
        moduleItem,
        moduleVersion,
        moduleEntry,
      ] = await loadModule(module, version, path);
      enqueue({ kind: "commitMutations", mutations });
    } catch {
      if (!moduleVersion) {
        assert(moduleItem);
        return getPageInvalidVersion(moduleItem);
      }
      return undefined;
    }
  } else if (!moduleEntry) {
    assert(moduleItem);
    assert(moduleVersion);
    return getPagePathNotFound(moduleItem, moduleVersion, path);
  }
  if (moduleItem && moduleVersion && moduleEntry) {
    return moduleEntry.type === "file"
      ? getCodePageFile(moduleItem, moduleVersion, moduleEntry)
      : getCodePageDir(datastore, moduleItem, moduleVersion, moduleEntry);
  }
}

function getDocPageFile(
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
): DocPageFile {
  return getPageBase("file", module, version, entry.path);
}

async function getDocPageModule(
  datastore: Datastore,
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
  entryKey: Key,
): Promise<DocPageModule> {
  const docPage = getPageBase(
    "module",
    module,
    version,
    entry.path,
  ) as DocPageModule;
  const dirPath = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
  docPage.nav = await getNav(datastore, version.name, version.version, dirPath);
  docPage.docNodes = await queryDocNodes(datastore, entryKey);
  return docPage;
}

async function getDocPageIndex(
  datastore: Datastore,
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
): Promise<DocPageIndex> {
  const docPage = getPageBase(
    "index",
    module,
    version,
    entry.path,
  ) as DocPageIndex;
  const items: IndexItem[] = docPage.items = [];
  const ancestor = datastore.key(
    ["module", version.name],
    ["module_version", version.version],
  );
  const query = datastore
    .createQuery("module_entry")
    .hasAncestor(ancestor);
  const path = entry.path;
  const docMap = new Map<string, IndexItem[]>();

  function maybeDoc(entry: ModuleEntry, item: IndexItem): IndexItem {
    if (item.kind === "module" && !item.ignored) {
      if (!docMap.has(item.path)) {
        docMap.set(item.path, []);
      }
      docMap.get(item.path)?.push(item);
    } else if (item.kind === "dir" && !item.ignored) {
      const indexModule = getIndexModule(entry.index);
      if (indexModule) {
        if (!docMap.has(indexModule)) {
          docMap.set(indexModule, []);
        }
        docMap.get(indexModule)?.push(item);
      }
    }
    return item;
  }

  for await (const entity of datastore.streamQuery(query)) {
    const entry = entityToObject<ModuleEntry>(entity);
    const slice = path === "/" ? entry.path : entry.path.slice(path.length);
    if (
      entry.path.startsWith(path) && entry.path !== path &&
      slice.lastIndexOf("/") === 0
    ) {
      if (entry.type === "file") {
        if (isDocable(entry.path)) {
          items.push(maybeDoc(entry, {
            kind: "module",
            path: entry.path,
            size: entry.size,
            ignored: RE_IGNORED_MODULE.test(slice),
          }));
        } else {
          items.push({
            kind: "file",
            path: entry.path,
            size: entry.size,
            ignored: true,
          });
        }
      } else {
        items.push(maybeDoc(entry, {
          kind: "dir",
          path: entry.path,
          size: entry.size,
          ignored: RE_PRIVATE_PATH.test(slice),
        }));
      }
    }
  }

  if (docMap.size) {
    const docNodes = await queryDocNodes(
      datastore,
      ancestor,
      "moduleDoc",
    ) as DocNodeModuleDoc[];
    console.log(docNodes);
    for (const moduleDoc of docNodes) {
      if (moduleDoc.jsDoc.doc) {
        const key = objectGetKey(moduleDoc);
        const modDocPath = key?.path[2].name;
        if (modDocPath) {
          const items = docMap.get(modDocPath);
          if (items) {
            for (const item of items) {
              item.doc = moduleDoc.jsDoc.doc;
            }
          }
        }
      }
    }
  }

  return docPage;
}

async function getDocPageSymbol(
  datastore: Datastore,
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
  symbol: string,
): Promise<DocPageSymbol | undefined> {
  const docPage = getPageBase(
    "symbol",
    module,
    version,
    entry.path,
  ) as DocPageSymbol;
  docPage.name = symbol;
  const dirPath = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
  docPage.nav = await getNav(datastore, version.name, version.version, dirPath);
  docPage.docNodes = await queryDocNodesBySymbol(
    datastore,
    version.name,
    version.version,
    entry.path,
    symbol,
  );
  if (docPage.docNodes.length) {
    return docPage;
  }
}

export async function generateDocPage(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
  symbol: string,
): Promise<DocPage | undefined> {
  let [
    moduleItem,
    moduleVersion,
    moduleEntry,
  ] = await lookup(module, version, path);
  if (!moduleItem && !moduleVersion) {
    let mutations: Mutation[];
    try {
      [
        mutations,
        moduleItem,
        moduleVersion,
        moduleEntry,
      ] = await loadModule(module, version, path);
      enqueue({ kind: "commitMutations", mutations });
    } catch {
      if (!moduleVersion) {
        assert(moduleItem);
        return getPageInvalidVersion(moduleItem);
      }
      return undefined;
    }
  } else if (!moduleEntry) {
    assert(moduleItem);
    assert(moduleVersion);
    return getPagePathNotFound(moduleItem, moduleVersion, path);
  }
  if (moduleEntry && moduleEntry.default) {
    const defaultKey = datastore.key(
      ["module", module],
      ["module_version", version],
      ["module_entry", moduleEntry.default],
    );
    const result = await datastore.lookup(defaultKey);
    if (result.found && result.found.length === 1) {
      const { path } = entityToObject<ModuleEntry>(result.found[0].entity);
      return { kind: "redirect", path };
    }
  }
  if (moduleItem && moduleVersion && moduleEntry) {
    if (moduleEntry.type === "file" && isDocable(path)) {
      return symbol === ROOT_SYMBOL
        ? getDocPageModule(
          datastore,
          moduleItem,
          moduleVersion,
          moduleEntry,
          datastore.key(
            ["module", module],
            ["module_version", version],
            ["module_entry", path],
          ),
        )
        : getDocPageSymbol(
          datastore,
          moduleItem,
          moduleVersion,
          moduleEntry,
          symbol,
        );
    } else {
      if (symbol !== ROOT_SYMBOL) {
        throw new errors.BadRequest(
          `A symbol cannot be specified on a non-module path.`,
        );
      }
      return moduleEntry.type === "dir"
        ? getDocPageIndex(datastore, moduleItem, moduleVersion, moduleEntry)
        : getDocPageFile(moduleItem, moduleVersion, moduleEntry);
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
  const seen = new Set<string>();
  for (const entity of entities) {
    const item = entityToObject<NullableSymbolItem>(entity);
    if (item.kind === "null") {
      continue;
    }
    assert(entity.key);
    if (!descendentNotChild(ancestor, entity.key)) {
      const { name, kind, jsDoc } = item;
      const id = `${name}_${kind}`;
      if (!seen.has(id)) {
        seen.add(id);
        results.push({ name, kind, jsDoc });
      }
    }
  }
  return results;
}

function docNodesToSymbolItems(
  ancestor: Key,
  docNodes: DenoDocNode[],
): SymbolItem[] {
  const results: SymbolItem[] = [];
  const seen = new Set<string>();
  for (const docNode of docNodes) {
    const key = objectGetKey(docNode);
    assert(key);
    if (!descendentNotChild(ancestor, key)) {
      const { name, kind, jsDoc } = docNode;
      const id = `${name}_${kind}`;
      if (!seen.has(id)) {
        seen.add(id);
        results.push({ name, kind, jsDoc });
      }
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
  if (!entry.index || !entry.dirs) {
    return;
  }
  const missing: string[] = [];
  const items: SymbolIndexItem[] = [];
  for (const path of entry.dirs) {
    items.push({
      path,
      kind: "dir",
    });
  }
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
      items.push({
        path,
        kind: "module",
        items: entitiesToSymbolItems(ancestor, entities),
      });
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
        items.push({
          path,
          kind: "module",
          items: docNodesToSymbolItems(ancestor, docNodes),
        });
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

/** Convert a doc page to an {@linkcode Entity}, serializing any doc nodes
 * that are part of the object. */
function docPageToEntity(docPage: DocPage): Entity {
  if ("docNodes" in docPage) {
    docPage.docNodes = docPage.docNodes.map((docNode) => {
      // deno-lint-ignore no-explicit-any
      let node: any;
      switch (docNode.kind) {
        case "moduleDoc":
          node = docNode;
          break;
        case "namespace": {
          const { namespaceDef, ...rest } = docNode;
          const elements = namespaceDef.elements.map((el) =>
            JSON.stringify(el)
          );
          node = { namespaceDef: { elements }, ...rest };
          break;
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
      return node;
    });
  }
  return objectToEntity(docPage);
}

/** Take a datastore entity and convert it to a {@linkcode DocPage}. It will
 * attempt to deserializes doc nodes for those pages that serialize them. */
export function entityToDocPage(entity: Entity): DocPage {
  const docPage = entityToObject<DocPage>(entity);
  if ("docNodes" in docPage) {
    for (const docNode of docPage.docNodes) {
      switch (docNode.kind) {
        case "namespace": {
          docNode.namespaceDef.elements = docNode.namespaceDef.elements.map((
            element,
          ) => typeof element === "string" ? JSON.parse(element) : element);
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
  }
  return docPage;
}

/** Recursively add doc nodes to the mutations, serializing the definition
 * fields and breaking out namespace entries as their own entities.
 *
 * The definition fields are serialized, because Datastore only supports 20
 * nested entities, which can occur in doc nodes with complex types.
 */
export function addNodes(
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

export async function commitCodePage(
  id: number,
  module: string,
  version: string,
  path: string,
  codePage: CodePage,
) {
  const datastore = await getDatastore();
  const key = datastore.key(
    ["module", module],
    ["module_version", version],
    ["code_page", path],
  );
  objectSetKey(codePage, key);
  const mutations = [{ upsert: objectToEntity(codePage) }];
  try {
    for await (
      const _result of datastore.commit(mutations, { transactional: false })
    ) {
      console.log(
        `[${id}]: %cCommitted %cbatch for %c${module}@${version}${path}%c.`,
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

export async function commitDocPage(
  id: number,
  module: string,
  version: string,
  path: string,
  symbol: string,
  docPage: DocPage,
) {
  const datastore = await getDatastore();
  const key = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_entry", path],
    ["doc_page", symbol],
  );
  objectSetKey(docPage, key);
  const mutations = [{ upsert: docPageToEntity(docPage) }];
  try {
    for await (
      const _result of datastore.commit(mutations, { transactional: false })
    ) {
      console.log(
        `[${id}]: %cCommitted %cbatch for %c${module}@${version}${path}#${symbol}%c.`,
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

export async function commitNav(
  id: number,
  module: string,
  version: string,
  path: string,
  nav: DocPageNavItem[],
) {
  const datastore = await getDatastore();
  const key = datastore.key(
    ["module", module],
    ["module_version", version],
    ["nav_index", path],
  );
  const obj = { nav };
  objectSetKey(obj, key);
  const mutations = [{ upsert: objectToEntity(obj) }];
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

function isKeyKind(key: Key, kind: string): boolean {
  return key.path[key.path.length - 1]?.kind === kind;
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
      if (parentKey && isKeyKind(parentKey, "doc_node")) {
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

async function getNamespaceKeyInit(
  datastore: Datastore,
  keyInit: KeyInit[],
  namespace: string,
): Promise<KeyInit | undefined> {
  const key = datastore.key(...keyInit);
  const query = datastore
    .createQuery("doc_node")
    .hasAncestor(key)
    .filter("name", namespace)
    .filter("kind", "namespace");
  const result = await datastore.runQuery(query);
  if (!result.batch.entityResults || !result.batch.entityResults.length) {
    return undefined;
  }
  for (const { entity: { key: entityKey } } of result.batch.entityResults) {
    if (entityKey && !isKeyEqual(entityKey, key)) {
      const pathElement = entityKey.path.pop();
      if (pathElement && pathElement.id) {
        return [pathElement.kind, parseInt(pathElement.id, 10)];
      }
    }
  }
}

async function queryDocNodesBySymbol(
  datastore: Datastore,
  module: string,
  version: string,
  entry: string,
  symbol: string,
): Promise<DenoDocNode[]> {
  const keyInit: KeyInit[] = [
    ["module", module],
    ["module_version", version],
    ["module_entry", entry],
  ];
  let name = symbol;
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
  for await (const entity of datastore.streamQuery(query)) {
    entities.push(entity);
  }
  return entitiesToDocNodes(ancestor, entities);
}

/** Query the datastore for doc nodes, deserializing the definitions and
 * recursively querying namespaces. */
export async function queryDocNodes(
  datastore: Datastore,
  ancestor: Key,
  kind?: DocNodeKind,
): Promise<DenoDocNode[]> {
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
