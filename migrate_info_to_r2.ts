// Copyright 2022-2023 the Deno authors. All rights reserved. MIT license.

/**
 * Migration job which writes the module metadata that only exists in apiland's
 * datastore into an R2 bucket, so that deno.land/x can render module pages
 * after apiland is shut down.
 *
 * One blob per module is written to `{module}/meta/info.json`:
 *
 * ```json
 * {
 *   "name": "oak",
 *   "description": "A middleware framework for Deno's native HTTP server",
 *   "tags": [{ "kind": "popularity", "value": "top_1_percent" }],
 *   "dependencies": {
 *     "v12.6.1": [{ "src": "std", "pkg": "path", "ver": "0.190.0" }],
 *     "v12.6.0": []
 *   }
 * }
 * ```
 *
 * Everything else the module page renders already lives in the registry
 * bucket: `versions`/`latest_version` in `{module}/meta/versions.json`, and
 * `uploaded_at`/`upload_options`/`directory_listing` (from which the readme
 * and deno config entries are derived) in
 * `{module}/versions/{version}/meta/meta.json`.
 *
 * A version key present with an empty array means "analyzed, no dependencies".
 * A version key that is absent means apiland never analyzed that version —
 * dependency information for it does not exist and cannot be recovered without
 * re-running the module graph analysis.
 *
 * The datastore is read over its REST API using the caller's Application
 * Default Credentials, so no service account key is needed — run
 * `gcloud auth application-default login` first. R2 credentials are read from
 * `R2_ACCOUNT_ID` (or `R2_ENDPOINT`), `R2_BUCKET`, `R2_ACCESS_KEY_ID` and
 * `R2_SECRET_ACCESS_KEY`, from the environment or a `.env` file.
 *
 * Usage:
 * ```
 * # a single module, printed to stdout — touches neither R2 nor the filesystem
 * deno run -A migrate_info_to_r2.ts --module=oak --stdout
 *
 * # dry run, writes every blob to ./info-export instead of R2
 * deno run -A migrate_info_to_r2.ts --dry-run
 *
 * # the real thing
 * deno run -A migrate_info_to_r2.ts --state=./migrated.log
 * ```
 *
 * @module
 */

import { entityToObject } from "google_datastore";
import type { Entity } from "google_datastore/types";
import { load } from "std/dotenv/mod.ts";
import { parse } from "std/flags/mod.ts";
import { ensureDir } from "std/fs/ensure_dir.ts";
import { dirname, join } from "std/path/mod.ts";

import { kinds } from "./consts.ts";
import type {
  Module,
  ModuleDependency,
  ModuleTag,
  ModuleVersion,
} from "./types.d.ts";

/** The shape written to `{module}/meta/info.json`. */
export interface ModuleInfoJson {
  name: string;
  description?: string;
  tags?: ModuleTag[];
  /** Dependencies keyed by module version. An absent version was never
   * analyzed; a version mapped to an empty array has no dependencies. */
  dependencies: Record<string, ModuleDependency[]>;
}

/** The registry is read only, so these blobs never change once written. */
const CACHE_CONTROL = "public, max-age=3600";

const encoder = new TextEncoder();

// ## R2 ##

/** `Uint8Array` is generic over its backing buffer as of TypeScript 5.7, and
 * the web crypto and `fetch` signatures only accept the `ArrayBuffer` flavour. */
type Bytes = Uint8Array<ArrayBuffer>;

function toHex(bytes: Bytes): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: Bytes | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function hmac(
  key: Bytes | string,
  message: string,
): Promise<Bytes> {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)),
  );
}

/** `encodeURIComponent()` leaves a handful of characters unescaped which
 * RFC 3986 — and therefore the SigV4 canonical request — considers reserved. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

export interface SignOptions {
  method: string;
  url: URL;
  /** Headers to sign, beyond the `host` and `x-amz-date` which are always
   * added. For S3 and R2 this must include `x-amz-content-sha256`. */
  headers?: Record<string, string>;
  body?: Bytes;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
}

/** Sign a request with AWS Signature Version 4, resolving with the complete
 * set of request headers including `authorization`.
 *
 * Verified against the published `aws4_testsuite` vectors — see
 * `migrate_info_to_r2_test.ts`. */
