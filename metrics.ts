// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Work in progress tool for scoring registry packages.
 *
 * @module
 */

import {
  Datastore,
  entityToObject,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Mutation } from "google_datastore/types";
import { AnalyticsReporting, GoogleAuth } from "google_analytics_reporting";

import { keys, readyPromise } from "./auth.ts";
import type { Module, ModuleMetrics } from "./types.d.ts";

await readyPromise;
const auth = new GoogleAuth().fromJSON(keys);
const reporter = new AnalyticsReporting(auth);

console.log(
  `%cRunning %c30 day sessions report%c...`,
  "color:green",
  "color:yellow",
  "color:none",
);

const res = await reporter.reportsBatchGet({
  reportRequests: [{
    viewId: "253817008",
    pageSize: 100_000,
    dateRanges: [
      {
        startDate: "30daysAgo",
        endDate: "today",
      },
    ],
    metrics: [
      {
        expression: "ga:sessions",
      },
      {
        expression: "ga:users",
      },
    ],
    filtersExpression: "ga:pagePathLevel1==/x/",
    dimensions: [
      {
        name: "ga:pagePathLevel2",
      },
    ],
  }],
});

const metrics: Record<
  string,
  { sessions: number; users: number; score: number }
> = {};

if (res.reports?.[0].data?.rows) {
  for (const row of res.reports[0].data.rows) {
    if (row.dimensions?.[0] && row.metrics?.[0].values) {
      let [pkg] = row.dimensions[0].slice(1).split("@");
      if (!pkg || pkg.match(/^[$._\s]/)) {
        continue;
      }
      if (pkg.endsWith("/")) {
        pkg = pkg.slice(0, pkg.length - 1);
      }
      if (!(pkg in metrics)) {
        metrics[pkg] = { sessions: 0, users: 0, score: 0 };
      }
      metrics[pkg].sessions += parseInt(row.metrics[0].values[0], 10);
      metrics[pkg].users += parseInt(row.metrics[0].values[1], 10);
    }
  }
}

// calculate the popularity score.
for (const metric of Object.values(metrics)) {
  metric.score = Math.trunc((metric.sessions * 0.6) + (metric.users * 0.4));
}

/** An sorted array of tuples containing the module name and its popularity
 * score. Sorted from highest score to lowest score, filtering out `0`
 * scores. */
const rankedPopularity = Object.entries(metrics).filter(([, { score }]) =>
  score > 0
).map(([key, { score }]) => [key, score] as [string, number]).sort((
  [, scoreA],
  [, scoreB],
) => scoreB - scoreA);

/** Return the percentile rank (from 0 to 99) of a module in relationship to
 * all other modules. If a rank cannot be determined an `undefined` is
 * returned. */
function getPercentile(module: string) {
  const rank = rankedPopularity.findIndex(([key]) => key === module);
  if (rank >= 0) {
    return Math.trunc(((rank + 1) / rankedPopularity.length) * 100);
  }
}

/** For a given module, set or update tags based on module metrics. */
function setModuleTags(module: Module) {
  module.tags = module.tags?.filter(({ kind }) => kind !== "popularity") ?? [];
  const rank = getPercentile(module.name);
  if (rank != null) {
    if (rank === 0) {
      module.tags.push({ kind: "popularity", value: "Super Popular" });
    } else if (rank < 5) {
      module.tags.push({ kind: "popularity", value: "Very Popular" });
    } else if (rank < 10) {
      module.tags.push({ kind: "popularity", value: "Popular" });
    }
  }
}

const updated = new Date();
const mutations: Mutation[] = [];

for (
  const [name, { sessions: sessions_30_day, users: users_30_day }] of Object
    .entries(metrics)
) {
  const metrics: ModuleMetrics = {
    name,
    updated,
    maintenance: {},
    popularity: { sessions_30_day, users_30_day },
    quality: {},
  };
  objectSetKey(metrics, { path: [{ kind: "module_metrics", name }] });
  mutations.push({ upsert: objectToEntity(metrics) });
}

if (mutations.length) {
  let remaining = mutations.length;
  console.log(
    `%cCommitting %c${remaining}%c changes...`,
    "color:green",
    "color:yellow",
    "color:none",
  );
  const datastore = new Datastore(keys);
  for await (
    const res of datastore.commit(mutations, { transactional: false })
  ) {
    remaining -= res.mutationResults.length;
    console.log(
      `%cCommitted %c${res.mutationResults.length}%c changes. %c${remaining}%c to go.`,
      "color:green",
      "color:yellow",
      "color:none",
      "color:yellow",
      "color:none",
    );
  }

  const moduleMutations: Mutation[] = [];

  console.log(
    "%cUpdate %cmodule scores%c...",
    "color:green",
    "color:yellow",
    "color:none",
  );

  const query = datastore.createQuery("module");
  for await (const moduleEntity of datastore.streamQuery(query)) {
    const module = entityToObject<Module>(moduleEntity);
    const metric = metrics[module.name];
    module.popularity_score = metric ? metric.score : 0;
    setModuleTags(module);
    moduleMutations.push({ update: objectToEntity(module) });
  }

  remaining = moduleMutations.length;
  console.log(
    `%cCommitting %c${remaining}%c changes...`,
    "color:green",
    "color:yellow",
    "color:none",
  );
  for await (
    const res of datastore.commit(moduleMutations, { transactional: false })
  ) {
    remaining -= res.mutationResults.length;
    console.log(
      `%cCommitted %c${res.mutationResults.length}%c changes. %c${remaining}%c to go.`,
      "color:green",
      "color:yellow",
      "color:none",
      "color:yellow",
      "color:none",
    );
  }
}

console.log("%cDone.", "color:green");
