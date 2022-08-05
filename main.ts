// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * The main API server process.
 *
 * @module
 */

import { auth, type Context, Router } from "acorn";
import { errors, isHttpError } from "oak_commons/http_errors.ts";
import { type Datastore, entityToObject } from "google_datastore";

import { endpointAuth } from "./auth.ts";
import {
  cacheCodePage,
  cacheDocPage,
  lookupCodePage,
  lookupDocPage,
} from "./cache.ts";
import {
  checkMaybeLoad,
  type DocNode,
  type DocNodeKind,
  generateCodePage,
  generateDocNodes,
  generateDocPage,
  generateModuleIndex,
  generateSymbolIndex,
  getDocNodes,
  getImportMapSpecifier,
  isDocable,
  queryDocNodes,
  ROOT_SYMBOL,
} from "./docs.ts";
import { redirectToLatest } from "./modules.ts";
import { enqueue } from "./process.ts";
import { getDatastore } from "./store.ts";

interface PagedItems<T> {
  items: T[];
  next?: string;
  previous?: string;
}

performance.mark("startup");

let datastore: Datastore | undefined;

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
          <li><code>/v2/pages/doc/:module/:version/:path*</code> - provides a structure to render a doc view page - [<a href="/v2/pages/doc/std/0.150.0/testing/asserts.ts">example</a>]</li>
          <li><code>/v2/pages/code/:module/:version/:path*</code> - provides a structure to render a code view page - [<a href="/v2/pages/code/std/0.150.0/testing/asserts.ts">example</a>]</li>
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
  datastore = datastore ?? await getDatastore();
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
  datastore = datastore ?? await getDatastore();
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
  datastore = datastore ?? await getDatastore();
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
    datastore = datastore ?? await getDatastore();
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
    if (ctx.params.version === "__latest__") {
      return redirectToLatest(ctx.url(), ctx.params.module);
    }
    datastore = datastore ?? await getDatastore();
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
    if (version === "__latest__") {
      return redirectToLatest(ctx.url(), module);
    }
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

router.get("/v2/modules/:module/:version/doc/:path*", async (ctx) => {
  const { module, version, path } = ctx.params;
  if (!isDocable(path)) {
    return;
  }
  if (version === "__latest__") {
    return redirectToLatest(ctx.url(), module);
  }
  datastore = datastore ?? await getDatastore();
  const moduleEntryKey = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_entry", `/${path}`],
  );
  // attempt to retrieve the doc nodes from the datastore
  const results = await queryDocNodes(
    datastore,
    moduleEntryKey,
    ctx.searchParams.kind as DocNodeKind,
  );
  if (results.length) {
    return results;
  }
  // attempt to load the module
  if (!await checkMaybeLoad(datastore, module, version, path)) {
    return undefined;
  }
  try {
    const importMap = await getImportMapSpecifier(module, version);
    const docNodes = await generateDocNodes(module, version, path, importMap);
    enqueue({ kind: "commit", module, version, path, docNodes });
    return docNodes;
  } catch (e) {
    if (isHttpError(e)) {
      throw e;
    }
    return undefined;
  }
});

router.get("/v2/modules/:module/:version/index/:path*{/}?", async (ctx) => {
  const { module, version, path: paramPath } = ctx.params;
  if (version === "__latest__") {
    return redirectToLatest(ctx.url(), module);
  }
  const path = `/${paramPath}`;
  datastore = datastore ?? await getDatastore();
  const indexKey = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_index", path],
  );
  const response = await datastore.lookup(indexKey);
  if (response.found) {
    return entityToObject(response.found[0].entity);
  }
  const index = await generateModuleIndex(datastore, module, version, path);
  if (index) {
    enqueue({ kind: "commitIndex", module, version, path, index });
  }
  return index;
});

router.get("/v2/modules/:module/:version/symbols/:path*{/}?", async (ctx) => {
  const { module, version, path: paramPath } = ctx.params;
  if (version === "__latest__") {
    return redirectToLatest(ctx.url(), module);
  }
  const path = `/${paramPath}`;
  datastore = datastore ?? await getDatastore();
  const indexKey = datastore.key(
    ["module", module],
    ["module_version", version],
    ["symbol_index", path],
  );
  const response = await datastore.lookup(indexKey);
  if (response.found) {
    return entityToObject(response.found[0].entity);
  }
  const index = await generateSymbolIndex(datastore, module, version, path);
  if (index) {
    enqueue({ kind: "commitSymbolIndex", module, version, path, index });
  }
  return index;
});

router.get("/v2/pages/code/:module/:version/:path*{/}?", async (ctx) => {
  let { module, version, path: paramPath } = ctx.params;
  module = decodeURIComponent(module);
  version = decodeURIComponent(version);
  paramPath = decodeURIComponent(paramPath);
  if (version === "__latest__") {
    return redirectToLatest(ctx.url(), module);
  }
  const path = `/${paramPath}`;
  let codePage = await lookupCodePage(module, version, path);
  if (!codePage) {
    datastore = datastore ?? await getDatastore();
    codePage = await generateCodePage(datastore, module, version, path);
    if (codePage) {
      cacheCodePage(module, version, path, codePage);
    }
    if (
      codePage && codePage.kind !== "invalid-version" &&
      codePage.kind !== "notfound"
    ) {
      enqueue({
        kind: "commitCodePage",
        module,
        version,
        path,
        codePage,
      });
    }
  }
  return codePage;
});

router.get("/v2/pages/doc/:module/:version/:path*{/}?", async (ctx) => {
  let { module, version, path: paramPath } = ctx.params;
  module = decodeURIComponent(module);
  version = decodeURIComponent(version);
  paramPath = decodeURIComponent(paramPath);
  if (version === "__latest__") {
    return redirectToLatest(ctx.url(), module);
  }
  const path = `/${paramPath}`;
  const symbol = ctx.searchParams.symbol ?? ROOT_SYMBOL;
  let docPage = await lookupDocPage(module, version, path, symbol);
  if (!docPage) {
    datastore = datastore ?? await getDatastore();
    try {
      docPage = await generateDocPage(datastore, module, version, path, symbol);
    } catch (e) {
      console.log("docPageError");
      console.error(e);
      throw e;
    }
    if (docPage) {
      cacheDocPage(module, version, path, symbol, docPage);
    }
    if (
      docPage && docPage.kind !== "invalid-version" &&
      docPage.kind !== "notfound"
    ) {
      enqueue({
        kind: "commitDocPage",
        module,
        version,
        path,
        symbol,
        docPage,
      });
    }
  }
  if (docPage?.kind === "redirect") {
    return new Response(null, {
      status: 301,
      statusText: "Moved Permanently",
      headers: {
        location:
          `/v2/modules/${module}/${version}/page${docPage.path}${ctx.url().search}`,
        "X-Deno-Module": module,
        "X-Deno-Version": version,
        "X-Deno-Module-Path": docPage.path,
      },
    });
  }
  return docPage;
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
  const measure = performance.measure("listen", "startup");
  console.log(
    `%cTime to listen%c in %c${measure.duration.toFixed(2)}ms%c.`,
    "color:green",
    "color:none",
    "color:cyan",
    "color:none",
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