export async function signRequest(
  {
    method,
    url,
    headers: extraHeaders = {},
    body,
    accessKeyId,
    secretAccessKey,
    region,
    service,
    date,
  }: SignOptions,
): Promise<Record<string, string>> {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body ?? new Uint8Array());

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers[name.toLowerCase()] = value;
  }
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name].trim()}`)
    .join("\n");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let signingKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  signingKey = await hmac(signingKey, region);
  signingKey = await hmac(signingKey, service);
  signingKey = await hmac(signingKey, "aws4_request");
  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** A minimal SigV4 client for R2.
 *
 * The `s3` module this repo already depends on sets `x-amz-content-sha256`
 * after signing the request, so the header never makes it into
 * `SignedHeaders`. S3 accepts that; R2 is stricter, so signing is done here
 * instead of reusing `getS3Bucket()`. */
class R2Bucket {
  #endpoint: string;
  #bucket: string;
  #accessKeyId: string;
  #secretAccessKey: string;
  // R2 has no notion of regions, but SigV4 requires one in the credential
  // scope, and R2 only accepts "auto".
  #region = "auto";

  constructor(
    { endpoint, bucket, accessKeyId, secretAccessKey }: {
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
  ) {
    this.#endpoint = endpoint.replace(/\/$/, "");
    this.#bucket = bucket;
    this.#accessKeyId = accessKeyId;
    this.#secretAccessKey = secretAccessKey;
  }

  async #sign(
    method: string,
    key: string,
    body: Bytes | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<Request> {
    const url = new URL(
      `${this.#endpoint}/${encodeKey(this.#bucket)}/${encodeKey(key)}`,
    );
    const headers = await signRequest({
      method,
      url,
      headers: {
        ...extraHeaders,
        // Unlike S3, R2 requires this to be part of `SignedHeaders`.
        "x-amz-content-sha256": await sha256Hex(body ?? new Uint8Array()),
      },
      body,
      accessKeyId: this.#accessKeyId,
      secretAccessKey: this.#secretAccessKey,
      region: this.#region,
      service: "s3",
      date: new Date(),
    });
    return new Request(url, { method, body, headers });
  }

  async put(
    key: string,
    body: Bytes,
    { contentType, cacheControl }: {
      contentType: string;
      cacheControl: string;
    },
  ): Promise<void> {
    const request = await this.#sign("PUT", key, body, {
      "cache-control": cacheControl,
      "content-type": contentType,
    });
    const res = await fetch(request);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PUT ${key} failed: ${res.status} ${res.statusText}
${text}`);
    }
  }

  async get(key: string): Promise<string | undefined> {
    const request = await this.#sign("GET", key, undefined, {});
    const res = await fetch(request);
    if (res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GET ${key} failed: ${res.status} ${res.statusText}
${text}`);
    }
    return text;
  }
}

function getR2Bucket(): R2Bucket {
  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const endpoint = Deno.env.get("R2_ENDPOINT") ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const bucket = Deno.env.get("R2_BUCKET");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const missing = [
    ["R2_ACCOUNT_ID or R2_ENDPOINT", endpoint],
    ["R2_BUCKET", bucket],
    ["R2_ACCESS_KEY_ID", accessKeyId],
    ["R2_SECRET_ACCESS_KEY", secretAccessKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`missing R2 configuration: ${missing.join(", ")}`);
  }
  return new R2Bucket({
    endpoint: endpoint!,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
  });
}

// ## datastore ##

/** The datastore project apiland runs against. */
export const DEFAULT_PROJECT = "apiland-350005";

/** Read only access to the datastore over its REST API, authorized with the
 * caller's Application Default Credentials.
 *
 * The `google_datastore` module the server uses signs its own JWTs from a
 * service account key and offers no way to supply a bearer token, which makes
 * it unusable for a one-off job run from a workstation. Only `entityToObject`
 * is reused from it, which is a pure conversion of the REST representation. */
class DatastoreClient {
  #project: string;
  #token: string | undefined;
  #tokenExpiry = 0;

  constructor(project: string) {
    this.#project = project;
  }

