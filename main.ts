// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * The main API server process.
 *
 * @module
 */

import { auth, type Context, Router } from "acorn";
import { errors, isHttpError } from "oak_commons/http_errors.ts";
import { entityToObject } from "google_datastore";
import { type Query } from "google_datastore/query";

import { endpointAuth } from "./auth.ts";
import {
  type DocNode,
  type DocNodeModuleDoc,
  generateDocNodes,
  getDocNodes,
  getImportMapSpecifier,
  type JsDoc,
  queryDocNodes,
} from "./docs.ts";
import { loadModule } from "./modules.ts";
import { enqueue } from "./process.ts";
import { datastore } from "./store.ts";
import { ModuleEntry } from "./types.d.ts";
import { assert } from "./util.ts";

interface PagedItems<T> {
  items: T[];
  next?: string;
  previous?: string;
}

function pagedResults<T>(
  items: T[],
  base: URL,
  current: number,
  limit: number,
  hasNext?: boolean,
): PagedItems<T> {
  const pagedItems: PagedItems<T> = { items };
  base.searchParams.set("limit", String(limit));
  if (hasNext) {
    const next = current + 1;
    base.searchParams.set("page", String(next));
    pagedItems.next = `${base.pathname}${base.search}${base.hash}`;
  }
  if (current > 1) {
    const prev = current - 1;
    base.searchParams.set("page", String(prev));
    pagedItems.previous = `${base.pathname}${base.search}${base.hash}`;
  }
  return pagedItems;
}

// The router is exported for testing purposes.
export const router = new Router();

// Provide a basic landing page.
router.all("/", () =>
  `<!DOCTYPE html>
  <html>
    <head>
      <title>apiland.deno.dev</title>
    </head>
    <body>
      <h1>apiland.deno.dev</h1>
      <div>
        <p><a href="/~/spec" target="_blank">Current Specification</a></p>
        <p><a href="https://redocly.github.io/redoc/?url=https://apiland.deno.dev/~/spec" target="_blank">Specification rendered as documentation</a></p>
      </div>
      <h2>Endpoints</h2>
      <div>
        <ul>
          <li><code>/v2/modules</code> - Provide a list of modules in the registry - [<a href="/v2/modules" target="_blank">example</a>]</li>
          <li><code>/v2/metrics/modules/:module</code> - Provide metric information for a module -  [<a href="/v2/metrics/modules/oak" target="_blank">example</a>]</li>
          <li><code>/v2/modules/:module</code> - Provide information about a specific module - [<a href="/v2/modules/std" target="_blank">example</a>]</li>
          <li><code>/v2/modules/:module/:version</code> - Provide information about a specific module version - [<a href="/v2/modules/std/0.139.0" target="_blank">example</a>]</li>
          <li><code>/v2/modules/:module/:version/doc/:path*</code> - Provide documentation nodes for a specific path of a specific module version -  [<a href="/v2/modules/std/0.139.0/doc/archive/tar.ts" target="_blank">example</a>]</li>
          <li><code>/ping</code> - A health endpoint for the server - [<a href="/ping" target="_blank">example</a>]</li>
        <ul>
      </div>
    </body>
  </html>`);

// Return the current API spec
router.get("/~/spec", async () => {
  const bodyInit = await Deno.readTextFile("./specs/api-2.0.0.yaml");
  return new Response(bodyInit, {
    headers: {
      "content-type": "text/yaml",
    },
  });
});

// server health-check endpoint
router.get("/ping", () => ({ pong: true }));

// ## Metrics related APIs ##

router.get("/v2/metrics/modules", async (ctx) => {
  const query = datastore.createQuery("module_metrics");
  let limit = 100;
  let page = 1;
  if (ctx.searchParams.limit) {
    limit = parseInt(ctx.searchParams.limit, 10);
    if (limit < 1 || limit > 100) {
      throw new errors.BadRequest(
        `Parameter "limit" must be between 1 and 100, received ${limit}.`,
      );
    }
    query.limit(limit);
    if (ctx.searchParams.page) {
      page = parseInt(ctx.searchParams.page, 10);
      if (page < 1) {
        throw new errors.BadRequest(
          `Parameter "page" must be 1 or greater, received ${page}.`,
        );
      }
      if (page > 1) {
        query.offset((page - 1) * limit);
      }
    }
  } else if (ctx.searchParams.page) {
    throw new errors.BadRequest(
      `Parameter "page" cannot be specified without "limit" being specified.`,
    );
  }
  query.order("popularity.sessions_30_day", true);
  const response = await datastore.runQuery(query);
  if (response.batch.entityResults) {
    const hasNext = response.batch.moreResults !== "NO_MORE_RESULTS";
    return pagedResults(
      response.batch.entityResults.map(({ entity }) => entityToObject(entity)),
      ctx.url(),
      page,
      limit,
      hasNext,
    );
  }
});
router.get("/v2/metrics/modules/:module", async (ctx) => {
  const response = await datastore.lookup(
    datastore.key(["module_metrics", ctx.params.module]),
  );
  if (response.found) {
    console.log(response.found[0].entity);
    return entityToObject(response.found[0].entity);
  }
});

