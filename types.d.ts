// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

/** Types that are shared across apiland.
 *
 * @module
 */

import type {
  DeclarationKind,
  DocNode,
  DocNodeKind,
  JsDoc,
} from "deno_doc/types";
import type { patterns } from "./consts.ts";

export interface ApiModuleData {
  data: {
    name: string;
    description: string;
    star_count: number;
  };
}

export interface ModuleMetaVersionsJson {
  latest: string;
  versions: string[];
}

export interface ModuleVersionMetaJson {
  uploaded_at: string;
  upload_options: {
    type: string;
    repository: string;
    ref: string;
  };
  directory_listing: {
    path: string;
    size: number;
    type: "file" | "dir";
    default?: string;
    docable?: boolean;
    dirs?: string[];
    index?: string[];
  }[];
}

export interface PackageMetaListing {
  path: string;
  size: number;
  type: "file" | "dir";
}

/**
 * Common types used for data structures within the project
 *
 * @module
 */

export type { DocNode } from "deno_doc/types";

export interface GlobalSymbolItem {
  name: string;
  library: "deno" | "esnext";
  unstable?: boolean;
}

export interface GlobalSymbols {
  items: GlobalSymbolItem[];
}

export interface Library {
  name: string;
  versions: string[];
  latest_version: string;
}

export interface LibraryVersion {
  name: string;
  version: string;
  sources: { url: string; contentType?: string; unstable?: boolean }[];
}

export interface LibrarySymbolItems {
  items: SymbolItem[];
}

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

export interface DependencyModuleMetrics {
  /** The count of deno.land/x module version that have a dependency on this
   * module/package/repo */
  count: number;
  /** The deno.land/x module that has a dependency. */
  dependents: string[];
  /** The specific deno.land/x module and version that has a dependency. */
  dependent_versions: string[];
  /** A map of the version tags and the count of specific versions.
   * Dependencies that are un-versioned have a key of `$$unpinned$$`. */
  versions: Record<string, number>;
}

/** Stores as kind `dependency_metrics` in the datastore. */
export interface DependencyMetrics {
  /** The source label that the dependency is associated with */
  source: DependencySources;
  /** The count of deno_land/x module versions that have a dependency in this
   * source. */
  count: number;
  /** A map of module/package/repo names from the source with a value of metrics
   * about the */
  mods: Record<string, DependencyModuleMetrics>;
}

/** Stores as kind `module_metrics` in the datastore. */
export interface ModuleMetrics {
  name: string;
  updated: Date;
  maintenance: Record<string, never>;
  popularity: {
    sessions_30_day: number;
    users_30_day: number;
    score: number;
    prev_sessions_30_day?: number;
    prev_users_30_day?: number;
    prev_score?: number;
  };
  quality: Record<string, never>;
}

/** Stores as kind `submodule_metrics` in the datastore. */
export interface SubModuleMetrics {
  module: string;
  submodule: string;
  updated: Date;
  popularity: {
    sessions_30_day: number;
    users_30_day: number;
    score: number;
  };
}

