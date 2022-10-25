// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { type Module } from "./types.d.ts";

export function assert(
  cond: unknown,
  message = "Assertion failed.",
): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

/** Given a module, return a human readable string for the popularity. */
export function getPopularityLabel(module: Module): string {
  const popularity = module.tags?.find(({ kind }) => kind === "popularity");
  switch (popularity?.value) {
    case "top_1_percent":
      return "⭐⭐⭐ Extremely Popular";
    case "top_5_percent":
      return "⭐⭐ Very Popular";
    case "top_10_percent":
      return "⭐ Popular";
  }
  return "";
}
