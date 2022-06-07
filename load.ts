// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** A command line utility to migrate data from the "legacy" APIs to the Google
 * Datastore.
 *
 * ### Example
 *
 * ```
 * > deno task load oak all
 * ```
 *
 * @module
 */

import { parse } from "std/flags/mod.ts";

import { loadModule } from "./modules.ts";
import { datastore } from "./store.ts";

const args = parse(Deno.args, { boolean: ["doc", "dry-run"] });

function assert(cond: unknown, message = "Assertion failed."): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

const module = String(args["_"][0]);
const version = String(args["_"][1]);
assert(module, "A module name was not provided.");

console.log(
  `%cLoading %c${module}%c...`,
  "color:green",
  "color:yellow",
  "color:none",
);

const mutations = await loadModule(module, version);

if (args["dry-run"]) {
  console.log(
    `%cWould have committed ${mutations.length} changes.`,
    "color:yellow",
  );
  console.log("%cDone.", "color:green");
  Deno.exit();
}

let remaining = mutations.length;
console.log(
  `%cCommitting %c${remaining}%c changes...`,
  "color:green",
  "color:yellow",
  "color:none",
);
for await (const res of datastore.commit(mutations, { transactional: false })) {
  remaining -= res.mutationResults.length;
  console.log(
    `%cCommitted %c${res.mutationResults.length}%c changes. %c${remaining}%c to go.`,
    "color:green",
    "color:yellow",
    "color:none",
    "color:yellow",
    "color:none",
  );
}

console.log("%cDone.", "color:green");
