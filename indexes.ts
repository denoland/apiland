// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * A command line script which creates the composite indexes used by the server.
 *
 * @module
 */

import { parse } from "std/flags/mod.ts";
import { getDatastore } from "./store.ts";

const args = parse(Deno.args, { boolean: ["create"], string: ["delete"] });

const datastore = await getDatastore();

if (args["delete"]) {
  const indexId: string = args["delete"];
  console.log(
    `%cDeleting%c index %c"${indexId}"%c...`,
    "color:yellow",
    "color:none",
    "color:cyan",
    "color:none",
  );
  const response = await datastore.indexes.delete(indexId);

  if (response.error) {
    console.error("%cError%c creating index:", "color:red", "color:none");
    console.error(JSON.stringify(response.error));
  } else {
    console.log("%cSuccess%c.", "color:green", "color:none");
  }

  console.log("%cDone%c.", "color:green", "color:none");
} else if (args["create"]) {
  console.log("%cCreating%c composite indexes...", "color:green", "color:none");

  /* This is commented out, because composite indexes must have all fields
   * present in the response, and jsDoc is optional, and so most queries simply
   * don't work, but in the future if there is a good index, we can use this
   * as an example.
   */
  // console.log(
  //   "%cCreate%c doc_node symbol index...",
  //   "color:green",
  //   "color:none",
  // );
  // const response = await datastore.indexes.create({
  //   ancestor: "ALL_ANCESTORS",
  //   kind: "doc_node",
  //   properties: [{
  //     direction: "ASCENDING",
  //     name: "name",
  //   }, {
  //     direction: "ASCENDING",
  //     name: "kind",
  //   }, {
  //     direction: "ASCENDING",
  //     name: "jsDoc",
  //   }],
  // });

  // if (response.error) {
  //   console.error("%cError%c creating index:", "color:red", "color:none");
  //   console.error(JSON.stringify(response.error));
  // } else {
  //   console.log("%cSuccess%c.", "color:green", "color:none");
  // }

  console.log("%cDone%c.", "color:green", "color:none");
} else {
  const { indexes } = await datastore.indexes.list({ pageSize: 0 });
  // deno-lint-ignore no-explicit-any
  const output: Record<string, any> = {};
  for (const { indexId, state, ancestor, kind, properties } of indexes) {
    output[indexId] = {
      state,
      kind,
      ancestor: ancestor === "ALL_ANCESTORS",
      properties: properties.map(({ name, direction }) =>
        `${name}${direction === "ASCENDING" ? "" : " [desc]"}`
      ).join(", "),
    };
  }
  console.log("%cIndexes%c:", "color:green", "color:none");
  console.table(output);
}
