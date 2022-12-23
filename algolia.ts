// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Utilities for uploading and managing algolia indexes.
 *
 * @module
 */

import { createFetchRequester } from "@algolia/requester-fetch";
import algoliasearch, { type SearchClient } from "algoliasearch";

import { algoliaKeys, readyPromise } from "./auth.ts";

let denoLandApp: SearchClient | undefined;
let searchOnlyClient: SearchClient | undefined;

export enum Source {
  StandardLibraryDefault = 200,
  ThirdPartyDefault = 400,
}
export async function getDenoLandApp(): Promise<SearchClient> {
  if (denoLandApp) {
    return denoLandApp;
  }
  const requester = createFetchRequester();
  await readyPromise;
  return denoLandApp = algoliasearch(
    algoliaKeys.appId,
    algoliaKeys.apiKey,
    { requester },
  );
}

/** Resolves with a search only client against algolia */
export async function getSearchClient(): Promise<SearchClient> {
  if (searchOnlyClient) {
    return searchOnlyClient;
  }
  const requester = createFetchRequester();
  await readyPromise;
  return searchOnlyClient = algoliasearch(
    algoliaKeys.appId,
    algoliaKeys.searchApiKey,
    { requester },
  );
}
