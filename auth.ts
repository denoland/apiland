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

/** The service account keys used when connecting to the Google Datastore. */
export const keys = {
  client_email: Deno.env.get("GOOGLE_CLIENT_EMAIL") ?? "",
  private_key:
    (privateKey.startsWith(`"`)
      ? JSON.parse(privateKey)
      : privateKey) as string,
  private_key_id: Deno.env.get("GOOGLE_PRIVATE_KEY_ID") ?? "",
  project_id: Deno.env.get("GOOGLE_PROJECT_ID") ?? "",
};
