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
  latest_version: string | null;
  /** @deprecated Use `popularity_score` instead. */
  star_count?: number;
  maintenance_score?: number;
  /** A weighted score of how popular a module is. */
  popularity_score?: number;
  quality_score?: number;
  /** Tags which are associated with the module. */
  tags?: ModuleTag[];
}

/** Defines a tag related to how popular a module is. */
export interface PopularityModuleTag {
  kind: "popularity";
  value: "top_1_percent" | "top_5_percent" | "top_10_percent";
}

/** Defines a "tag" which can be displayed when rending a module or part of a
 * module. */
export type ModuleTag = PopularityModuleTag;

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
    subdir?: string;
  };
}

/** Stored as kind `module_entry` in datastore. */
export interface ModuleEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  /** For `"dir"` entries, indicates if there is a _default_ module that should
   * be used within the directory. */
  default?: string;
  /** For `"dir"` entries, an array of child sub-directory paths. */
  dirs?: string[];
  /** For `"file`" entries, indicates if the entry id can be queried for doc
   * nodes. */
  docable?: boolean;
  /** For `"dir"` entries, an array of docable child paths that are not
   * "ignored". */
  index?: string[];
}

/** Stores as kind `doc_structure` in datastore. */
export interface DocStructureItem {
  name: string;
  items: string[];
}

export interface PageBase {
  kind: string;
  module: string;
  description?: string;
  version: string;
  path: string;
  versions: string[];
  latest_version: string;
  uploaded_at: string;
  upload_options?: {
    type: string;
    repository: string;
    ref: string;
    subdir?: string;
  };
  /** @deprecated */
  star_count?: number;
  tags?: ModuleTag[];
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
  default?: true;
}

export type DocPageNavItem = DocPageModuleItem | DocPageDirItem;

export interface DocPageSymbol extends PageBase {
  kind: "symbol";
  nav: DocPageNavItem[];
  name: string;
  docNodes: DocNode[];
}

export interface DocPageModule extends PageBase {
  kind: "module";
  nav: DocPageNavItem[];
  docNodes: DocNode[];
}

export interface DocPageIndex extends PageBase {
  kind: "index";
  items: IndexItem[];
}

export interface DocPageFile extends PageBase {
  kind: "file";
}

export interface DocPageRedirect {
  kind: "redirect";
  path: string;
}

export interface PagePathNotFound extends PageBase {
  kind: "notfound";
}

export interface PageNoVersions {
  kind: "no-versions";
  module: string;
}

export interface PageInvalidVersion {
  kind: "invalid-version";
  module: string;
  description?: string;
  versions: string[];
  latest_version: string;
}

/** Stores as kind `doc_page` in datastore. */
export type DocPage =
  | DocPageSymbol
  | DocPageModule
  | DocPageIndex
  | DocPageFile
  | PageInvalidVersion
  | PageNoVersions
  | PagePathNotFound
  | DocPageRedirect;

export interface CodePageFile extends PageBase {
  kind: "file";
  size: number;
  /** Indicates if the page is docable or not. */
  docable?: boolean;
}

export interface CodePageDirEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  /** Indicates if the page is docable or not. */
  docable?: boolean;
}

export interface CodePageDir extends PageBase {
  kind: "dir";
  entries: CodePageDirEntry[];
}

export type CodePage =
  | CodePageFile
  | CodePageDir
  | PageInvalidVersion
  | PageNoVersions
  | PagePathNotFound;
