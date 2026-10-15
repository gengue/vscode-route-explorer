import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoveryExcludeGlob, expandIncludePatterns, filterSourceFiles, matchGlob } from "../src/glob";

describe("globs", () => {
  it("matches extensions, node_modules, and tests on absolute paths", () => {
    const source = "/workspace/fixtures/express-app/backend/app/index.ts";
    assert.equal(matchGlob(source, "**/*.{js,jsx,mjs,cjs,ts,tsx}"), true);
    assert.equal(matchGlob(source, "**/*.d.ts"), false);
    assert.equal(matchGlob("/workspace/src/types.d.ts", "**/*.d.ts"), true);
    assert.equal(matchGlob("/workspace/node_modules/express/index.js", "**/node_modules/**"), true);
    assert.equal(matchGlob("/workspace/src/app.test.ts", "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx}"), true);
    assert.equal(matchGlob("/workspace/src/app.ts", "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx}"), false);
  });

  it("filters include and exclude together", () => {
    const files = [
      "/app/src/index.ts",
      "/app/src/index.test.ts",
      "/app/node_modules/express/index.js",
      "/app/README.md",
    ];
    const kept = filterSourceFiles(
      files,
      ["**/*.{js,ts}"],
      ["**/node_modules/**", "**/*.{test,spec}.{js,ts}"],
    );
    assert.deepEqual(kept, ["/app/src/index.ts"]);
  });

  it("expands include braces and excludes build output before the search cap", () => {
    assert.deepEqual(expandIncludePatterns(["**/*.{ts,tsx}"]), ["**/*.ts", "**/*.tsx"]);
    const exclude = discoveryExcludeGlob();
    for (const pattern of ["**/node_modules/**", "**/dist/**", "**/.turbo/**", "**/generated/**", "**/*.d.ts"]) {
      assert.equal(exclude.includes(pattern), true, pattern);
    }
    const kept = filterSourceFiles(
      [
        "/repo/apps/billing/src/app.ts",
        "/repo/apps/billing/dist/noise.js",
        "/repo/node_modules/hono/dist/index.js",
        "/repo/.turbo/cache/x.js",
      ],
      ["**/*.ts", "**/*.js"],
      ["**/node_modules/**", "**/dist/**", "**/.turbo/**"],
    );
    assert.deepEqual(kept, ["/repo/apps/billing/src/app.ts"]);
  });
});
