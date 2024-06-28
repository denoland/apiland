// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * The main API server process.
 *
 * @module
 */

import { auth, type Context, Router } from "acorn";
import { type SearchIndex } from "algoliasearch";
import {
  type Datastore,
  DatastoreError,
  datastoreValueToValue,
  entityToObject,
} from "google_datastore";
import { errors, isHttpError } from "std/http/http_errors.ts";
import twas from "twas";

import { getSearchClient } from "./algolia.ts";
import { endpointAuth, getDatastore } from "./auth.ts";
import {
  cacheDocPage,
  cacheSourcePage,
  lookup,
  lookupDocPage,
  lookupInfoPage,
  lookupSourcePage,
} from "./cache.ts";
import {
  getCompletionItems,
  getCompletions,
  getPathDoc,
} from "./completions.ts";
import { GITHUB_HOOKS_CIDRS, indexes, kinds, ROOT_SYMBOL } from "./consts.ts";
import {
  checkMaybeLoad,
  type DocNode,
  type DocNodeKind,
  generateDocNodes,
  generateDocPage,
  generateInfoPage,
  generateModuleIndex,
  generateSourcePage,
  getDocNodes,
  getImportMapSpecifier,
  isDocable,
  queryDocNodes,
} from "./docs.ts";
import { getModuleLatestVersion, redirectToLatest } from "./modules.ts";
import { enqueue } from "./process.ts";
import {
  ApiModuleData,
  DependencyMetrics,
  InfoPage,
  Module,
  ModuleMetrics,
  ModuleVersion,
  SubModuleMetrics,
} from "./types.d.ts";
import { assert, getPopularityLabel, isIp4InCidrs } from "./util.ts";
import type {
  WebhookPayloadCreate,
  WebhookPayloadPing,
  WebhookPayloadPush,
} from "./webhooks.d.ts";
import { createEvent, pingEvent, pushEvent } from "./webhook.ts";
import DISABLED_MODULES from "./docDisabledModules.json" with {
  type: "json",
};

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
          <li><code>/v2/pages/mod/doc/:module/:version/:path*</code> - provides a structure to render a doc view page - [<a href="/v2/pages/mod/doc/std/0.150.0/testing/asserts.ts">example</a>]</li>
          <li><code>/v2/pages/mod/source/:module/:version/:path*</code> - provides a structure to render a source view page - [<a href="/v2/pages/mod/source/std/0.150.0/testing/asserts.ts">example</a>]</li>
          <li><code>/v2/pages/mod/info/:module/:version</code> - provides a structure to render a module info page - [<a href="/v2/pages/info/oak/v11.0.0">example</a>]</li>
          <li><code>/v2/modules</code> - Provide a list of modules in the registry - [<a href="/v2/modules" target="_blank">example</a>]</li>
          <li><code>/v2/modules/:module</code> - Provide information about a specific module - [<a href="/v2/modules/std" target="_blank">example</a>]</li>
          <li><code>/v2/modules/:module/:version</code> - Provide information about a specific module version - [<a href="/v2/modules/std/0.139.0" target="_blank">example</a>]</li>
          <li><code>/v2/modules/:module/:version/doc/:path*</code> - Provide documentation nodes for a specific path of a specific module version -  [<a href="/v2/modules/std/0.139.0/doc/archive/tar.ts" target="_blank">example</a>]</li>
          <li><code>/v2/metrics/apis</code> - Provide metric information for builtin APIs -  [<a href="/v2/metrics/apis" target="_blank">example</a>]</li>
          <li><code>/v2/metrics/modules/:module</code> - Provide metric information for a module -  [<a href="/v2/metrics/modules/oak" target="_blank">example</a>]</li>
          <li><code>/v2/metrics/submmodules/:submodule</code> - Provide metric information for a module's submodules -  [<a href="/v2/metrics/modules/std" target="_blank">example</a>]</li>
          <li><code>/v2/metrics/dependencies/:source*</code> - Provide metrics information for a dependency source -  [<a href="/v2/metrics/modules/deno.land/x" target="_blank">example</a>]</li>
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
  const query = datastore.createQuery(kinds.MODULE_METRICS_KIND);
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
  const orderBy = ctx.searchParams.orderBy ?? "score";
  query.order(`popularity.${orderBy}`, true);
  const response = await datastore.runQuery(query);
  if (response.batch.entityResults) {
    const hasNext = response.batch.moreResults !== "NO_MORE_RESULTS";
    const lookups = new Map<string, ModuleMetrics & { description?: string }>();
    const results = pagedResults<ModuleMetrics & { description?: string }>(
      response.batch.entityResults.map(({ entity }) => {
        const metric = entityToObject<ModuleMetrics>(entity);
        lookups.set(metric.name, metric);
        return metric;
      }),
      ctx.url(),
      page,
      limit,
      hasNext,
    );
    const lookupResult = await datastore.lookup(
      [...lookups.keys()].map((name) =>
        datastore!.key([kinds.MODULE_KIND, name])
      ),
    );
    if (lookupResult.found) {
      for (const { entity } of lookupResult.found) {
        const module = entityToObject<Module>(entity);
        const result = lookups.get(module.name);
        if (result) {
          result.description = module.description;
        }
      }
    }
    return results;
  }
});
router.get("/v2/metrics/modules/:module", async (ctx) => {
  datastore = datastore ?? await getDatastore();
  const res = await datastore.lookup(
    datastore.key([kinds.MODULE_METRICS_KIND, ctx.params.module]),
  );
  if (res.found && res.found.length === 1) {
    const metrics = entityToObject<ModuleMetrics>(res.found[0].entity);
    const latest = await getModuleLatestVersion(ctx.params.module);
    let info: InfoPage | undefined;
    if (latest) {
      info = await lookupInfoPage(ctx.params.module, latest);
      if (!info) {
        info = await generateInfoPage(ctx.params.module, latest);
      }
    }
    return { metrics, info };
  }
});

