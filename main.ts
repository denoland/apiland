// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * The main API server process.
 *
 * @module
 */

import { Router } from "https://deno.land/x/acorn@0.0.8/mod.ts";
import {
  errors,
  isHttpError,
} from "https://deno.land/x/oak_commons@0.3.1/http_errors.ts";
import {
  Datastore,
  DatastoreError,
  entityToObject,
  type KeyInit,
  objectSetKey,
  objectToEntity,
} from "https://deno.land/x/google_datastore@0.0.11/mod.ts";
import type {
  Entity,
  Key,
  Mutation,
} from "https://deno.land/x/google_datastore@0.0.11/types.d.ts";

import { keys } from "./auth.ts";
import {
  type DocNode,
  type DocNodeNamespace,
  generateDocNodes,
} from "./docs.ts";

const datastore = new Datastore(keys);

interface PagedItems<T> {
  items: T[];
  next?: string;
  previous?: string;
}

function assert(cond: unknown, message = "Assertion failed."): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
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
      <title>api.deno.land</title>
    </head>
    <body>
      <h1>api.deno.land</h1>
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

function asDocNodeMap(entities: Entity[]) {
  const map: Record<string, unknown[]> = Object.create(null);
  for (const entity of entities) {
    if (entity.key) {
      const key = entity.key.path.find((v) => v.kind === "module_entry")?.name;
      if (key) {
        if (!(key in map)) {
          map[key] = [];
        }
        map[key].push(entityToObject(entity));
      }
    }
  }
  const arr = [];
  for (const [module_entry, doc_nodes] of Object.entries(map)) {
    arr.push({ module_entry, doc_nodes });
  }
  return arr;
}

router.get("/v2/modules/:module/:version/doc", async (ctx) => {
  const query = datastore
    .createQuery("doc_node")
    .hasAncestor(datastore.key(
      ["module", ctx.params.module],
      ["module_version", ctx.params.version],
    ));
  if (ctx.searchParams.kind) {
    query.filter("kind", ctx.searchParams.kind);
  }
  const results = [];
  for await (const entity of datastore.streamQuery(query)) {
    results.push(entity);
  }
  return results.length ? asDocNodeMap(results) : undefined;
});

/** Recursively add doc nodes to the mutations, serializing the definition
 * fields and breaking out namespace entries as their own entities.
 *
 * The definition fields are serialized, because Datastore only supports 20
 * nested entities, which can occur in doc nodes with complex types.
 */
function addNodes(
  mutations: Mutation[],
  docNodes: DocNode[],
  keyInit: KeyInit[],
) {
  let id = 1;
  for (const docNode of docNodes) {
    const paths: KeyInit[] = [...keyInit, ["doc_node", id++]];
    // deno-lint-ignore no-explicit-any
    let node: any;
    switch (docNode.kind) {
      case "namespace": {
        const { namespaceDef, ...namespaceNode } = docNode;
        objectSetKey(namespaceNode, datastore.key(...paths));
        mutations.push({ upsert: objectToEntity(namespaceNode) });
        addNodes(mutations, namespaceDef.elements, paths);
        continue;
      }
      case "class": {
        const { classDef, ...rest } = docNode;
        node = { classDef: JSON.stringify(classDef), ...rest };
        break;
      }
      case "enum": {
        const { enumDef, ...rest } = docNode;
        node = { enumDef: JSON.stringify(enumDef), ...rest };
        break;
      }
      case "function": {
        const { functionDef, ...rest } = docNode;
        node = { functionDef: JSON.stringify(functionDef), ...rest };
        break;
      }
      case "import": {
        const { importDef, ...rest } = docNode;
        node = { importDef: JSON.stringify(importDef), ...rest };
        break;
      }
      case "interface": {
        const { interfaceDef, ...rest } = docNode;
        node = { interfaceDef: JSON.stringify(interfaceDef), ...rest };
        break;
      }
      case "moduleDoc": {
        node = docNode;
        break;
      }
      case "typeAlias": {
        const { typeAliasDef, ...rest } = docNode;
        node = { typeAliasDef: JSON.stringify(typeAliasDef), ...rest };
        break;
      }
      case "variable": {
        const { variableDef, ...rest } = docNode;
        node = { variableDef: JSON.stringify(variableDef), ...rest };
        break;
      }
    }
    objectSetKey(node, datastore.key(...paths));
    mutations.push({ upsert: objectToEntity(node) });
  }
}

