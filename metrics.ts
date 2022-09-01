// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Work in progress tool for scoring registry packages.
 *
 * @module
 */

import dax from "dax";
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

dax.logStep("Running analytics last 30 day report...");

let res = await reporter.reportsBatchGet({
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

dax.logLight(`  retrieved report.`);

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
} else {
  dax.logError("Unexpected report response.");
  console.log(JSON.stringify(res, undefined, "  "));
  Deno.exit(1);
}

// calculate the popularity score.
for (const metric of Object.values(metrics)) {
  metric.score = Math.trunc((metric.sessions * 0.6) + (metric.users * 0.4));
}

dax.logStep("Running analytics last 30-60 day report...");

res = await reporter.reportsBatchGet({
  reportRequests: [{
    viewId: "253817008",
    pageSize: 100_000,
    dateRanges: [
      {
        startDate: "60daysAgo",
        endDate: "30daysAgo",
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

dax.logLight(`  retrieved report.`);

const metricsPrevious: Record<
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
      if (!(pkg in metricsPrevious)) {
        metricsPrevious[pkg] = { sessions: 0, users: 0, score: 0 };
      }
      metricsPrevious[pkg].sessions += parseInt(row.metrics[0].values[0], 10);
      metricsPrevious[pkg].users += parseInt(row.metrics[0].values[1], 10);
    }
  }
} else {
  dax.logError("Unexpected report response.");
  console.log(JSON.stringify(res, undefined, "  "));
  Deno.exit(1);
}

// calculate the popularity score for the previous range.
for (const metric of Object.values(metricsPrevious)) {
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
      module.tags.push({ kind: "popularity", value: "top_1_percent" });
    } else if (rank < 5) {
      module.tags.push({ kind: "popularity", value: "top_5_percent" });
    } else if (rank < 10) {
      module.tags.push({ kind: "popularity", value: "top_10_percent" });
    }
  }
}

const updated = new Date();
const mutations: Mutation[] = [];

for (
  const [name, { sessions: sessions_30_day, users: users_30_day, score }]
    of Object
      .entries(metrics)
) {
  let prev_sessions_30_day;
  let prev_users_30_day;
  let prev_score;
  const prev = metricsPrevious[name];
  if (prev) {
    prev_sessions_30_day = prev.sessions;
    prev_users_30_day = prev.users;
    prev_score = prev.score;
  }
  const metrics: ModuleMetrics = {
    name,
    updated,
    maintenance: {},
    popularity: {
      sessions_30_day,
      users_30_day,
      score,
      prev_sessions_30_day,
      prev_users_30_day,
      prev_score,
    },
    quality: {},
  };
  objectSetKey(metrics, { path: [{ kind: "module_metrics", name }] });
  mutations.push({ upsert: objectToEntity(metrics) });
}

if (mutations.length) {
  let remaining = mutations.length;
  dax.logStep(`Committing ${remaining} changes...`);
  const datastore = new Datastore(keys);
  for await (
    const res of datastore.commit(mutations, { transactional: false })
  ) {
    remaining -= res.mutationResults.length;
    dax.logLight(
      `  committed ${res.mutationResults.length} changes. ${remaining} to go.`,
    );
  }

  const moduleMutations: Mutation[] = [];

  dax.logStep("Update module scores...");

  const query = datastore.createQuery("module");
  for await (const moduleEntity of datastore.streamQuery(query)) {
    const module = entityToObject<Module>(moduleEntity);
    const metric = metrics[module.name];
    module.popularity_score = metric ? metric.score : 0;
    setModuleTags(module);
    moduleMutations.push({ update: objectToEntity(module) });
  }

  remaining = moduleMutations.length;
  dax.logStep(`Committing ${remaining} changes...`);
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
