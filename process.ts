// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Contains the "process" sub-system of the API server which maintains an in
 * memory queue of long running tasks and orchestrates the execution of the
 * tasks.
 *
 * @module
 */

import {
  DatastoreError,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Mutation } from "google_datastore/types";

import { getDenoLandApp, Source } from "./algolia.ts";
import { analyze } from "./analysis.ts";
import { getDatastore } from "./auth.ts";
import { clear } from "./cache.ts";
import { indexes, kinds } from "./consts.ts";
import {
  addNodes,
  commitDocNodes,
  commitDocPage,
  commitModuleIndex,
  commitNav,
  commitSourcePage,
  commitSymbolIndex,
  type DocNode,
  type DocNodeNull,
  generateDocNodes,
  getImportMapSpecifier,
  isDocable,
  type LegacyIndex,
  type ModuleIndex,
} from "./docs.ts";
import {
  clearModule,
  getIndexedModules,
  getModuleMetaVersions,
  getSubdirs,
  getVersionMeta,
  isIndexedDir,
  RE_IGNORED_MODULE,
  RE_PRIVATE_PATH,
} from "./modules.ts";
import type {
  DocPage,
  DocPageNavItem,
  DocWorkItem,
  Module,
  ModuleVersion,
  SourcePage,
  SymbolIndexItem,
} from "./types.d.ts";
import { assert } from "./util.ts";
import { ApiModuleData } from "./types.d.ts";

interface TaskBase {
  kind: string;
}

interface ModuleBase {
  module: string;
  version: string;
  path: string;
  docNodes: (DocNode | DocNodeNull)[];
}

interface CommitTask extends TaskBase, ModuleBase {
  kind: "commit";
}

interface LegacyIndexBase {
  module: string;
  version: string;
  path: string;
  index: LegacyIndex;
}

interface ModuleIndexBase {
  module: string;
  version: string;
  path: string;
  index: ModuleIndex;
}

interface CommitIndexTask extends TaskBase, ModuleIndexBase {
  kind: "commitIndex";
}

interface CommitSourcePageTask extends TaskBase {
  kind: "commitSourcePage";
  module: string;
  version: string;
  path: string;
  sourcePage: SourcePage;
}

interface CommitDocPageTask extends TaskBase {
  kind: "commitDocPage";
  module: string;
  version: string;
  path: string;
  symbol: string;
  docPage: DocPage;
}

interface CommitMutations extends TaskBase {
  kind: "commitMutations";
  mutations: Mutation[];
}

interface CommitSymbolIndexTask extends TaskBase {
  kind: "commitSymbolIndex";
  module: string;
  version: string;
  path: string;
  items: SymbolIndexItem[];
}

interface CommitNavTask extends TaskBase {
  kind: "commitNav";
  module: string;
  version: string;
  path: string;
  nav: DocPageNavItem[];
}

interface LoadTask extends TaskBase {
  kind: "load";
  module: string;
  version: string;
}

interface AlgoliaTask extends TaskBase {
  kind: "algolia";
  module: Module;
  version: ModuleVersion;
}

type TaskDescriptor =
  | LoadTask
  | CommitTask
  | AlgoliaTask
  | CommitSourcePageTask
  | CommitDocPageTask
  | CommitIndexTask
  | CommitMutations
  | CommitSymbolIndexTask
  | CommitNavTask;

let uid = 1;

const queue: [id: number, desc: TaskDescriptor][] = [];

let processing = false;

