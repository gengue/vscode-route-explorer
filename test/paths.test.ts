import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { joinPaths, normalizePath, toHonoPath } from "../src/paths";

describe("paths", () => {
  it("normalizes empty and relative fragments", () => {
    assert.equal(normalizePath(""), "/");
    assert.equal(normalizePath("/"), "/");
    assert.equal(normalizePath("items"), "/items");
    assert.equal(normalizePath("/items/"), "/items");
    assert.equal(normalizePath("//items//:id"), "/items/:id");
  });

  it("shows OpenAPI params in Hono's :id form", () => {
    assert.equal(toHonoPath("/users/{id}"), "/users/:id");
    assert.equal(toHonoPath("/users/{id}/posts/{postId}"), "/users/:id/posts/:postId");
    assert.equal(toHonoPath("/files/{name}?"), "/files/:name?");
    assert.equal(toHonoPath("/users/:id"), "/users/:id");
  });

  it("joins mount prefixes without duplicating slashes", () => {
    assert.equal(joinPaths("/items", "/"), "/items");
    assert.equal(joinPaths("/items", ":id"), "/items/:id");
    assert.equal(joinPaths("/api", "/users"), "/api/users");
    assert.equal(joinPaths("/", "/health"), "/health");
    assert.equal(joinPaths("/api/", "/v1/"), "/api/v1");
  });
});
