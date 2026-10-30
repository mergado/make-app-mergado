# Mergado

[Mergado](https://www.mergado.com) is a product feed management tool for online stores. It imports the input feed of an e-shop, transforms the products with rules and exports output feeds for advertising channels such as Google Shopping, Heureka, Zboží.cz, GLAMI or Meta.

With this app you can automate your work with Mergado: get information about e-shops and projects, search products with MQL, create queries, pause or resume rules, and start scenarios when a feed is exported or an import fails.

## Connecting Mergado to Make

1. Add any Mergado module to a scenario and click **Create a connection**.
2. Sign in to Mergado and allow Make to access your account. Keep the permissions that are preselected; when you uncheck some of them, the modules that need them fail with an access error.
3. The connection works with all e-shops and projects your Mergado account has access to. Access is renewed automatically, you don't have to reconnect.

## Modules

**Triggers**

- **Watch Feed Exports** – starts the scenario when an output feed of a project is exported (successfully or with warnings).
- **Watch Failed Imports** – starts the scenario when an import of the input feed of a project fails.

**Actions and searches**

- **Get Current User** – the Mergado user the connection belongs to.
- **List E-shops**, **List Projects**, **Get a Project** – e-shops and projects (output feeds). `Output feed URL` is the address of the exported feed; `URL` is the input feed.
- **Get Project Elements** – the element tree of a project. Use the element names in MQL queries.
- **Search Products**, **Get a Product** – products of a project, filtered with an MQL query such as `PRICE_VAT > 100`. Fill in **Values to extract** (for example `ITEM_ID, PRICE_VAT`) to get only these values.
- **List Queries**, **Create a Query** – saved product selections.
- **List Rules**, **Get a Rule**, **Pause or Resume a Rule** – rules of a project. A paused rule keeps its settings; the change shows in the output feed after the next feed update.
- **Make an API Call** – any other call to the [Mergado API](https://api-docs.mergado.com/?api=mergado-api) with your connection.

## Example scenarios

- A feed is exported → send a Slack message with the number of products and the output feed URL.
- An import fails → create a task for the e-shop administrator.
- Every Friday at midnight → resume the Black Friday rule; on Monday → pause it again.
- Every morning → search products without an image (MQL) and e-mail the list.

## Help

Mergado help center: [help.mergado.com](https://help.mergado.com). API documentation: [api-docs.mergado.com](https://api-docs.mergado.com/?api=mergado-api).
