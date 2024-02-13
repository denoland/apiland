// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Functions related to documenting modules.
 *
 * @module
 */

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
  type Query,
} from "google_datastore";
import type {
  Entity,
  Key,
  Mutation,
  PartitionId,
  PathElement,
  Value,
  ValueString,
} from "google_datastore/types";
import * as JSONC from "jsonc-parser";
import { errors } from "std/http/http_errors.ts";

import { getAnalysis } from "./analysis.ts";
import { getDatastore } from "./auth.ts";
import { cacheInfoPage, lookup } from "./cache.ts";
import { kinds, ROOT_SYMBOL, SYMBOL_REGEX } from "./consts.ts";
import {
  getIndexModule,
  loadModule,
  RE_IGNORED_MODULE,
  RE_PRIVATE_PATH,
} from "./modules.ts";
import { enqueue } from "./process.ts";
import type {
  DocPage,
  DocPageFile,
  DocPageIndex,
  DocPageModule,
  DocPageNavItem,
  DocPageSymbol,
  IndexItem,
  InfoPage,
  ModInfoPage,
  Module,
  ModuleEntry,
  ModuleVersion,
  PageBase,
  PageInvalidVersion,
  PagePathNotFound,
  SourcePage,
  SourcePageDir,
  SourcePageDirEntry,
  SourcePageFile,
  SymbolIndex,
  SymbolIndexItem,
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

interface SymbolItem {
  name: string;
  kind: DocNodeKind;
  jsDoc?: JsDoc;
}

type NullableSymbolItem = SymbolItem | { kind: "null" };

type DocNode = DenoDocNode | DocNodeNull;

interface ConfigFileJson {
  importMap?: string;
  imports?: Record<string, string>;
}

const MAX_CACHE_SIZE = parseInt(Deno.env.get("MAX_CACHE_SIZE") ?? "", 10) ||
  25_000_000;
const MAX_ENTITY_SIZE = 1_048_000;

const cachedSpecifiers = new Set<string>();
const cachedResources = new Map<string, LoadResponse | undefined>();
let cacheCheckQueued = false;
let cacheSize = 0;

const DENO_LAND_X = new URLPattern(
  "https://deno.land/x/:mod@:ver/:path*",
);
const DENO_LAND_STD = new URLPattern("https://deno.land/std@:ver/:path*");

export async function load(
  specifier: string,
): Promise<LoadResponse | undefined> {
  if (cachedResources.has(specifier)) {
    cachedSpecifiers.delete(specifier);
    cachedSpecifiers.add(specifier);
    return cachedResources.get(specifier);
  }
  try {
    let cdnSpecifier: string | undefined;
    const matchStd = DENO_LAND_STD.exec(specifier);
    if (matchStd) {
      const { ver, path } = matchStd.pathname.groups;
      cdnSpecifier = `https://cdn.deno.land/std/versions/${ver}/raw/${path}`;
    } else {
      const matchX = DENO_LAND_X.exec(specifier);
      if (matchX) {
        const { mod, ver, path } = matchX.pathname.groups;
        cdnSpecifier =
          `https://cdn.deno.land/${mod}/versions/${ver}/raw/${path}`;
      }
    }
    const url = new URL(cdnSpecifier ?? specifier);
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
        specifier: cdnSpecifier ? specifier : response.url,
        headers,
        content,
      };
      cachedResources.set(specifier, loadResponse);
      cachedSpecifiers.add(specifier);
      cacheSize += content.length;
      enqueueCheck();
      return loadResponse;
    } else if (url.protocol === "node:" || url.protocol === "npm:") {
      return {
        kind: "external",
        specifier,
      };
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
    const configFileJson: ConfigFileJson | undefined = JSONC.parse(content);
    if (configFileJson) {
      if (configFileJson.imports) {
        return new URL(specifier).toString();
      } else if (configFileJson.importMap) {
        return new URL(configFileJson.importMap, specifier).toString();
      }
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
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
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
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
      [kinds.MODULE_ENTRY_KIND, `/${path}`],
    );
    const result = await datastore.lookup(pathKey);
    return !!result.found;
  } else {
    return true;
  }
}