router.get("/v2/metrics/submodules/:mod", async (ctx) => {
  const { mod } = ctx.params;
  datastore = datastore ?? await getDatastore();
  const query = datastore
    .createQuery(kinds.SUBMODULE_METRICS_KIND)
    .filter("module", mod);
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
  // TODO(@kitsonk) - datastore is complaining there is no index
  // const orderBy = ctx.searchParams.orderBy ?? "score";
  // query.order(`popularity.${orderBy}`, true);
  try {
    const response = await datastore.runQuery(query);
    if (response.batch.entityResults) {
      const hasNext = response.batch.moreResults !== "NO_MORE_RESULTS";
      return pagedResults<SubModuleMetrics>(
        response.batch.entityResults.map(({ entity }) =>
          entityToObject<SubModuleMetrics>(entity)
        ),
        ctx.url(),
        page,
        limit,
        hasNext,
      );
    }
  } catch (error) {
    if (error instanceof DatastoreError) {
      console.error(JSON.stringify(error.statusInfo, undefined, "  "));
    } else {
      throw error;
    }
  }
});

router.get("/v2/metrics/apis", async (_ctx) => {
  const views: Record<string, unknown> = {};
  datastore = datastore ?? await getDatastore();
  for await (
    const entity of datastore.streamQuery(
      datastore.createQuery(kinds.API_STATS_KIND),
    )
  ) {
    assert(entity.key);
    assert(entity.key.path[0].name);
    views[entity.key.path[0].name] = entityToObject(entity);
  }
  return views;
});

router.get("/v2/metrics/usage/:mod", async (ctx) => {
  datastore = datastore ?? await getDatastore();
  const res = await datastore
    .lookup(datastore.key([kinds.METRIC_USAGE_KIND, ctx.params.mod]));
  if (res.found) {
    return entityToObject(res.found[0].entity);
  }
});

router.get("/v2/metrics/dependencies/:source*", async (ctx) => {
  datastore = datastore ?? await getDatastore();
  let query = datastore.createQuery(kinds.DEP_METRICS_KIND);
  const { source } = ctx.params;
  if (source) {
    query = query.filter("source", source);
  }
  const items = await datastore.query<DependencyMetrics>(query);
  if (items.length) {
    return { items };
  }
});

