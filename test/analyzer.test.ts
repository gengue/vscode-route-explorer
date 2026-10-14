import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { countRoutesInApp, countRoutesInRouter } from "../src/labels";
import { analyzeFixture, lineText, routeMap, routesOf } from "./helpers";

function expectRoute(
  map: Map<string, { method: string; path: string; functionName: string; location: { filePath: string; line: number } }>,
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

describe("express", () => {
  it("resolves router mounts across files, including barrel re-exports", () => {
    const apps = analyzeFixture("express-app");
    assert.equal(apps.length, 1);
    assert.equal(apps[0].framework, "express");
    assert.equal(countRoutesInApp(apps[0]), 23);

    const groups = apps[0].routers.map((router) => [router.prefix, countRoutesInRouter(router)]);
    assert.deepEqual(groups, [
      ["/items", 5],
      ["/login", 5],
      ["/private", 1],
      ["/users", 10],
      ["/utils", 2],
    ]);

    const map = routeMap(apps);
    expectRoute(map, "GET", "/items", "listItems");
    expectRoute(map, "GET", "/items/:id", "getItem");
    expectRoute(map, "POST", "/items", "createItem");
    expectRoute(map, "PUT", "/items/:id", "updateItem");
    expectRoute(map, "DELETE", "/items/:id", "deleteItem");
    expectRoute(map, "POST", "/login/logout", "logout");
    expectRoute(map, "GET", "/private", "getPrivate");
    expectRoute(map, "DELETE", "/users/:id/friends/:friendId", "deleteFriend");
    expectRoute(map, "GET", "/utils/health", "health");
    expectRoute(map, "GET", "/utils/version", "version");

    const listed = map.get("GET /items");
    assert.equal(listed?.docstring, "List items.");
    assert.equal(path.basename(listed?.location.filePath ?? ""), "items.ts");
  });

  it("understands nested routers, route chains, const paths, arrays, and middleware", () => {
    const apps = analyzeFixture("express-patterns");
    const map = routeMap(apps);

    expectRoute(map, "GET", "/api/items/:id", "getItem");
    expectRoute(map, "GET", "/health", "health");
    expectRoute(map, "GET", "/admin/stats", "stats");
    expectRoute(map, "GET", "/session", "getSession");
    expectRoute(map, "POST", "/session", "createSession");
    expectRoute(map, "GET", "/a", "multi");
    expectRoute(map, "GET", "/b", "multi");
    expectRoute(map, "POST", "/jobs", "createJob");
    expectRoute(map, "PATCH", "/jobs/:id", "patchJob");
    expectRoute(map, "HEAD", "/jobs/:id", "headJob");
    expectRoute(map, "OPTIONS", "/jobs", "optionsJob");
    expectRoute(map, "ALL", "/hooks", "allHooks");
    expectRoute(map, "GET", "/a/x", "handler");
    expectRoute(map, "GET", "/b/x", "handler");

    assert.equal(
      routesOf(apps).some((route) => route.path.includes("json")),
      false,
    );
  });

  it("follows CommonJS require() mounts", () => {
    const map = routeMap(analyzeFixture("express-cjs"));
    expectRoute(map, "GET", "/items", "listItems");
    expectRoute(map, "POST", "/items", "createItem");
    expectRoute(map, "GET", "/health", "health");
  });
});

describe("fastify", () => {
  it("resolves register prefixes across files and route option objects", () => {
    const apps = analyzeFixture("fastify-app");
    assert.equal(apps.length, 1);
    assert.equal(apps[0].framework, "fastify");
    const map = routeMap(apps);
    expectRoute(map, "GET", "/health", "health");
    expectRoute(map, "GET", "/items", "listItems");
    expectRoute(map, "PUT", "/items/:id", "updateItem");
    expectRoute(map, "PATCH", "/items/:id", "updateItem");
    expectRoute(map, "GET", "/users", "listUsers");
    expectRoute(map, "GET", "/users/:id", "getUser");
    expectRoute(map, "GET", "/users/account/settings", "getSettings");

    const users = apps[0].routers.find((router) => router.prefix === "/users");
    assert.ok(users);
    assert.equal(users.children[0]?.prefix, "/users/account");
    assert.match(lineText(map.get("GET /users")!.location.filePath, map.get("GET /users")!.location.line), /listUsers/);
  });
});

describe("nestjs", () => {
  it("reads controller decorators, versions, and the global prefix", () => {
    const apps = analyzeFixture("nest-app");
    assert.equal(apps.length, 1);
    assert.equal(apps[0].framework, "nest");
    assert.equal(apps[0].name, "app");
    const map = routeMap(apps);
    expectRoute(map, "GET", "/api/items", "findAll");
    expectRoute(map, "GET", "/api/items/:id", "findOne");
    expectRoute(map, "POST", "/api/items", "create");
    expectRoute(map, "PUT", "/api/items/:id", "update");
    expectRoute(map, "PATCH", "/api/items/:id", "patch");
    expectRoute(map, "DELETE", "/api/items/:id", "remove");
    expectRoute(map, "GET", "/api/items/archived", "findArchived");
    expectRoute(map, "GET", "/api/items/old", "findArchived");
    expectRoute(map, "GET", "/api/v1/users", "findAll");
    expectRoute(map, "GET", "/api/v1/users/:id", "findOne");
    expectRoute(map, "HEAD", "/api/v1/users/:id", "headOne");
    expectRoute(map, "OPTIONS", "/api/v1/users", "options");

    const listed = map.get("GET /api/items");
    assert.equal(listed?.docstring, "List every item.");
    assert.match(lineText(listed!.location.filePath, listed!.location.line), /@Get/);
  });
});