function getPageBase<Kind extends DocPage["kind"] | SourcePage["kind"]>(
  kind: Kind,
  { versions, latest_version, tags }: Module,
  { name: module, version, uploaded_at, upload_options, description }:
    ModuleVersion,
  path: string,
): PageBase & { kind: Kind } {
  assert(latest_version);
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

function appendIndex(
  items: SymbolIndexItem[],
  docNodes: DenoDocNode[],
  namespace?: string,
) {
  for (const docNode of docNodes) {
    if (docNode.kind === "moduleDoc") {
      continue;
    }
    const name = namespace ? `${namespace}.${docNode.name}` : docNode.name;
    if (docNode.kind === "import") {
      const { kind, declarationKind, importDef: { src: filename } } = docNode;
      items.push({ name, kind, declarationKind, filename });
    } else {
      const { kind, declarationKind, location: { filename } } = docNode;
      items.push({ name, kind, declarationKind, filename });
    }
    if (docNode.kind === "namespace") {
      appendIndex(items, docNode.namespaceDef.elements, name);
    }
  }
}

async function getSymbolIndex(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
  docNodes?: DenoDocNode[],
): Promise<SymbolIndexItem[]> {
  const indexKey = datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.SYMBOL_INDEX_KIND, path],
  );
  const symbolIndex = await dbLookup<SymbolIndex>(datastore, indexKey);
  if (symbolIndex) {
    return symbolIndex.items;
  }
  const items: SymbolIndexItem[] = [];
  docNodes = docNodes ?? await queryDocNodes(
    datastore,
    datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
      [kinds.MODULE_ENTRY_KIND, path],
    ),
  );
  appendIndex(items, docNodes);
  enqueue({ kind: "commitSymbolIndex", module, version, path, items });
  return items;
}