function taskCommitDocNodes(
  id: number,
  { module, version, path, docNodes }: CommitTask,
) {
  console.log(
    `[${id}]: %cCommitting%c doc nodes for %c"${module}@${version}/${path}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  return commitDocNodes(id, module, version, path, docNodes);
}

function taskCommitModuleIndex(
  id: number,
  { module, version, path, index }: CommitIndexTask,
) {
  console.log(
    `[${id}]: %cCommitting%c module index for %c"${module}@${version}/${path}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  return commitModuleIndex(id, module, version, path, index);
}

async function taskCommitMutations(id: number, { mutations }: CommitMutations) {
  console.log(
    `[${id}]: %cCommitting %c${mutations.length}%c mutations...`,
    "color:green",
    "color:cyan",
    "color:none",
  );
  const datastore = await getDatastore();
  try {
    for await (
      const batch of datastore.commit(mutations, { transactional: false })
    ) {
      console.log(
        `[${id}]: %cCommitted %c${batch.mutationResults.length}%c mutations.`,
        "color:green",
        "color:cyan",
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
  }
}

function taskCommitCodePage(
  id: number,
  { module, version, path, sourcePage }: CommitSourcePageTask,
) {
  console.log(
    `[${id}]: %cCommitting%c code page for %c"${module}@${version}${path}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  return commitSourcePage(id, module, version, path, sourcePage);
}

function taskCommitDocPage(
  id: number,
  { module, version, path, symbol, docPage }: CommitDocPageTask,
) {
  console.log(
    `[${id}]: %cCommitting%c doc page for %c"${module}@${version}${path}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  return commitDocPage(id, module, version, path, symbol, docPage);
}

function taskCommitSymbolIndex(
  id: number,
  { module, version, path, items }: CommitSymbolIndexTask,
) {
  console.log(
    `[${id}]: %cCommitting%c symbol index for %c"${module}@${version}${path}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  return commitSymbolIndex(id, module, version, path, items);
}

function taskCommitNav(
  id: number,
  { module, version, path, nav }: CommitNavTask,
) {
  console.log(
    `[${id}]: %cCommitting%c nav index for %c"${module}@${version}${path}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  return commitNav(id, module, version, path, nav);
}

async function taskLoadModule(
  id: number,
  { module, version }: LoadTask,
): Promise<void> {
  console.log(
    `[${id}]: %cLoading%c module %c"${module}@${version}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  const datastore = await getDatastore();
  const moduleDataKey = datastore.key([kinds.LEGACY_MODULES, module]);
  const result = await datastore.lookup(moduleDataKey);
  const entity = result.found?.[0].entity;
  assert(entity, "Module data missing");
  const moduleData = entityToObject<ApiModuleData>(result.found![0].entity);
  const moduleMetaVersion = await getModuleMetaVersions(module);
  assert(moduleMetaVersion, "module version data missing");

  const mutations: Mutation[] = [];

  const moduleKey = datastore.key(
    [kinds.MODULE_KIND, module],
  );

  let moduleItem: Module;
  const lookupResult = await datastore.lookup(moduleKey);
  if (lookupResult.found) {
    assert(lookupResult.found.length === 1, "More than one item found.");
    moduleItem = entityToObject(lookupResult.found[0].entity);
    moduleItem.description = moduleData.description;
    moduleItem.versions = moduleMetaVersion.versions;
    moduleItem.latest_version = moduleMetaVersion.latest;
  } else {
    moduleItem = {
      name: module,
      description: moduleData.description,
      versions: moduleMetaVersion.versions,
      latest_version: moduleMetaVersion.latest,
    };
    objectSetKey(moduleItem, moduleKey);
  }
  mutations.push({ upsert: objectToEntity(moduleItem) });

  const versionMeta = await getVersionMeta(module, version);
  assert(versionMeta, `unable to load meta data for ${module}@${version}`);
  const moduleVersion: ModuleVersion = {
    name: module,
    description: moduleItem.description,
    version,
    uploaded_at: new Date(versionMeta.uploaded_at),
    upload_options: versionMeta.upload_options,
  };
  const versionKey = datastore.key(
    [kinds.MODULE_KIND, moduleItem.name],
    [kinds.MODULE_VERSION_KIND, version],
  );
  objectSetKey(moduleVersion, versionKey);
  mutations.push({ upsert: objectToEntity(moduleVersion) });
  const { directory_listing: listing } = versionMeta;
  const toDoc = new Set<string>();
  for (const moduleEntry of listing) {
    if (moduleEntry.path === "") {
      moduleEntry.path = "/";
    }
    if (moduleEntry.type === "dir") {
      moduleEntry.dirs = getSubdirs(moduleEntry.path, listing);
    } else if (isDocable(moduleEntry.path)) {
      moduleEntry.docable = true;
      if (
        !RE_IGNORED_MODULE.test(moduleEntry.path) &&
        !RE_PRIVATE_PATH.test(moduleEntry.path)
      ) {
        toDoc.add(moduleEntry.path);
      }
    }
    if (isIndexedDir(moduleEntry)) {
      [moduleEntry.index, moduleEntry.default] = getIndexedModules(
        moduleEntry.path,
        listing,
      );
    }
    const moduleEntryKey = datastore.key(
      [kinds.MODULE_KIND, moduleItem.name],
      [kinds.MODULE_VERSION_KIND, moduleVersion.version],
      [kinds.MODULE_ENTRY_KIND, moduleEntry.path],
    );
    objectSetKey(moduleEntry, moduleEntryKey);
    mutations.push({ upsert: objectToEntity(moduleEntry) });
  }

  await clearModule(
    datastore,
    mutations,
    moduleItem.name,
    moduleVersion.version,
  );

  const docWorkItem: DocWorkItem = {
    module: moduleItem.name,
    version: moduleVersion.version,
    to_doc: [...toDoc],
  };
  objectSetKey(
    docWorkItem,
    datastore.key([kinds.DOC_WORK_ITEM, moduleItem.name]),
  );
  mutations.push({ upsert: objectToEntity(docWorkItem) });

  let remaining = mutations.length;
  console.log(
    `[${id}]: %cCommitting %c${remaining}%c changes...`,
    "color:green",
    "color:yellow",
    "color:none",
  );
  for await (
    const res of datastore.commit(mutations, { transactional: false })
  ) {
    remaining -= res.mutationResults.length;
    console.log(
      `[${id}]: %cCommitted %c${res.mutationResults.length}%c changes. %c${remaining}%c to go.`,
      "color:green",
      "color:yellow",
      "color:none",
      "color:yellow",
      "color:none",
    );
  }

  if (toDoc.size >= 2000) {
    // the module has too many modules, skipping, will be processed via batch
    // later.
    console.warn(
      `[${id}]: %cToo many%c modules. Skipping.`,
      "color:red",
      "color:none",
    );
  }

  const docMutations: Mutation[] = [];

  const importMap = await getImportMapSpecifier(
    moduleItem.name,
    moduleVersion.version,
  );
  const docNodes = new Map<string, DocNode[]>();
  for (const path of toDoc) {
    console.log(
      `[${id}]: %cGenerating%c doc nodes for: %c${moduleItem.name}@${moduleVersion.version}${path}%c...`,
      "color:green",
      "color:none",
      "color:cyan",
      "color:none",
    );
    let nodes: DocNode[] = [];
    try {
      nodes = await generateDocNodes(
        moduleItem.name,
        moduleVersion.version,
        path.slice(1),
        importMap,
      );
      docNodes.set(path, nodes);
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n\n${e.stack}` : String(e);
      console.error(
        `[${id}]: Error generating doc nodes for "${path}":\n${msg}`,
      );
    }
    addNodes(
      datastore,
      docMutations,
      nodes.length ? nodes : [{ kind: "null" }],
      [
        [kinds.MODULE_KIND, moduleItem.name],
        [kinds.MODULE_VERSION_KIND, moduleVersion.version],
        [kinds.MODULE_ENTRY_KIND, path],
      ],
    );
  }

  docMutations.push({
    delete: datastore.key([kinds.DOC_WORK_ITEM, moduleItem.name]),
  });

  // Upload doc nodes to datastore.

  remaining = docMutations.length;
  console.log(
    `[${id}]: %cCommitting %c${remaining}%c doc nodes...`,
    "color:green",
    "color:yellow",
    "color:none",
  );
  for await (
    const res of datastore.commit(docMutations, { transactional: false })
  ) {
    remaining -= res.mutationResults.length;
    console.log(
      `[${id}]: %cCommitted %c${res.mutationResults.length}%c doc nodes. %c${remaining}%c to go.`,
      "color:green",
      "color:yellow",
      "color:none",
      "color:yellow",
      "color:none",
    );
  }
  clear(module);

  // perform dependency analysis
  await analyze(module, version, true);
  if (docNodes.size) {
    enqueue({
      kind: "algolia",
      module: moduleItem,
      version: moduleVersion,
    });
  }
}

let moduleIndex;
async function taskAlgolia(
  id: number,
  { module, version }: AlgoliaTask,
) {
  console.log(
    `[${id}]: %cUploading%c %c"${version.name}@${version.version}"%c to algolia...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );

  moduleIndex ??= (await getDenoLandApp()).initIndex(indexes.MODULE_INDEX);
  await moduleIndex.saveObject({
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
  }).wait();

  console.log(
    `[${id}]: %Uploaded%c %c"${version.name}@${version.version}"%c to algolia...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
}

function process(id: number, task: TaskDescriptor): Promise<void> {
  switch (task.kind) {
    case "algolia":
      return taskAlgolia(id, task);
    case "commit":
      return taskCommitDocNodes(id, task);
    case "commitIndex":
      return taskCommitModuleIndex(id, task);
    case "commitMutations":
      return taskCommitMutations(id, task);
    case "commitSourcePage":
      return taskCommitCodePage(id, task);
    case "commitDocPage":
      return taskCommitDocPage(id, task);
    case "commitNav":
      return taskCommitNav(id, task);
    case "commitSymbolIndex":
      return taskCommitSymbolIndex(id, task);
    case "load":
      return taskLoadModule(id, task);
    default:
      console.error(
        `%cERROR%c: [${id}]: unexpected task kind: %c${
          (task as TaskBase).kind
        }`,
        "color:red",
        "color:none",
        "color:yellow",
      );
      return Promise.resolve();
  }
}

async function drainQueue() {
  if (processing) {
    return;
  }
  processing = true;
  const item = queue.shift();
  if (!item) {
    return;
  }
  const [id, task] = item;
  console.log(
    `[${id}]: %cProcessing %ctask %c"${task.kind}"%c...`,
    "color:green",
    "color:none",
    "color:yellow",
    "color:none",
  );
  const startMark = `task ${task.kind} ${id}`;
  performance.mark(startMark);
  await process(id, task);
  const measure = performance.measure(`duration ${startMark}`, startMark);
  console.log(
    `[${id}]: %cFinished%c task %c"${task.kind}"%c in %c${
      measure.duration.toFixed(2)
    }ms%c.`,
    "color:green",
    "color:none",
    "color:yellow",
    "color:none",
    "color:cyan",
    "color:none",
  );
  if (queue.length) {
    queueMicrotask(drainQueue);
  }
  processing = false;
}

/** Enqueue a long running task and schedule draining of the queue. */
export function enqueue(desc: TaskDescriptor): number {
  const id = uid++;
  queue.push([id, desc]);
  queueMicrotask(drainQueue);
  return id;
}
