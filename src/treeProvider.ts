import {
  EventEmitter,
  MarkdownString,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  type TreeDataProvider,
} from "vscode";
import { countRoutesInRouter, getAppLabel, getRouteLabel, getRouterLabel } from "./labels";
import type { AppDefinition } from "./types";
import {
  buildExplorerElements,
  flattenRouteElements,
  type AppElement,
  type ExplorerElement,
  type RouteElement,
  type RouterElement,
  type WorkspaceElement,
} from "./treeModel";

const METHOD_ICONS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "all",
  "trace",
  "connect",
]);

/**
 * Sidebar tree modelled on the FastAPI Path Operation Explorer:
 * folder root, `{}` router groups with a route count, colored method dots,
 * and `METHOD /full/path` labels whose description is the handler name.
 */
export class PathOperationTreeProvider implements TreeDataProvider<ExplorerElement> {
  private readonly onDidChange = new EventEmitter<ExplorerElement | undefined>();
  readonly onDidChangeTreeData = this.onDidChange.event;

  private roots: ExplorerElement[] = [];
  private routersExpanded = false;
  /** Bumped so VS Code forgets the previous expanded state and collapse-all sticks. */
  private toggleCount = 0;

  constructor(private readonly extensionUri: Uri) {}

  getRouteElements(): RouteElement[] {
    return flattenRouteElements(this.roots);
  }

  setApps(apps: AppDefinition[], workspaceLabel: string): void {
    this.roots = buildExplorerElements(apps, workspaceLabel);
    this.refresh();
  }

  refresh(): void {
    this.onDidChange.fire(undefined);
  }

  /** Force every router group back to collapsed. */
  collapseAll(): void {
    this.routersExpanded = false;
    this.toggleCount++;
    this.refresh();
  }

  dispose(): void {
    this.onDidChange.dispose();
  }

  getParent(element: ExplorerElement): ExplorerElement | undefined {
    if (element.type === "workspace") return undefined;
    return element.parent;
  }

  getChildren(element?: ExplorerElement): ExplorerElement[] {
    if (!element) return this.roots;
    if (element.type === "route") return [];
    return element.children;
  }

  getTreeItem(element: ExplorerElement): TreeItem {
    switch (element.type) {
      case "workspace":
        return this.workspaceItem(element);
      case "app":
        return this.appItem(element);
      case "router":
        return this.routerItem(element);
      case "route":
        return this.routeItem(element);
    }
  }

  private workspaceItem(element: WorkspaceElement): TreeItem {
    const item = new TreeItem(element.label, TreeItemCollapsibleState.Expanded);
    item.iconPath = new ThemeIcon("folder-library");
    item.contextValue = "workspace";
    return item;
  }

  private appItem(element: AppElement): TreeItem {
    const item = new TreeItem(getAppLabel(element.app), TreeItemCollapsibleState.Expanded);
    item.iconPath = new ThemeIcon("root-folder");
    item.contextValue = "app";
    item.description = element.app.framework;
    item.tooltip = `${element.app.framework} application \`${element.app.name}\``;
    return item;
  }

  private routerItem(element: RouterElement): TreeItem {
    const parentPrefix = element.parent.type === "router" ? element.parent.router.prefix : "/";
    const item = new TreeItem(
      getRouterLabel(element.router, parentPrefix),
      this.routersExpanded ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed,
    );
    item.id = `router:${element.router.location.filePath}:${element.router.location.line}:${element.router.prefix}:${this.toggleCount}`;
    item.iconPath = new ThemeIcon("symbol-namespace");
    const total = countRoutesInRouter(element.router);
    item.description = total === 1 ? "1 route" : `${total} routes`;
    item.contextValue = "router";
    item.tooltip = new MarkdownString(
      `**${element.router.prefix}**\n\n${item.description}\n\n${element.router.location.filePath}:${element.router.location.line + 1}`,
    );
    item.command = {
      command: "nodePathExplorer.goToRouter",
      title: "Go to Router Definition",
      arguments: [element],
    };
    return item;
  }

  private routeItem(element: RouteElement): TreeItem {
    const { route } = element;
    const item = new TreeItem(getRouteLabel(route));
    if (route.functionName) item.description = route.functionName;
    item.iconPath = this.methodIcon(route.method);
    item.contextValue = "route";
    item.id = `route:${route.location.filePath}:${route.location.line}:${route.method}:${route.path}`;
    const doc = route.docstring ? `\n\n---\n\n${route.docstring}` : "";
    const handlerLine = route.functionName ? `**Function:** \`${route.functionName}\`\n\n` : "";
    const tooltip = new MarkdownString(
      `**${route.method}** \`${route.path}\`\n\n` +
        handlerLine +
        `**Framework:** ${route.framework}\n\n` +
        `**File:** ${route.location.filePath}:${route.location.line + 1}` +
        doc,
    );
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.command = {
      command: "nodePathExplorer.goToPathOperation",
      title: "Go to Definition",
      arguments: [element],
    };
    return item;
  }

  private methodIcon(method: string): Uri {
    const name = METHOD_ICONS.has(method.toLowerCase()) ? method.toLowerCase() : "all";
    return Uri.joinPath(this.extensionUri, "media", "icons", "methods", `${name}.svg`);
  }
}
