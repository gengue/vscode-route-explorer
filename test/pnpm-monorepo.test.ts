import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAppLabel, getRouterLabel } from "../src/labels";
import { buildExplorerElements } from "../src/treeModel";
import { analyzeFixture, lineText, routesOf } from "./helpers";

describe("pnpm monorepo hono apps", () => {
  it("mounts factory apps per package and names inline handlers from describeRoute", () => {
    const apps = analyzeFixture("pnpm-monorepo");
    const labels = apps.map((app) => getAppLabel(app)).sort();
    assert.deepEqual(labels, ["apps/billing", "apps/notify"]);

    const routes = routesOf(apps);
    const expectRoute = (method: string, routePath: string, handler: string) => {
      const route = routes.find((item) => item.method === method && item.path === routePath && item.functionName === handler);
      assert.ok(route, `missing ${method} ${routePath} (${handler || "no name"})`);
      if (!handler) return;
      const around = [0, 1, 2, 3]
        .map((offset) => lineText(route.location.filePath, route.location.line + offset))
        .join("\n");
      assert.match(around, new RegExp(handler));
    };

    expectRoute("GET", "/health", "getHealth");
    expectRoute("GET", "/health", "");
    expectRoute("GET", "/account-info", "getAccountInfo");
    expectRoute("GET", "/project-info", "");
    expectRoute("POST", "/charges", "Create a charge");
    expectRoute("GET", "/jobs", "listJobs");
    expectRoute("POST", "/get-message", "getMessage");

    assert.equal(
      routes.some((route) => route.path.includes("*") || route.path === "/from-dist"),
      false,
    );

    const elements = buildExplorerElements(apps, "sample-monorepo");
    assert.deepEqual(
      elements.map((element) => (element.type === "app" ? getAppLabel(element.app) : element.type)),
      ["apps/billing", "apps/notify"],
    );
    const billing = elements.find((element) => element.type === "app" && getAppLabel(element.app) === "apps/billing");
    assert.ok(billing && billing.type === "app");
    const chargeGroup = billing.children.find((child) => child.type === "router" && getRouterLabel(child.router, "/") === "/charges");
    assert.ok(chargeGroup, "charges factory should be a prefix group");
  });
});
