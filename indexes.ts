// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * A command line script which creates the composite indexes used by the server.
 *
 * @module
 */

import dax from "dax";
import { parse } from "std/flags/mod.ts";
import { getDatastore } from "./store.ts";

const args = parse(Deno.args, { boolean: ["create"], string: ["delete"] });

const datastore = await getDatastore();

if (args["delete"]) {
  const indexId: string = args["delete"];
  dax.logStep(`Deleting index "${indexId}"...`);
  const response = await datastore.indexes.delete(indexId);

  if (response.error) {
    dax.logError("Error deleting index:", JSON.stringify(response.error));
  } else {
    dax.logStep("Success.");
  }

  dax.logStep("Done.");
} else if (args["create"]) {
  dax.logStep("Creating composite indexes...");

  dax.logStep("  Create module index...");
  let response = await datastore.indexes.create({
    ancestor: "NONE",
    kind: "module",
    properties: [{
      direction: "ASCENDING",
      name: "name",
    }, {
      direction: "ASCENDING",
      name: "latest_version",
    }],
  });

  if (response.error) {
    dax.logError("Error creating index:", JSON.stringify(response.error));
  } else {
    dax.logStep("Success.");
  }

  dax.logStep("  Create doc node index...");
  response = await datastore.indexes.create({
    ancestor: "NONE",
    kind: "doc_node",
    properties: [{
      direction: "ASCENDING",
      name: "name",
    }, {
      direction: "ASCENDING",
      name: "kind",
    }, {
      direction: "ASCENDING",
      name: "jsDoc",
    }],
  });

  if (response.error) {
    dax.logError("Error creating index:", JSON.stringify(response.error));
  } else {
    dax.logStep("Success.");
  }

  dax.logStep("Done.");
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
  dax.logStep("Indexes:");
  console.table(output);
}