// ## Registry related APIs ##

router.get("/v2/modules", async (ctx) => {
  const query = datastore.createQuery("module");
  let limit = 100;
  let page = 1;
  if (ctx.searchParams.limit) {
    limit = parseInt(ctx.searchParams.limit, 10);
    if (limit < 1 || limit > 100) {
      throw new errors.BadRequest(
        `Parameter "limit" must be between 1 and 100, received ${limit}.`,
      );
    }
    query.limit(limit);
    if (ctx.searchParams.page) {
      page = parseInt(ctx.searchParams.page, 10);
      if (page < 1) {
        throw new errors.BadRequest(
          `Parameter "page" must be 1 or greater, received ${page}.`,
        );
      }
      if (page > 1) {
        query.offset((page - 1) * limit);
      }
    }
  } else if (ctx.searchParams.page) {
    throw new errors.BadRequest(
      `Parameter "page" cannot be specified without "limit" being specified.`,
    );
  }
  query.order("popularity_score", true);
  const response = await datastore.runQuery(query);
  if (response.batch.entityResults) {
    const hasNext = response.batch.moreResults !== "NO_MORE_RESULTS";
    return pagedResults(
      response.batch.entityResults.map(({ entity }) => entityToObject(entity)),
      ctx.url(),
      page,
      limit,
      hasNext,
    );
  }
});
router.get(
  "/v2/modules/:module",
  async (ctx) => {
    const response = await datastore.lookup(
      datastore.key(["module", ctx.params.module]),
    );
    if (response.found) {
      return entityToObject(response.found[0].entity);
    }
  },
);
router.get(
  "/v2/modules/:module/:version",
  async (ctx) => {
    const response = await datastore.lookup(
      datastore.key([
        "module",
        ctx.params.module,
      ], [
        "module_version",
        ctx.params.version,
      ]),
    );
    if (response.found) {
      return entityToObject(response.found[0].entity);
    }
  },
);

// ## DocNode related APIs

router.post(
  "/v2/modules/:module/:version/doc",
  async (ctx: Context<string[], { module: string; version: string }>) => {
    const { params: { module, version } } = ctx;
    const entries = await ctx.body();
    if (!entries || !Array.isArray(entries)) {
      throw new errors.BadRequest("Body is missing or malformed");
    }
    const results = await Promise.all(
      entries.map((entry) => getDocNodes(module, version, entry)),
    );
    const result: Record<string, DocNode[]> = {};
    for (const item of results) {
      if (item) {
        const [entry, nodes] = item;
        result[entry] = nodes;
      }
    }
    return result;
  },
);

async function checkMaybeLoad(
  module: string,
  version: string,
  path?: string,
): Promise<boolean> {
  const moduleVersionKey = datastore.key(
    ["module", module],
    ["module_version", version],
  );
  const result = await datastore.lookup(moduleVersionKey);
  const moduleVersionExists = !!result.found;
  if (!moduleVersionExists) {
    try {
      const mutations = await loadModule(module, version);
      if (mutations.length <= 1) {
        return false;
      }
      console.log(
        `  adding ${module}@${version}. Committing ${mutations.length} changes...`,
      );
      for await (
        const batch of datastore.commit(mutations, { transactional: false })
      ) {
        console.log(`  committed ${batch.mutationResults.length} changes.`);
      }
    } catch {
      return false;
    }
  }
  if (path) {
    const pathKey = datastore.key(
      ["module", module],
      ["module_version", version],
      ["module_entry", `/${path}`],
    );
    const result = await datastore.lookup(pathKey);
    return !!result.found;
  } else {
    return true;
  }
}

