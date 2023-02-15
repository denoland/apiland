// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Utilities for analyzing modules at a detailed level.
 *
 * @module
 */

import $ from "dax";
import { createGraph } from "deno_graph";
import {
  type Datastore,
  DatastoreError,
  entityToObject,
  type KeyInit,
  objectGetKey,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Mutation } from "google_datastore/types";
import { parseFromJson } from "import_map";

import { getDatastore } from "./auth.ts";
import { lookup } from "./cache.ts";
import { kinds, patterns } from "./consts.ts";
import { getImportMapSpecifier, load } from "./docs.ts";
import { clearAppend } from "./modules.ts";
import type {
  DependencyError,
  Module,
  ModuleDependency,
  ModuleEntry,
  ModuleVersion,
} from "./types.d.ts";
import { assert } from "./util.ts";

const ANALYSIS_VERSION = "1";

function resolveSpecifiers(
  specifier: string,
  redirects: Record<string, string>,
) {
  return redirects[specifier] ?? specifier;
}

function parse(specifier: string): ModuleDependency {
  for (
    const [src, urlPatterns] of Object.entries(patterns) as [
      keyof typeof patterns,
      URLPattern[],
    ][]
  ) {
    for (const pattern of urlPatterns) {
      const match = pattern.exec(specifier);
      if (match) {
        const { org, pkg = "std", ver } = match.pathname.groups;
        return { src, org, pkg, ver };
      }
    }
  }
  return { src: "other", pkg: specifier };
}

function depKey({ src, org, pkg, ver }: ModuleDependency): string {
  return `${src}:${org ? `${org}/` : ""}${pkg}${ver ? `@${ver}` : ""}`;
}

const externalPattern = new URLPattern("https://deno.land/x/:mod/:path*");

function isExternal(specifier: string, referrer: string): boolean {
  const referrerMatch = externalPattern.exec(referrer);
  assert(referrerMatch, `unexpected referrer: ${referrer}`);
  const { mod } = referrerMatch.pathname.groups;
  const specifierMatch = externalPattern.exec(specifier);
  if (!specifierMatch) {
    return true;
  }
  return mod !== specifierMatch.pathname.groups.mod;
}

interface MappedDependency {
  code?: { specifier?: string; error?: string };
  type?: { specifier?: string; error?: string };
}

interface MappedModule {
  error?: string;
  deps?: Map<string, MappedDependency>;
}

function resolveModule(
  modules: Map<string, MappedModule>,
  redirects: Record<string, string>,
  errors: DependencyError[],
  specifier: string,
): MappedModule | undefined {
  const resolved = resolveSpecifiers(specifier, redirects);
  const mod = modules.get(resolved);
  assert(mod, `cannot find module: ${resolved}`);
  if (mod.error) {
    errors.push({ specifier: resolved, error: mod.error });
    return;
  }
  return mod;
}

function analyzeDeps(
  deps: Map<string, ModuleDependency>,
  modules: Map<string, MappedModule>,
  redirects: Record<string, string>,
  errors: DependencyError[],
  seen: Set<string>,
  specifier: string,
) {
  if (seen.has(specifier)) {
    return;
  }
  seen.add(specifier);
  const mod = resolveModule(modules, redirects, errors, specifier);
  if (mod && mod.deps) {
    for (const [dep, { code, type }] of mod.deps) {
      if (code) {
        if (code.error) {
          errors.push({ specifier: code.specifier ?? dep, error: code.error });
        } else if (code.specifier) {
          if (isExternal(code.specifier, specifier)) {
            const parsedDep = parse(code.specifier);
            deps.set(depKey(parsedDep), parsedDep);
            resolveModule(modules, redirects, errors, code.specifier);
          } else {
            analyzeDeps(deps, modules, redirects, errors, seen, code.specifier);
          }
        }
      }
      if (type) {
        if (type.error) {
          errors.push({ specifier: type.specifier ?? dep, error: type.error });
        } else if (type.specifier) {
          if (isExternal(type.specifier, specifier)) {
            const parsedDep = parse(type.specifier);
            deps.set(depKey(parsedDep), parsedDep);
            resolveModule(modules, redirects, errors, type.specifier);
          } else {
            analyzeDeps(deps, modules, redirects, errors, seen, type.specifier);
          }
        }
      }
    }
  }
}

let datastore: Datastore | undefined;

async function getRoots(module: string, version: string): Promise<string[]> {
  datastore = datastore ?? await getDatastore();
  const res = await datastore.lookup(datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.MODULE_ENTRY_KIND, "/"],
  ));
  assert(
    res.found && res.found.length === 1,
    "was unable to lookup root path of module",
  );
  const rootEntry = entityToObject<ModuleEntry>(res.found[0].entity);
  if (rootEntry.default) {
    return [`https://deno.land/x/${module}@${version}${rootEntry.default}`];
  } else {
    const query = datastore
      .createQuery(kinds.MODULE_ENTRY_KIND)
      .filter("docable", true)
      .hasAncestor(datastore.key(
        [kinds.MODULE_KIND, module],
        [kinds.MODULE_VERSION_KIND, version],
      ));
    const roots: string[] = [];
    for (const entry of await datastore.query<ModuleEntry>(query)) {
      if (entry.path.lastIndexOf("/") === 0) {
        roots.push(`https://deno.land/x/${module}@${version}${entry.path}`);
      }
    }
    return roots;
  }
}

async function isAnalyzed(module: string, version: string): Promise<boolean> {
  const [, moduleVersion] = await lookup(module, version);
  assert(moduleVersion, `Cannot find module version: ${module}@${version}`);
  return moduleVersion.analysis_version === ANALYSIS_VERSION;
}

