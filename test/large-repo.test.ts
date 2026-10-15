import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { analyzeFiles, emptyStats } from "../src/analyzer";
import { dropGitignored } from "../src/gitIgnore";
import { looksLikeFrameworkSource, looksLikeReexport } from "../src/prefilter";
import { routesOf } from "./helpers";

describe("source prefilter", () => {
  it("parses framework files and re-export barrels, and skips everything else", () => {
    assert.equal(looksLikeFrameworkSource("export const Button = () => null;\n"), false);
    assert.equal(looksLikeFrameworkSource('import { Hono } from "hono";\nconst app = new Hono();\n'), true);
    assert.equal(looksLikeFrameworkSource('import express from "express";\n'), true);
    assert.equal(looksLikeFrameworkSource('import { Controller, Get } from "@nestjs/common";\n@Controller("items")\n'), true);
    assert.equal(looksLikeReexport('export { users } from "./users";\n'), true);
    assert.equal(looksLikeReexport("export const value = 1;\n"), false);
  });
});

describe("gitignore", () => {
  it("drops ignored paths and keeps tracked ones", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-explorer-git-"));
    fs.writeFileSync(path.join(root, ".gitignore"), "secret/\n");
    fs.mkdirSync(path.join(root, "secret"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const ignored = path.join(root, "secret", "a.ts");
    const kept = path.join(root, "src", "app.ts");
    fs.writeFileSync(ignored, "export const a = 1;\n");
    fs.writeFileSync(kept, "export const app = 1;\n");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    const files = await dropGitignored(root, [ignored, kept]);
    assert.deepEqual(files, [kept]);
  });
});

describe("large monorepo", () => {
  it("finishes on thousands of files and a re-export cycle without parsing them all", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-explorer-big-"));
    const noise = path.join(root, "noise");
    fs.mkdirSync(noise, { recursive: true });
    const count = 3000;
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(path.join(noise, `file-${i}.ts`), `export const value${i} = ${i};\n`);
    }

    const cycle = path.join(root, "packages", "cycle");
    fs.mkdirSync(cycle, { recursive: true });
    fs.writeFileSync(
      path.join(cycle, "a.ts"),
      `import { Hono } from "hono";
export { bApp } from "./b";
export const aApp = new Hono();
aApp.get("/from-a", function fromA() {});
`,
    );
    fs.writeFileSync(
      path.join(cycle, "b.ts"),
      `import { Hono } from "hono";
export { aApp } from "./a";
export const bApp = new Hono();
bApp.get("/from-b", function fromB() {});
`,
    );

    const fact = path.join(root, "packages", "fact");
    fs.mkdirSync(fact, { recursive: true });
    fs.writeFileSync(
      path.join(fact, "a.ts"),
      `import { Hono } from "hono";
import { makeB } from "./b";
export function makeA() {
  const app = new Hono();
  app.get("/a", function factA() {});
  app.route("/b", makeB());
  return app;
}
`,
    );
    fs.writeFileSync(
      path.join(fact, "b.ts"),
      `import { Hono } from "hono";
import { makeA } from "./a";
export function makeB() {
  const app = new Hono();
  app.get("/b", function factB() {});
  app.route("/a", makeA());
  return app;
}
`,
    );

    const appDir = path.join(root, "apps", "api", "src");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "app.ts"),
      `import { Hono } from "hono";
import { aApp } from "../../../packages/cycle/a";
import { makeA } from "../../../packages/fact/a";
const app = new Hono();
app.get("/health", function health() {});
app.route("/cycle", aApp);
app.route("/fact", makeA());
export default app;
`,
    );

    const decoys = [
      path.join(root, "node_modules", "hono", "index.ts"),
      path.join(root, "apps", "api", "dist", "noise.ts"),
      path.join(root, "apps", "api", "generated", "gen.ts"),
    ];
    for (const decoy of decoys) {
      fs.mkdirSync(path.dirname(decoy), { recursive: true });
      fs.writeFileSync(decoy, `import { Hono } from "hono";\nconst app = new Hono();\napp.get("/from-decoy", function decoy() {});\n`);
    }

    const files = [
      ...Array.from({ length: count }, (_, i) => path.join(noise, `file-${i}.ts`)),
      path.join(cycle, "a.ts"),
      path.join(cycle, "b.ts"),
      path.join(fact, "a.ts"),
      path.join(fact, "b.ts"),
      path.join(appDir, "app.ts"),
      ...decoys,
    ];

    const stats = emptyStats();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apps = await Promise.race([
      analyzeFiles(files, { stats }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("analysis did not finish")), 20_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    const routes = routesOf(apps);
    const has = (method: string, routePath: string, handler: string) =>
      routes.some((route) => route.method === method && route.path === routePath && route.functionName === handler);

    assert.equal(has("GET", "/health", "health"), true);
    assert.equal(has("GET", "/cycle/from-a", "fromA"), true);
    assert.equal(has("GET", "/fact/a", "factA"), true);
    assert.equal(routes.some((route) => route.path.includes("from-decoy")), false);
    assert.ok(stats.candidates >= count);
    assert.ok(stats.parsed < 30, `parsed ${stats.parsed}`);
    assert.ok(stats.elapsedMs < 20_000);
    assert.ok(routes.length < 30, `routes ${routes.length}`);

    const capped = emptyStats();
    await analyzeFiles(files, { maxFiles: 1, stats: capped });
    assert.equal(capped.capped, true);
    assert.ok(capped.parsed <= 1);
  });
});
