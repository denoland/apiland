import dax from "dax";
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
import { parse as parseArgs } from "std/flags/mod.ts";
import { lookup } from "./cache.ts";
import { getImportMapSpecifier, load } from "./docs.ts";
import { clearAppend } from "./modules.ts";
import { getDatastore } from "./store.ts";
import type {
  DependencyError,
  Module,
  ModuleDependency,
  ModuleEntry,
  ModuleVersion,
} from "./types.d.ts";
import { assert } from "./util.ts";

export const MODULE_DEP_KIND = "module_dependency";
export const DEP_ERROR_KIND = "dependency_error";
const ANALYSIS_VERSION = "1";

export const patterns = {
  /** Modules that or external to the current module, but hosted on
   * `deno.land/x`. */
  "deno.land/x": [
    new URLPattern({
      protocol: "https",
      hostname: "deno.land",
      pathname: "/x/:pkg([^@/]+){@:ver}?/:mod*",
      search: "*",
      hash: "*",
    }),
  ],
  /** Modules that are being read directly off the deno.land CDN. */
  "cdn.deno.land": [
    // https://cdn.deno.land/mimetypes/versions/v1.0.0/raw/mod.ts
    new URLPattern("https://cdn.deno.land/:pkg/versions/:ver/raw/:mod+"),
  ],
  /** Dependency that originates from the Deno `std` library. */
  "std": [
    new URLPattern({
      protocol: "https",
      hostname: "deno.land",
      pathname: "/std{@:ver}?/:mod*",
      search: "*",
      hash: "*",
    }),
  ],
  /** Modules/packages hosted on nest.land. */
  "nest.land": [new URLPattern("https://x.nest.land/:pkg([^@/]+)@:ver/:mod*")],
  /** Modules hosted on crux.land. */
  "crux.land": [new URLPattern("https://crux.land/:pkg([^@/]+)@:ver")],
  /** Content hosted on GitHub. */
  "github.com": [
    new URLPattern({
      protocol: "https",
      hostname: "raw.githubusercontent.com",
      pathname: "/:org/:pkg/:ver/:mod*",
      search: "*",
    }),
    // https://github.com/denoland/deno_std/raw/main/http/mod.ts
    new URLPattern(
      "https://github.com/:org/:pkg/raw/:ver/:mod*",
    ),
  ],
  /** Content that is hosted in a GitHub gist. */
  "gist.github.com": [
    new URLPattern(
      "https://gist.githubusercontent.com/:org/:pkg/raw/:ver/:mod*",
    ),
  ],
  /** Packages that are hosted on esm.sh. */
  "esm.sh": [
    new URLPattern({
      protocol: "http{s}?",
      hostname: "{cdn.}?esm.sh",
      pathname: "/:org(@[^/]+)?/:pkg([^@/]+){@:ver}?/:mod*",
      search: "*",
    }),
    // https://esm.sh/v92/preact@10.10.0/src/index.d.ts
    new URLPattern({
      protocol: "http{s}?",
      hostname: "{cdn.}?esm.sh",
      pathname:
        "/:regver(stable|v[0-9]+)/:org(@[^/]+)?/:pkg([^@/]+){@:ver}?/:mod*",
      search: "*",
    }),
  ],
  "denopkg.com": [
    new URLPattern({
      protocol: "https",
      hostname: "denopkg.com",
      pathname: "/:org(@[^/]+)?/:pkg([^@/]+){@:ver}?/:mod*",
      search: "*",
      hash: "*",
    }),
  ],
  "denolib.com": [
    new URLPattern({
      protocol: "https",
      hostname: "denolib.com",
      pathname: "/:org(@[^/]+)?/:pkg([^@/]+){@:ver}?/:mod*",
      search: "*",
      hash: "*",
    }),
  ],
  "lib.deno.dev": [
    new URLPattern({
      protocol: "https",
      hostname: "lib.deno.dev",
      pathname: "/x/:pkg([^@/]+){@:ver}?/:mod*",
      search: "*",
      hash: "*",
    }),
  ],
  /** a github proxy */
  "pax.deno.dev": [
    // https://pax.deno.dev/windchime-yk/deno-util@v1.1.1/file.ts
    new URLPattern("https://pax.deno.dev/:org/:pkg([^@/]+){@:ver}?/:mod*"),
  ],
  /** a github proxy */
  "ghuc.cc": [
    // https://ghuc.cc/qwtel/kv-storage-interface/index.d.ts
    new URLPattern("https://ghuc.cc/:org/:pkg([^@/]+){@:ver}?/:mod*"),
  ],
  "ghc.deno.dev": [
    // https://ghc.deno.dev/tbjgolden/deno-htmlparser2@1f76cdf/htmlparser2/Parser.ts
    new URLPattern("https://ghc.deno.dev/:org/:pkg([^@/]+){@:ver}?/:mod*"),
  ],
  /** jspm.dev and jspm.io packages */
  "jspm.dev": [
    // https://jspm.dev/@angular/compiler@11.0.5
    new URLPattern(
      "https://jspm.dev/:org((?:npm:)?@[^/]+)?/:pkg([^@!/]+){@:ver([^!/]+)}?{(![^/]+)}?/:mod*",
    ),
    // https://dev.jspm.io/markdown-it@11.0.1
    new URLPattern(
      "https://dev.jspm.io/:org((?:npm:)?@[^/]+)?/:pkg([^@!/]+){@:ver([^!/]+)}?{(![^/]+)}?/:mod*",
    ),
  ],
  /** Packages that are hosted on skypack.dev */
  "skypack.dev": [
    new URLPattern({
      protocol: "https",
      hostname: "cdn.skypack.dev",
      pathname: "/:org(@[^/]+)?/:pkg([^@/]+){@:ver}?/:mod*",
      search: "*",
    }),
    // https://cdn.skypack.dev/-/@firebase/firestore@v3.4.3-A3UEhS17OZ2Vgra7HCZF/dist=es2019,mode=types/dist/index.d.ts
    new URLPattern(
      "https://cdn.skypack.dev/-/:org(@[^/]+)?/:pkg([^@/]+)@:ver([^-]+):hash/:mod*",
    ),
    // https://cdn.pika.dev/class-transformer@^0.2.3
    new URLPattern({
      protocol: "https",
      hostname: "cdn.pika.dev",
      pathname: "/:org(@[^/]+)?/:pkg([^@/]+){@:ver}?/:mod*",
      search: "*",
    }),
  ],
  /** Packages that are hosted on jsdeliver.net */
  "jsdeliver.net": [
    new URLPattern(
      "https://cdn.jsdelivr.net/npm/:org(@[^/]+)?/:pkg([^@/]+){@:ver}?/:mod*",
    ),
    new URLPattern(
      "https://cdn.jsdelivr.net/gh/:org/:pkg([^@/]+){@:ver}?/:mod*",
    ),
  ],
  /** Packages that are hosted on unpkg.com */
  "unpkg.com": [
    new URLPattern(
      "https://unpkg.com/:org(@[^/]+)?/:pkg([^@/]+){@:ver}?/:mod*",
    ),
  ],

  /** Not really a package/module host, but performs codegen for aws APIs. */
  "aws-api": [
    // https://aws-api.deno.dev/latest/services/sqs.ts
    new URLPattern({
      protocol: "https",
      hostname: "aws-api.deno.dev",
      pathname: "/:ver/services/:pkg{(\\.ts)}",
      search: "*",
    }),
  ],

  /** Not really a package/module host, but performs codegen for google cloud
   * APIs. */
  "googleapis": [
    new URLPattern({
      protocol: "https",
      hostname: "googleapis.deno.dev",
      pathname: "/v1/:pkg([^:]+){(:)}:ver{(\\.ts)}",
      search: "*",
    }),
  ],
};

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
  const resolved = resolveSpecifiers(specifier, redirects);
  const mod = modules.get(resolved);
  assert(mod, `cannot find module: ${resolved}`);
  if (mod.error) {
    errors.push({ specifier: resolved, error: mod.error });
    return;
  }
  if (mod.deps) {
    for (const [dep, { code, type }] of mod.deps) {
      if (code) {
        if (code.error) {
          errors.push({ specifier: code.specifier ?? dep, error: code.error });
        } else if (code.specifier) {
          if (isExternal(code.specifier, specifier)) {
            const parsedDep = parse(code.specifier);
            deps.set(depKey(parsedDep), parsedDep);
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
    ["module", module],
    ["module_version", version],
    ["module_entry", "/"],
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
      .createQuery("module_entry")
      .filter("docable", true)
      .hasAncestor(datastore.key(
        ["module", module],
        ["module_version", version],
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

async function analyze(
  module: string,
  version: string,
  force: boolean,
): Promise<[ModuleDependency[], DependencyError[]]> {
  if (!force && await isAnalyzed(module, version)) {
    dax.logStep(`Skipping ${module}@${version}. Already analyzed.`);
    return [[], []];
  }
  dax.logStep(`Analyzing dependencies of ${module}@${version}...`);
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
      dax.logError(`Cannot load identified import map: ${importMapSpecifier}`);
    }
  }
  const graphRoots = await getRoots(module, version);
  if (!graphRoots.length) {
    dax.logError("No root docable modules found.");
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
    dax.logLight(`  updated module version.`);
    return [[], []];
  }
  dax.logLight(`  generating module graph...`);
  const graph = await createGraph(graphRoots, { load, resolve });
  const { modules, redirects, roots } = graph.toJSON();
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
    dax.logLight(`  analyzing dependencies for "${root}"...`);
    analyzeDeps(deps, mods, redirects, errors, seen, root);
  }
  const mutations: Mutation[] = [];
  datastore = datastore ?? await getDatastore();
  const keyInit: KeyInit[] = [["module", module], ["module_version", version]];
  await clearAppend(
    datastore,
    mutations,
    ["info_page"],
    datastore.key(keyInit[0]),
  );
  await clearAppend(
    datastore,
    mutations,
    [MODULE_DEP_KIND, DEP_ERROR_KIND],
    datastore.key(...keyInit),
  );
  for (const error of errors) {
    objectSetKey(error, datastore.key(...keyInit, DEP_ERROR_KIND));
    mutations.push({ upsert: objectToEntity(error) });
  }
  for (const [key, value] of deps) {
    objectSetKey(value, datastore.key(...keyInit, [MODULE_DEP_KIND, key]));
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
  dax.logStep(`  Committing to datastore ${remaining} changes...`);
  try {
    for await (
      const res of datastore.commit(mutations, { transactional: false })
    ) {
      remaining -= res.mutationResults.length;
      dax.logLight(
        `    ${res.mutationResults.length} committed. ${remaining} to go.`,
      );
    }
  } catch (err) {
    if (err instanceof DatastoreError) {
      dax.logError(
        "DatastoreError",
        err.statusText,
        JSON.stringify(err.statusInfo, undefined, "  "),
      );
    } else {
      throw err;
    }
  }
  dax.logStep("Done.");
  return [[...deps.values()], errors];
}

export async function getAnalysis(
  module: Module,
  version: ModuleVersion,
  force = false,
): Promise<[ModuleDependency[], DependencyError[]]> {
  if (!force && await isAnalyzed(module.name, version.version)) {
    datastore = datastore ?? await getDatastore();
    const ancestor = datastore.key(
      ["module", module.name],
      ["module_version", version.version],
    );
    const depsQuery = datastore
      .createQuery(MODULE_DEP_KIND)
      .hasAncestor(ancestor);
    const deps = await datastore.query<ModuleDependency>(depsQuery);
    const errorQuery = datastore
      .createQuery(DEP_ERROR_KIND)
      .hasAncestor(ancestor);
    const errors = await datastore.query<DependencyError>(errorQuery);
    return [deps, errors];
  } else {
    return analyze(module.name, version.version, force);
  }
}

async function updateAll(force: boolean) {
  dax.logStep("Fetching all modules...");
  datastore = datastore ?? await getDatastore();
  const query = datastore
    .createQuery("module")
    .select(["name", "latest_version"]);
  const items = await datastore
    .query<{ name: string; latest_version: string | null }>(query);
  dax.logStep("Analyzing latest versions...");
  for (const { name, latest_version } of items) {
    if (latest_version) {
      await analyze(name, latest_version, force);
    }
  }
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["all", "force"],
  });
  if (args["all"]) {
    return updateAll(args["force"]);
  }
  let module = args["_"][0];
  if (!module) {
    return dax.logError("No module provided");
  } else {
    module = String(module);
  }
  let version = args["_"][1];
  let versions: string[];
  if (!version) {
    const [moduleEntry] = await lookup(module);
    if (!moduleEntry) {
      return dax.logError(`Could not find module: ${module}`);
    }
    if (!moduleEntry.latest_version) {
      return dax.logError(
        `No version supplied and "${module}" has no latest version.`,
      );
    }
    versions = [moduleEntry.latest_version];
  } else {
    version = String(version);
    if (version === "all") {
      const [moduleEntry] = await lookup(module);
      if (!moduleEntry) {
        return dax.logError(`Could not find module: ${module}`);
      }
      versions = [...moduleEntry.versions];
    } else {
      versions = [version];
    }
  }
  for (const version of versions) {
    await analyze(module, version, args["force"]);
  }
}

if (import.meta.main) {
  main();
}
