// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/**
 * Common types used for data structures within the project
 *
 * @module
 */

export type { DocNode } from "https://deno.land/x/deno_doc@v0.34.0/lib/types.d.ts";

/** Stored as kind `module` in the datastore. */
export interface Module {
  name: string;
  description: string;
  versions: string[];
  latest_version: string;
}

/** Stored as kind `module_version` in datastore. */
export interface ModuleVersion {
  name: string;
  description: string;
  version: string;
  uploaded_at: Date;
  upload_options: {
    type: string;
    repository: string;
    ref: string;
  };
}

/** Stored as kind `module_entry` in datastore. */
export interface ModuleEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

/** Stores as kind `doc_structure` in datastore. */
export interface DocStructureItem {
  name: string;
  items: string[];
}
