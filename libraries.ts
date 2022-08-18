// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import dax from "dax";
import { doc } from "deno_doc";
import {
  type Datastore,
  DatastoreError,
  type KeyInit,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Mutation } from "google_datastore/types";
import { parse } from "std/flags/mod.ts";

import { addNodes, mergeEntries } from "./docs.ts";
import { getDatastore } from "./store.ts";
import type { Library, LibraryVersion } from "./types.d.ts";
import { assert } from "./util.ts";

interface GitHubAsset {
  name: string;
  content_type: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  draft: boolean;
  prerelease: false;
  assets: GitHubAsset[];
}

const LIBRARY_KIND = "library";
const LIBRARY_VERSION_KIND = "library_version";
const DENO_STABLE_NAME = "deno_stable";

const GITHUB_API_HEADERS = {
  accept: "application/vnd.github.v3+json",
} as const;

async function clear(
  datastore: Datastore,
  mutations: Mutation[],
  keyInit: KeyInit[],
) {
  const kinds = ["doc_node"];
  const ancestor = datastore.key(...keyInit);

  for (const kind of kinds) {
    const query = datastore
      .createQuery(kind)
      .hasAncestor(ancestor)
      .select("__key__");

    for await (const { key } of datastore.streamQuery(query)) {
      if (key) {
        mutations.push({ delete: key });
      }
    }
  }
}

async function commit(datastore: Datastore, mutations: Mutation[]) {
  let remaining = mutations.length;
  dax.logLight(`    committing ${remaining} changes to datastore...`);
  try {
    for await (
      const res of datastore.commit(mutations, { transactional: false })
    ) {
      remaining -= res.mutationResults.length;
      dax.logLight(
        `    ${res.mutationResults.length} committed. ${remaining} to go.`,
      );
    }
  } catch (error) {
    if (error instanceof DatastoreError) {
      dax.logError(
        "DatastoreError",
        error.statusText,
        JSON.stringify(error.statusInfo, undefined, "  "),
      );
    } else {
      throw error;
    }
  }
}

async function docLibrary(
  datastore: Datastore,
  mutations: Mutation[],
  source: string,
  contentType: string | undefined,
  keyInit: KeyInit[],
) {
  const docNodes = mergeEntries(
    await doc(source, {
      includeAll: true,
      async load(specifier) {
        const res = await dax.request(specifier).noThrow();
        if (res.status === 200) {
          return {
            specifier,
            headers: {
              "content-type": contentType ?? res.headers.get("content-type") ??
                "application/typescript",
            },
            content: await res.text(),
            kind: "module",
          };
        }
      },
    }),
  );
  addNodes(datastore, mutations, docNodes, keyInit);
}

async function loadStableLibrary(reload: boolean) {
  dax.logStep("Loading the Deno CLI stable libraries...");
  dax.logStep("Fetching most recent 100 releases...");
  const releases = await dax
    .request(
      "https://api.github.com/repos/denoland/deno/releases?per_page=100",
    )
    .header(GITHUB_API_HEADERS).json<GitHubRelease[]>();
  const stableVersions = new Map<string, LibraryVersion>();
  let latestVersion: string | undefined;
  for (const release of releases) {
    if (!release.draft && !release.prerelease) {
      latestVersion = latestVersion ?? release.tag_name;
      for (const asset of release.assets) {
        if (asset.name === "lib.deno.d.ts") {
          stableVersions.set(release.tag_name, {
            name: DENO_STABLE_NAME,
            version: release.tag_name,
            source: asset.browser_download_url,
            source_content_type: asset.content_type,
          });
        }
      }
    }
  }
  assert(latestVersion);
  const library: Library = {
    name: DENO_STABLE_NAME,
    versions: [...stableVersions].map(([, { version }]) => version),
    latest_version: latestVersion,
  };
  const datastore = await getDatastore();
  const libraryKey = datastore.key([LIBRARY_KIND, DENO_STABLE_NAME]);
  if (!reload) {
    const versionQuery = datastore
      .createQuery(LIBRARY_VERSION_KIND)
      .hasAncestor(libraryKey)
      .select("__key__");
    for await (const { key } of datastore.streamQuery(versionQuery)) {
      if (key && key.path[1]?.name) {
        stableVersions.delete(key.path[1].name);
      }
    }
  }
  if (!stableVersions.size) {
    dax.logWarn("Nothing to load.");
    return;
  }
  dax.logStep(`Creating ${stableVersions.size} stable library versions...`);
  objectSetKey(library, libraryKey);
  let mutations: Mutation[] = [];
  mutations.push({ upsert: objectToEntity(library) });
  for (const [versionName, version] of stableVersions) {
    dax.logLight(`  documenting ${versionName}...`);
    const keyInit: KeyInit[] = [
      [LIBRARY_KIND, DENO_STABLE_NAME],
      [LIBRARY_VERSION_KIND, versionName],
    ];
    await clear(datastore, mutations, keyInit);
    objectSetKey(version, datastore.key(...keyInit));
    mutations.push({ upsert: objectToEntity(version) });
    await docLibrary(
      datastore,
      mutations,
      version.source,
      version.source_content_type,
      keyInit,
    );
    await commit(datastore, mutations);
    mutations = [];
  }
  dax.logStep("Success.");
}

function loadLibrary(name: string, reload: boolean) {
  switch (name) {
    case "stable":
      return loadStableLibrary(reload);
    default:
      dax.logError(`Unsupported loading of library: "${name}".`);
  }
}

function main() {
  const args = parse(Deno.args, { boolean: ["reload"] });
  const subcommand = String(args["_"][0]);
  switch (subcommand) {
    case "load":
      return loadLibrary(String(args["_"][1]), args["reload"]);
    default:
      dax.logError(`Unsupported sub-command: "${subcommand}".`);
  }
}

if (import.meta.main) {
  main();
}
