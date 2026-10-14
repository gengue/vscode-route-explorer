import { compareRoutes, getAppLabel, getRouterLabel, monorepoPackageLabel } from "./labels";
import type { AppDefinition, RouteDefinition, RouterDefinition } from "./types";

export interface WorkspaceElement {
  type: "workspace";
  label: string;
  children: AppElement[];
}

export interface AppElement {
  type: "app";
  app: AppDefinition;
  children: Array<RouterElement | RouteElement>;
  parent?: WorkspaceElement;
}

export interface RouterElement {
  type: "router";
  router: RouterDefinition;
  children: Array<RouterElement | RouteElement>;
  parent: AppElement | RouterElement;
}

export interface RouteElement {
  type: "route";
  route: RouteDefinition;
  parent: AppElement | RouterElement;
}

export type ExplorerElement = WorkspaceElement | AppElement | RouterElement | RouteElement;

/** Build the sidebar tree once so expand/collapse and reveal keep stable nodes. */
export function buildExplorerElements(apps: AppDefinition[], workspaceLabel: string): ExplorerElement[] {
  const appElements = groupAppsByLabel(apps).map((app) => buildApp(app));
  appElements.sort((a, b) => getAppLabel(a.app).localeCompare(getAppLabel(b.app)));
  if (appElements.length <= 1) return appElements;
  // Package roots (`apps/billing`) are the top of the tree, same idea as one
  // FastAPI app per service. Other multi-app folders stay under the workspace name.
  if (appElements.some((element) => monorepoPackageLabel(element.app.filePath))) return appElements;

  const workspace: WorkspaceElement = {
    type: "workspace",
    label: workspaceLabel,
    children: [],
  };
  for (const app of appElements) {
    app.parent = workspace;
    workspace.children.push(app);
  }
  return [workspace];
}

/** One sidebar root per `apps/<name>` even when several Hono() calls live there. */
function groupAppsByLabel(apps: AppDefinition[]): AppDefinition[] {
  const groups = new Map<string, AppDefinition[]>();
  for (const app of apps) {
    const label = getAppLabel(app);
    const list = groups.get(label);
    if (list) list.push(app);
    else groups.set(label, [app]);
  }
  const merged: AppDefinition[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const first = group[0];
    merged.push({
      ...first,
      routes: group.flatMap((app) => app.routes),
      routers: group.flatMap((app) => app.routers),
    });
  }
  return merged;
}

function buildApp(app: AppDefinition): AppElement {
  const element: AppElement = { type: "app", app, children: [] };
  element.children = sortedChildren(app.routers, app.routes, element, "/");
  return element;
}

function buildRouter(router: RouterDefinition, parent: AppElement | RouterElement): RouterElement {
  const element: RouterElement = { type: "router", router, children: [], parent };
  element.children = sortedChildren(router.children, router.routes, element, router.prefix);
  return element;
}

function sortedChildren(
  routers: RouterDefinition[],
  routes: RouteDefinition[],
  parent: AppElement | RouterElement,
  parentPrefix: string,
): Array<RouterElement | RouteElement> {
  const routerElements = routers
    .map((router) => buildRouter(router, parent))
    .sort((a, b) =>
      getRouterLabel(a.router, parentPrefix).localeCompare(getRouterLabel(b.router, parentPrefix)),
    );
  const routeElements = [...routes]
    .sort(compareRoutes)
    .map((route): RouteElement => ({ type: "route", route, parent }));
  return [...routerElements, ...routeElements];
}

export function flattenRouteElements(elements: ExplorerElement[]): RouteElement[] {
  const routes: RouteElement[] = [];
  const walk = (element: ExplorerElement) => {
    if (element.type === "route") {
      routes.push(element);
      return;
    }
    if (element.type === "workspace" || element.type === "app" || element.type === "router") {
      element.children.forEach(walk);
    }
  };
  elements.forEach(walk);
  return routes;
}

export function isRouteElement(value: unknown): value is RouteElement {
  return !!value && typeof value === "object" && (value as { type?: string }).type === "route";
}

export function isRouterElement(value: unknown): value is RouterElement {
  return !!value && typeof value === "object" && (value as { type?: string }).type === "router";
}
