import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./helpers";

describe("package manifest", () => {
  const root = repoRoot();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    name: string;
    displayName: string;
    description: string;
    publisher: string;
    license: string;
    icon: string;
    homepage: string;
    keywords: string[];
    galleryBanner: { color: string; theme: string };
    repository: { url: string };
    bugs: { url: string };
    main: string;
    activationEvents: string[];
    contributes: {
      commands: { command: string }[];
      views: Record<string, { id: string; name: string }[]>;
      viewsContainers: { activitybar: { id: string; icon: string }[] };
      configuration: { properties: Record<string, { default: unknown }> };
    };
  };

  it("is ready for vsce package", () => {
    assert.equal(manifest.name, "nodejs-path-explorer");
    assert.equal(manifest.displayName, "Hono Route Explorer");
    assert.match(manifest.description, /Hono/);
    assert.equal(manifest.publisher, "gengue");
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.icon, "images/icon.png");
    assert.equal(manifest.homepage, "https://github.com/gengue/vscode-route-explorer");
    assert.equal(manifest.repository.url, "https://github.com/gengue/vscode-route-explorer");
    assert.equal(manifest.bugs.url, "https://github.com/gengue/vscode-route-explorer/issues");
    assert.deepEqual(manifest.keywords, ["hono", "routes", "express", "api", "explorer"]);
    assert.equal(manifest.galleryBanner.color, "#F84810");
    assert.equal(manifest.galleryBanner.theme, "dark");
    assert.ok(fs.existsSync(path.join(root, manifest.icon)));
    assert.equal(manifest.main, "./dist/extension.js");
    assert.ok(manifest.activationEvents.includes("onView:node-path-operation-explorer"));
    assert.equal(
      manifest.activationEvents.some((event) => event.startsWith("workspaceContains")),
      false,
    );
    assert.ok(fs.existsSync(path.join(root, "LICENSE")));
  });

  it("contributes the explorer, refresh, collapse, search, and copy commands", () => {
    const commands = new Set(manifest.contributes.commands.map((command) => command.command));
    for (const id of [
      "nodePathExplorer.refresh",
      "nodePathExplorer.collapseAll",
      "nodePathExplorer.searchPathOperations",
      "nodePathExplorer.copyPath",
      "nodePathExplorer.goToPathOperation",
    ]) {
      assert.ok(commands.has(id), id);
    }
    const views = manifest.contributes.views["node-path-explorer"];
    assert.equal(views[0].name, "Path Operation Explorer");
    assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, "media/icons/activity.svg");
    assert.ok(manifest.contributes.configuration.properties["nodePathExplorer.include"]);
    assert.ok(manifest.contributes.configuration.properties["nodePathExplorer.exclude"]);
  });
});
