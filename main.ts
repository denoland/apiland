// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { Router } from "https://deno.land/x/acorn@0.0.3/mod.ts";
import modulesDB from "./mocks/modules.json" assert { type: "json" };
import modulesVersionsDB from "./mocks/modules_versions.json" assert {
  type: "json",
};

type ModuleKey = keyof typeof modulesDB;
type VersionsKey<Key extends ModuleKey> = keyof (typeof modulesVersionsDB)[Key];

const router = new Router();

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

router.get("/v2/modules", () => Object.values(modulesDB));
router.get(
  "/v2/modules/:id",
  (ctx) => modulesDB[ctx.params.id as ModuleKey],
);
router.get(
  "/v2/modules/:id/:version",
  (ctx) => {
    return modulesVersionsDB[ctx.params.id as ModuleKey][
      ctx.params.version as VersionsKey<ModuleKey>
    ];
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

router.listen({ port: 3000 });