/** Stored as kind `module_version` in datastore. */
export interface ModuleVersion {
  name: string;
  /** If assigned, contains a text string which indicates what version of
   * analysis has been done on the content. */
  analysis_version?: string;
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

type DependencySources = keyof typeof patterns | "other";

/** Stored as kind `module_dependency` in datastore. */
export interface ModuleDependency {
  /** The source for the module. If the module is not a recognized source, then
   * `"other"` is used and the `pkg` field will be set to the "raw" URL. */
  src: DependencySources;
  /** The optional "organization" associated with dependency. For example with
   * npm or GitHub style dependency, the organization that the `pkg` belongs
   * to. */
  org?: string;
  /** The package or module name associated with the dependency. */
  pkg: string;
  /** The optional version or tag associated with the dependency. */
  ver?: string;
}

/** Stored as kind `dependency_error` in datastore. */
export interface DependencyError {
  /** The specifier the error was related to. */
  specifier: string;
  /** The error message. */
  error: string;
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
  upload_options: {
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

export interface SymbolItem {
  name: string;
  kind: DocNodeKind;
  category?: string;
  jsDoc?: JsDoc | null;
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
  symbols?: SymbolIndexItem[];
}

export interface DocPageModule extends PageBase {
  kind: "module";
  nav: DocPageNavItem[];
  docNodes: DocNode[];
  symbols?: SymbolIndexItem[];
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

export interface ModuleUsage {
  total: UsageMetric;
  daily: UsageMetric[];
  versions: Record<string, UsageMetric>;
  updated: Date;
}

export interface ModInfoPage {
  kind: "modinfo";
  module: string;
  description?: string;
  version: string;
  versions: string[];
  latest_version: string;
  /** An optional array of dependencies identified for the module. */
  dependencies?: ModuleDependency[];
  /** An optional array of dependencies identified for the module. */
  dependency_errors?: DependencyError[];
  /** The default module for the module. */
  defaultModule?: ModuleEntry;
  /** A flag that indicates if the default module has a default export. */
  defaultExport?: boolean;
  /** The file entry for the module that is a README to be rendered. */
  readme?: ModuleEntry;
  /** The file entry for the module that has a detectable deno configuration. */
  config?: ModuleEntry;
  /** The file entry for an import map specified within the detectable config
   * file. */
  import_map?: ModuleEntry;
  uploaded_at: string;
  upload_options: {
    type: string;
    repository: string;
    ref: string;
    subdir?: string;
  };
  tags?: ModuleTag[];
}

export type InfoPage = ModInfoPage | PageInvalidVersion | PageNoVersions;

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

interface DocPageLibraryBase {
  kind: string;
  name: string;
  version: string;
  versions: string[];
  latest_version: string;
}

export interface DocPageLibrary extends DocPageLibraryBase {
  kind: "library";
  items: SymbolItem[];
}

export interface DocPageLibrarySymbol extends DocPageLibraryBase {
  kind: "librarySymbol";
  items: SymbolItem[];
  name: string;
  docNodes: DocNode[];
}

export interface DocPageLibraryInvalidVersion {
  kind: "libraryInvalidVersion";
  name: string;
  versions: string[];
  latest_version: string;
}

/** An interface representing a doc work item. Typically the doc work item
 * is processed at the time of module publish, but if for various reasons it
 * cannot be processed, then the doc work item will remain in the datastore to
 * be processed at a later point in time. */
export interface DocWorkItem {
  module: string;
  version: string;
  /** The paths of the module entries that need to be doc'ed. */
  to_doc: string[];
  /** The number of attempts that have been made to try to document the module.
   * This is used to detect issues with modules that are having issues being
   * documented. */
  attempts?: number;
}

export type LibDocPage =
  | DocPageLibrary
  | DocPageLibrarySymbol
  | DocPageLibraryInvalidVersion;

export interface SourcePageFile extends PageBase {
  kind: "file";
  size: number;
  /** Indicates if the page is docable or not. */
  docable?: boolean;
}

export interface SourcePageDirEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  /** Indicates if the page is docable or not. */
  docable?: boolean;
}

export interface SourcePageDir extends PageBase {
  kind: "dir";
  entries: SourcePageDirEntry[];
}

export type SourcePage =
  | SourcePageFile
  | SourcePageDir
  | PageInvalidVersion
  | PageNoVersions
  | PagePathNotFound;

export interface SymbolIndex {
  items: SymbolIndexItem[];
}

export interface SymbolIndexItem {
  name: string;
  kind: DocNodeKind;
  declarationKind: DeclarationKind;
  filename: string;
}

export interface UsageMetric {
  users: number;
  sessions: number;
}

export interface CompletionItems {
  items: string[];
  isIncomplete: boolean;
  preselect?: string;
}

export interface PathCompletion {
  path: string;
  default?: string;
  dirs?: string[];
  modules: { path: string; doc?: string }[];
}

export interface PathCompletions {
  name: string;
  version: string;
  items: PathCompletion[];
}
