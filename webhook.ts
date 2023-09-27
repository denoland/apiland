// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.

import { join } from "std/path/mod.ts";
import {
  Datastore,
  datastoreValueToValue,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import { Mutation } from "google_datastore/types";
import type {
  WebhookPayloadCreate,
  WebhookPayloadPing,
  WebhookPayloadPush,
} from "./webhooks.d.ts";
import { kinds } from "./consts.ts";
import {
  getDatastore,
  getModerationS3Bucket,
  getS3Bucket,
  getSQSQueue,
} from "./auth.ts";
import {
  ApiModuleData,
  Build,
  ModuleMetaVersionsJson,
  OwnerQuota,
} from "./types.d.ts";

let datastore: Datastore | undefined;

export async function pingEvent(
  module: string,
  body: WebhookPayloadPing,
  searchParams: URLSearchParams,
): Promise<Response> {
  const [owner, repo] = body.repository.full_name.split("/");
  const repoId = body.repository.id;
  const description = body.repository.description ?? "";
  const sender = body.sender.login;
  const subdirRaw = decodeURIComponent(searchParams.get("subdir") ?? "") ||
    null;
  const subdir = normalizeSubdir(subdirRaw);

  const res = await checkAndUpdateModule(
    module,
    owner,
    sender,
    repoId,
    subdir,
    repo,
    description,
  );
  if (res instanceof Response) {
    return res;
  } else {
    datastore = datastore ?? await getDatastore();
    for await (
      const _res of datastore.commit([res], {
        transactional: false,
      })
    ) {
      //
    }
  }

  const versionInfo = await getMeta(module);
  if (versionInfo === undefined) {
    await uploadMetaJson(module, { latest: null, versions: [] });
  }

  return new Response(
    JSON.stringify({
      success: true,
      data: {
        module,
        repository: `${owner}/${repo}`,
      },
    }),
    {
      status: 200,
    },
  );
}

// deno-lint-ignore require-await
export async function pushEvent(
  module: string,
  body: WebhookPayloadPush,
  searchParams: URLSearchParams,
): Promise<Response> {
  const [owner, repo] = body.repository.full_name.split("/");
  if (!body.ref.startsWith("refs/tags/")) {
    return new Response(
      JSON.stringify({
        success: false,
        info: "created ref is not tag",
      }),
      {
        status: 200,
      },
    );
  }

  const ref = body.ref.replace(/^refs\/tags\//, "");
  const versionPrefix = decodeURIComponent(
    searchParams.get("version_prefix") ?? "",
  );
  const subdirRaw = decodeURIComponent(searchParams.get("subdir") ?? "") ||
    null;

  return initiateBuild({
    module,
    repoId: body.repository.id,
    owner,
    repo,
    sender: body.sender.login,
    ref,
    description: body.repository.description ?? "",
    versionPrefix,
    subdir: normalizeSubdir(subdirRaw),
  });
}

// deno-lint-ignore require-await
export async function createEvent(
  module: string,
  body: WebhookPayloadCreate,
  searchParams: URLSearchParams,
): Promise<Response> {
  const [owner, repo] = body.repository.full_name.split("/");
  if (body.ref_type !== "tag") {
    return new Response(
      JSON.stringify({
        success: false,
        info: "created ref is not tag",
      }),
      {
        status: 200,
      },
    );
  }

  const versionPrefix = decodeURIComponent(
    searchParams.get("version_prefix") ?? "",
  );
  const subdirRaw = decodeURIComponent(searchParams.get("subdir") ?? "") ||
    null;

  return initiateBuild({
    module,
    repoId: body.repository.id,
    owner,
    repo,
    sender: body.sender.login,
    ref: body.ref,
    description: body.repository.description ?? "",
    versionPrefix,
    subdir: normalizeSubdir(subdirRaw),
  });
}

async function initiateBuild({
  module,
  repoId,
  owner,
  repo,
  sender,
  ref,
  description,
  versionPrefix,
  subdir,
}: {
  module: string;
  repoId: number;
  owner: string;
  repo: string;
  sender: string;
  ref: string;
  description: string;
  versionPrefix: string;
  subdir: string | null;
}): Promise<Response> {
  if (!ref.startsWith(versionPrefix)) {
    return new Response(
      JSON.stringify({
        success: false,
        info: "ignoring event as the version does not match the version prefix",
      }),
      {
        status: 200,
      },
    );
  }

  const mutations: Mutation[] = [];

  const res = await checkAndUpdateModule(
    module,
    owner,
    sender,
    repoId,
    subdir,
    repo,
    description,
  );
  if (res instanceof Response) {
    return res;
  } else {
    mutations.push(res);
  }

  const version = ref.substring(versionPrefix.length);
  const invalidVersion = await checkVersion(module, version);
  if (invalidVersion) return invalidVersion;

  const id = crypto.randomUUID();

  datastore ??= await getDatastore();

  const newBuild: Build = {
    id,
    module,
    version,
    status: "queued",
    created_at: new Date(),
    upload_options: {
      type: "github",
      repository: `${owner}/${repo}`,
      ref,
      subdir: subdir ?? undefined,
    },
  };

  objectSetKey(newBuild, datastore.key([kinds.BUILD_KIND, id]));

  mutations.push(
    { upsert: objectToEntity(newBuild) },
  );

  for await (
    const _res of datastore.commit(mutations, { transactional: false })
  ) {
    //
  }

  const sqs = await getSQSQueue();
  await sqs.sendMessage({
    body: JSON.stringify({ buildID: id }),
  });

  return new Response(
    JSON.stringify({
      success: true,
      data: {
        module,
        version,
        repository: `${owner}/${repo}`,
        status_url: `https://deno.land/status/${id}`,
      },
    }),
    {
      status: 200,
    },
  );
}

async function checkAndUpdateModule(
  module: string,
  owner: string,
  sender: string,
  repoId: number,
  subdir: string | null,
  repo: string,
  description: string,
): Promise<Response | Mutation> {
  datastore = datastore ?? await getDatastore();

  const key = datastore.key([kinds.LEGACY_MODULES, module]);
  const result = await datastore.lookup(key);

  const entry = (result.found && result.found.length)
    ? entityToObject<ApiModuleData>(result.found[0].entity)
    : null;

  const resp = await checkModuleInfo(
    entry,
    module,
    owner,
    sender,
    repoId,
    subdir,
  );
  if (resp) return resp;

  const newModule: ApiModuleData = {
    ...entry ??
      {
        name: module,
        type: "github",
        created_at: new Date(),
        is_unlisted: false,
      },
    repo_id: repoId,
    owner,
    repo,
    description,
  };
  objectSetKey(newModule, key);

  return { upsert: objectToEntity(newModule) };
}

/**
 * CheckModuleInfo performs a series of general validation on the module such as
 * validating that the module name complies with the naming convention enforced
 * on deno.land/x, whether or not the sender or owner have been blocked etc...
 *
 * These verifications are meant to be performed before the module is registered
 * or updated in the database to prevent "bad" modules from being pushed to the
 * build queue and subsequently published.
 *
 * @param entry database entry for the module
 * @param module module name as shown on deno.land/x
 * @param owner username of the GH repository owner
 * @param sender username of the user triggering the webhoo
 * @param repoId numerical id of the GH repository
 */
async function checkModuleInfo(
  entry: ApiModuleData | null,
  module: string,
  owner: string,
  sender: string,
  repoId: number,
  subdir: string | null,
): Promise<Response | undefined> {
  const checks = await checkBlocked(sender) ??
    await checkBlocked(owner) ??
    checkSubdir(subdir) ??
    checkMatchesRepo(entry, repoId) ??
    await checkName(entry, module);
  if (!Deno.env.get("CI")) {
    return checks ?? await checkModulesInRepo(entry, repoId) ??
      await hasReachedQuota(entry, owner);
  }
  return checks;
}

function checkSubdir(
  subdir: string | null,
): Response | undefined {
  if (subdir !== null) {
    if (!subdir.endsWith("/")) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "provided sub directory is not valid as it does not end with a /",
        }),
        {
          status: 400,
        },
      );
    }
  }
  return;
}

