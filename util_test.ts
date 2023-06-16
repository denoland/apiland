// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { assert, assertEquals, assertThrows } from "std/testing/asserts.ts";
import {
  ip4ToInt,
  isIp4InCidr,
  moduleDependencyToURLAndDisplay,
} from "./util.ts";

Deno.test("moduleDependencyToURLAndDisplay - std", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "std",
    src: "std",
  });

  assertEquals(url1, "https://deno.land/std");
  assertEquals(display1, "std");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "std",
    src: "std",
    ver: "1.0",
  });

  assertEquals(url2, "https://deno.land/std@1.0");
  assertEquals(display2, "std@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - deno.land/x", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "deno.land/x",
  });

  assertEquals(url1, "https://deno.land/x/foo");
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "deno.land/x",
    ver: "1.0",
  });

  assertEquals(url2, "https://deno.land/x/foo@1.0");
  assertEquals(display2, "foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - cdn.deno.land", () => {
  const [url, display] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    ver: "1.0",
    src: "cdn.deno.land",
  });

  assertEquals(url, "https://cdn.deno.land/foo/versions/1.0/raw");
  assertEquals(display, "foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - esm.sh", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "esm.sh",
  });

  assertEquals(url1, "https://esm.sh/foo");
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "esm.sh",
    ver: "1.0",
  });

  assertEquals(url2, "https://esm.sh/foo@1.0");
  assertEquals(display2, "foo@1.0");

  const [url3, display3] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "esm.sh",
    org: "bar",
    ver: "1.0",
  });

  assertEquals(url3, "https://esm.sh/bar/foo@1.0");
  assertEquals(display3, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - unpkg.com", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "unpkg.com",
  });

  assertEquals(url1, "https://unpkg.com/foo");
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "unpkg.com",
    ver: "1.0",
  });

  assertEquals(url2, "https://unpkg.com/foo@1.0");
  assertEquals(display2, "foo@1.0");

  const [url3, display3] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "unpkg.com",
    org: "bar",
    ver: "1.0",
  });

  assertEquals(url3, "https://unpkg.com/bar/foo@1.0");
  assertEquals(display3, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - jsdeliver.net", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "jsdeliver.net",
  });

  assertEquals(url1, undefined);
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "jsdeliver.net",
    ver: "1.0",
  });

  assertEquals(url2, undefined);
  assertEquals(display2, "foo@1.0");

  const [url3, display3] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "jsdeliver.net",
    org: "bar",
    ver: "1.0",
  });

  assertEquals(url3, undefined);
  assertEquals(display3, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - skypack.dev", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "skypack.dev",
  });

  assertEquals(url1, undefined);
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "skypack.dev",
    ver: "1.0",
  });

  assertEquals(url2, undefined);
  assertEquals(display2, "foo@1.0");

  const [url3, display3] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "skypack.dev",
    org: "bar",
    ver: "1.0",
  });

  assertEquals(url3, undefined);
  assertEquals(display3, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - jspm.dev", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "jspm.dev",
  });

  assertEquals(url1, undefined);
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "jspm.dev",
    ver: "1.0",
  });

  assertEquals(url2, undefined);
  assertEquals(display2, "foo@1.0");

  const [url3, display3] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "jspm.dev",
    org: "bar",
    ver: "1.0",
  });

  assertEquals(url3, undefined);
  assertEquals(display3, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - gist.github.com", () => {
  const [url, display] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    src: "gist.github.com",
  });

  assertEquals(url, "https://gist.github.com/bar/foo");
  assertEquals(display, "bar/foo");
});