export async function getNav(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
): Promise<DocPageNavItem[]> {
  const navKey = datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.NAV_INDEX_KIND, path],
  );
  const navIndex = await dbLookup<{ nav: DocPageNavItem[] }>(
    datastore,
    navKey,
  );
  if (navIndex) {
    return navIndex.nav;
  }
  const [, , entry] = await lookup(module, version, path);
  if (!entry) {
    throw new errors.InternalServerError(
      `Unable to lookup nav dir module entry: ${module}@${version}${path}`,
    );
  }
  const missing: string[] = [];
  const nav: DocPageNavItem[] = [];
  if (entry.dirs && entry.dirs.length) {
    const keys = entry.dirs.map((path) =>
      datastore.key(
        [kinds.MODULE_KIND, module],
        [kinds.MODULE_VERSION_KIND, version],
        [kinds.MODULE_ENTRY_KIND, path],
      )
    );
    const res = await datastore.lookup(keys);
    if (res.found) {
      for (const { entity } of res.found) {
        const entry = entityToObject<ModuleEntry>(entity);
        if (
          entry.default ||
          (entry.dirs && entry.dirs.length) ||
          (entry.index && entry.index.length)
        ) {
          nav.push({ kind: "dir", path: entry.path });
        }
      }
    }
  }
  if (entry.index) {
    for (const path of entry.index) {
      const ancestor = datastore.key(
        [kinds.MODULE_KIND, module],
        [kinds.MODULE_VERSION_KIND, version],
        [kinds.MODULE_ENTRY_KIND, path],
      );
      const query = datastore.createQuery(kinds.DOC_NODE_KIND).hasAncestor(
        ancestor,
      );
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
          [kinds.MODULE_KIND, module],
          [kinds.MODULE_VERSION_KIND, version],
          [kinds.MODULE_ENTRY_KIND, path],
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
  assert(
    latest_version,
    "Assertion failed for " + JSON.stringify({ module, versions }),
  );
  return {
    kind: "invalid-version",
    module,
    description,
    versions,
    latest_version,
  };
}

function getSourcePageFile(
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
): SourcePageFile {
  const sourcePage = getPageBase(
    "file",
    module,
    version,
    entry.path,
  ) as SourcePageFile;
  sourcePage.size = entry.size;
  sourcePage.docable = entry.docable;
  return sourcePage;
}

async function getSourcePageDir(
  datastore: Datastore,
  module: Module,
  version: ModuleVersion,
  entry: ModuleEntry,
): Promise<SourcePageDir> {
  const entryPath = entry.path;
  const codePage = getPageBase(
    "dir",
    module,
    version,
    entryPath,
  ) as SourcePageDir;
  const query = datastore
    .createQuery(kinds.MODULE_ENTRY_KIND)
    .hasAncestor(datastore.key(
      [kinds.MODULE_KIND, module.name],
      [kinds.MODULE_VERSION_KIND, version.version],
    ));
  const entries: SourcePageDirEntry[] = [];
  for await (const entity of datastore.streamQuery(query)) {
    const {
      type: kind,
      size = 0,
      docable,
      path,
    } = entityToObject<ModuleEntry>(entity);
    const slice = entryPath !== "/" ? path.slice(entryPath.length) : path;
    if (
      path.startsWith(entryPath) && slice.lastIndexOf("/") === 0 &&
      path !== entryPath
    ) {
      entries.push({ path, kind, size, docable });
    }
  }
  codePage.entries = entries;
  return codePage;
}

export async function generateSourcePage(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
): Promise<SourcePage | undefined> {
  let [
    moduleItem,
    moduleVersion,
    moduleEntry,
  ] = await lookup(module, version, path);
  if (
    !moduleItem || (!moduleVersion && moduleItem.versions.includes(version))
  ) {
    let mutations: Mutation[];
    try {
      [
        mutations,
        moduleItem,
        moduleVersion,
        moduleEntry,
      ] = await loadModule(module, version, path);
      enqueue({ kind: "commitMutations", mutations });
    } catch (e) {
      console.log("error loading module", e);
      return undefined;
    }
  }
  if (!moduleVersion) {
    assert(moduleItem);
    return getPageInvalidVersion(moduleItem);
  } else if (!moduleEntry) {
    assert(
      moduleItem,
      `moduleItem should exists after lookup: ${module}@${version}${path}`,
    );
    assert(
      moduleVersion,
      `moduleItem should exists after lookup: ${module}@${version}${path}`,
    );
    return getPagePathNotFound(moduleItem, moduleVersion, path);
  }
  if (moduleItem && moduleVersion && moduleEntry) {
    return moduleEntry.type === "file"
      ? getSourcePageFile(moduleItem, moduleVersion, moduleEntry)
      : getSourcePageDir(datastore, moduleItem, moduleVersion, moduleEntry);
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
  docPage.symbols = await getSymbolIndex(
    datastore,
    version.name,
    version.version,
    entry.path,
    docPage.docNodes,
  );
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
    [kinds.MODULE_KIND, version.name],
    [kinds.MODULE_VERSION_KIND, version.version],
  );
  const query = datastore
    .createQuery(kinds.MODULE_ENTRY_KIND)
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
          ignored: RE_PRIVATE_PATH.test(slice) ||
            !(entry.default || (entry.dirs && entry.dirs.length) ||
              (entry.index && entry.index.length)),
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
  if (!SYMBOL_REGEX.test(symbol)) {
    return undefined;
  }

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
    docPage.symbols = await getSymbolIndex(
      datastore,
      version.name,
      version.version,
      entry.path,
    );
    return docPage;
  }
}

let datastore: Datastore | undefined;

export async function getModuleEntries(
  module: string,
  version: string,
): Promise<ModuleEntry[]> {
  datastore = datastore || await getDatastore();
  const query = datastore
    .createQuery(kinds.MODULE_ENTRY_KIND)
    .hasAncestor(datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
    ));
  const entries: ModuleEntry[] = [];
  for await (const entity of datastore.streamQuery(query)) {
    entries.push(entityToObject(entity));
  }
  return entries;
}

function getDefaultModule(entries: ModuleEntry[]): ModuleEntry | undefined {
  const root = entries.find(({ path, type }) => path === "/" && type === "dir");
  const defModule = root?.default;
  if (defModule) {
    return entries.find(({ path, type }) =>
      path === defModule && type === "file"
    );
  }
}

function getConfig(entries: ModuleEntry[]): ModuleEntry | undefined {
  return entries.find(({ type, path }) =>
    type === "file" && /^\/deno\.jsonc?$/i.test(path)
  );
}

