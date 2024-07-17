// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Utilities for uploading and managing orama indexes.
 *
 * @module
 */

import { CloudManager, OramaClient } from "orama";
import type { IndexManager } from "orama/types";

import { oramaKeys, readyPromise } from "./auth.ts";

let oramaManager: IndexManager | undefined;
let searchClient: OramaClient | undefined;

export enum Source {
  StandardLibraryDefault = 200,
  ThirdPartyDefault = 400,
}
export async function getDenoLandApp(): Promise<IndexManager> {
  if (oramaManager) {
    return oramaManager;
  }
  await readyPromise;
  return oramaManager = new CloudManager({
    api_key: oramaKeys.privateApiKey,
  }).index(oramaKeys.privateIndex);
}

/** Resolves with a search only client against orama */
export async function getSearchClient(): Promise<OramaClient> {
  if (searchClient) {
    return searchClient;
  }
  await readyPromise;
  return searchClient = new OramaClient({
    endpoint: oramaKeys.endpoint,
    api_key: oramaKeys.publicApiKey,
  });
}
