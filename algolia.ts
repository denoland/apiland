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
 *
 * Usage:
 * ```
 * # Upload 1000 most popular modules to algolia.
 * $ deno task algolia
 *
 * # Upload the lastest version of a specific module to algolia.
 * $ deno task algolia <module>
 * ```
 */

import "https://deno.land/x/xhr@0.2.1/mod.ts?code";
import { accountCopyIndex } from "https://esm.sh/@algolia/client-account@4.14.1?dts";
import algoliasearch from "https://esm.sh/algoliasearch@4.14.1?dts";
import { entityToObject } from "google_datastore";

import { algoliaKeys, denoManualAlgoliaKeys, readyPromise } from "./auth.ts";
import { getDatastore } from "./store.ts";

const ALGOLIA_INDEX = "doc_nodes";
const NUMBER_OF_MODULES_TO_SCRAPE = 1000;
const STD_POPULARITY_SCORE = 1000000;
const ALLOWED_DOCNODES = [
  "function",
  "variable",
  "enum",
  "class",
  "typeAlias",
  "interface",
];

async function main() {
  const arg = Deno.args[0]?.trim();
  if (arg === "--update-manual") {
    return await updateManual();
  }
  if (arg === "--update-modules") {
    return await updateModules();
  }
  if (arg) {
    const module =
      await (await fetch("https://apiland.deno.dev/v2/modules/" + arg))
        .json();
    return await scrapeModule(module, 1, 1);
  }

  const limitPerRequest = 100;
  const totalPages = NUMBER_OF_MODULES_TO_SCRAPE / limitPerRequest;
  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    const modules = await getModules(limitPerRequest, currentPage);
    for await (let [index, module] of modules.entries()) {
      index = index + (currentPage - 1) * limitPerRequest;
      await scrapeModule(module, index, NUMBER_OF_MODULES_TO_SCRAPE);
    }
  }
}
main();

async function updateModules() {
  console.log("[update_modules] started updating modules");
  const modules = await getAllModules();
  console.log(`[update_modules] fetched ${modules.length} modules`);
  const batchRequests = [];
  for (const module of modules) {
    batchRequests.push({
      action: "addObject",
      body: {
        objectID: module.name,
        popularity_score: module.name == "std"
          ? STD_POPULARITY_SCORE
          : module.popularity_score,
        description: module.description,
        name: module.name,
      },
    });
  }
  await uploadToAlgolia(batchRequests, algoliaKeys, "modules");
  console.log(`[update_modules] uploaded ${modules.length} modules to algolia`);
}

async function updateManual() {
  await readyPromise;
  const denoManualApp = algoliasearch(
    denoManualAlgoliaKeys.appId,
    denoManualAlgoliaKeys.apiKey,
  );
  const denoLandApp = algoliasearch(
    algoliaKeys.appId,
    algoliaKeys.apiKey,
  );
  const sourceIndex = denoManualApp.initIndex("manual");
  const destinationIndex = denoLandApp.initIndex("destination_index");

  // Why copy and move?
  // We cannot copy to an existing index, but move
  // a new index to an existing index's place.
  try {
    accountCopyIndex(sourceIndex, destinationIndex).then(() => {
      denoLandApp.moveIndex("destination_index", "manual").then(
        () => {
          console.log("Successfully updated manual index.");
        },
      );
    });
  } catch (error) {
    console.error("failed to update manual index", error);
  }
}

async function scrapeModule(
  module: Module,
  currentIndex: number,
  totalModules: number,
) {
  const logPrefix =
    `[${currentIndex}/${totalModules} ${module.name}@${module.latest_version}]`;
  const log = (msg: string) => console.log(`${logPrefix} ${msg}`);
  log("started scraping doc nodes");
  console.time(logPrefix);
  try {
    const batchRecordsGenerators = [];
    const [publishedAt, moduleIndex] = await Promise.all([
      getPublishDate(module.name, module.latest_version),
      getModuleIndex(module.name, module.latest_version),
    ]);
    for (const path of moduleIndex) {
      // Ignore tests and examples.
      if (!path.startsWith("/tests") && !path.startsWith("/examples")) {
        batchRecordsGenerators.push(
          getAlgoliaBatchRecords(module, path, publishedAt),
        );
      }
    }
    const batchRequests = (await Promise.all(batchRecordsGenerators))
      .flat();
    log(`scraped ${batchRequests.length} doc nodes`);
    // Back up doc nodes to the disk.
    await Deno.mkdir("docnodes").catch((err) => {
      if (err.name !== "AlreadyExists") {
        throw err;
      }
    });
    const backupPath =
      `docnodes/${currentIndex}_${module.name}_${Date.now()}.json`;
    await Deno.writeTextFile(
      backupPath,
      JSON.stringify(batchRequests),
    );
    await uploadToAlgolia(batchRequests, algoliaKeys, ALGOLIA_INDEX);
  } catch (error) {
    log(`failed to scrape module ${error}`);
  }
  console.timeEnd(logPrefix);
}

/** Upload batch requests to Algolia. */
async function uploadToAlgolia(
  batchRequests: AlgoliaBatchRecords[],
  keys: typeof algoliaKeys,
  algoliaIndex: string,
) {
  const payload = JSON.stringify({
    requests: batchRequests,
  });
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
  if (!res.ok) {
    throw await res.text();
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
        popularityScore: module.name == "std"
          ? STD_POPULARITY_SCORE
          : module.popularity_score,
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
      node.location.filename.endsWith(modulePath)
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

/** Get all modules from Datastore. */
async function getAllModules() {
  const modules: Module[] = [];
  const datastore = await getDatastore();
  const query = datastore.createQuery("module");
  for await (const entity of datastore.streamQuery(query)) {
    modules.push(entityToObject(entity));
  }
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