/** Given a set of doc nodes, commit them to the datastore. */
async function commitDocNodes(
  module: string,
  version: string,
  path: string,
  docNodes: DocNode[],
) {
  const mutations: Mutation[] = [];
  const keyInit = [["module", module], ["module_version", version], [
    "module_entry",
    `/${path}`,
  ]] as KeyInit[];
  addNodes(mutations, docNodes, keyInit);
  console.log(
    `  Committing ${mutations.length} doc nodes for ${module}@${version}/${path}...`,
  );
  try {
    for await (
      const _result of datastore.commit(mutations, { transactional: false })
    ) {
      console.log(`  Committed batch for ${module}@${version}/${path}.`);
    }
  } catch (error) {
    if (error instanceof DatastoreError) {
      console.log("Datastore Error:");
      console.log(`${error.status} ${error.message}`);
      console.log(error.statusInfo);
    } else {
      console.log("Unexpected Error:");
      console.log(error);
    }
    return;
  }
  console.log(`  Done.`);
}

/** Determine if a datastore key is equal to another one. */
function isKeyEqual(a: Key, b: Key): boolean {
  if (
    a.partitionId?.projectId === b.partitionId?.projectId &&
    a.partitionId?.namespaceId === b.partitionId?.namespaceId &&
    a.path.length === b.path.length
  ) {
    for (let i = 0; i < a.path.length; i++) {
      const aPathElement = a.path[i];
      const bPathElement = b.path[i];
      if (
        aPathElement.kind !== bPathElement.kind ||
        aPathElement.id !== bPathElement.id ||
        aPathElement.name !== bPathElement.name
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** Query the datastore for doc nodes, deserializing the definitions and
 * recursively querying namespaces. */
async function queryDocNodes(
  ancestor: Key,
  kind?: string,
): Promise<DocNode[]> {
  const query = datastore.createQuery("doc_node").hasAncestor(ancestor);
  if (kind) {
    query.filter("kind", kind);
  }
  const results: DocNode[] = [];
  const namespaces: [DocNodeNamespace, Key][] = [];
  for await (const entity of datastore.streamQuery(query)) {
    const docNode: DocNode = entityToObject(entity);
    results.push(docNode);
    assert(entity.key);
    switch (docNode.kind) {
      case "namespace":
        if (!isKeyEqual(ancestor, entity.key)) {
          namespaces.push([docNode, entity.key]);
        }
        break;
      case "class":
        docNode.classDef = JSON.parse(docNode.classDef as unknown as string);
        break;
      case "enum":
        docNode.enumDef = JSON.parse(docNode.enumDef as unknown as string);
        break;
      case "function":
        docNode.functionDef = JSON.parse(
          docNode.functionDef as unknown as string,
        );
        break;
      case "import":
        docNode.importDef = JSON.parse(docNode.importDef as unknown as string);
        break;
      case "interface":
        docNode.interfaceDef = JSON.parse(
          docNode.interfaceDef as unknown as string,
        );
        break;
      case "typeAlias":
        docNode.typeAliasDef = JSON.parse(
          docNode.typeAliasDef as unknown as string,
        );
        break;
      case "variable":
        docNode.variableDef = JSON.parse(
          docNode.variableDef as unknown as string,
        );
    }
  }
  for (const [namespace, key] of namespaces) {
    namespace.namespaceDef = { elements: await queryDocNodes(key, kind) };
  }
  return results;
}

router.get("/v2/modules/:module/:version/doc/:path*", async (ctx) => {
  const { module, version, path } = ctx.params;
  const moduleEntryKey = datastore.key(
    ["module", module],
    ["module_version", version],
    ["module_entry", `/${path}`],
  );
  // attempt to retrieve the doc nodes from the datastore
  const results = await queryDocNodes(moduleEntryKey, ctx.searchParams.kind);
  if (results.length) {
    return results;
  }
  try {
    // ensure that the module actually exists
    await datastore.lookup(moduleEntryKey);
    const docNodes = await generateDocNodes(module, version, path);
    commitDocNodes(module, version, path, docNodes);
    return docNodes;
  } catch {
    return undefined;
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