// ## Registry related APIs ##
router.get("/legacy_modules/:id", async (ctx) => {
  const datastore = await getDatastore();
  const res = await datastore.lookup(
    datastore.key([kinds.LEGACY_MODULES, ctx.params.id]),
  );
  if (res.found && res.found.length === 1) {
    return entityToObject<ApiModuleData>(res.found[0].entity);
  }
});

router.get("/legacy_modules_count", async () => {
  datastore = datastore ?? await getDatastore();
  const query = await datastore.runGqlAggregationQuery({
    queryString:
      `SELECT COUNT(*) FROM legacy_modules WHERE is_unlisted = false`,
    allowLiterals: true,
  });
  return datastoreValueToValue(
    query.batch.aggregationResults[0].aggregateProperties.property_1,
  ) as number;
});

router.get(
  "/v2/builds/:id",
  async (ctx) => {
    datastore = datastore ?? await getDatastore();
    const response = await datastore.lookup(
      datastore.key([kinds.BUILD_KIND, ctx.params.id]),
    );
    if (response.found) {
      return entityToObject(response.found[0].entity);
    }
  },
);

router.get("/v2/modules", async (ctx) => {
  datastore = datastore ?? await getDatastore();
  const query = datastore.createQuery(kinds.MODULE_KIND);
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
      datastore.key([kinds.MODULE_KIND, ctx.params.module]),
    );
    if (response.found) {
      const obj = entityToObject<Module>(response.found[0].entity);

      if (obj.latest_version) {
        const response = await datastore.lookup(
          datastore.key(
            [kinds.MODULE_KIND, ctx.params.module],
            [kinds.MODULE_VERSION_KIND, obj.latest_version],
          ),
        );

        if (response.found) {
          obj.upload_options =
            entityToObject<ModuleVersion>(response.found[0].entity)
              .upload_options;
        }
      }

      return obj;
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
      datastore.key(
        [kinds.MODULE_KIND, ctx.params.module],
        [kinds.MODULE_VERSION_KIND, ctx.params.version],
      ),
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
  // puts too much pressure on datastore
  if (DISABLED_MODULES.includes(module)) return undefined;
  datastore = datastore ?? await getDatastore();
  const moduleEntryKey = datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.MODULE_ENTRY_KIND, `/${path}`],
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
  // puts too much pressure on datastore
  const path = `/${paramPath}`;
  datastore = datastore ?? await getDatastore();
  const indexKey = datastore.key(
    [kinds.MODULE_KIND, module],
    [kinds.MODULE_VERSION_KIND, version],
    [kinds.MODULE_INDEX_KIND, path],
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

interface ModuleSourcePagesParams extends Record<string, string> {
  module: string;
  version: string;
  path: string;
}

async function moduleSourcePage(
  ctx: Context<unknown, ModuleSourcePagesParams>,
) {
  let { module, version, path: paramPath } = ctx.params;
  module = decodeURIComponent(module);
  version = decodeURIComponent(version);
  paramPath = decodeURIComponent(paramPath);
  if (version === "__latest__") {
    return redirectToLatest(ctx.url(), module);
  }
  // puts too much pressure on datastore
  const path = `/${paramPath}`;
  let sourcePage = await lookupSourcePage(module, version, path);
  if (!sourcePage) {
    datastore = datastore ?? await getDatastore();
    sourcePage = await generateSourcePage(datastore, module, version, path);
    if (sourcePage) {
      cacheSourcePage(module, version, path, sourcePage);
    }
    if (
      sourcePage && sourcePage.kind !== "invalid-version" &&
      sourcePage.kind !== "notfound"
    ) {
      enqueue({
        kind: "commitSourcePage",
        module,
        version,
        path,
        sourcePage,
      });
    }
  }
  return sourcePage;
}

/** @deprecated to be removed */
router.get("/v2/pages/code/:module/:version/:path*{/}?", moduleSourcePage);
router.get(
  "/v2/pages/mod/source/:module/:version/:path*{/}?",
  moduleSourcePage,
);

router.get("/v2/pages/mod/info/:module/:version{/}?", async (ctx) => {
  let { module, version } = ctx.params;
  module = decodeURIComponent(module);
  version = decodeURIComponent(version);
  if (version === "__latest__") {
    return redirectToLatest(ctx.url(), module);
  }
  // puts too much pressure on datastore
  let infoPage = await lookupInfoPage(module, version);
  if (!infoPage) {
    infoPage = await generateInfoPage(module, version);
  }
  return infoPage;
});

interface ModuleDocPagesParams extends Record<string, string> {
  module: string;
  version: string;
  path: string;
}

async function moduleDocPage(ctx: Context<unknown, ModuleDocPagesParams>) {
  let { module, version, path: paramPath } = ctx.params;
  module = decodeURIComponent(module);
  version = decodeURIComponent(version);
  paramPath = decodeURIComponent(paramPath);
  if (version === "__latest__") {
    return redirectToLatest(ctx.url(), module);
  }
  const path = `/${paramPath}`;
  const symbol = ctx.searchParams.symbol ?? ROOT_SYMBOL;
  // puts too much pressure on datastore
  if (DISABLED_MODULES.includes(module)) return undefined;
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
          `/v2/pages/mod/doc/${module}/${version}${docPage.path}${ctx.url().search}`,
        "X-Deno-Module": module,
        "X-Deno-Version": version,
        "X-Deno-Module-Path": docPage.path,
      },
    });
  }
  return docPage;
}

