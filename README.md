# apiland

The Deno API Server.

## Documentation

The APIs that are available with this server are documented in
`/specs/api-2.0.0.yaml` as an
[OpenAPI 3.1 specification](https://spec.openapis.org/oas/v3.1.0) and can be
[viewed here](https://redocly.github.io/redoc/?url=https://apiland.deno.dev/~/spec).

## Usage

The current production API server is available on
[apiland.deno.dev](https://apiland.deno.dev). Currently only the
`/webhook/publish` requires an API token and it not part of the public API of
the server.

## Architecture

The API server uses [Google Datastore](https://cloud.google.com/datastore) as
the persistance layer. It connects to the datastore using the
[google_datastore](https://deno.land/x/google_datastore/) module.

The API server uses an API focused framework named
[acorn](https://deno.land/x/acorn/) to serve the APIs.

The API server processes and documents third party modules registered on
[deno.land](https://deno.land/x/) as well as the Deno Standard Library and
built-in APIs for the Deno. It uses
[deno_graph](https://deno.land/x/deno_graph/) and
[deno_doc](https://deno.land/x/deno_doc/) to accomplish this, which are
components that are part of the Deno CLI but are also available as Wasm
libraries with a JavaScript/TypeScript interface.

## Local development

A local development server is available using:

```
> deno task dev
```

Note that you need to have a properly configured `.env` file for this to work.
An example file is included in `.env.example`, but for obvious reasons we will
not make the production keys available.
