// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { commitDocNodes, type DocNode, type DocNodeNull } from "./docs.ts";
import { loadModule } from "./modules.ts";
import { algolia, datastore } from "./store.ts";

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

interface LoadTask extends TaskBase {
  kind: "load";
  module: string;
  version: string;
}

interface AlgoliaTask extends TaskBase, ModuleBase {
  kind: "algolia";
}

type TaskDescriptor = LoadTask | CommitTask | AlgoliaTask;

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
  const mutations = await loadModule(module, version, true);
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

function taskAlgolia(
  id: number,
  { module, version, docNodes }: AlgoliaTask,
) {
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