/** Perform an analysis of a module and version, resolving with a tuple of
 * arrays of dependencies and dependency errors. */
export async function analyze(
  module: string,
  version: string,
  force: boolean,
): Promise<[ModuleDependency[], DependencyError[]]> {
  if (!force && await isAnalyzed(module, version)) {
    $.logStep(`Skipping ${module}@${version}. Already analyzed.`);
    return [[], []];
  }
  $.logStep(`Analyzing dependencies of ${module}@${version}...`);
  const importMapSpecifier = await getImportMapSpecifier(module, version);
  let resolve: ((specifier: string, referrer: string) => string) | undefined;
  if (importMapSpecifier) {
    try {
      const res = await fetch(importMapSpecifier);
      if (res.status === 200) {
        const content = await res.text();
        const importMap = await parseFromJson(importMapSpecifier, content);
        resolve = (specifier, referrer) =>
          importMap.resolve(specifier, referrer);
      }
    } catch {
      $.logError(`Cannot load identified import map: ${importMapSpecifier}`);
    }
  }
  const graphRoots = await getRoots(module, version);
  if (!graphRoots.length) {
    $.logError("No root docable modules found.");
    const [, moduleVersion] = await lookup(module, version);
    assert(
      moduleVersion,
      `unexpected missing module version: ${module}@${version}`,
    );
    moduleVersion.analysis_version = ANALYSIS_VERSION;
    assert(
      objectGetKey(moduleVersion),
      "module version is missing a key, unexpectedly",
    );
    const mutations: Mutation[] = [{ upsert: objectToEntity(moduleVersion) }];
    datastore = datastore ?? await getDatastore();
    for await (
      const _ of datastore.commit(mutations, { transactional: false })
    ) {
      // just empty here
    }
    $.logLight(`  updated module version.`);
    return [[], []];
  }
  $.logLight(`  generating module graph...`);
  const { modules, redirects, roots } = await createGraph(graphRoots, {
    load,
    resolve,
  });
  const mods = modules.reduce((map, { specifier, error, dependencies }) => {
    const deps = dependencies?.reduce(
      (map, { specifier, code, type }) => map.set(specifier, { code, type }),
      new Map<string, MappedDependency>(),
    );
    return map.set(specifier, { error, deps });
  }, new Map<string, MappedModule>());
  const deps = new Map<string, ModuleDependency>();
  const errors: DependencyError[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    $.logLight(`  analyzing dependencies for "${root}"...`);
    analyzeDeps(deps, mods, redirects, errors, seen, root);
  }
  const mutations: Mutation[] = [];
  datastore = datastore ?? await getDatastore();
  const keyInit: KeyInit[] = [[kinds.MODULE_KIND, module], [
    kinds.MODULE_VERSION_KIND,
    version,
  ]];
  await clearAppend(
    datastore,
    mutations,
    ["info_page"],
    datastore.key(keyInit[0]),
  );
  await clearAppend(
    datastore,
    mutations,
    [kinds.MODULE_DEP_KIND, kinds.DEP_ERROR_KIND],
    datastore.key(...keyInit),
  );
  for (const error of errors) {
    objectSetKey(error, datastore.key(...keyInit, kinds.DEP_ERROR_KIND));
    mutations.push({ upsert: objectToEntity(error) });
  }
  for (const [key, value] of deps) {
    objectSetKey(
      value,
      datastore.key(...keyInit, [kinds.MODULE_DEP_KIND, key]),
    );
    mutations.push({ upsert: objectToEntity(value) });
  }
  const [, moduleVersion] = await lookup(module, version);
  assert(
    moduleVersion,
    `unexpected missing module version: ${module}@${version}`,
  );
  moduleVersion.analysis_version = ANALYSIS_VERSION;
  assert(
    objectGetKey(moduleVersion),
    "module version is missing a key, unexpectedly",
  );
  mutations.push({ upsert: objectToEntity(moduleVersion) });
  let remaining = mutations.length;
  $.logStep(`  Committing to datastore ${remaining} changes...`);
  try {
    for await (
      const res of datastore.commit(mutations, { transactional: false })
    ) {
      remaining -= res.mutationResults.length;
      $.logLight(
        `    ${res.mutationResults.length} committed. ${remaining} to go.`,
      );
    }
  } catch (err) {
    if (err instanceof DatastoreError) {
      $.logError(
        "DatastoreError",
        err.statusText,
        JSON.stringify(err.statusInfo, undefined, "  "),
      );
    } else {
      throw err;
    }
  }
  $.logStep("Done.");
  return [[...deps.values()], errors];
}

/** Attempt to retrieve a module and versions analysis from the datastore, or
 * otherwise perform an analysis. */
export async function getAnalysis(
  module: Module,
  version: ModuleVersion,
  force = false,
): Promise<[ModuleDependency[], DependencyError[]]> {
  if (!force && await isAnalyzed(module.name, version.version)) {
    datastore = datastore ?? await getDatastore();
    const ancestor = datastore.key(
      [kinds.MODULE_KIND, module.name],
      [kinds.MODULE_VERSION_KIND, version.version],
    );
    const depsQuery = datastore
      .createQuery(kinds.MODULE_DEP_KIND)
      .hasAncestor(ancestor);
    const deps = await datastore.query<ModuleDependency>(depsQuery);
    const errorQuery = datastore
      .createQuery(kinds.DEP_ERROR_KIND)
      .hasAncestor(ancestor);
    const errors = await datastore.query<DependencyError>(errorQuery);
    return [deps, errors];
  } else {
    return analyze(module.name, version.version, force);
  }
}
