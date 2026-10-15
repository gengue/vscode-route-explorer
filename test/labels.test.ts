import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countRoutesInRouter, getAppLabel, getRouteLabel, getRouterLabel } from "../src/labels";
import { buildExplorerElements } from "../src/treeModel";
import { analyzeFixture, routesOf } from "./helpers";
import type { RouterDefinition } from "../src/types";

describe("labels", async () => {
  it("names an app binding after the backend/app folder", async () => {
    const [app] = await analyzeFixture("express-app");
    assert.equal(app.name, "app");
    assert.equal(getAppLabel(app), "backend/app");
  });

  it("shows router prefixes relative to their parent and counts nested routes", async () => {
    const [app] = await analyzeFixture("express-app");
    const elements = buildExplorerElements([app], "express-app");
    assert.equal(elements.length, 1);
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
  });

  it("labels a route with its method and full path", async () => {
    const routes = routesOf(await analyzeFixture("express-app"));
    const patch = routes.find((route) => route.method === "PATCH");
    assert.ok(patch);
    assert.equal(getRouteLabel(patch), "PATCH /users/:id");
  });
});
