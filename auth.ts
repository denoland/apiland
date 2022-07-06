// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Load service account information from a `.env` if present and export the
 * service account information for connecting to the Google Datastore.
 *
 * @module
 */

import { type Context } from "acorn";

import { config } from "std/dotenv/mod.ts";

await config({ export: true });

const privateKey = Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "";
const endpointToken = Deno.env.get("APILAND_AUTH_TOKEN") ?? "";
const authHeaderValue = `bearer ${endpointToken}`;

/** The service account keys used when connecting to the Google Datastore. */
export let keys: {
  client_email: string;
  private_key: string;
  private_key_id: string;
  project_id: string;
};
/** Algolia credentials required to upload docNodes to algolia. */
export let algoliaKeys: { appId: string; apiKey: string };

let readyResolve: (value?: unknown) => void;
export const readyPromise = new Promise((res) => {
  readyResolve = res;
});

(async () => {
  await config({ export: true });
  readyResolve!();
  keys = {
    client_email: Deno.env.get("GOOGLE_CLIENT_EMAIL") ?? "",
    private_key:
      (privateKey.startsWith(`"`)
        ? JSON.parse(privateKey)
        : privateKey) as string,
    private_key_id: Deno.env.get("GOOGLE_PRIVATE_KEY_ID") ?? "",
    project_id: Deno.env.get("GOOGLE_PROJECT_ID") ?? "",
  };

  algoliaKeys = {
    appId: Deno.env.get("ALGOLIA_APP_ID") ?? "",
    apiKey: Deno.env.get("ALGOLIA_API_KEY") ?? "",
  };
})();

export const endpointAuth = {
  authorize(ctx: Context) {
    // TODO(@kitsonk) we need better authorization than this...
    if (
      ctx.request.headers.get("authorization")?.toLowerCase() ===
        authHeaderValue
    ) {
      return true;
    }
  },
};
