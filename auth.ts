// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Load service account information from a `.env` if present and export the
 * service account information for connecting to the Google Datastore.
 *
 * @module
 */

import { type Context } from "acorn";
import {
  DatastoreError,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import { config } from "std/dotenv/mod.ts";
import { getDatastore } from "./store.ts";

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
  const privateKey = Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "";
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

interface TokenManagerJson {
  data: Record<string, { token: string; created: Date | string }>;
}

class TokenManager {
  #dirty = false;
  #tokens = new Map<string, string>();
  #ids = new Map<string, { token: string; created: Date }>();

  get dirty(): boolean {
    return this.#dirty;
  }

  constructor(init?: TokenManagerJson) {
    if (init) {
      for (const [id, { token, created }] of Object.entries(init.data)) {
        this.#ids.set(id.toLocaleLowerCase(), {
          token,
          created: typeof created === "string" ? new Date(created) : created,
        });
        this.#tokens.set(token, id.toLocaleLowerCase());
      }
    }
  }

  create(id: string): string {
    const token = crypto.randomUUID();
    this.#dirty = true;
    this.#ids.set(id.toLocaleLowerCase(), { token, created: new Date() });
    this.#tokens.set(token, id.toLocaleLowerCase());
    return btoa(token);
  }

  has(id: string): Date | undefined {
    const item = this.#ids.get(id);
    return item && new Date(item.created);
  }

  lookup(
    token: string | undefined | null,
  ): { id: string; created: Date } | undefined {
    if (!token) {
      return undefined;
    }
    const matches = token.match(/^bearer\s(\S+)/i);
    if (matches) {
      [, token] = matches;
    }
    const id = this.#tokens.get(atob(token));
    if (id) {
      const { created } = this.#ids.get(id)!;
      return { id, created: new Date(created) };
    }
  }

  revoke(tokenOrId: string): void {
    this.#dirty = true;
    const id = this.#tokens.get(atob(tokenOrId));
    const { token } = this.#ids.get(tokenOrId) ?? {};
    if (id) {
      this.#tokens.delete(atob(tokenOrId));
      this.#ids.delete(id);
    }
    if (token) {
      this.#tokens.delete(token);
      this.#ids.delete(tokenOrId);
    }
  }

  validate(token: string | undefined | null): boolean {
    if (!token) {
      return false;
    }
    const matches = token.match(/^bearer\s(\S+)/i);
    if (matches) {
      [, token] = matches;
    }
    return this.#tokens.has(atob(token));
  }

  toJSON(): TokenManagerJson {
    this.#dirty = false;
    return { data: Object.fromEntries(this.#ids) };
  }
}

export async function loadTokens(): Promise<TokenManager> {
  const datastore = await getDatastore();
  const result = await datastore.lookup(datastore.key(["config", "$$root$$"]));
  let init: TokenManagerJson | undefined;
  if (result && result.found && result.found.length === 1) {
    console.log(
      "%cLoaded%c tokens from datastore.",
      "color:green",
      "color:none",
    );
    init = entityToObject(result.found[0].entity);
  }
  return new TokenManager(init);
}

export async function saveTokens(tokenManager: TokenManager): Promise<void> {
  if (!tokenManager.dirty) {
    console.log(
      "%cSkipping%c saving tokens, not changed.",
      "color:yellow",
      "color:none",
    );
    return;
  }
  const datastore = await getDatastore();
  const config = tokenManager.toJSON();
  objectSetKey(config, datastore.key(["config", "$$root$$"]));
  const entity = objectToEntity(config);
  try {
    for await (
      const _result of datastore.commit(
        [{ upsert: entity }],
        { transactional: false },
      )
    ) {
      console.log(
        "%cSaved%c tokens to datastore.",
        "color:green",
        "color:none",
      );
    }
  } catch (error) {
    if (error instanceof DatastoreError) {
      console.error(
        `Datastore Error: ${error.status} ${error.message}\n\n${error.statusInfo}`,
      );
    } else {
      console.error("Unexpected error saving tokens.\n", error);
    }
  }
}

let tokenManager: TokenManager | undefined;

async function getTokenManager(): Promise<TokenManager> {
  if (tokenManager) {
    return tokenManager;
  }
  return tokenManager = await loadTokens();
}

export const endpointAuth = {
  async authorize(ctx: Context) {
    const tokens = await getTokenManager();
    return tokens.validate(ctx.request.headers.get("authorization"));
  },
};
