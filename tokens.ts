// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { parse } from "std/flags/mod.ts";
import { loadTokens, saveTokens } from "./auth.ts";

async function createToken(id: string) {
  const tokens = await loadTokens();
  const token = tokens.create(id);
  console.log("%cCreated%c.", "color:green", "color:none");
  console.log(`%cid%c: %c${id}`, "color:yellow", "color:none", "color:cyan");
  console.log(
    `%ctoken%c: %c${token}`,
    "color:yellow",
    "color:none",
    "color:cyan",
  );
  return saveTokens(tokens);
}

async function revokeToken(id: string) {
  const tokens = await loadTokens();
  tokens.revoke(id);
  console.log("%cRevoked%c.", "color:green", "color:none");
  return saveTokens(tokens);
}

async function query(id: string) {
  const tokens = await loadTokens();
  const created = tokens.has(id);
  if (created) {
    console.log("%cExists%c.", "color:green", "color:none");
    console.log(
      `%ccreated%c: %c${created.toISOString()}`,
      "color:yellow",
      "color:none",
      "color:cyan",
    );
  } else {
    console.log("%cDoesn't exists%c.", "color:yellow", "color:none");
  }
}

async function validate(token: string) {
  const tokens = await loadTokens();
  const result = tokens.lookup(token);
  if (result) {
    console.log("%cValid%c.", "color:green", "color:none");
    console.log(
      `%cid%c: %c${result.id}`,
      "color:yellow",
      "color:none",
      "color:cyan",
    );
    console.log(
      `%ccreated%c: %c${result.created.toISOString()}`,
      "color:yellow",
      "color:none",
      "color:cyan",
    );
  } else {
    console.log("%cInvalid%c.", "color:yellow", "color:none");
  }
}

function printHelp() {
  console.log(`
USAGE:
    deno task tokens [SUBCOMMAND]

SUBCOMMANDS:
    create
            Create (or replace) an API token for a given id.
    query
            Return if an ID has an API token.
    revoke
            Revoke an API token for a given id. Either the token or the ID can
            be provided.
    validate
            Given an API token, return if it is valid and what user it is
            associated with.

`);
}

async function main() {
  console.log("apiland tokens CLI");
  const args = parse(Deno.args, { boolean: "help" });
  if (args["help"]) {
    printHelp();
    return;
  }
  const [subcommand] = args["_"];
  switch (subcommand) {
    case "create": {
      const [, id] = args["_"];
      if (id && typeof id === "string") {
        await createToken(id);
      } else {
        console.error("bad request");
      }
      break;
    }
    case "revoke": {
      const [, id] = args["_"];
      if (id && typeof id === "string") {
        await revokeToken(id);
      } else {
        console.error("bad request");
      }
      break;
    }
    case "query": {
      const [, id] = args["_"];
      if (id && typeof id === "string") {
        await query(id);
      } else {
        console.error("bad request");
      }
      break;
    }
    case "validate": {
      const [, token] = args["_"];
      if (token && typeof token === "string") {
        await validate(token);
      } else {
        console.error("bad request");
      }
      break;
    }
    default:
      console.error(
        "%cBad or missing subcommand%c.",
        "color:red",
        "color:none",
      );
      printHelp();
  }
}

main();
