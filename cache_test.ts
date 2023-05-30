// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { assert, assertStrictEquals } from "std/testing/asserts.ts";
import { readyPromise } from "./auth.ts";
import { clear, lookup, lookupDocPage } from "./cache.ts";

await readyPromise;

Deno.test({
  name: "cache - lookup(module)",
  async fn() {
    clear();
    performance.mark("gm1");
    const [gm1] = await lookup("std");
    const pass1 = performance.measure("result1", "gm1");
    performance.mark("gm2");
    const [gm2] = await lookup("std");
    const pass2 = performance.measure("result2", "gm2");
    assertStrictEquals(gm1, gm2);
    assert(pass1.duration > pass2.duration);
    assert(pass2.duration < 2);
  },
});

Deno.test({
  name: "cache - lookup(module, version)",
  async fn() {
    clear();
    performance.mark("gv-gm1");
    const [, gv1] = await lookup("std", "0.189.0");
    assert(gv1);
    performance.mark("gv-gv1");
    const [, gv2] = await lookup("std", "0.189.0");
    performance.mark("gv-gv2");
    assertStrictEquals(gv1, gv2);
    const pass1 = performance.measure("gv-pass1", "gv-gm1", "gv-gv1");
    const pass2 = performance.measure("gv-pass2", "gv-gv1", "gv-gv2");
    assert(pass1.duration > pass2.duration);
    assert(pass2.duration < 2);
  },
});

Deno.test({
  name: "cache - lookup(module, version, path)",
  async fn() {
    clear();
    performance.mark("me-gm1");
    const [, , me1] = await lookup("std", "0.189.0", "/");
    assert(me1);
    performance.mark("me-me1");
    const [, , me2] = await lookup("std", "0.189.0", "/");
    performance.mark("me-me2");
    assertStrictEquals(me1, me2);
    const pass1 = performance.measure("me-pass1", "me-gm1", "me-me1");
    const pass2 = performance.measure("me-pass2", "me-me1", "me-me2");
    assert(pass1.duration > pass2.duration);
    assert(pass2.duration < 2);
  },
});

Deno.test({
  name: "cache - lookupDocPage(module, version, path, symbol)",
  async fn() {
    clear();
    performance.mark("dp-gm1");
    const dp1 = await lookupDocPage("std", "0.190.0", "/", "$$root$$");
    assert(dp1);
    performance.mark("dp-dp1");
    const dp2 = await lookupDocPage("std", "0.190.0", "/", "$$root$$");
    performance.mark("dp-dp2");
    assertStrictEquals(dp1, dp2);
    const pass1 = performance.measure("dp-pass1", "dp-gm1", "dp-dp1");
    const pass2 = performance.measure("dp-pass2", "dp-dp1", "dp-dp2");
    console.log(pass1.duration, pass2.duration);
    assert(pass1.duration > pass2.duration);
    assert(pass2.duration < 2);
  },
});
