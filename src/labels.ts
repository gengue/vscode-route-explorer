import path from "node:path";
import type { AppDefinition, RouteDefinition, RouterDefinition } from "./types";

const METHOD_ORDER: Record<string, number> = {
  GET: 0,
  POST: 1,
  PUT: 2,
  PATCH: 3,
  DELETE: 4,
  OPTIONS: 5,
  HEAD: 6,
  ALL: 7,
  TRACE: 8,
  CONNECT: 9,
};

export function countRoutesInRouter(router: RouterDefinition): number {
  return (
    router.routes.length +
    router.children.reduce((total, child) => total + countRoutesInRouter(child), 0)
  );
}

export function countRoutesInApp(app: AppDefinition): number {
  return (
    app.routes.length +
    app.routers.reduce((total, router) => total + countRoutesInRouter(router), 0)
  );
}

/** `GET /items/:id` — method plus the fully resolved path. */
export function getRouteLabel(route: RouteDefinition): string {
  return `${route.method} ${route.path}`;
}

export function compareRoutes(a: RouteDefinition, b: RouteDefinition): number {
  const methodDelta = (METHOD_ORDER[a.method] ?? 99) - (METHOD_ORDER[b.method] ?? 99);
  if (methodDelta !== 0) return methodDelta;
  return a.path.localeCompare(b.path);
}

/**
 * Label a router relative to its parent, matching the FastAPI explorer:
 * a router mounted at `/api/items` under `/api` is shown as `/items`.
 */
export function getRouterLabel(router: RouterDefinition, parentPrefix: string): string {
  let label = router.prefix || "/";
  if (parentPrefix && parentPrefix !== "/") {
    if (label.startsWith(`${parentPrefix}/`)) {
      label = label.slice(parentPrefix.length);
    } else if (label.startsWith(parentPrefix)) {
      label = label.slice(parentPrefix.length) || "/";
    }
  }
  if (!label.startsWith("/")) label = `/${label}`;
  if (label !== "/") return label;

  if (router.name && router.name !== "router" && router.name !== "app" && router.name !== "default") {
    return router.name;
  }
  const parts = router.location.filePath.split(/[/\\]/);
  const fileName = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  if (fileName === "router" || fileName === "routes" || fileName === "index") {
    return parts.pop() || fileName || "/";
  }
  return fileName || "/";
}

/**
 * Root label. A binding literally named `app` is replaced with the folder
 * that contains it (`backend/app` when the file lives in that directory),
 * which is the same convention the FastAPI explorer uses.
 */
export function getAppLabel(app: AppDefinition): string {
  if (app.name !== "app") return app.name;
  const parts = app.filePath.split(/[/\\]/);
  const fileName = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  const parentDir = parts.pop() ?? "";
  const grandParentDir = parts.pop() ?? "";
  if (parentDir && parentDir !== "src" && parentDir !== "app") return parentDir;
  if (grandParentDir) return `${grandParentDir}/${parentDir}`;
  return fileName;
}

export function flattenRoutes(app: AppDefinition): RouteDefinition[] {
  const routes = [...app.routes];
  const walk = (router: RouterDefinition) => {
    routes.push(...router.routes);
    router.children.forEach(walk);
  };
  app.routers.forEach(walk);
  return routes;
}

export function relativeFile(filePath: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return path.basename(filePath);
  const relative = path.relative(workspaceRoot, filePath);
  return relative.startsWith("..") ? filePath : relative;
}