async function getOwnerQuota(owner: string): Promise<OwnerQuota | null> {
  const result = await datastore!.lookup(
    datastore!.key([kinds.LEGACY_OWNER_QUOTAS, owner]),
  );
  if (result.found && result.found.length) {
    return entityToObject<OwnerQuota>(result.found[0].entity);
  } else {
    return null;
  }
}

async function checkBlocked(
  owner: string,
): Promise<Response | undefined> {
  const ownerQuota = await getOwnerQuota(owner);
  if (ownerQuota?.blocked ?? false) {
    return new Response(
      JSON.stringify({
        success: false,
        error:
          `Publishing your module failed. Please contact modules@deno.com.`,
      }),
      {
        status: 400,
      },
    );
  }
  return;
}

function checkMatchesRepo(
  entry: ApiModuleData | null,
  repoId: number,
): Response | undefined {
  if (
    entry && !(entry.type === "github" && entry.repo_id === repoId)
  ) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "module name is registered to a different repository",
      }),
      {
        status: 409,
      },
    );
  }
  return;
}

const MAX_MODULES_PER_REPOSITORY = 3;
const MAX_MODULES_PER_OWNER_DEFAULT = 15;

async function checkModulesInRepo(
  entry: ApiModuleData | null,
  repoId: number,
): Promise<Response | undefined> {
  const query = await datastore!.runGqlAggregationQuery({
    queryString:
      `SELECT COUNT(*) FROM ${kinds.LEGACY_MODULES} WHERE repo_id = ${repoId}`,
    allowLiterals: true,
  });
  const modulesForRepo = datastoreValueToValue(
    query.batch.aggregationResults[0].aggregateProperties.property_1,
  ) as number;

  if (!entry && modulesForRepo >= MAX_MODULES_PER_REPOSITORY) {
    return new Response(
      JSON.stringify({
        success: false,
        error:
          `Max number of modules for one repository (${MAX_MODULES_PER_REPOSITORY}) has been reached. Please contact modules@deno.com if you need more.`,
      }),
      {
        status: 400,
      },
    );
  }
  return;
}