router.get("/v2/modules/:module/:version/doc/:path*", async (ctx) => {
  const { module, version, path } = ctx.params;
  const moduleEntryKey = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_entry", `/${path}`],
  );
  // attempt to retrieve the doc nodes from the datastore
  const results = await queryDocNodes(
    datastore,
    moduleEntryKey,
    ctx.searchParams.kind,
  );
  if (results.length) {
    return results;
  }
  // attempt to load the module
  if (!await checkMaybeLoad(module, version, path)) {
    return undefined;
  }
  try {
    const importMap = await getImportMapSpecifier(module, version);
    const docNodes = await generateDocNodes(module, version, path, importMap);
    enqueue({ kind: "commit", module, version, path, docNodes });
    // Upload docNodes to algolia.
    if (docNodes.length) {
      enqueue({ kind: "algolia", module, version, path, docNodes });
    }
    return docNodes;
  } catch (e) {
    if (isHttpError(e)) {
      throw e;
    }
    return undefined;
  }
});

async function appendQuery(
  results: Record<string, string[]>,
  query: Query,
  path: string,
): Promise<boolean> {
  let any = false;
  for await (const entity of datastore.streamQuery(query)) {
    any = true;
    const obj: ModuleEntry = entityToObject(entity);
    if (obj.path.startsWith(path) && obj.index) {
      results[obj.path] = obj.index;
    }
  }
  return any;
}

router.get("/v2/modules/:module/:version/index/:path*{/}?", async (ctx) => {
  const { module, version, path: paramPath } = ctx.params;
  const moduleKey = datastore.key(
    ["module", module],
    ["module_version", version],
  );
  const query = datastore
    .createQuery("module_entry")
    .filter("type", "dir")
    .hasAncestor(moduleKey);
  const results: Record<string, string[]> = {};
  const path = `/${paramPath}`;
  const any = await appendQuery(results, query, path);
  if (!any) {
    if (await checkMaybeLoad(module, version)) {
      await appendQuery(results, query, path);
    }
  }
  if (Object.keys(results).length) {
    const docNodeQuery = datastore
      .createQuery("doc_node")
      .filter("kind", "moduleDoc")
      .hasAncestor(moduleKey);
    const docs: Record<string, JsDoc> = {};
    for await (const entity of datastore.streamQuery(docNodeQuery)) {
      assert(entity.key);
      // this ensure we only find moduleDoc for the module, not from a re-exported
      // namespace which might have module doc as well.
      if (entity.key.path.length !== 4) {
        continue;
      }
      const key = entity.key.path[2]?.name;
      assert(key);
      if (key.startsWith(path)) {
        const obj: DocNodeModuleDoc = entityToObject(entity);
        docs[key] = obj.jsDoc;
      }
    }
    return { index: results, docs };
  }
});

// webhooks

interface ApiPayload {
  event: "create";
  module: string;
  version: string;
}

router.post(
  "/webhook/publish",
  auth(async (ctx: Context<ApiPayload>) => {
    const body = await ctx.body();
    if (!body || body.event !== "create" || !body.module || !body.version) {
      throw new errors.BadRequest("Missing or malformed body");
    }
    const { module, version } = body;
    const id = enqueue({ kind: "load", module, version });
    return { result: "enqueued", id };
  }, endpointAuth),
);

// basic logging and error handling

router.addEventListener("listen", (evt) => {
  console.log(
    `%cListening: %c${
      evt.secure ? "https://" : "http://"
    }${evt.hostname}:${evt.port}`,
    "color:green;font-weight:bold;",
    "color:yellow",
  );
});

router.addEventListener("handled", (evt) => {
  const responseColor = evt.response.status < 400
    ? "color:green"
    : evt.response.status < 500
    ? "color:yellow"
    : "color:red";
  let url;
  try {
    url = new URL(evt.request.url);
  } catch {
    // just swallow errors here
  }
  console.log(
    `%c${evt.request.method} ${
      evt.route?.route ?? url?.pathname
    } - [${evt.response.status}] ${evt.measure.duration.toFixed(2)}ms`,
    responseColor,
  );
});

// log out stack of errors that are either server errors or other non-http
// errors.
router.addEventListener("error", (evt) => {
  if (isHttpError(evt.error)) {
    if (evt.error.status > 500 && evt.error.stack) {
      console.log(evt.error.stack);
    }
  } else if (evt.error instanceof Error) {
    if (evt.error.stack) {
      console.log(evt.error.stack);
    }
  }
});

// we only listen if this is the main module (or on Deploy). This allows the
// router listening to be controlled in the tests.
if (Deno.env.get("DENO_DEPLOYMENT_ID") || Deno.mainModule === import.meta.url) {
  router.listen({ port: 3000 });
}