function getReadme(entries: ModuleEntry[]): ModuleEntry | undefined {
  return entries.find(({ type, path }) =>
    type === "file" && /^\/README(\.(md|txt|markdown))?$/i.test(path)
  );
}

async function getModInfoPage(
  moduleItem: Module,
  moduleVersion: ModuleVersion,
  entries: ModuleEntry[],
): Promise<ModInfoPage> {
  const {
    name: module,
    description,
    latest_version,
    tags,
    versions,
  } = moduleItem;
  assert(latest_version);
  const { uploaded_at, upload_options, version } = moduleVersion;
  const defaultModule = getDefaultModule(entries);
  const config = getConfig(entries);
  const readme = getReadme(entries);
  const [dependencies, dependency_errors] = await getAnalysis(
    moduleItem,
    moduleVersion,
  );
  return {
    kind: "modinfo",
    module,
    description,
    dependencies,
    dependency_errors,
    version,
    versions,
    latest_version,
    defaultModule,
    readme,
    config,
    uploaded_at: uploaded_at.toISOString(),
    upload_options,
    tags,
  };
}

export async function generateInfoPage(
  module: string,
  version: string,
): Promise<InfoPage | undefined> {
  let [moduleItem, moduleVersion] = await lookup(module, version);
  let moduleEntries: ModuleEntry[] | undefined;
  if (
    !moduleItem || (!moduleVersion && moduleItem.versions.includes(version))
  ) {
    let mutations: Mutation[];
    try {
      [
        mutations,
        moduleItem,
        moduleVersion,
        ,
        ,
        moduleEntries,
      ] = await loadModule(module, version);
      enqueue({ kind: "commitMutations", mutations });
    } catch (e) {
      console.log("error loading module", e);
      return undefined;
    }
  }
  if (!moduleVersion) {
    assert(moduleItem);
    return getPageInvalidVersion(moduleItem);
  }
  if (!moduleItem.latest_version) {
    return { kind: "no-versions", module: moduleItem.name };
  }
  moduleEntries = moduleEntries || await getModuleEntries(module, version);
  const infoPage = await getModInfoPage(
    moduleItem,
    moduleVersion,
    moduleEntries,
  );
  datastore = datastore || await getDatastore();
  objectSetKey(
    infoPage,
    datastore.key([kinds.MODULE_KIND, module], ["info_page", version]),
  );
  const mutations: Mutation[] = [{ upsert: objectToEntity(infoPage) }];
  enqueue({ kind: "commitMutations", mutations });
  cacheInfoPage(module, version, infoPage);
  return infoPage;
}

