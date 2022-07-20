// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { DatastoreError, objectSetKey, objectToEntity } from "google_datastore";
import type { Mutation } from "google_datastore/types";

import {
  commitDocNodes,
  commitDocPage,
  commitModuleIndex,
  commitNav,
  commitSymbolIndex,
  type DocNode,
  type DocNodeNull,
  type LegacyIndex,
  type ModuleIndex,
  type SymbolIndex,
} from "./docs.ts";
import { loadModule } from "./modules.ts";
import { getAlgolia, getDatastore } from "./store.ts";
import type { DocPage, DocPageNavItem } from "./types.d.ts";

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
      `[${id}]: %cCommitted $c${batch.mutationResults.length}$c mutations.`,
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
  const [mutations] = await loadModule(module, version, undefined, true);
  let remaining = mutations.length;
  console.log(
    `[${id}]: %cCommitting %c${remaining}%c changes...`,
    "color:green",
    "color:yellow",
    "color:none",
  );
  const datastore = await getDatastore();
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
