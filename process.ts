// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import {
  DatastoreError,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Mutation } from "google_datastore/types";

import {
  addNodes,
  commitDocNodes,
  commitDocPage,
  commitModuleIndex,
  commitNav,
  commitSymbolIndex,
  type DocNode,
  type DocNodeNull,
  generateDocNodes,
  getImportMapSpecifier,
  isDocable,
  type LegacyIndex,
  type ModuleIndex,
  type SymbolIndex,
} from "./docs.ts";
import {
  getIndexedModules,
  getModuleData,
  getModuleMetaVersions,
  getSubdirs,
  getVersionMeta,
  isIndexedDir,
  RE_IGNORED_MODULE,
  RE_PRIVATE_PATH,
} from "./modules.ts";
import { getAlgolia, getDatastore } from "./store.ts";
import type {
  DocPage,
  DocPageNavItem,
  Module,
  ModuleVersion,
} from "./types.d.ts";
import { assert } from "./util.ts";

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

interface CommitLegacyIndex extends TaskBase, LegacyIndexBase {
  kind: "commitLegacyIndex";
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

interface SymbolIndexBase {
  module: string;
  version: string;
  path: string;
  index: SymbolIndex;
}

interface CommitSymbolIndexTask extends TaskBase, SymbolIndexBase {
  kind: "commitSymbolIndex";
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

interface AlgoliaTask extends TaskBase, ModuleBase {
  kind: "algolia";
}

type TaskDescriptor =
  | LoadTask
  | CommitTask
  | AlgoliaTask
  | CommitDocPageTask
  | CommitIndexTask
  | CommitLegacyIndex
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

async function taskCommitLegacyIndex(
  id: number,
  { module, version, path, index }: CommitLegacyIndex,
) {
  console.log(
    `[${id}]: %cCommitting%c legacy module index for %c"${module}@${version}${path}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  const datastore = await getDatastore();
  const key = datastore.key(
    ["module", module],
    ["module_version", version],
    ["legacy_index", path],
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
}

function taskCommitSymbolIndex(
  id: number,
  { module, version, path, index }: CommitSymbolIndexTask,
) {
  console.log(
    `[${id}]: %cCommitting%c symbol index for %c"${module}@${version}${path}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  return commitSymbolIndex(id, module, version, path, index);
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
  const moduleData = await getModuleData(module);
  assert(moduleData, "module data missing");
  const moduleMetaVersion = await getModuleMetaVersions(module);
  assert(moduleMetaVersion, "module version data missing");

  const mutations: Mutation[] = [];
  const datastore = await getDatastore();

  const moduleKey = datastore.key(
    ["module", module],
  );

  let moduleItem: Module;
  const lookupResult = await datastore.lookup(moduleKey);
  if (lookupResult.found) {
    assert(lookupResult.found.length === 1, "More than one item found.");
    moduleItem = entityToObject(lookupResult.found[0].entity);
    moduleItem.description = moduleData.data.description;
    moduleItem.versions = moduleMetaVersion.versions;
    moduleItem.latest_version = moduleMetaVersion.latest;
    moduleItem.star_count = moduleData.data.star_count;
  } else {
    moduleItem = {
      name: module,
      description: moduleData.data.description,
      versions: moduleMetaVersion.versions,
      latest_version: moduleMetaVersion.latest,
      star_count: moduleData.data.star_count,
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
    ["module", moduleItem.name],
    ["module_version", version],
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
      ["module", moduleItem.name],
      ["module_version", moduleVersion.version],
      ["module_entry", moduleEntry.path],
    );
    objectSetKey(moduleEntry, moduleEntryKey);
    mutations.push({ upsert: objectToEntity(moduleEntry) });
  }

  // because we are upserting the previous keys, we need to clear out any
  // doc_nodes that might be in the datastore to ensure we are starting with
  // a clean slate, since we can't upsert doc_nodes, as they aren't keyed by
  // a unique name.
  const docNodeQuery = datastore
    .createQuery("doc_node")
    .hasAncestor(versionKey)
    .select("__key__");

  for await (const { key } of datastore.streamQuery(docNodeQuery)) {
    if (key) {
      mutations.push({ delete: key });
    }
  }

  const importMap = await getImportMapSpecifier(
    moduleItem.name,
    moduleVersion.version,
  );
  for (const path of toDoc) {
    console.log(
      `[${id}]: %cGenerating%c doc nodes for: %c${path}%c...`,
      "color:green",
      "color:none",
      "color:cyan",
      "color:none",
    );
    let docNodes: (DocNode | DocNodeNull)[] = [];
    try {
      docNodes = await generateDocNodes(
        moduleItem.name,
        moduleVersion.version,
        path.slice(1),
        importMap,
      );
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n\n${e.stack}` : String(e);
      console.error(
        `[${id}]: Error generating doc nodes for "${path}":\n${msg}`,
      );
    }
    addNodes(
      datastore,
      mutations,
      docNodes.length ? docNodes : [{ kind: "null" }],
      [
        ["module", moduleItem.name],
        ["module_version", moduleVersion.version],
        ["module_entry", path],
      ],
    );
  }

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
}

async function taskAlgolia(
  id: number,
  { module, version, docNodes }: AlgoliaTask,
) {
  const algolia = await getAlgolia();
  const index = algolia.initIndex("deno_modules");
  console.log(
    `[${id}]: %Indexing%c module %c"${module}@${version}"%c...`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
  );
  // deno-lint-ignore no-explicit-any
  const docNodesWithIDs: Record<string, any>[] = [];
  docNodes.map((node) => {
    if (node.kind !== "null") {
      const location = node.location;
      const fullPath = `${location.filename}:${location.line}:${location.col}`;
      const objectID = `${fullPath}_${node.kind}_${node.name}`;
      docNodesWithIDs.push({
        objectID,
        ...node,
      });
    }
  });
  index.saveObjects(docNodesWithIDs).wait();
  console.log(
    `[${id}]: %cIndexed%c module %c${module}@${version}%c.`,
    "color:green",
    "color:none",
    "color:yellow",
    "color:none",
  );
}

function process(id: number, task: TaskDescriptor): Promise<void> {
  switch (task.kind) {
    case "commit":
      return taskCommitDocNodes(id, task);
    case "commitIndex":
      return taskCommitModuleIndex(id, task);
    case "commitLegacyIndex":
      return taskCommitLegacyIndex(id, task);
    case "commitMutations":
      return taskCommitMutations(id, task);
    case "commitSymbolIndex":
      return taskCommitSymbolIndex(id, task);
    case "commitDocPage":
      return taskCommitDocPage(id, task);
    case "commitNav":
      return taskCommitNav(id, task);
    case "load":
      return taskLoadModule(id, task);
    case "algolia":
      return Promise.resolve(taskAlgolia(id, task));
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
