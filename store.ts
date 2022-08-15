// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

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

export async function getAlgoliaKeys(): Promise<typeof algoliaKeys> {
  await readyPromise;
  return algoliaKeys;
}