/** @deprecated to be removed */
router.get("/v2/pages/doc/:module/:version/:path*{/}?", moduleDocPage);
router.get("/v2/pages/mod/doc/:module/:version/:path*{/}?", moduleDocPage);

// registry completions

export const MAX_AGE_1_HOUR = "max-age=3600";
export const MAX_AGE_1_DAY = "max-age=86400";
export const IMMUTABLE = "max-age=2628000, immutable";

let searchIndex: SearchIndex | undefined;
let cachedRootQuery: string[] | undefined;

router.get("/completions/items/{:mod}?", async (ctx) => {
  let items: string[] | undefined;
  let isIncomplete = true;
  if (ctx.params.mod || !cachedRootQuery) {
    searchIndex = searchIndex ??
      (await getSearchClient()).initIndex(indexes.MODULE_INDEX);
    const res = await searchIndex.search<{ name: string }>(
      ctx.params.mod ?? "",
      {
        facetFilters: "third_party:true",
        hitsPerPage: 20,
        attributesToRetrieve: ["name"],
      },
    );
    isIncomplete = res.nbPages > 1;
    items = res.hits.map(({ name }) => name);
    if (!ctx.params.mod) {
      cachedRootQuery = items;
    }
  } else if (!ctx.params.mod && cachedRootQuery) {
    items = cachedRootQuery;
  }
  return Response.json({ items, isIncomplete }, {
    headers: {
      "cache-control": MAX_AGE_1_DAY,
      "content-type": "application/json",
    },
  });
});

router.get("/completions/resolve/:mod", async (ctx) => {
  const [moduleItem] = await lookup(ctx.params.mod);
  if (moduleItem) {
    const message = getPopularityLabel(moduleItem);
    return Response.json({
      kind: "markdown",
      value:
        `**${moduleItem.name}**\n\n${moduleItem.description}\n\n[info](https://deno.land/${
          moduleItem.name !== "std" ? "x/" : ""
        }${moduleItem.name})${message ? ` | ${message}` : ""}\n\n`,
    }, {
      headers: {
        "cache-control": MAX_AGE_1_DAY,
        "content-type": "application/json",
      },
    });
  }
});

router.get("/completions/items/:mod/{:ver}?", async (ctx) => {
  const [moduleItem] = await lookup(ctx.params.mod);
  if (moduleItem) {
    const items = ctx.params.ver
      ? moduleItem.versions.filter((version) =>
        version.startsWith(ctx.params.ver)
      )
      : moduleItem.versions;
    if (items.length) {
      return Response.json({
        items,
        isIncomplete: false,
        preselect:
          moduleItem.latest_version && items.includes(moduleItem.latest_version)
            ? moduleItem.latest_version
            : undefined,
      }, {
        headers: {
          "cache-control": MAX_AGE_1_HOUR,
          "content-type": "application/json",
        },
      });
    }
  }
});

