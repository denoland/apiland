// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Load service account information from a `.env` if present and export the
 * service account information for connecting to the Google Datastore.
 *
 * @module
 */

import { config } from "https://deno.land/std@0.142.0/dotenv/mod.ts";

await config({ export: true });

const privateKey = Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "";

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
