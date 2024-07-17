// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import { type RouterListenEvent } from "acorn";
import { getDatastore } from "./auth.ts";

import { router } from "./main.ts";

// required to ensure that all bootstrapping is completed before attempting to
// test
await getDatastore();

function setup(): [AbortController, Promise<string>] {
  const { promise, resolve } = Promise.withResolvers<string>();

  const controller = new AbortController();
  function onlisten({ secure, hostname, port }: RouterListenEvent) {
    // deno-lint-ignore no-explicit-any
    router.removeEventListener("listen", onlisten as any);
    const url = `${secure ? "https" : "http"}://${hostname}:${port}`;
    resolve(url);
  }
  router.addEventListener("listen", onlisten);

  router.listen({ signal: controller.signal });

  return [controller, promise];
}

function teardown(controller: AbortController) {
  if (!controller) {
    return;
  }
  controller.abort();
}

Deno.test({
  name: "GET /",
  sanitizeResources: false,
  async fn() {
    const [controller, hostnamePromise] = setup();
    const hostname = await hostnamePromise;

    const response = await fetch(`${hostname}/`);
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "text/html; charset=UTF-8",
    );
    assertStringIncludes(await response.text(), "<h1>apiland.deno.dev</h1>");

    teardown(controller);
  },
});

Deno.test({
  name: "GET /ping",
  async fn() {
    const [controller, hostnamePromise] = setup();
    const hostname = await hostnamePromise;

    const response = await fetch(`${hostname}/ping`);
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "application/json; charset=UTF-8",
    );
    assertEquals(await response.json(), { pong: true });

    teardown(controller);
  },
});
