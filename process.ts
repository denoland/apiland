// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

interface TaskBase {
  kind: string;
}

interface LoadTask extends TaskBase {
  kind: "load";
  module: string;
  version: string;
}

type TaskDescriptor = LoadTask;

let uid = 1;

const queue: [id: number, desc: TaskDescriptor][] = [];

let processing = false;

function process(id: number, task: TaskDescriptor): Promise<void> {
  console.log(
    `%cProcessing %ctask: %c${task.kind}[${id}]`,
    "color:green",
    "color:none",
    "color:yellow",
  );
  switch (task.kind) {
    case "load":
      console.log(`module: ${task.module} version: ${task.version}`);
      return Promise.resolve();
    default:
      console.error(
        `%cERROR%c: unexpected task kind: %c${task.kind}`,
        "color:red",
        "color:none",
        "color:yellow",
      );
      return Promise.resolve();
  }
}

async function checkQueue() {
  if (processing) {
    return;
  }
  processing = true;
  const item = queue.shift();
  if (!item) {
    return;
  }
  const [id, task] = item;
  await process(id, task);
  if (queue.length) {
    queueMicrotask(checkQueue);
  }
  processing = false;
}

export function enqueue(desc: TaskDescriptor): number {
  const id = uid++;
  queue.push([id, desc]);
  queueMicrotask(checkQueue);
  return id;
}