router.get("/completions/resolve/:mod/:ver", async (ctx) => {
  const [moduleItem, moduleVersion] = await lookup(
    ctx.params.mod,
    ctx.params.ver,
  );
  if (moduleItem && moduleVersion) {
    const message = getPopularityLabel(moduleItem);
    const value =
      `**${moduleVersion.name} @ ${moduleVersion.version}**\n\n${moduleVersion.description}\n\n[info](https://deno.land/${
        moduleVersion.name !== "std" ? "x/" : ""
      }${moduleVersion.name}@${moduleVersion.version}) | published: _${
        twas(moduleVersion.uploaded_at)
      }_${message ? ` | ${message}` : ""}\n\n`;
    return Response.json({ kind: "markdown", value }, {
      headers: {
        "cache-control": MAX_AGE_1_DAY,
        "content-type": "application/json",
      },
    });
  }
});

router.get("/completions/items/:mod/:ver/:path*{/}?", async (ctx) => {
  const completions = await getCompletions(ctx.params.mod, ctx.params.ver);
  if (completions) {
    const path = ctx.url().pathname.endsWith("/") && ctx.params.path
      ? `/${ctx.params.path}/`
      : `/${ctx.params.path}`;
    const completionItems = getCompletionItems(completions, path);
    if (completionItems) {
      return Response.json(completionItems, {
        headers: {
          "cache-control": ctx.params.ver === "__latest__"
            ? MAX_AGE_1_DAY
            : IMMUTABLE,
          "content-type": "application/json",
        },
      });
    }
  }
});

router.get("/completions/resolve/:mod/:ver/:path*{/}?", async (ctx) => {
  const completions = await getCompletions(ctx.params.mod, ctx.params.ver);
  if (completions) {
    const path = ctx.url().pathname.endsWith("/") && ctx.params.path
      ? `/${ctx.params.path}/`
      : `/${ctx.params.path}`;
    const parts = path.split("/");
    const last = parts.pop();
    const dir = last ? `${parts.join("/")}/` : path;
    let value = await getPathDoc(completions, dir, path) ?? "";
    if (value) {
      value += "\n\n---\n\n";
    }
    const { mod, ver } = ctx.params;
    value += `[doc](https://deno.land/${mod !== "std" ? "x/" : ""}${mod}${
      ver !== "__latest__" ? `@${ver}` : ""
    }${path}) | [source](https://deno.land/${mod !== "std" ? "x/" : ""}${mod}${
      ver !== "__latest__" ? `@${ver}` : ""
    }${path}?source) | [info](https://deno.land/${
      mod !== "std" ? "x/" : ""
    }${mod}${ver !== "__latest__" ? `@${ver}` : ""}/)`;
    return Response.json({
      kind: "markdown",
      value,
    }, {
      headers: {
        "cache-control": ctx.params.ver === "__latest__"
          ? MAX_AGE_1_DAY
          : IMMUTABLE,
        "content-type": "application/json",
      },
    });
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

router.post(
  "/webhook/temp_gh/:module",
  auth(async (
    ctx: Context<
      WebhookPayloadCreate | WebhookPayloadPing | WebhookPayloadPush
    >,
  ) => {
    const body = await ctx.body();

    if (!body) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "no body provided",
        }),
        {
          status: 400,
        },
      );
    }

    const ghEvent = ctx.request.headers.get("x-github-event");

    switch (ghEvent) {
      case "ping":
        return pingEvent(
          ctx.params.module,
          body as WebhookPayloadPing,
          ctx.url().searchParams,
        );
      case "push":
        return pushEvent(
          ctx.params.module,
          body as WebhookPayloadPush,
          ctx.url().searchParams,
        );
      case "create":
        return createEvent(
          ctx.params.module,
          body as WebhookPayloadCreate,
          ctx.url().searchParams,
        );
      default:
        return new Response(
          JSON.stringify({
            success: false,
            info: "not a ping, or create event",
          }),
          {
            status: 200,
          },
        );
    }
  }, endpointAuth),
);

