// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Load service account information from a `.env` if present and export the
 * service account information for connecting to the Google Datastore.
 *
 * @module
 */

import { type Context } from "acorn";
import {
  Datastore,
  DatastoreError,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import { S3Bucket } from "s3";
import { SQSQueue } from "sqs";
import { load } from "std/dotenv/mod.ts";

import { kinds, ROOT_SYMBOL } from "./consts.ts";

/** The service account keys used when connecting to the Google Datastore. */
export let keys: {
  client_email: string;
  private_key: string;
  private_key_id: string;
  project_id: string;
};
/** Algolia credentials required to upload docNodes to algolia. */
export let algoliaKeys: { appId: string; apiKey: string; searchApiKey: string };

export let awsKeys: {
  region: string;
  accessKeyID: string;
  secretKey: string;
  sessionToken?: string;
  endpointURL?: string;
};

let readyResolve: (value?: unknown) => void;

/** A promise that is resolved when auth keys are properly set. This allows for
 * async resolution of environment variables. */
export const readyPromise = new Promise((res) => readyResolve = res);

(async () => {
  await load({ export: true, examplePath: "" });
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
    searchApiKey: Deno.env.get("ALGOLIA_SEARCH_API_KEY") ?? "",
  };

  awsKeys = {
    region: Deno.env.get("AWS_REGION") ?? "",
    accessKeyID: Deno.env.get("AWS_ACCESS_KEY_ID") ?? "",
    secretKey: Deno.env.get("AWS_SECRET_ACCESS_KEY") ?? "",
    sessionToken: Deno.env.get("AWS_SESSION_TOKEN"),
    endpointURL: Deno.env.get("S3_ENDPOINT_URL"),
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

  *[Symbol.iterator](): IterableIterator<[string, Date]> {
    for (const [string, { created }] of this.#ids) {
      yield [string, created];
    }
  }
}

let datastore: Datastore | undefined;

/** Return an instance of the datastore configured to be authorized using the
 * environmental configuration. */
export async function getDatastore(): Promise<Datastore> {
  if (datastore) {
    return datastore;
  }
  await readyPromise;
  return datastore = new Datastore(keys);
}

let s3Bucket: S3Bucket | undefined;

/** Return an instance of the s3 bucket configured to be authorized using the
 * environmental configuration. */
export async function getS3Bucket(): Promise<S3Bucket> {
  if (s3Bucket) {
    return s3Bucket;
  }
  await readyPromise;
  return s3Bucket = new S3Bucket({
    bucket: Deno.env.get("STORAGE_BUCKET")!,
    ...awsKeys,
  });
}

let moderationS3Bucket: S3Bucket | undefined;

/** Return an instance of the s3 moderation bucket configured to be authorized
 * using the environmental configuration. */
export async function getModerationS3Bucket(): Promise<S3Bucket | undefined> {
  const moderationbucket = Deno.env.get("MODERATION_BUCKET");
  if (moderationS3Bucket || !moderationbucket) {
    return moderationS3Bucket;
  }
  await readyPromise;
  return moderationS3Bucket = new S3Bucket({
    bucket: moderationbucket,
    ...awsKeys,
  });
}

let sqsQueue: SQSQueue | undefined;

/** Return an instance of the s3 moderation bucket configured to be authorized
 * using the environmental configuration. */
export async function getSQSQueue(): Promise<SQSQueue> {
  if (sqsQueue) {
    return sqsQueue;
  }
  await readyPromise;
  return sqsQueue = new SQSQueue({
    queueURL: Deno.env.get("BUILD_QUEUE")!,
    ...awsKeys,
  });
}

/** Load API tokens from the datastore. */
export async function loadTokens(): Promise<TokenManager> {
  const datastore = await getDatastore();
  const result = await datastore.lookup(
    datastore.key([kinds.CONFIG_KIND, ROOT_SYMBOL]),
  );
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
  objectSetKey(config, datastore.key([kinds.CONFIG_KIND, ROOT_SYMBOL]));
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