async function hasReachedQuota(
  entry: ApiModuleData | null,
  owner: string,
): Promise<Response | undefined> {
  const ownerQuota = await getOwnerQuota(owner);

  const query = await datastore!.runGqlAggregationQuery({
    queryString:
      `SELECT COUNT(*) FROM ${kinds.LEGACY_MODULES} WHERE owner = '${owner}'`,
    allowLiterals: true,
  });
  const modulesForOwner = datastoreValueToValue(
    query.batch.aggregationResults[0].aggregateProperties.property_1,
  ) as number;

  const maxModuleQuota = ownerQuota?.max_modules ??
    MAX_MODULES_PER_OWNER_DEFAULT;
  if (!entry && modulesForOwner >= maxModuleQuota) {
    return new Response(
      JSON.stringify({
        success: false,
        error:
          `Max number of modules for one user/org (${maxModuleQuota}) has been reached. Please contact modules@deno.com if you need more.`,
      }),
      {
        status: 400,
      },
    );
  }
  return;
}

const VALID_NAME = /^[a-z0-9_]{3,40}$/;

async function checkName(
  entry: ApiModuleData | null,
  module: string,
): Promise<Response | undefined> {
  if (!entry) {
    if (!VALID_NAME.test(module)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "module name is not valid",
        }),
        {
          status: 400,
        },
      );
    }

    if (await isForbidden(module)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "found forbidden word in module name",
        }),
        {
          status: 400,
        },
      );
    }
  }
  return;
}

const decoder = new TextDecoder();
async function checkVersion(
  module: string,
  version: string,
): Promise<Response | undefined> {
  // Check that version doesn't already exist
  const versionInfo = await getMeta(module);
  if (versionInfo?.versions.includes(version)) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "version already exists",
      }),
      {
        status: 400,
      },
    );
  }

  datastore = datastore ?? await getDatastore();
  const query = datastore!
    .createQuery(kinds.BUILD_KIND)
    .filter("module", module)
    .filter("version", version);

  const builds = await datastore!.query<Build>(query);
  if (builds[0] && builds[0].status !== "error") {
    return new Response(
      JSON.stringify({
        success: false,
        error: "this module version is already being published",
      }),
      {
        status: 400,
      },
    );
  }
  return;
}

function normalizeSubdir(subdir: string | null): string | null {
  if (subdir === null) return null;
  subdir = join("/", subdir);
  return subdir.substr(1);
}

export async function isForbidden(module: string): Promise<boolean> {
  const moderationS3 = await getModerationS3Bucket();
  if (!moderationS3) {
    throw new Error("Missing MODERATION_BUCKET environment variable.");
  }
  const resp = await moderationS3.getObject(
    "badwords.txt",
    {},
  );
  if (resp === undefined) throw new Error("badwords.txt not found");
  const data = await new Response(resp.body).arrayBuffer();

  const badwords = decoder.decode(data).split("\n");
  for (const word of badwords) {
    const e = new RegExp(`(^|_)(${word})($|_)`);
    if (e.test(module)) return true;
  }
  return false;
}

export async function getMeta(
  module: string,
): Promise<ModuleMetaVersionsJson | undefined> {
  const s3 = await getS3Bucket();
  const resp = await s3.getObject(join(module, "meta", "versions.json"), {});
  if (resp === undefined) return undefined;
  const data = await new Response(resp.body).arrayBuffer();
  return JSON.parse(decoder.decode(data));
}

const encoder = new TextEncoder();
export async function uploadMetaJson(module: string, data: unknown) {
  const s3 = await getS3Bucket();
  await s3.putObject(
    join(module, "meta", "versions.json"),
    encoder.encode(JSON.stringify(data)),
    {
      // Global module meta data must always be fresh.
      cacheControl: "max-age=10, must-revalidate",
      contentType: "application/json",
    },
  );
}
