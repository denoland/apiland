// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { Router } from "https://deno.land/x/acorn@0.0.1/mod.ts";

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

router.listen({ port: 3000 });
