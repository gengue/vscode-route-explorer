import {
  commands,
  env,
  Position,
  Range,
  Selection,
  TextEditorRevealType,
  Uri,
  window,
  workspace,
  type ExtensionContext,
  type QuickPickItem,
  type TextDocument,
} from "vscode";
import { analyzeFiles } from "./analyzer";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, filterSourceFiles } from "./glob";
import { countRoutesInApp, getRouteLabel, relativeFile } from "./labels";
import type { SourceLocation } from "./types";
import { PathOperationTreeProvider } from "./treeProvider";
import { isRouteElement, isRouterElement, type RouteElement } from "./treeModel";

const SOURCE_LANGUAGES = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
]);

let scanToken = 0;

export function activate(context: ExtensionContext): void {
  const output = window.createOutputChannel("Node.js Path Explorer");
  const provider = new PathOperationTreeProvider(context.extensionUri);
  const treeView = window.createTreeView("node-path-operation-explorer", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  const scan = async (): Promise<void> => {
    const token = ++scanToken;
    try {
      const files = await discoverFiles();
      if (token !== scanToken) return;
      const apps = analyzeFiles(files);
      if (token !== scanToken) return;
      provider.setApps(apps, workspaceLabel());
      const routes = apps.reduce((total, app) => total + countRoutesInApp(app), 0);
      output.appendLine(
        `Scanned ${files.length} file(s), found ${routes} route(s) across ${apps.length} app(s).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Scan failed: ${message}`);
      provider.setApps([], workspaceLabel());
      window.showErrorMessage(`Node.js Path Explorer: ${message}`);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void scan();
    }, 250);
  };

  context.subscriptions.push(
    output,
    treeView,
    provider,
    commands.registerCommand("nodePathExplorer.refresh", () => scan()),
    commands.registerCommand("nodePathExplorer.collapseAll", () => provider.collapseAll()),
    commands.registerCommand("nodePathExplorer.goToPathOperation", async (element: unknown) => {
      if (!isRouteElement(element)) return;
      await openLocation(element.route.location);
      await treeView.reveal(element, { select: true, focus: false, expand: true });
    }),
    commands.registerCommand("nodePathExplorer.goToRouter", async (element: unknown) => {
      if (!isRouterElement(element)) return;
      await openLocation(element.router.location);
    }),
    commands.registerCommand("nodePathExplorer.copyPath", async (element: unknown) => {
      const text = copyText(element);
      if (!text) return;
      await env.clipboard.writeText(text);
    }),
    commands.registerCommand("nodePathExplorer.searchPathOperations", async () => {
      const routes = provider.getRouteElements();
      if (routes.length === 0) {
        window.showInformationMessage("No path operations to search yet.");
        return;
      }
      const picked = await window.showQuickPick(routes.map(toQuickPick), {
        placeHolder: "Search path operations by method, path, or handler",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) return;
      await openLocation(picked.element.route.location);
      await treeView.reveal(picked.element, { select: true, focus: true, expand: true });
    }),
    workspace.onDidSaveTextDocument((document) => {
      if (isSourceDocument(document)) schedule();
    }),
    workspace.onDidCreateFiles(() => schedule()),
    workspace.onDidDeleteFiles(() => schedule()),
    workspace.onDidRenameFiles(() => schedule()),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nodePathExplorer")) schedule();
    }),
  );

  void scan();
}

export function deactivate(): void {
  scanToken++;
}

async function discoverFiles(): Promise<string[]> {
  const scope = workspace.workspaceFolders?.[0]?.uri ?? null;
  const config = workspace.getConfiguration("nodePathExplorer", scope);
  const include = readPatterns(config.get("include"), DEFAULT_INCLUDE);
  const exclude = readPatterns(config.get("exclude"), DEFAULT_EXCLUDE);
  const found = new Set<string>();
  for (const pattern of include) {
    const uris = await workspace.findFiles(pattern, "{**/node_modules/**,**/.git/**}", 20_000);
    for (const uri of uris) found.add(uri.fsPath);
  }
  return filterSourceFiles([...found], include, exclude);
}

function readPatterns(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return fallback;
  return value.length > 0 ? (value as string[]) : fallback;
}

function workspaceLabel(): string {
  const folders = workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0].name;
  return "workspace";
}

function isSourceDocument(document: TextDocument): boolean {
  return SOURCE_LANGUAGES.has(document.languageId);
}

async function openLocation(location: SourceLocation): Promise<void> {
  const document = await workspace.openTextDocument(Uri.file(location.filePath));
  const editor = await window.showTextDocument(document, { preview: false });
  const position = new Position(location.line, location.character);
  editor.selection = new Selection(position, position);
  editor.revealRange(new Range(position, position), TextEditorRevealType.InCenter);
}

function copyText(element: unknown): string | undefined {
  if (isRouteElement(element)) return element.route.path;
  if (isRouterElement(element)) return element.router.prefix;
  return undefined;
}

interface RoutePick extends QuickPickItem {
  element: RouteElement;
}

function toQuickPick(element: RouteElement): RoutePick {
  const folder = workspace.workspaceFolders?.[0]?.uri.fsPath;
  const file = relativeFile(element.route.location.filePath, folder);
  return {
    label: getRouteLabel(element.route),
    description: element.route.functionName,
    detail: `${file}:${element.route.location.line + 1}`,
    element,
  };
}
