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
import {
  addNodes,
  DocNode,
  DocNodeNull,
  generateDocNodes,
  getImportMapSpecifier,
} from "./docs.ts";
import { loadModule } from "./modules.ts";
import { getDatastore } from "./store.ts";

const datastore = await getDatastore();

const args = parse(Deno.args, { boolean: ["no-doc", "dry-run"] });

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

const [mutations, , , , toDoc] = await loadModule(module, version);

if (args["dry-run"]) {
  console.log(toDoc);
  console.log(
    `%cWould have committed ${mutations.length} changes and documented ${toDoc.length} module versions.`,
    "color:yellow",
  );
  console.log("%cDone.", "color:green");
  Deno.exit();
}

if (!args["no-doc"]) {
  for (const [module, version, paths] of toDoc) {
    const importMap = await getImportMapSpecifier(module, version);
    for (const path of paths) {
      console.log(
        `%cGenerating%c doc nodes for: %c${module}@${version}${path}%c...`,
        "color:green",
        "color:none",
        "color:cyan",
        "color:none",
      );
      let docNodes: (DocNode | DocNodeNull)[] = [];
      try {
        docNodes = await generateDocNodes(
          module,
          version,
          path.slice(1),
          importMap,
        );
      } catch (e) {
        const msg = e instanceof Error
          ? `${e.message}\n\n${e.stack}`
          : String(e);
        console.error(
          `Error generating doc nodes for "${module}@${version}${path}":\n${msg}`,
        );
      }
      addNodes(
        datastore,
        mutations,
        docNodes.length ? docNodes : [{ kind: "null" }],
        [
          ["module", module],
          ["module_version", version],
          ["module_entry", path],
        ],
      );
    }
  }
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
