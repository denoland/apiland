// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import { type RouterListenEvent } from "acorn";

import { router } from "./main.ts";

let serverPromise: Promise<string> | undefined;
let controller: AbortController | undefined;

function setup(): Promise<string> {
  if (serverPromise) {
    return serverPromise;
  }
  let resolve: (value: string | PromiseLike<string>) => void;
  serverPromise = new Promise((res) => resolve = res);
  controller = new AbortController();
  function onlisten({ secure, hostname, port }: RouterListenEvent) {
    // deno-lint-ignore no-explicit-any
    router.removeEventListener("listen", onlisten as any);
    const url = `${secure ? "https" : "http"}://${hostname}:${port}`;
    resolve(url);
  }
  router.addEventListener("listen", onlisten);

  router.listen({ signal: controller.signal });

  return serverPromise;
}

function teardown() {
  if (!controller) {
    return;
  }
  controller.abort();
  controller = undefined;
  serverPromise = undefined;
}

Deno.test({
  name: "GET /",
  async fn() {
    const hostname = await setup();

    const response = await fetch(`${hostname}/`);
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "text/html; charset=UTF-8",
    );
    assertStringIncludes(await response.text(), "<h1>api.deno.land</h1>");

    teardown();
  },
});

Deno.test({
  name: "GET /ping",
  async fn() {
    const hostname = await setup();

    const response = await fetch(`${hostname}/ping`);
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "application/json; charset=UTF-8",
    );
    assertEquals(await response.json(), { pong: true });

    teardown();
  },
});
