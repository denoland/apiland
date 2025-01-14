// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Functions related to documenting modules.
 *
 * @module
 */

import type { LoadResponse } from "deno_graph";
import {
  Datastore,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Mutation } from "google_datastore/types";
import * as JSONC from "jsonc-parser";

import { getAnalysis } from "./analysis.ts";
import { getDatastore } from "./auth.ts";
import { cacheInfoPage, lookup } from "./cache.ts";
import { kinds } from "./consts.ts";
import { loadModule } from "./modules.ts";
import { enqueue } from "./process.ts";
import type {
  InfoPage,
  ModInfoPage,
  Module,
  ModuleEntry,
  ModuleVersion,
  PageInvalidVersion,
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

interface ConfigFileJson {
  importMap?: string;
  imports?: Record<string, string>;
}

const MAX_CACHE_SIZE = parseInt(Deno.env.get("MAX_CACHE_SIZE") ?? "", 10) ||
  25_000_000;

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

/** Determines if a file path can be doc'ed or not. */
export function isDocable(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(path);
}
