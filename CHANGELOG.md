# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [0.2.0] - 2026-10-30

Changes for the Make app review.

### Changed

- Module labels follow Make's sentence case (for example "Get a project", "Make an API call").
- Get and update modules (Get a project, Get project elements, Get a rule, Pause or resume a rule) open with the ID fields in Map mode; these fields are labelled "E-shop ID", "Project ID" and "Rule ID".

### Added

- Module groups: Triggers, E-shops and projects, Products, Queries, Rules, Other.
- Output samples for every generated module, taken from the Mergado API documentation.
- Fields the API returns beyond the OpenAPI document in the output of List e-shops and Watch feed exports.
- Make an API call: banner about connection scopes; URL hint ends with a period.
- `scripts/make.mjs deploy` uploads the module groups.

## [0.1.0] - 2026-10-30

### Added

- Connection to Mergado: OAuth 2.0 with PKCE and refresh tokens through a public client (no client secret), Mergado API version header `2026-10-30`.
- Triggers: Watch Feed Exports, Watch Failed Imports.
- Modules: Get Current User, List E-shops, List Projects, Get a Project (with output feed URL), Get Project Elements, Search Products (MQL, values to extract), Get a Product, List Queries, Create a Query, List Rules, Get a Rule, Pause or Resume a Rule, Make an API Call.
- Dropdowns for e-shop, project, rule and pausable rule.
- Shared specification `spec/mergado-moduly.json` with the n8n node, generator `scripts/generate.mjs` and parity check `scripts/check-parity.mjs`.
- App description, Docs tab content and icon.
- CI: JSON validation, generator diff check, parity check against the n8n node, deployment to the private Make app.