router.post(
  "/webhook/gh/:module",
  async (
    ctx: Context<
      WebhookPayloadCreate | WebhookPayloadPing | WebhookPayloadPush
    >,
  ) => {
    if (!isIp4InCidrs(ctx.addr.hostname, GITHUB_HOOKS_CIDRS)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "request does not come from GitHub",
        }),
        {
          status: 400,
        },
      );
    }

    if (
      !(ctx.request.headers.get("content-type") ?? "").startsWith(
        "application/json",
      ) &&
      !(ctx.request.headers.get("content-type") ?? "").startsWith(
        "application/x-www-form-urlencoded",
      )
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "content-type is not json or x-www-form-urlencoded",
        }),
        {
          status: 400,
        },
      );
    }

    let body;

    if (
      (ctx.request.headers.get("content-type") ?? "").startsWith(
        "application/json",
      )
    ) {
      body = await ctx.body();
    } else {
      body = ctx.searchParams.payload;
    }

    if (!body) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "no body provided",
        }),
        {
          status: 400,
        },
      );
    }

    const ghEvent = ctx.request.headers.get("x-github-event");
    switch (ghEvent) {
      case "ping":
        return pingEvent(
          ctx.params.module,
          body as WebhookPayloadPing,
          ctx.url().searchParams,
        );
      case "push":
        return pushEvent(
          ctx.params.module,
          body as WebhookPayloadPush,
          ctx.url().searchParams,
        );
      case "create":
        return createEvent(
          ctx.params.module,
          body as WebhookPayloadCreate,
          ctx.url().searchParams,
        );
      default:
        return new Response(
          JSON.stringify({
            success: false,
            info: "not a ping, or create event",
          }),
          {
            status: 200,
          },
        );
    }
  },
);

// shield.io endpoints

router.get("/shields/:module/version", async (ctx) => {
  const { module } = ctx.params;
  const [moduleItem] = await lookup(module);
  if (moduleItem?.latest_version) {
    return {
      schemaVersion: 1,
      label: "deno.land/x",
      namedLogo: "deno",
      message: moduleItem.latest_version,
      color: "informational",
    };
  }
});

router.get("/shields/:module/popularity", async (ctx) => {
  const { module } = ctx.params;
  const [moduleItem] = await lookup(module);
  if (moduleItem?.tags) {
    let message = "Published";
    let color = "informational";
    const popularity = moduleItem.tags.find(({ kind }) =>
      kind === "popularity"
    );
    switch (popularity?.value) {
      case "top_1_percent":
        message = "Top 1%";
        color = "brightgreen";
        break;
      case "top_5_percent":
        message = "Top 5%";
        color = "green";
        break;
      case "top_10_percent":
        message = "Top 10%";
        color = "yellowgreen";
        break;
    }
    return {
      schemaVersion: 1,
      label: "deno.land/x",
      namedLogo: "deno",
      message,
      color,
    };
  }
});

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
  if (evt.measure.duration > 5000) {
    let url;
    try {
      url = new URL(evt.request.url);
    } catch {
      // just swallow errors here
    }
    console.warn(
      `%c${evt.request.method} ${url?.pathname} - [${evt.response.status}] ${
        evt.measure.duration.toFixed(2)
      }ms`,
      "color:yellow",
    );
  }
});

/*
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
});*/

// log out stack of errors that are either server errors or other non-http
// errors.
router.addEventListener("error", (evt) => {
  if (isHttpError(evt.error)) {
    if (evt.error.status > 500 && evt.error.stack) {
      console.error(evt.error.stack);
    }
  } else if (evt.error instanceof Error) {
    if (evt.error.stack) {
      console.error(evt.error.stack);
    }
  }
});

// we only listen if this is the main module (or on Deploy). This allows the
// router listening to be controlled in the tests.
if (Deno.env.get("DENO_DEPLOYMENT_ID") || Deno.mainModule === import.meta.url) {
  router.listen({ port: 3000 });
}
