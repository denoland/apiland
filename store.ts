// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import "xhr"; // algoliasearch depends on XMLHttpRequest().
import algoliasearch from "algoliasearch";
import { Datastore } from "google_datastore";

import { algoliaKeys, keys, readyPromise } from "./auth.ts";

let datastore: Datastore | undefined;

export async function getDatastore(): Promise<Datastore> {
  if (datastore) {
    return datastore;
  }
  await readyPromise;
  return datastore = new Datastore(keys);
}

let algolia: ReturnType<typeof algoliasearch> | undefined;

export async function getAlgolia(): Promise<ReturnType<typeof algoliasearch>> {
  if (algolia) {
    return algolia;
  }
  await readyPromise;
  return algolia = algoliasearch(algoliaKeys.appId, algoliaKeys.apiKey);
}
