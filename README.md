# Mergado app for Make

Custom app that connects [Make](https://www.make.com) to [Mergado](https://www.mergado.com), the product feed management tool. It covers core Mergado (no paid extensions): e-shops, projects, products, queries, rules and feed import/export logs.

The app is private in Make for now (`mergado-wp1zb2`, version 1, zone eu1). Publishing it and requesting the Make review is done by a person, never from CI.

## What the app can do

| Module | Type | Mergado API |
|---|---|---|
| Watch Feed Exports | Trigger | `GET /projects/{id}/exportlogs/` (success, warning) |
| Watch Failed Imports | Trigger | `GET /projects/{id}/importlogs/` (failure) |
| Get Current User | Action | `GET /me/` |
| List E-shops | Search | `GET /users/{userId}/shops/` |
| List Projects, Get a Project | Search, Action | `GET /shops/{id}/projects/`, `GET /projects/{id}/` – both add `output_feed_url` |
| Get Project Elements | Action | `GET /projects/{id}/elements/` |
| Search Products, Get a Product | Search, Action | `POST /projects/{id}/products` (MQL, values to extract), `GET /products/{id}/` |
| List Queries, Create a Query | Search, Action | `GET`/`POST /projects/{id}/queries/` |
| List Rules, Get a Rule, Pause or Resume a Rule | Search, Action | `GET /projects/{id}/rules/`, `GET`/`PATCH /rules/{id}/` |
| Make an API Call | Universal | any path |

User documentation shown in Make (Docs tab) is in [`docs/make-readme.md`](docs/make-readme.md).

### Sign-in

The connection uses the same OAuth 2.0 server as the Mergado MCP server (`app.mergado.com`): a public client registered through dynamic client registration, PKCE (S256), scopes in the authorize request and refresh tokens. There is no client secret; the client ID is stored in the connection's common data in Make and in [`make-app.json`](make-app.json). Every request sends `use-mergado-api-version`, otherwise the API answers in its 2020 format.

## Shared specification

[`spec/mergado-moduly.json`](spec/mergado-moduly.json) is the source of truth for both this app and the n8n node [`mergado/n8n-nodes-mergado`](https://github.com/mergado/n8n-nodes-mergado): functions, endpoints, scopes, inputs, dropdowns, output fields, vocabulary and the names used on each platform. The content is the same on both platforms, the shape follows each platform's conventions. The field descriptions are at the top of the file (in Czech).

- The Make modules, RPCs, the version header in `base.json` and `app.json` are **generated** from the spec by [`scripts/generate.mjs`](scripts/generate.mjs). Output fields come from the Mergado OpenAPI document in [`spec/mergado-api/`](spec/mergado-api/). Change the spec, not the generated files.
- The n8n node is written by hand. [`scripts/check-parity.mjs`](scripts/check-parity.mjs) checks that both platforms match the spec.
- Hand-written parts: the connection (`connections/`), `base.json` (except the version header), the universal module `modules/makeApiCall/`, docs and the icon.

## Development

Requirements: Node.js 22, no dependencies.

```bash
node scripts/generate.mjs          # regenerate modules and RPCs from the spec
node scripts/check-parity.mjs      # compare Make and n8n with the spec
```

`check-parity.mjs` reads the built n8n node, so clone `mergado/n8n-nodes-mergado` next to this repo and build it first (`npm ci && npm run build`). Another location can be passed with `--n8n=<path>` or `N8N_DIR`.

```
dev/
  make-app-mergado/     this repo
  n8n-nodes-mergado/    the n8n node
```

Keep working copies outside synced folders such as Google Drive, they break git.

## Deployment

```bash
cp .env.example .env               # add MAKE_API_TOKEN (scopes sdk-apps:read, sdk-apps:write)
node scripts/make.mjs check        # token works and the app is visible
node scripts/make.mjs deploy       # app description, docs, icon, base, connection, RPCs, modules
node scripts/make.mjs pull         # download the deployed state to .pull/ for comparison
```

After a merge to `main`, CI deploys to the private app with the `MAKE_API_TOKEN` repository secret. Deployment never publishes the app and never touches the connection's common data.

The icon ([`assets/icon-512.png`](assets/icon-512.png)) is the Mergado symbol in one colour, as Make requires (dark areas render white, transparent areas in the theme colour `#5da528`). It is made with [`assets/make_icon.py`](assets/make_icon.py) from a rendering of the official Mergado logo.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml):

1. every JSON file parses,
2. `generate.mjs` leaves no diff (generated files are committed in sync with the spec),
3. parity with `main` of `mergado/n8n-nodes-mergado` – skipped with a warning while that repo has no code,
4. on `main` only: deploy to the private Make app – skipped with a warning while the `MAKE_API_TOKEN` secret is missing.

## Licence

[MIT](LICENSE)
