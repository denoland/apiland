// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * A module for generating the metrics records in the datastore for
 * dependencies.
 *
 * @module
 */

import dax from "dax";
import {
  type Datastore,
  objectGetKey,
  objectSetKey,
  objectToEntity,
} from "google_datastore";
import type { Entity, Mutation } from "google_datastore/types";
import { MODULE_DEP_KIND } from "./analysis.ts";
import { getDatastore } from "./store.ts";
import { ModuleDependency } from "./types.d.ts";
import { assert } from "./util.ts";

const SOURCE_METRIC_KIND = "dependency_metrics";

interface SourceMetrics {
  count: number;
  mods: Record<
    string,
    {
      count: number;
      dependents: Set<string>;
      dependent_versions: Set<string>;
      versions: Record<string, number>;
    }
  >;
}

const counts: Record<string, SourceMetrics> = {};

function metricsToEntity(
  datastore: Datastore,
  source: string,
  metrics: SourceMetrics,
): Entity {
  const { count, mods } = metrics;
  // deno-lint-ignore no-explicit-any
  const obj: any = { source, count, mods: {} };
  for (const [key, value] of Object.entries(mods)) {
    const { count, dependents, dependent_versions, versions } = value;
    // deno-lint-ignore no-explicit-any
    const mods: any = {
      count,
      dependents: [...dependents],
      dependent_versions: [...dependent_versions],
      versions,
    };
    obj.mods[key] = mods;
  }
  objectSetKey(obj, datastore.key([SOURCE_METRIC_KIND, source]));
  return objectToEntity(obj);
}

async function main() {
  dax.logStep("Fetching dependencies...");
  const datastore = await getDatastore();
  const deps = await datastore.query<ModuleDependency>(
    datastore.createQuery(MODULE_DEP_KIND),
  );
  dax.logLight(`  fetched ${deps.length} records.`);
  for (const dep of deps) {
    const key = objectGetKey(dep);
    assert(key);
    const dependent = key.path[0].name!;
    const dependentVersion = key.path[1].name!;
    const { src, org, pkg, ver } = dep;
    if (!(src in counts)) {
      counts[src] = Object.create(null, {
        count: {
          value: 0,
          enumerable: true,
          writable: true,
          configurable: true,
        },
        mods: {
          value: Object.create(null),
          enumerable: true,
          writable: true,
          configurable: true,
        },
      });
    }
    const sourceCount = counts[src];
    sourceCount.count++;
    const mod = org ? `${org}/${pkg}` : pkg;
    if (!(mod in sourceCount.mods)) {
      sourceCount.mods[mod] = {
        count: 0,
        dependents: new Set(),
        dependent_versions: new Set(),
        versions: {},
      };
    }
    const modCount = sourceCount.mods[mod];
    modCount.count++;
    modCount.dependents.add(dependent);
    modCount.dependent_versions.add(`${dependent}@${dependentVersion}`);
    const version = ver ? ver : "$$unpinned$$";
    if (!(version in modCount.versions)) {
      modCount.versions[version] = 0;
    }
    modCount.versions[version]++;
  }
  const mutations: Mutation[] = [];
  for (const [src, metrics] of Object.entries(counts)) {
    dax.logLight(`  adding source: "${src}".`);
    mutations.push({ upsert: metricsToEntity(datastore, src, metrics) });
  }
  dax.logStep("Committing source metrics to datastore...");
  for await (
    const res of datastore.commit(mutations, { transactional: false })
  ) {
    dax.logLight(`  committed ${res.mutationResults.length} changes.`);
  }
  dax.logStep("Done.");
}

if (import.meta.main) {
  main();
}
