import { compareRoutes, getRouterLabel } from "./labels";
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
  const appElements = apps.map((app) => buildApp(app));
  if (appElements.length <= 1) return appElements;

  const workspace: WorkspaceElement = {
    type: "workspace",
    label: workspaceLabel,
    children: [],
  };
  for (const app of appElements) {
    app.parent = workspace;
    workspace.children.push(app);
  }
  workspace.children.sort((a, b) => a.app.name.localeCompare(b.app.name));
  return [workspace];
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
