import fs from "node:fs";
import path from "node:path";
import { analyzeFiles } from "../src/analyzer";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, filterSourceFiles } from "../src/glob";
import { flattenRoutes } from "../src/labels";
import type { AppDefinition, RouteDefinition } from "../src/types";

export function repoRoot(): string {
  return path.resolve(__dirname, "..");
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

export async function analyzeFixture(name: string): Promise<AppDefinition[]> {
  const dir = path.join(repoRoot(), "fixtures", name);
  const files = filterSourceFiles(listFiles(dir), DEFAULT_INCLUDE, DEFAULT_EXCLUDE);
  return analyzeFiles(files);
}

export function routesOf(apps: AppDefinition[]): RouteDefinition[] {
  return apps.flatMap((app) => flattenRoutes(app));
}

export function routeMap(apps: AppDefinition[]): Map<string, RouteDefinition> {
  const map = new Map<string, RouteDefinition>();
  for (const route of routesOf(apps)) {
    map.set(`${route.method} ${route.path}`, route);
  }
  return map;
}

export function lineText(filePath: string, line: number): string {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/)[line] ?? "";
}