export async function generateDocPage(
  datastore: Datastore,
  module: string,
  version: string,
  path: string,
  symbol: string,
): Promise<DocPage | undefined> {
  if (!SYMBOL_REGEX.test(symbol)) {
    return undefined;
  }

  let [
    moduleItem,
    moduleVersion,
    moduleEntry,
  ] = await lookup(module, version, path);
  if (
    !moduleItem || (!moduleVersion && moduleItem.versions.includes(version))
  ) {
    let mutations: Mutation[];
    try {
      [
        mutations,
        moduleItem,
        moduleVersion,
        moduleEntry,
      ] = await loadModule(module, version, path);
      enqueue({ kind: "commitMutations", mutations });
    } catch (e) {
      console.log("error loading module", e);
      return undefined;
    }
  }
  if (!moduleVersion) {
    assert(moduleItem);
    return getPageInvalidVersion(moduleItem);
  } else if (!moduleEntry) {
    assert(moduleItem);
    return getPagePathNotFound(moduleItem, moduleVersion, path);
  }
  if (moduleEntry && moduleEntry.default) {
    const defaultKey = datastore.key(
      [kinds.MODULE_KIND, module],
      [kinds.MODULE_VERSION_KIND, version],
      [kinds.MODULE_ENTRY_KIND, moduleEntry.default],
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
            [kinds.MODULE_KIND, module],
            [kinds.MODULE_VERSION_KIND, version],
            [kinds.MODULE_ENTRY_KIND, path],
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
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
  );
  const query = datastore
    .createQuery(kinds.MODULE_ENTRY_KIND)
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
      .createQuery(kinds.DOC_NODE_KIND)
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

/** Namespaces and interfaces are open ended. This function will merge these
 * together, so that you have single entries per symbol. */
export function mergeEntries(entries: DenoDocNode[]): DenoDocNode[] {
  const merged: DenoDocNode[] = [];
  const namespaces = new Map<string, DocNodeNamespace>();
  const interfaces = new Map<string, DocNodeInterface>();
  for (const node of entries) {
    if (node.kind === "namespace") {
      const namespace = namespaces.get(node.name);
      if (namespace) {
        namespace.namespaceDef.elements.push(...node.namespaceDef.elements);
        if (!namespace.jsDoc) {
          // deno-lint-ignore no-explicit-any
          namespace.jsDoc = (node.jsDoc ?? null) as any;
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

export function dehydrateDocNodes(docNodes: DocNode[]): DenoDocNode[] {
  return docNodes.map((docNode) => {
    // deno-lint-ignore no-explicit-any
    let node: any;
    switch (docNode.kind) {
      case "moduleDoc":
        node = docNode;
        break;
      case "namespace": {
        const { namespaceDef, ...rest } = docNode;
        const elements = namespaceDef.elements.map((el) => JSON.stringify(el));
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
    // ensure the property exists in Google Datastore
    node.jsDoc = node.jsDoc ?? null;
    return node;
  });
}

/** Convert a doc page to an {@linkcode Entity}, serializing any doc nodes
 * that are part of the object. */
function docPageToEntity(docPage: DocPage): Entity {
  if ("docNodes" in docPage) {
    docPage.docNodes = dehydrateDocNodes(docPage.docNodes);
  }
  return objectToEntity(docPage);
}

export function hydrateDocNodes(docNodes: DocNode[]): void {
  for (const docNode of docNodes) {
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

/** Take a datastore entity and convert it to a {@linkcode DocPage}. It will
 * attempt to deserializes doc nodes for those pages that serialize them. */
export function entityToDocPage(entity: Entity): DocPage {
  const docPage = entityToObject<DocPage>(entity);
  if ("docNodes" in docPage) {
    hydrateDocNodes(docPage.docNodes);
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
        if (node.classDef.length > MAX_ENTITY_SIZE) {
          node.classDef = JSON.stringify({
            isAbstract: false,
            constructors: [],
            properties: [],
            indexSignatures: [],
            methods: [],
            implements: [],
            typeParams: [],
            superTypeParams: [],
          });
          node.jsDoc = {
            doc: "**WARNING** this class was too large to document.",
            tags: node.jsDoc?.tags,
          };
        }
        break;
      }
      case "enum": {
        const { enumDef, ...rest } = docNode;
        node = { enumDef: JSON.stringify(enumDef), ...rest };
        if (node.enumDef.length > MAX_ENTITY_SIZE) {
          node.enumDef = JSON.stringify({ members: [] });
          node.jsDoc = {
            doc: "**WARNING** this enum was too large to document.",
            tags: node.jsDoc?.tags,
          };
        }
        break;
      }
      case "function": {
        const { functionDef, ...rest } = docNode;
        node = { functionDef: JSON.stringify(functionDef), ...rest };
        if (node.functionDef.length > MAX_ENTITY_SIZE) {
          node.functionDef = JSON.stringify({
            params: [],
            isAsync: false,
            isGenerator: false,
            typeParams: [],
          });
          node.jsDoc = {
            doc: "**WARNING** this function was too large to document.",
            tags: node.jsDoc?.tags,
          };
        }
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
        if (node.interfaceDef.length > MAX_ENTITY_SIZE) {
          node.interfaceDef = JSON.stringify({
            extends: [],
            methods: [],
            properties: [],
            callSignatures: [],
            indexSignatures: [],
            typeParams: [],
          });
          node.jsDoc = {
            doc: "**WARNING** this interface was too large to document.",
            tags: node.jsDoc?.tags,
          };
        }
        break;
      }
      case "typeAlias": {
        const { typeAliasDef, ...rest } = docNode;
        node = { typeAliasDef: JSON.stringify(typeAliasDef), ...rest };
        if (node.typeAliasDef.length > MAX_ENTITY_SIZE) {
          node.typeAliasDef = JSON.stringify({
            tsType: {
              repr: "[UNSUPPORTED]",
              kind: "keyword",
              keyword: "[UNSUPPORTED]",
            },
            typeParams: [],
          });
          node.jsDoc = {
            doc: "**WARNING** this type alias was too large to document.",
            tags: node.jsDoc?.tags,
          };
        }
        break;
      }
      case "variable": {
        const { variableDef, ...rest } = docNode;
        node = { variableDef: JSON.stringify(variableDef), ...rest };
        if (node.variableDef.length > MAX_ENTITY_SIZE) {
          node.variableDef = JSON.stringify({ kind: variableDef.kind });
          node.jsDoc = {
            doc: "**WARNING** this variable was too large to document.",
            tags: node.jsDoc?.tags,
          };
        }
        break;
      }
    }
    // ensure the property exists in Google Datastore
    node.jsDoc = node.jsDoc ?? null;
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
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.MODULE_ENTRY_KIND, `/${path}`],
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
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
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

export async function commitSourcePage(
  id: number,
  module: string,
  version: string,
  path: string,
  sourcePage: SourcePage,
) {
  const datastore = await getDatastore();
  const key = datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    ["code_page", path],
  );
  objectSetKey(sourcePage, key);
  const mutations = [{ upsert: objectToEntity(sourcePage) }];
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
  if (!SYMBOL_REGEX.test(symbol)) {
    return undefined;
  }

  const datastore = await getDatastore();
  const key = datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.MODULE_ENTRY_KIND, path],
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

export async function commitSymbolIndex(
  id: number,
  module: string,
  version: string,
  path: string,
  items: SymbolIndexItem[],
) {
  const datastore = await getDatastore();
  const key = datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.SYMBOL_INDEX_KIND, path],
  );
  const obj = { items };
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

export async function commitNav(
  id: number,
  module: string,
  version: string,
  path: string,
  nav: DocPageNavItem[],
) {
  const datastore = await getDatastore();
  const key = datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.NAV_INDEX_KIND, path],
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
export function isKeyEqual(a: Key, b: Key): boolean {
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
export function descendentNotChild(
  parent: Key,
  descendent: Key,
): Key | undefined {
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
    const docNode = entityToObject<DocNode>(entity);
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
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.MODULE_ENTRY_KIND, entry],
  );
  const query = datastore
    .createQuery(kinds.DOC_NODE_KIND)
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

export async function getNamespaceKeyInit(
  datastore: Datastore,
  keyInit: KeyInit[],
  namespace: string,
): Promise<KeyInit | undefined> {
  const key = datastore.key(...keyInit);
  const query = datastore
    .createQuery(kinds.DOC_NODE_KIND)
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

function isStringValue(value: Value): value is ValueString {
  return "stringValue" in value;
}

export function isNamespace(entity: Entity): boolean {
  return !!(entity.key &&
    entity.key.path[entity.key.path.length - 1].kind === kinds.DOC_NODE_KIND &&
    entity.properties && entity.properties["kind"] &&
    isStringValue(entity.properties["kind"]) &&
    entity.properties["kind"].stringValue === "namespace");
}

async function queryDocNodesBySymbol(
  datastore: Datastore,
  module: string,
  version: string,
  entry: string,
  symbol: string,
): Promise<DenoDocNode[]> {
  if (!SYMBOL_REGEX.test(symbol)) {
    return [];
  }

  const keyInit: KeyInit[] = [
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.MODULE_ENTRY_KIND, entry],
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
    .createQuery(kinds.DOC_NODE_KIND)
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
        .createQuery(kinds.DOC_NODE_KIND)
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

/** Query the datastore for doc nodes, deserializing the definitions and
 * recursively querying namespaces. */
export async function queryDocNodes(
  datastore: Datastore,
  ancestor: Key,
  kind?: DocNodeKind,
): Promise<DenoDocNode[]> {
  const query = datastore
    .createQuery(kinds.DOC_NODE_KIND)
    .hasAncestor(ancestor);
  if (kind) {
    query.filter("kind", kind);
  }
  const entities: Entity[] = [];
  for await (const entity of datastore.streamQuery(query)) {
    entities.push(entity);
  }
  return entitiesToDocNodes(ancestor, entities);
}
