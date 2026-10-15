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
import path from "node:path";
import { analyzeFiles, emptyStats } from "./analyzer";
import { dropGitignored } from "./gitIgnore";
import {
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  DISCOVERY_EXCLUDES,
  combineExcludeGlob,
  excludePatternsFromSetting,
  expandIncludePatterns,
  filterSourceFiles,
} from "./glob";
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
    const started = Date.now();
    try {
      treeView.message = "Discovering route files…";
      const discovered = await discoverFiles();
      if (token !== scanToken) return;
      const discoverMs = Date.now() - started;
      output.appendLine(
        `[scan] discovered ${discovered.files.length} file(s) in ${discoverMs}ms via ${discovered.mode}` +
          `${discovered.capped ? " (discovery cap hit)" : ""}`,
      );
      const stats = emptyStats();
      treeView.message = `Checking ${discovered.files.length} files…`;
      const apps = await analyzeFiles(discovered.files, {
        stats,
        isCancelled: () => token !== scanToken,
        onProgress: (message) => {
          if (token !== scanToken) return;
          treeView.message = message;
        },
      });
      if (token !== scanToken) return;
      provider.setApps(apps, workspaceLabel());
      treeView.message = "";
      const routes = apps.reduce((total, app) => total + countRoutesInApp(app), 0);
      output.appendLine(
        `[scan] prefilter ${stats.candidates} → ${stats.matched} framework file(s) in ${stats.prefilterMs}ms`,
      );
      output.appendLine(
        `[scan] parsed ${stats.parsed} file(s) in ${stats.parseMs}ms${stats.capped ? " (parse cap hit)" : ""}`,
      );
      if (stats.factoryDepthHits > 0) {
        output.appendLine(`[scan] factory follow stopped early ${stats.factoryDepthHits} time(s)`);
      }
      output.appendLine(
        `[scan] linked ${routes} route(s) across ${apps.length} app(s) in ${stats.linkMs}ms`,
      );
      output.appendLine(`[scan] done in ${Date.now() - started}ms`);
    } catch (error) {
      if (token !== scanToken) return;
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Scan failed: ${message}`);
      treeView.message = "";
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

const MAX_DISCOVERED = 20_000;

async function discoverFiles(): Promise<{ files: string[]; mode: string; capped: boolean }> {
  const folders = workspace.workspaceFolders ?? [];
  const scope = folders[0]?.uri ?? null;
  const config = workspace.getConfiguration("nodePathExplorer", scope);
  const include = readPatterns(config.get("include"), DEFAULT_INCLUDE);
  const exclude = readPatterns(config.get("exclude"), DEFAULT_EXCLUDE);
  const filesExclude = excludePatternsFromSetting(workspace.getConfiguration("files", scope).get("exclude"));
  const searchExclude = excludePatternsFromSetting(workspace.getConfiguration("search", scope).get("exclude"));
  const excludeGlobs = [...new Set([...DISCOVERY_EXCLUDES, ...exclude, ...filesExclude, ...searchExclude])];
  const found = new Set<string>();
  let capped = false;
  let mode = "findFiles";
  const finder = (workspace as { findFiles2?: FindFiles2 }).findFiles2;

  for (const pattern of expandIncludePatterns(include)) {
    if (found.size >= MAX_DISCOVERED) {
      capped = true;
      break;
    }
    const room = MAX_DISCOVERED - found.size;
    let uris: Array<{ fsPath: string }> = [];
    if (typeof finder === "function") {
      try {
        uris = await finder.call(workspace, pattern, {
          exclude: excludeGlobs,
          useExcludeSettings: 3,
          useIgnoreFiles: true,
          maxResults: room,
        });
        mode = "findFiles2";
      } catch {
        uris = await workspace.findFiles(pattern, combineExcludeGlob(excludeGlobs), room);
      }
    } else {
      uris = await workspace.findFiles(pattern, combineExcludeGlob(excludeGlobs), room);
    }
    if (uris.length >= room) capped = true;
    for (const uri of uris) found.add(uri.fsPath);
  }

  let files = filterSourceFiles([...found], include, [...exclude, ...DISCOVERY_EXCLUDES]);
  const kept = new Set<string>();
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const inside = files.filter((file) => file === root || file.startsWith(root + path.sep));
    for (const file of await dropGitignored(root, inside)) kept.add(file);
  }
  if (folders.length > 0) {
    for (const file of files) {
      const inside = folders.some((folder) => file === folder.uri.fsPath || file.startsWith(folder.uri.fsPath + path.sep));
      if (!inside) kept.add(file);
    }
    files = [...kept];
  }
  return { files, mode, capped };
}

interface FindFiles2Options {
  exclude?: string[];
  useExcludeSettings?: number;
  maxResults?: number;
  useIgnoreFiles?: boolean;
}

type FindFiles2 = (pattern: string, options?: FindFiles2Options) => Thenable<Array<{ fsPath: string }>>;

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
