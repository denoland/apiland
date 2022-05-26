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
} from "https://deno.land/x/google_datastore@0.0.13/mod.ts";
import type { Mutation } from "https://deno.land/x/google_datastore@0.0.13/types.d.ts";
import {
  AnalyticsReporting,
  GoogleAuth,
} from "https://googleapis.deno.dev/v1/analyticsreporting:v4.ts";
import { keys } from "./auth.ts";
import type { Module, ModuleMetrics } from "./types.d.ts";

const auth = new GoogleAuth().fromJSON(keys);
const reporter = new AnalyticsReporting(auth);

console.log(
  `%cRunning %c30 day sessions report%c...`,
  "color:green",
  "color:yellow",
  "color:white",
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
    ],
    filtersExpression: "ga:pagePathLevel1==/x/",
    dimensions: [
      {
        name: "ga:pagePathLevel2",
      },
    ],
  }],
});

const sessions: Record<string, number> = {};

if (res.reports?.[0].data?.rows) {
  for (const row of res.reports[0].data.rows) {
    if (row.dimensions?.[0] && row.metrics?.[0].values?.[0]) {
      let [pkg] = row.dimensions[0].slice(1).split("@");
      if (!pkg || pkg.match(/^[$._\s]/)) {
        continue;
      }
      if (pkg.endsWith("/")) {
        pkg = pkg.slice(0, pkg.length - 1);
      }
      if (!(pkg in sessions)) {
        sessions[pkg] = 0;
      }
      sessions[pkg] += parseInt(row.metrics[0].values[0], 10);
    }
  }
}

const updated = new Date();
const mutations: Mutation[] = [];

for (const [name, sessions_30_day] of Object.entries(sessions)) {
  const metrics: ModuleMetrics = {
    name,
    updated,
    maintenance: {},
    popularity: { sessions_30_day },
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
    "color:white",
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
      "color:white",
      "color:yellow",
      "color:white",
    );
  }

  const moduleMutations: Mutation[] = [];

  console.log(
    "%cUpdate %cmodule scores%c...",
    "color:green",
    "color:yellow",
    "color:white",
  );

  const query = datastore.createQuery("module");
  for await (const moduleEntity of datastore.streamQuery(query)) {
    const module = entityToObject<Module>(moduleEntity);
    const popularityScore = sessions[module.name];
    if (popularityScore !== undefined) {
      module.popularity_score = popularityScore;
    } else {
      delete module.popularity_score;
    }
    moduleMutations.push({ update: objectToEntity(module) });
  }

  remaining = moduleMutations.length;
  console.log(
    `%cCommitting %c${remaining}%c changes...`,
    "color:green",
    "color:yellow",
    "color:white",
  );
  for await (
    const res of datastore.commit(moduleMutations, { transactional: false })
  ) {
    remaining -= res.mutationResults.length;
    console.log(
      `%cCommitted %c${res.mutationResults.length}%c changes. %c${remaining}%c to go.`,
      "color:green",
      "color:yellow",
      "color:white",
      "color:yellow",
      "color:white",
    );
  }
}

console.log("%cDone.", "color:green");
