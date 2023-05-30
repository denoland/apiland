// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import type { Module, ModuleDependency } from "./types.d.ts";

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

export function moduleDependencyToURLAndDisplay(
  dep: ModuleDependency,
): [url: string | undefined, display: string] {
  switch (dep.src) {
    case "std": {
      const ver = dep.ver ? `@${dep.ver}` : "";
      return [`https://deno.land/std${ver}`, `std${ver}`];
    }
    case "deno.land/x": {
      const ver = dep.ver ? `@${dep.ver}` : "";
      return [`https://deno.land/x/${dep.pkg}${ver}`, `${dep.pkg}${ver}`];
    }
    case "cdn.deno.land": {
      return [
        `https://cdn.deno.land/${dep.pkg}/versions/${dep.ver!}/raw`,
        `${dep.pkg}@${dep.ver!}`,
      ];
    }

    // npm
    case "esm.sh": {
      const path = `${dep.org ? `${dep.org}/` : ""}${dep.pkg}${
        dep.ver ? `@${dep.ver}` : ""
      }`;
      return [`https://esm.sh/${path}`, path];
    }
    case "unpkg.com": {
      const path = `${dep.org ? `${dep.org}/` : ""}${dep.pkg}${
        dep.ver ? `@${dep.ver}` : ""
      }`;
      return [`https://unpkg.com/${path}`, path];
    }

    // Too many different cases without enough information to reconstruct,
    // so we don't link and use a common style for naming
    case "jsdeliver.net":
    case "skypack.dev":
    case "jspm.dev": {
      const path = `${dep.org ? `${dep.org}/` : ""}${dep.pkg}${
        dep.ver ? `@${dep.ver}` : ""
      }`;
      return [undefined, path];
    }

    // github
    case "gist.github.com": {
      const url = `https://gist.github.com/${dep.org!}/${dep.pkg}`;
      return [url, `${dep.org!}/${dep.pkg}`];
    }
    case "github.com": {
      const url = `https://github.com/${dep.org!}/${dep.pkg}/tree/${dep.ver!}`;
      return [url, `${dep.org!}/${dep.pkg}/${dep.ver!}`];
    }
    case "ghuc.cc": {
      const path = `${dep.org!}/${dep.pkg}${dep.ver ? `@${dep.ver}` : ""}`;
      return [`https://ghuc.cc/${path}`, path];
    }
    case "pax.deno.dev": {
      const path = `${dep.org!}/${dep.pkg}${dep.ver ? `@${dep.ver}` : ""}`;
      return [`https://pax.deno.dev/${path}`, path];
    }
    case "ghc.deno.dev": {
      const path = `${dep.org!}/${dep.pkg}${dep.ver ? `@${dep.ver}` : ""}`;
      return [`https://ghc.deno.dev/${path}`, path];
    }
    case "denopkg.com": {
      const path = `${dep.org ? `${dep.org}/` : ""}${dep.pkg}${
        dep.ver ? `@${dep.ver}` : ""
      }`;
      return [`https://denopkg.com/${path}`, path];
    }

    // others
    case "lib.deno.dev": {
      const ver = dep.ver ? `@${dep.ver}` : "";
      return [`https://lib.deno.dev/${dep.pkg}${ver}`, `${dep.pkg}${ver}`];
    }
    case "denolib.com": {
      const path = `${dep.org ? `${dep.org}/` : ""}${dep.pkg}${
        dep.ver ? `@${dep.ver}` : ""
      }`;
      return [`https://denolib.com/${path}`, path];
    }
    case "crux.land": {
      const path = `${dep.pkg}@${dep.ver!}`;
      return [`https://crux.land/${path}`, path];
    }
    case "nest.land": {
      const path = `${dep.pkg}@${dep.ver!}`;
      return [`https://x.nest.land/${path}`, path];
    }
    case "googleapis": {
      const path = `${dep.pkg}:${dep.ver!}`;
      return [`https://googleapis.deno.dev/v1/${path}`, path];
    }
    case "aws-api": {
      return [
        `https://aws-api.deno.dev/${dep.ver!}/services/${dep.pkg}`,
        `${dep.ver!}/${dep.pkg}`,
      ];
    }
    case "other":
      return [dep.pkg, dep.pkg];
  }
}

export function ip4ToInt(ip: string) {
  const octs_ = ip.split(".");
  if (octs_.length !== 4) throw new Error(`Invalid IP address ${ip}`);
  const oct = octs_.map((oct_) => {
    const oct = parseInt(oct_, 10);
    if (oct > 255 || oct < 0) throw new Error(`Invalid IP address ${ip}`);
    return oct;
  });
  return oct.reduce(
    (int, oct) => (int << 8) + oct,
    0,
  ) >>> 0;
}

export function isIp4InCidr(ip: string) {
  return (cidr: string) => {
    const [range, bits = "32"] = cidr.split("/");
    const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);
    return (ip4ToInt(ip) & mask) === (ip4ToInt(range) & mask);
  };
}

export function isIp4InCidrs(ip: string, cidrs: string[]) {
  return cidrs.some(isIp4InCidr(ip));
}
