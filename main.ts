// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { config } from "https://deno.land/std@0.139.0/dotenv/mod.ts";
import { Router } from "https://deno.land/x/acorn@0.0.7/mod.ts";
import {
  errors,
  isHttpError,
} from "https://deno.land/x/oak_commons@0.3.1/http_errors.ts";
import {
  Datastore,
  entityToObject,
} from "https://deno.land/x/google_datastore@0.0.5/mod.ts";
import { type Query } from "https://deno.land/x/google_datastore@0.0.5/types.d.ts";

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
    </body>
  </html>`,
    {
      headers: {
        "content-type": "text/html",
      },
    },
  );
});

router.get("/v2/modules", async (ctx) => {
  const query: Query = { kind: [{ name: "module" }] };
  if (ctx.searchParams.limit) {
    const limit = parseInt(ctx.searchParams.limit, 10);
    if (limit < 1 || limit > 100) {
      throw new errors.BadRequest(
        `Parameter "limit" must be between 1 and 100, received ${limit}.`,
      );
    }
    query.limit = limit;
    if (ctx.searchParams.page) {
      const page = parseInt(ctx.searchParams.page, 10);
      if (page < 1) {
        throw new errors.BadRequest(
          `Parameter "page" must be 1 or greater, received ${page}.`,
        );
      }
      if (page > 1) {
        query.offset = (page - 1) * limit;
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
  "/v2/modules/:id",
  async (ctx) => {
    const response = await datastore.lookup([{
      path: [{
        kind: "module",
        name: ctx.params.id,
      }],
    }]);
    if (response.found) {
      return entityToObject(response.found[0].entity);
    }
  },
);
router.get(
  "/v2/modules/:id/:version",
  async (ctx) => {
    const response = await datastore.lookup([{
      path: [{
        kind: "module",
        name: ctx.params.id,
      }, {
        kind: "module_version",
        name: ctx.params.version,
      }],
    }]);
    if (response.found) {
      return entityToObject(response.found[0].entity);
    }
  },
);

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
