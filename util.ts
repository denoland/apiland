// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

export function assert(
  cond: unknown,
  message = "Assertion failed.",
): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}
