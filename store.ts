// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import "xhr"; // algoliasearch depends on XMLHttpRequest().
import algoliasearch from "algoliasearch";
import { Datastore } from "google_datastore";

import { algoliaKeys, keys } from "./auth.ts";

export const datastore = new Datastore(keys);
export const algolia = algoliasearch(algoliaKeys.appId, algoliaKeys.apiKey);
