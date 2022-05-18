import { config } from "https://deno.land/std@0.139.0/dotenv/mod.ts";
import {
  Datastore,
  DatastoreError,
  objectSetKey,
  objectToEntity,
} from "https://deno.land/x/google_datastore@0.0.7/mod.ts";

import type {
  Mutation,
  PathElement,
} from "https://deno.land/x/google_datastore@0.0.7/types.d.ts";

import type { DocNode } from "https://deno.land/x/deno_doc@v0.34.0/lib/types.d.ts";

await config({ export: true });

function getServiceAccountFromEnv() {
  const privateKey = Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "";
  return {
    client_email: Deno.env.get("GOOGLE_CLIENT_EMAIL") ?? "",
    private_key: privateKey.startsWith(`"`)
      ? JSON.parse(privateKey)
      : privateKey,
    private_key_id: Deno.env.get("GOOGLE_PRIVATE_KEY_ID") ?? "",
    project_id: Deno.env.get("GOOGLE_PROJECT_ID") ?? "",
  };
}

const keys = getServiceAccountFromEnv();
const datastore = new Datastore(keys);

const mutations: Mutation[] = [];

const std = JSON.parse(await Deno.readTextFile("./mocks/std.json"));
const path: PathElement[] = [{ kind: "module", name: "std" }];
objectSetKey(std, { path: [...path] });
mutations.push({ upsert: objectToEntity(std) });

const stdVersion = {
  name: "std",
  version: "0.139.0",
  description: "The Deno Standard Library",
  upload_options: {
    ref: "0.139.0",
    type: "github",
    repository: "denoland/deno_std",
  },
  uploaded_at: new Date("2022-05-12T13:03:24.611Z"),
};
path.push({ kind: "module_version", name: "0.139.0" });
objectSetKey(stdVersion, { path: [...path] });
mutations.push({ upsert: objectToEntity(stdVersion) });

interface DocNodeIndex {
  structure: Record<string, string[]>;
  entries: Record<string, DocNode[]>;
}

const { structure, entries }: DocNodeIndex = JSON.parse(
  await Deno.readTextFile("./mocks/std_0.139.0_doc.json"),
);

for (const [key, value] of Object.entries(structure)) {
  const node = { name: key, items: value };
  objectSetKey(node, { path: [...path, { kind: "doc_structure", name: key }] });
  mutations.push({ upsert: objectToEntity(node) });
}

for (const [key, value] of Object.entries(entries)) {
  const moduleEntry = { path: key, type: "file" };
  const moduleEntryPath = [...path, { kind: "module_entry", name: key }];
  objectSetKey(moduleEntry, { path: moduleEntryPath });
  mutations.push({ upsert: objectToEntity(moduleEntry) });
  for (const docNode of value) {
    objectSetKey(docNode, { path: [...moduleEntryPath, { kind: "doc_node" }] });
    mutations.push({ upsert: objectToEntity(docNode) });
  }
}

async function commit(mutations: Mutation[]) {
  while (mutations.length) {
    let current: Mutation[];
    if (mutations.length > 500) {
      current = mutations.slice(0, 500);
      mutations = mutations.slice(500);
    } else {
      current = mutations;
      mutations = [];
    }
    try {
      await datastore.commit(current, false);
      console.log(`committed ${current.length} mutations`);
    } catch (err) {
      if (err instanceof DatastoreError) {
        console.log(err.statusInfo);
      } else {
        console.log("Error occurred.");
      }
      return;
    }
  }
}

await commit(mutations);
