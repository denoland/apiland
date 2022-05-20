// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { config } from "https://deno.land/std@0.140.0/dotenv/mod.ts";
import { Router } from "https://deno.land/x/acorn@0.0.7/mod.ts";
import {
  errors,
  isHttpError,
} from "https://deno.land/x/oak_commons@0.3.1/http_errors.ts";
import {
  Datastore,
  entityToObject,
} from "https://deno.land/x/google_datastore@0.0.9/mod.ts";

await config({ export: true });

function getServiceAccountFromEnv() {
  const privateKey = Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "";
  return {
    client_email: Deno.env.get("GOOGLE_CLIENT_EMAIL") ?? "",
    private_key: privateKey.startsWith(`"`)
      ? JSON.parse(privateKey)
      : privateKey,
    private_key_id: Deno.env.get("GOOGLE_PRIVATE_KEY_ID") ?? "",
    project_id: Deno.env.get("GOOGLE_PROJECT_ID") ?? "",
  };
}

const keys = getServiceAccountFromEnv();
const datastore = new Datastore(keys);

export const router = new Router();

router.all("/", () => {
  return new Response(
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
          <li><code>/v2/modules/:module</code> - Provide information about a specific module - [<a href="/v2/modules/std" target="_blank">example</a>]</li>
          <li><code>/v2/modules/:module/:version</code> - Provide information about a specific module version - [<a href="/v2/modules/std/0.139.0" target="_blank">example</a>]</li>
          <li><code>/v2/modules/:module/:version/doc/:path*</code> - Provide documentation nodes for a specific path of a specific module version -  [<a href="/v2/modules/std/0.139.0/doc/archive/tar.ts" target="_blank">example</a>]</li>
          <li><code>/ping</code> - A health endpoint for the server - [<a href="/ping" target="_blank">example</a>]</li>
        <ul>
      </div>
    </body>
  </html>`,
    {
      headers: {
        "content-type": "text/html",
      },
    },
  );
});
router.get("/~/spec", async () => {
  const bodyInit = await Deno.readTextFile("./specs/api-2.0.0.yaml");
  return new Response(bodyInit, {
    headers: {
      "content-type": "text/yaml",
    },
  });
});

router.get("/v2/modules", async (ctx) => {
  const query = datastore.createQuery("module");
  if (ctx.searchParams.limit) {
    const limit = parseInt(ctx.searchParams.limit, 10);
    if (limit < 1 || limit > 100) {
      throw new errors.BadRequest(
        `Parameter "limit" must be between 1 and 100, received ${limit}.`,
      );
    }
    query.limit(limit);
    if (ctx.searchParams.page) {
      const page = parseInt(ctx.searchParams.page, 10);
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
  const response = await datastore.runQuery(query);
  if (response.batch.entityResults) {
    return response.batch.entityResults.map(({ entity }) =>
      entityToObject(entity)
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
    results.push(entityToObject(entity));
  }
  return results.length ? results : undefined;
});
router.get("/v2/modules/:module/:version/doc/:path*", async (ctx) => {
  const query = datastore
    .createQuery("doc_node")
    .hasAncestor(datastore.key(
      ["module", ctx.params.module],
      ["module_version", ctx.params.version],
      ["module_entry", `/${ctx.params.path}`],
    ));
  if (ctx.searchParams.kind) {
    query.filter("kind", ctx.searchParams.kind);
  }
  const results = [];
  for await (const entity of datastore.streamQuery(query)) {
    results.push(entityToObject(entity));
  }
  return results.length ? results : undefined;
});

router.get("/ping", () => ({ pong: true }));

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
