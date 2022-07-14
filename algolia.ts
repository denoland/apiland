// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Script to upload doc nodes of modules to algolia.
 *
 * How does it work?
 *
 * 1. List modules using /v2/modules endpoint.
 * 2. For each module, get the paths of the latest version of the module.
 * 3. For each path, get the doc nodes of the module.
 * 4. Get the publish date of the module from Google Datastore.
 * 5. Append publishDate and popularityScore to the doc nodes.
 * 6. Upload the doc nodes to algolia.
 */

import { algoliaKeys } from "./auth.ts";
// import { sleep } from "https://deno.land/x/sleep/mod.ts";

const ALGOLIA_INDEX = "deno_modules";
const ALLOWED_DOCNODES = [
  "function",
  "variable",
  "enum",
  "class",
  "typeAlias",
  "interface",
];

async function main() {
  let batchRequests = [];
  const modules = await getModules(100, 3);
  for await (const [index, module] of modules.entries()) {
    if (module.popularity_score === 0) {
      continue;
    }

    const logPrefix = `[${index + 201}/${
      modules.length + 200
    } ${module.name}@${module.latest_version}]`;
    const log = (msg: string) => console.log(`${logPrefix} ${msg}`);

    log("started scraping doc nodes");
    console.time(logPrefix);
    const batchRecordsGenerators = [];
    try {
      const [publishedAt, moduleIndex] = await Promise.all([
        getPublishDate(module.name, module.latest_version),
        getModuleIndex(module.name, module.latest_version),
      ]);
      for (const path of moduleIndex) {
        batchRecordsGenerators.push(
          getAlgoliaBatchRecords(module, path, publishedAt),
        );
      }
      const algoliaBatchRequests = (await Promise.all(batchRecordsGenerators))
        .flat();
      log(`scraped ${algoliaBatchRequests.length} doc nodes`);
      // Back up doc nodes to the disk.
      await Deno.mkdir("docnodes").catch((err) => {
        if (err.name !== "AlreadyExists") {
          throw err;
        }
      });
      const backupPath = `docnodes/${index + 201}_${module.name}.json`;
      await Deno.writeTextFile(
        backupPath,
        JSON.stringify(algoliaBatchRequests),
      );
      batchRequests.push(...algoliaBatchRequests);
      if (index === modules.length - 1 || batchRequests.length > 100) {
        await uploadToAlgolia(batchRequests, algoliaKeys, ALGOLIA_INDEX);
        batchRequests = [];
      }
    } catch (error) {
      log(`failed to scrape module: ${error.message}`);
    }
    console.timeEnd(logPrefix);
  }
}

main();

async function uploadToAlgolia(
  batchRequests: AlgoliaBatchRecords[],
  keys: typeof algoliaKeys,
  algoliaIndex: string,
) {
  const payload = JSON.stringify({
    requests: batchRequests,
  });
  const label =
    `[upload] ${batchRequests.length} records of total size ${payload.length} bytes`;
  console.time(label);

  const res = await fetch(
    `https://QFPCRZC6WX.algolia.net/1/indexes/${algoliaIndex}/batch`,
    {
      method: "POST",
      headers: {
        "X-Algolia-API-Key": keys.apiKey,
        "X-Algolia-Application-Id": keys.appId,
      },
      body: payload,
    },
  );
  console.timeEnd(label);
  if (!res.ok) {
    const error = await res.text();
    console.error("failed to upload to algolia", error);
    await Deno.writeTextFile(
      `./error_${Date.now()}.json`,
      JSON.stringify({
        error,
        payload: {
          requests: batchRequests,
        },
      }),
    );
  }
}

/** Get the publish date of a module. */
async function getPublishDate(module: string, version: string): Promise<Date> {
  const response = await fetch(
    `https://apiland.deno.dev/v2/modules/${module}/${version}`,
  );
  const data = await response.json();
  return new Date(data.uploaded_at);
}

/** Get the index of the module. The index contains all paths of the module. */
async function getModuleIndex(
  module: string,
  version: string,
): Promise<string[]> {
  const response = await fetch(
    `https://apiland.deno.dev/v2/modules/${module}/${version}/index`,
  );
  const data = await response.json();
  if (response.ok) {
    return Object.values(data.index).flat() as string[];
  } else {
    return [];
  }
}

/** Get the index of the module. The index contains all paths of the module. */
async function getDocNodes(
  module: string,
  version: string,
  path: string,
): Promise<DocNode[]> {
  const response = await fetch(
    `https://apiland.deno.dev/v2/modules/${module}/${version}/doc${path}`,
  );
  if (response.ok) {
    return await response.json();
  } else {
    return [];
  }
}

/** Get doc nodes for the module, filter them and construct them into
 * valid Algolia batch records. */
async function getAlgoliaBatchRecords(
  module: Module,
  path: string,
  publishedAt: Date,
): Promise<AlgoliaBatchRecords[]> {
  const batchRecords = [];
  const docNodes = await getDocNodes(
    module.name,
    module.latest_version,
    path,
  );
  const filteredNodes = filterDocNodes(path, docNodes);
  for (const node of filteredNodes) {
    const objectID = `${module.name}${path}:${node.kind}:${node.name}`;
    batchRecords.push({
      action: "addObject",
      body: {
        name: node.name,
        kind: node.kind,
        jsDoc: node.jsDoc,
        location: node.location,
        objectID,
        publishedAt: publishedAt.getTime(),
        popularityScore: module.popularity_score,
      },
    });
  }
  return batchRecords;
}

/** Remove docNodes that don't have a jsDoc, are not of allowed docNodeKinds
 * and those that don't belong to the provided modulePath. */
function filterDocNodes(modulePath: string, docNodes: DocNode[]): DocNode[] {
  const filtered = [];
  for (const node of docNodes) {
    if (
      ALLOWED_DOCNODES.includes(node.kind) &&
      node.location.filename.endsWith(modulePath) &&
      node.jsDoc
    ) {
      filtered.push(node);
    }
  }
  return filtered;
}

/** Get modules from apiland.deno.dev */
async function getModules(limit: number, page: number) {
  const listModules = await fetch(
    `https://apiland.deno.dev/v2/modules?limit=${limit}&page=${page}`,
  );
  const modules: Module[] = (await listModules.json()).items;
  return modules;
}

interface AlgoliaBatchRecords {
  action: string;
  // deno-lint-ignore no-explicit-any
  body: Record<string, any>;
}

interface DocNode {
  kind: string;
  name: string;
  location: {
    filename: string;
    line: number;
    col: number;
  };
  // deno-lint-ignore no-explicit-any
  jsDoc: Record<string, any>;
}

interface Module {
  description: string;
  name: string;
  popularity_score: number;
  latest_version: string;
}