Deno.test("moduleDependencyToURLAndDisplay - github.com", () => {
  const [url, display] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    ver: "1.0",
    src: "github.com",
  });

  assertEquals(url, "https://github.com/bar/foo/tree/1.0");
  assertEquals(display, "bar/foo/1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - ghuc.cc", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    src: "ghuc.cc",
  });

  assertEquals(url1, "https://ghuc.cc/bar/foo");
  assertEquals(display1, "bar/foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    ver: "1.0",
    src: "ghuc.cc",
  });

  assertEquals(url2, "https://ghuc.cc/bar/foo@1.0");
  assertEquals(display2, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - pax.deno.dev", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    src: "pax.deno.dev",
  });

  assertEquals(url1, "https://pax.deno.dev/bar/foo");
  assertEquals(display1, "bar/foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    ver: "1.0",
    src: "pax.deno.dev",
  });

  assertEquals(url2, "https://pax.deno.dev/bar/foo@1.0");
  assertEquals(display2, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - ghc.deno.dev", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    src: "ghc.deno.dev",
  });

  assertEquals(url1, "https://ghc.deno.dev/bar/foo");
  assertEquals(display1, "bar/foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    ver: "1.0",
    src: "ghc.deno.dev",
  });

  assertEquals(url2, "https://ghc.deno.dev/bar/foo@1.0");
  assertEquals(display2, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - denopkg.com", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "denopkg.com",
  });

  assertEquals(url1, "https://denopkg.com/foo");
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    src: "denopkg.com",
  });

  assertEquals(url2, "https://denopkg.com/bar/foo");
  assertEquals(display2, "bar/foo");

  const [url3, display3] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    ver: "1.0",
    src: "denopkg.com",
  });

  assertEquals(url3, "https://denopkg.com/bar/foo@1.0");
  assertEquals(display3, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - lib.deno.dev", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "lib.deno.dev",
  });

  assertEquals(url1, "https://lib.deno.dev/foo");
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    ver: "1.0",
    src: "lib.deno.dev",
  });

  assertEquals(url2, "https://lib.deno.dev/foo@1.0");
  assertEquals(display2, "foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - denolib.com", () => {
  const [url1, display1] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "denolib.com",
  });

  assertEquals(url1, "https://denolib.com/foo");
  assertEquals(display1, "foo");

  const [url2, display2] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    src: "denolib.com",
  });

  assertEquals(url2, "https://denolib.com/bar/foo");
  assertEquals(display2, "bar/foo");

  const [url3, display3] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    org: "bar",
    ver: "1.0",
    src: "denolib.com",
  });

  assertEquals(url3, "https://denolib.com/bar/foo@1.0");
  assertEquals(display3, "bar/foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - crux.land", () => {
  const [url, display] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    ver: "1.0",
    src: "crux.land",
  });

  assertEquals(url, "https://crux.land/foo@1.0");
  assertEquals(display, "foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - nest.land", () => {
  const [url, display] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    ver: "1.0",
    src: "nest.land",
  });

  assertEquals(url, "https://x.nest.land/foo@1.0");
  assertEquals(display, "foo@1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - googleapis", () => {
  const [url, display] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    ver: "1.0",
    src: "googleapis",
  });

  assertEquals(url, "https://googleapis.deno.dev/v1/foo:1.0");
  assertEquals(display, "foo:1.0");
});

Deno.test("moduleDependencyToURLAndDisplay - aws-api", () => {
  const [url, display] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    ver: "1.0",
    src: "aws-api",
  });

  assertEquals(url, "https://aws-api.deno.dev/1.0/services/foo");
  assertEquals(display, "1.0/foo");
});

Deno.test("moduleDependencyToURLAndDisplay - other", () => {
  const [url, display] = moduleDependencyToURLAndDisplay({
    pkg: "foo",
    src: "other",
  });

  assertEquals(url, "foo");
  assertEquals(display, "foo");
});

Deno.test({
  name: "ipv4 parsing",
  fn() {
    assert(ip4ToInt("1.1.1.1"));
    assertThrows(() => ip4ToInt("1.1.1.1.1"));
    assertThrows(() => ip4ToInt("1.1.1.-1"));
    assertThrows(() => ip4ToInt("1.1.1.300"));
  },
});

Deno.test({
  name: "ipv4 in cidr matches",
  fn() {
    assertEquals(isIp4InCidr("1.1.1.1")("0.0.0.0/0"), true);
    assertEquals(isIp4InCidr("1.1.1.1")("1.1.1.0/24"), true);
    assertEquals(isIp4InCidr("1.1.1.1")("1.1.1.0/31"), true);
    assertEquals(isIp4InCidr("1.1.1.1")("1.1.1.0/32"), false);
    assertEquals(isIp4InCidr("1.1.1.1")("1.2.1.0/31"), false);
  },
});
