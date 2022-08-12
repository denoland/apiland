# Search Design

apiland publishes several indexes to Algolia to empower search. This document
provides documentation of this.

## Indexes

### `modules`

#### Record attributes

The `objectId` is the value of module's name.

| Attribute Name   | Description                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name             | The name of the module. This is also the `objectId` of the record. It is searchable.                                                                                               |
| description      | The description of the module. It is searchable.                                                                                                                                   |
| list             | Either `true` or `false` if the module should be listed in the default module list without searching. This allows supression of `std` and `std` sub modules in the 3rd party list. |
| popularity_score | The popularity score which is a weighted average of 30 days usage. It is used for ordering responses.                                                                              |
| popularity_tag   | The popularity tag, if defined is `top_1_percent`, `top_5_percent`, or `top_10_percent`. It is a display facet.                                                                    |

### `doc_nodes`

#### Record attributes

The `objectId` is a is in the format of `${module}:${path}:${name}:${id}` where
ID is a simple counter per path of symbols contained.

| Attribute Name   | Description                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| name             | The name of the exported symbol. It is searchable.                                                                                        |
| source           | A number which represents the source of the symbol, which is used for ordering. See the `source` section below.                           |
| popularity_score | The popularity score of the module.                                                                                                       |
| module           | The module name that the symbol belongs to. Used as a facet to enable deletion queries.                                                   |
| version          | The version of the module that the symbol belongs to.                                                                                     |
| path             | The path to the module the symbol was exported from.                                                                                      |
| doc              | Any JSDoc that was associated with the symbol. It is searchable.                                                                          |
| kind             | The symbol kind. `class`, `function`, `variable`, `interface`, `typeAlias`, or `moduleDoc`. It is a display facet and used for filtering. |
| location         | Used for linking to source code, but really shouldn't be used as it is the source definition, not the export location.                    |

- On publishing we need to flatten namespaces, so that they are reduced to
  `class`, `function`, `variable`, `interface`, `typeAlias`, or `class`.
- We should transition away from using `location` when linking to symbols, and
  instead start to link to the doc pages, using the `module` + `version` +
  `path` + `name` to generate the link.

##### `source`

- 100 - Built-in Library
- 200 - Standard Library - Index
- 220 - Standard Library - Other
- 300 - Deno Official - Index
- 400 - 3rd Party - Index
- 530 - Deno Official - Other
- 540 - 3rd Party - Other
