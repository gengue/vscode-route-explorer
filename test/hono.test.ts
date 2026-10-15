import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { countRoutesInApp, countRoutesInRouter, getAppLabel, getRouteLabel, getRouterLabel } from "../src/labels";
import { buildExplorerElements } from "../src/treeModel";
import type { RouterDefinition } from "../src/types";
import { analyzeFixture, lineText, routeMap } from "./helpers";

function expectRoute(
  map: Map<string, { functionName: string; location: { filePath: string; line: number } }>,
  method: string,
  routePath: string,
  handler: string,
): void {
  const route = map.get(`${method} ${routePath}`);
  assert.ok(route, `missing ${method} ${routePath}`);
  assert.equal(route.functionName, handler);
  const around = [0, 1, 2]
    .map((offset) => lineText(route.location.filePath, route.location.line + offset))
    .join("\n");
  assert.match(around, new RegExp(handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

describe("hono app tree", async () => {
  it("groups mounted sub-apps by prefix, the way the FastAPI explorer groups routers", async () => {
    const apps = await analyzeFixture("hono-app");
    assert.equal(apps.length, 1);
    assert.equal(apps[0].framework, "hono");
    assert.equal(apps[0].name, "app");
    assert.equal(getAppLabel(apps[0]), "backend/app");
    assert.equal(countRoutesInApp(apps[0]), 23);

    const elements = buildExplorerElements(apps, "hono-app");
    assert.equal(elements[0].type, "app");
    if (elements[0].type !== "app") return;
    const labels = elements[0].children
      .filter((child) => child.type === "router")
      .map((child) => {
        const router = (child as { router: RouterDefinition }).router;
        return `${getRouterLabel(router, "/")} (${countRoutesInRouter(router)})`;
      });
    assert.deepEqual(labels, [
      "/items (5)",
      "/login (5)",
      "/private (1)",
      "/users (10)",
      "/utils (2)",
    ]);

    const items = elements[0].children.find((child) => child.type === "router" && child.router.prefix === "/items");
    assert.ok(items && items.type === "router");
    if (items?.type !== "router") return;
    assert.deepEqual(
      items.children.map((child) => (child.type === "route" ? getRouteLabel(child.route) : "")),
      ["GET /items", "GET /items/:id", "POST /items", "PUT /items/:id", "DELETE /items/:id"],
    );
    assert.equal(items.children[0].type === "route" ? items.children[0].route.functionName : "", "listItems");
    assert.equal(items.children[0].type === "route" ? items.children[0].route.docstring : "", "List items.");
    assert.equal(path.basename(apps[0].routers[0]?.location.filePath ?? ""), "items.ts");
  });
});

describe("hono patterns", async () => {
  it("resolves basePath, chains, app.on, inline apps, and OpenAPI routes", async () => {
    const apps = await analyzeFixture("hono-patterns");
    const map = routeMap(apps);

    expectRoute(map, "GET", "/api/health", "health");
    expectRoute(map, "GET", "/api/ready", "ready");
    expectRoute(map, "POST", "/api/ping", "ping");
    expectRoute(map, "PUT", "/api/ping", "echo");
    expectRoute(map, "GET", "/api/extra/inline", "inlineGet");
    expectRoute(map, "POST", "/api/extra/inline", "inlinePost");
    expectRoute(map, "GET", "/api/books", "listBooks");
    expectRoute(map, "GET", "/api/books/:id", "getBook");
    expectRoute(map, "POST", "/api/books", "createBook");
    expectRoute(map, "DELETE", "/api/books/:id", "removeBook");
    expectRoute(map, "PUT", "/api/books/:id", "updateBook");
    expectRoute(map, "PATCH", "/api/books/:id", "updateBook");
    expectRoute(map, "GET", "/v2/one", "one");
    expectRoute(map, "POST", "/v2/two", "two");
    expectRoute(map, "GET", "/api/meta/status/:name", "statusHandler");
    expectRoute(map, "POST", "/api/meta/status", "createStatus");
    expectRoute(map, "ALL", "/api/hooks", "allHooks");

    const meta = apps
      .flatMap((app) => app.routers)
      .find((router) => router.prefix === "/api/meta" || router.children.some((child) => child.prefix === "/api/meta"));
    assert.ok(meta, "openapi sub-app should be a router group");
  });
});

describe("hono monorepo", async () => {
  it("follows tsconfig paths, package exports, and nested route() mounts", async () => {
    const apps = await analyzeFixture("hono-monorepo");
    assert.equal(apps.length, 1);
    assert.equal(apps[0].framework, "hono");
    const map = routeMap(apps);

    expectRoute(map, "GET", "/v1/users", "listUsers");
    expectRoute(map, "GET", "/v1/users/:id", "getUser");
    expectRoute(map, "GET", "/v1/users/:id/posts", "listPosts");
    expectRoute(map, "GET", "/v1/users/:id/posts/:postId", "getPost");
    expectRoute(map, "GET", "/v1/users/:id/posts/:postId/comments", "listComments");
    expectRoute(map, "GET", "/v1/users/:id/posts/:postId/comments/:commentId", "getComment");
    expectRoute(map, "GET", "/v1/catalog", "listProducts");
    expectRoute(map, "GET", "/v1/catalog/:sku", "getProduct");
    expectRoute(map, "GET", "/v1/billing/invoices", "listInvoices");
    expectRoute(map, "POST", "/v1/billing/invoices", "createInvoice");
    expectRoute(map, "GET", "/v1/billing/public/invoices/:id", "getInvoiceHandler");
    expectRoute(map, "GET", "/v1/docs/pages/:slug", "readPage");
    expectRoute(map, "PUT", "/v1/docs/pages/:slug", "writePage");

    const users = apps[0].routers.find((router) => router.prefix === "/v1/users");
    assert.ok(users);
    const posts = users.children.find((router) => router.prefix === "/v1/users/:id/posts");
    assert.ok(posts);
    assert.equal(posts.children[0]?.prefix, "/v1/users/:id/posts/:postId/comments");
    assert.equal(countRoutesInRouter(users), 6);
  });
});