  key(...path: { kind: string; name: string }[]) {
    return { partitionId: { projectId: this.#project }, path };
  }

  /** Access tokens are good for an hour; this refreshes on the half hour so a
   * long running job never trips over an expiry mid-flight. */
  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#tokenExpiry) {
      return this.#token;
    }
    const { code, stdout, stderr } = await new Deno.Command("gcloud", {
      args: ["auth", "application-default", "print-access-token"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (code !== 0) {
      throw new Error(
        `could not get an access token from gcloud — run \`gcloud auth application-default login\`:\n${
          new TextDecoder().decode(stderr)
        }`,
      );
    }
    this.#tokenExpiry = Date.now() + 30 * 60 * 1000;
    return this.#token = new TextDecoder().decode(stdout).trim();
  }

  // deno-lint-ignore no-explicit-any
  async #post(method: string, body: unknown): Promise<any> {
    const res = await fetch(
      `https://datastore.googleapis.com/v1/projects/${this.#project}:${method}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.#accessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      throw new Error(
        `datastore ${method} failed: ${res.status} ${
          json?.error?.message ?? JSON.stringify(json)
        }`,
      );
    }
    return json;
  }

  /** Run a query, following the result cursor until the datastore reports that
   * there is nothing left. */
  async *query(
    kind: string,
    ancestor?: ReturnType<DatastoreClient["key"]>,
  ): AsyncGenerator<Entity> {
    // deno-lint-ignore no-explicit-any
    const query: Record<string, any> = { kind: [{ name: kind }] };
    if (ancestor) {
      query.filter = {
        propertyFilter: {
          property: { name: "__key__" },
          op: "HAS_ANCESTOR",
          value: { keyValue: ancestor },
        },
      };
    }
    while (true) {
      const { batch } = await this.#post("runQuery", { query });
      for (const { entity } of batch.entityResults ?? []) {
        yield entity as Entity;
      }
      // NOT_FINISHED means the batch was truncated; the other "more results"
      // states mean a limit or the end of the result set was reached.
      if (batch.moreResults !== "NOT_FINISHED" || !batch.endCursor) {
        return;
      }
      query.startCursor = batch.endCursor;
    }
  }

  async lookup(
    key: ReturnType<DatastoreClient["key"]>,
  ): Promise<Entity | undefined> {
    const { found } = await this.#post("lookup", { keys: [key] });
    return found?.[0]?.entity;
  }
}

let datastore: DatastoreClient | undefined;

/** Both `module_version` and `module_dependency` entities are keyed under
 * `[module, name] -> [module_version, version] -> ...`, so the version is
 * always the second path element. */
function versionFromKey(entity: Entity): string | undefined {
  const element = entity.key?.path?.[1];
  if (element?.kind !== kinds.MODULE_VERSION_KIND) {
    return undefined;
  }
  return element.name;
}

async function getModules(limit?: number): Promise<Module[]> {
  const modules: Module[] = [];
  for await (const entity of datastore!.query(kinds.MODULE_KIND)) {
    modules.push(entityToObject<Module>(entity));
    if (limit && modules.length >= limit) {
      break;
    }
  }
  return modules;
}

/** Collect the analyzed versions of a module along with their dependencies.
 *
 * Both are ancestor queries rooted at the module rather than at each
 * module@version, so this is two datastore round trips per module regardless
 * of how many versions it has. */
async function getDependencies(
  module: string,
): Promise<Record<string, ModuleDependency[]>> {
  const moduleKey = datastore!.key({ kind: kinds.MODULE_KIND, name: module });

  const dependencies: Record<string, ModuleDependency[]> = {};

  // Seed the analyzed versions first, so that a version which was analyzed and
  // genuinely has no dependencies is distinguishable from one that was never
  // analyzed at all.
  for await (
    const entity of datastore!.query(kinds.MODULE_VERSION_KIND, moduleKey)
  ) {
    const version = versionFromKey(entity);
    if (!version) {
      continue;
    }
    const { analysis_version } = entityToObject<ModuleVersion>(entity);
    if (analysis_version) {
      dependencies[version] = [];
    }
  }

  for await (
    const entity of datastore!.query(kinds.MODULE_DEP_KIND, moduleKey)
  ) {
    const version = versionFromKey(entity);
    if (!version) {
      continue;
    }
    // A dependency without a corresponding analyzed version shouldn't happen,
    // but if it does the dependency is the more useful of the two signals.
    (dependencies[version] ??= []).push(
      entityToObject<ModuleDependency>(entity),
    );
  }

  return dependencies;
}

async function buildInfo(module: Module): Promise<ModuleInfoJson> {
  return {
    name: module.name,
    description: module.description || undefined,
    tags: module.tags?.length ? module.tags : undefined,
    dependencies: await getDependencies(module.name),
  };
}

// ## job ##

function infoKey(module: string): string {
  return `${module}/meta/info.json`;
}

async function writeLocal(out: string, module: string, body: string) {
  const path = join(out, infoKey(module));
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, body);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
      }
    }
  }
  throw lastError;
}

async function pooled<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const promise = fn(item).finally(() => executing.delete(promise));
    executing.add(promise);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

const HELP = `Migrate apiland module metadata to {module}/meta/info.json in R2.

  --dry-run           write to --out instead of R2
  --out=<dir>         dry run output directory (default: ./info-export)
  --stdout            print the blobs instead of writing them anywhere
  --module=<name>     migrate only this module
  --limit=<n>         migrate at most n modules
  --state=<file>      append migrated module names here and skip them on rerun
  --verify            read every blob back from R2 after writing it
  --concurrency=<n>   modules processed in parallel (default: 8)
  --project=<id>      datastore project (default: ${DEFAULT_PROJECT})

The datastore is read with your Application Default Credentials — run
\`gcloud auth application-default login\` first. R2 is configured with
R2_ACCOUNT_ID (or R2_ENDPOINT), R2_BUCKET, R2_ACCESS_KEY_ID and
R2_SECRET_ACCESS_KEY, read from the environment or a .env file.`;

async function main() {
  const args = parse(Deno.args, {
    boolean: ["dry-run", "stdout", "verify", "help"],
    string: ["out", "state", "module", "limit", "concurrency", "project"],
    default: {
      out: "./info-export",
      concurrency: "8",
      project: DEFAULT_PROJECT,
    },
  });

  if (args.help) {
    console.log(HELP);
    return;
  }

  await load({ export: true, examplePath: "" });

  const concurrency = parseInt(args.concurrency, 10);
  const limit = args.limit ? parseInt(args.limit, 10) : undefined;
  const toR2 = !args["dry-run"] && !args.stdout;
  const r2 = toR2 ? getR2Bucket() : undefined;
  datastore = new DatastoreClient(args.project);
  console.log(`reading datastore project ${args.project}`);

  let modules: Module[];
  if (args.module) {
    const entity = await datastore.lookup(
      datastore.key({ kind: kinds.MODULE_KIND, name: args.module }),
    );
    if (!entity) {
      console.error(`module "${args.module}" not found`);
      Deno.exit(1);
    }
    modules = [entityToObject<Module>(entity)];
  } else {
    modules = await getModules(limit);
  }

  // Modules which have never had a version published render as "no versions"
  // and have no prefix in the registry bucket, so there is nothing to write.
  const unpublished = modules.filter(({ latest_version }) => !latest_version);
  modules = modules.filter(({ latest_version }) => latest_version);

  let done = new Set<string>();
  if (args.state) {
    try {
      done = new Set(
        (await Deno.readTextFile(args.state)).split("\n").filter(Boolean),
      );
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
    }
  }
  const skipped = modules.filter(({ name }) => done.has(name)).length;
  modules = modules.filter(({ name }) => !done.has(name));

  const state = args.state
    ? await Deno.open(args.state, { create: true, append: true })
    : undefined;

  const stats = { migrated: 0, failed: 0, versions: 0, analyzed: 0 };
  const failures: string[] = [];

  console.log(
    `migrating ${modules.length} modules (${unpublished.length} unpublished, ${skipped} already done) -> ${
      args.stdout ? "stdout" : args["dry-run"] ? args.out : "R2"
    }`,
  );

  async function migrate(module: Module, verify: boolean) {
    const info = await buildInfo(module);
    const body = JSON.stringify(info);
    if (args.stdout) {
      console.log(JSON.stringify(info, undefined, 2));
    } else if (r2) {
      const key = infoKey(module.name);
      await withRetry(() =>
        r2.put(key, encoder.encode(body), {
          contentType: "application/json",
          cacheControl: CACHE_CONTROL,
        })
      );
      if (verify) {
        const roundTripped = await withRetry(() => r2.get(key));
        if (roundTripped !== body) {
          throw new Error(
            `verification failed for ${key}: read back ${
              roundTripped === undefined
                ? "nothing"
                : `${roundTripped.length} bytes, expected ${body.length}`
            }`,
          );
        }
      }
    } else {
      await writeLocal(args.out, module.name, body);
    }
    stats.migrated++;
    stats.analyzed += Object.keys(info.dependencies).length;
    stats.versions += module.versions.length;
    if (state) {
      await state.write(encoder.encode(`${module.name}\n`));
    }
  }

  // Migrate and verify the first module on its own. Credentials and request
  // signing either work or they don't, and finding out after a few thousand
  // modules have been processed is no fun.
  const [first, ...rest] = modules;
  if (first) {
    try {
      await migrate(first, toR2);
      if (toR2) {
        console.log(`verified ${infoKey(first.name)}, continuing`);
      }
    } catch (e) {
      console.error(`failed on the first module ("${first.name}"):`, e);
      state?.close();
      Deno.exit(1);
    }
  }

  await pooled(rest, concurrency, async (module) => {
    try {
      await migrate(module, args.verify);
      if (stats.migrated % 250 === 0) {
        console.log(`  ${stats.migrated}/${modules.length}`);
      }
    } catch (e) {
      stats.failed++;
      failures.push(module.name);
      console.error(`failed to migrate "${module.name}":`, e);
    }
  });

  state?.close();

  console.log(`
migrated:  ${stats.migrated}
failed:    ${stats.failed}
versions:  ${stats.analyzed}/${stats.versions} with dependency data (${
    stats.versions ? Math.round((stats.analyzed / stats.versions) * 100) : 0
  }%)`);
  if (failures.length) {
    console.log(`failures:  ${failures.join(", ")}`);
  }
}

if (import.meta.main) {
  await main();
}
