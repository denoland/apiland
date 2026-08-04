// Copyright 2022-2023 the Deno authors. All rights reserved. MIT license.

import { assertEquals } from "std/testing/asserts.ts";

import { signRequest } from "./migrate_info_to_r2.ts";

/** Credentials, region and service used throughout AWS' published
 * `aws4_testsuite` fixtures. */
const SUITE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  date: new Date("2015-08-30T12:36:00Z"),
};

// aws4_testsuite/get-vanilla
Deno.test("signRequest - get-vanilla", async () => {
  const headers = await signRequest({
    ...SUITE,
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
  });

  assertEquals(headers["x-amz-date"], "20150830T123600Z");
  assertEquals(headers.host, "example.amazonaws.com");
  assertEquals(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

// aws4_testsuite/post-x-www-form-urlencoded — exercises a request body and an
// additional signed header.
Deno.test("signRequest - post-x-www-form-urlencoded", async () => {
  const headers = await signRequest({
    ...SUITE,
    method: "POST",
    url: new URL("https://example.amazonaws.com/"),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new TextEncoder().encode("Param1=value1"),
  });

  assertEquals(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=content-type;host;x-amz-date, " +
      "Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
  );
});

Deno.test("signRequest - x-amz-content-sha256 is signed", async () => {
  const headers = await signRequest({
    ...SUITE,
    service: "s3",
    region: "auto",
    method: "PUT",
    url: new URL(
      "https://acct.r2.cloudflarestorage.com/bucket/oak/meta/info.json",
    ),
    headers: {
      "x-amz-content-sha256":
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  });

  assertEquals(
    headers.authorization.includes(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date",
    ),
    true,
    "R2 rejects requests where x-amz-content-sha256 is not a signed header",
  );
  assertEquals(
    headers.authorization.includes("/auto/s3/aws4_request"),
    true,
  );
});
