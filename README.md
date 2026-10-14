# Hono Route Explorer

A VS Code sidebar for HTTP routes in TypeScript and JavaScript backends, in the spirit of the [FastAPI Path Operation Explorer](https://marketplace.visualstudio.com/items?itemName=FastAPILabs.fastapi-vscode).

Hono is the primary target. The explorer also reads Express, Fastify, and NestJS. Discovery is static: the TypeScript compiler walks your sources, so nothing has to be running.

![Path Operation Explorer on a Hono app](https://raw.githubusercontent.com/gengue/vscode-route-explorer/main/media/screenshot-tree.png)

The screenshot file is `media/screenshot-tree.png` in this repository. The repository is private, so that raw GitHub URL returns 404 to anyone who is not signed in, and the image may not render on the Marketplace page.

## What you can do

- Open **Path Operation Explorer** from the activity bar.
- Routes are grouped by mounted prefix (`/items`, `5 routes`), with the full path and handler name on each row.
- Method dots use the usual colors: GET blue, POST green, PUT orange, PATCH teal, DELETE red.
- Click a route or a group to jump to the definition.
- Search from the view title (method, path, or handler).
- Refresh, or let the tree update when you save a source file.
- Collapse every group from the view title.
- Right-click a route or group to copy its path.

## Hono

These shapes are resolved, including across files:

```ts
const app = new Hono().basePath("/api");

app.get("/health", health).post("/ping", ping);
app.on("DELETE", "/books/:id", removeBook);
app.route("/books", books); // books may live in another file

new Hono().get("/inline", inlineGet).post("/inline", inlinePost);

const docs = new OpenAPIHono();
docs.openapi(createRoute({ method: "get", path: "/status/{name}" }), statusHandler);
```

`{name}` from `@hono/zod-openapi` is shown as Hono writes it: `:name`. Nested `app.route()` mounts are joined, so a posts app mounted at `/:id/posts` under `/users` becomes `/users/:id/posts`.

In a monorepo the import can be a `tsconfig` `paths` alias (`@shop/users`) or a workspace package name resolved through `package.json` `exports` (`@acme/billing`).

## Also recognized

- **Express** — `app` / `router.METHOD`, `router.route().get().post()`, and `app.use("/prefix", router)` across files.
- **Fastify** — `fastify.METHOD`, `route({ method, url })`, and `register(plugin, { prefix })`, including nested plugins.
- **NestJS** — `@Controller` and `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete`, plus `setGlobalPrefix`.

Paths have to be string literals or constants the compiler can fold. Dynamic paths are skipped.

## Settings

| Setting | Default |
| --- | --- |
| `nodePathExplorer.include` | `**/*.{js,jsx,mjs,cjs,ts,tsx}` |
| `nodePathExplorer.exclude` | `node_modules`, `dist`, `build`, `out`, `coverage`, `*.d.ts`, tests |

## Commands

| Command | What it does |
| --- | --- |
| **Node Routes: Search Path Operations...** | Quick-pick every route and jump to it |
| **Node Routes: Refresh Path Operations** | Scan again |
| **Node Routes: Collapse All** | Collapse every prefix group |
| **Copy Path** | Context menu on a route or group |

## Install a local build

```bash
npm install
npx @vscode/vsce package
code --install-extension nodejs-path-explorer-0.1.0.vsix
```

Reload the window, open a Hono (or Express) workspace, and choose the Node Routes icon in the activity bar. The extension id is `gengue.nodejs-path-explorer`.

## Development

```bash
npm install
npm test
npm run compile
```

`npm test` runs the analyzer against fixture apps in `fixtures/`. Hono coverage lives in `fixtures/hono-app` (the tree in the screenshot), `fixtures/hono-patterns` (base path, chains, `app.on`, OpenAPI), and `fixtures/hono-monorepo` (path aliases, package exports, three levels of `route()`).

## License

MIT
