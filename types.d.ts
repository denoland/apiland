// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import type { DocNode, DocNodeKind, JsDoc } from "deno_doc/types";

/**
 * Common types used for data structures within the project
 *
 * @module
 */

export type { DocNode } from "deno_doc/types";

/** Stored as kind `module` in the datastore. */
export interface Module {
  name: string;
  description: string;
  versions: string[];
  latest_version: string;
  star_count?: number;
  maintenance_score?: number;
  popularity_score?: number;
  quality_score?: number;
}

/** Stores as kind `module_metrics` in the datastore. */
export interface ModuleMetrics {
  name: string;
  updated: Date;
  maintenance: Record<string, never>;
  popularity: {
    sessions_30_day: number;
    users_30_day: number;
  };
  quality: Record<string, never>;
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
  dirs?: string[];
  index?: string[];
}

/** Stores as kind `doc_structure` in datastore. */
export interface DocStructureItem {
  name: string;
  items: string[];
}

export interface DocPageBase {
  kind: string;
  module: string;
  description?: string;
  version: string;
  path: string;
  versions: string[];
  latest_version: string;
  uploaded_at: string;
  upload_options: {
    type: string;
    repository: string;
    ref: string;
  };
  /** @deprecated */
  star_count?: number;
}

interface DocPageDirItem {
  kind: "dir";
  path: string;
}

interface SymbolItem {
  name: string;
  kind: DocNodeKind;
  jsDoc?: JsDoc;
}

export interface IndexItem {
  kind: "dir" | "module" | "file";
  path: string;
  size: number;
  ignored: boolean;
  doc?: string;
}

interface DocPageModuleItem {
  kind: "module";
  path: string;
  items: SymbolItem[];
}

export type DocPageNavItem = DocPageModuleItem | DocPageDirItem;

export interface DocPageSymbol extends DocPageBase {
  kind: "symbol";
  nav: DocPageNavItem[];
  name: string;
  docNodes: DocNode[];
}

export interface DocPageModule extends DocPageBase {
  kind: "module";
  nav: DocPageNavItem[];
  docNodes: DocNode[];
}

export interface DocPageIndex extends DocPageBase {
  kind: "index";
  items: IndexItem[];
}

export interface DocPageFile extends DocPageBase {
  kind: "file";
}

/** Stores as kind `doc_page` in datastore. */
export type DocPage =
  | DocPageSymbol
  | DocPageModule
  | DocPageIndex
  | DocPageFile;
