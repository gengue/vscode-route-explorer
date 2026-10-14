/**
 * Static route discovery.
 *
 * The TypeScript compiler builds a program over the workspace sources and
 * this module walks the AST. Imports are followed by the checker when it can
 * resolve them, and by a small export map when it cannot (there is usually
 * no `node_modules` full of framework typings). Nothing is executed.
 *
 * Passes:
 * Hono is the primary target: `new Hono()` / `OpenAPIHono`, `basePath`,
 * chained verbs, `app.route()` mounts (including across package imports),
 * and `@hono/zod-openapi` `app.openapi(createRoute(...))`.
 * Express mounts, Fastify plugins, and Nest decorators are collected too.
 *
 * Passes:
 * 1. Record every `new Hono()` / `express()` / `Router()` / `Fastify()` binding.
 * 2. Link CommonJS `module.exports` and ESM re-exports onto those bindings.
 * 3. Bind Fastify `register(plugin, { prefix })` callbacks, including nested plugins.
 * 4. Record HTTP calls, Hono `route` / `openapi`, and Express `use` mounts.
 * 5. Read NestJS `@Controller` classes and `setGlobalPrefix`.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { joinPaths, normalizePath, toHonoPath } from "./paths";
import type {
  AppDefinition,
  Framework,
  HttpMethod,
  RouteDefinition,
  RouterDefinition,
  SourceLocation,
} from "./types";

const HTTP_METHODS = new Set([
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

const NEST_METHODS: Record<string, HttpMethod> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Head: "HEAD",
  Options: "OPTIONS",
  All: "ALL",
};

interface Classification {
  framework: Framework;
  role: "app" | "router";
  basePath: string;
}

interface RawRoute {
  method: HttpMethod;
  path: string;
  functionName: string;
  location: SourceLocation;
  docstring?: string;
}

interface RawMount {
  prefix: string;
  child: RawRouter;
  location: SourceLocation;
}

interface RawRouter {
  name: string;
  framework: Framework;
  role: "app" | "router";
  basePath: string;
  location: SourceLocation;
  filePath: string;
  routes: RawRoute[];
  mounts: RawMount[];
}

interface ModuleRef {
  specifier: string;
  exportName: string;
}

interface RegisterSite {
  call: ts.CallExpression;
  sourceFile: ts.SourceFile;
}

export function analyzeFiles(filePaths: string[]): AppDefinition[] {
  const files = [
    ...new Set(
      filePaths
        .map((file) => path.resolve(file))
        .filter((file) => {
          if (!fs.existsSync(file)) return false;
          if (file.includes(`${path.sep}node_modules${path.sep}`)) return false;
          try {
            return fs.statSync(file).size <= 1_000_000;
          } catch {
            return false;
          }
        }),
    ),
  ];
  if (files.length === 0) return [];

  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    jsx: ts.JsxEmit.React,
    moduleDetection: ts.ModuleDetectionKind.Force,
    strict: false,
    skipLibCheck: true,
    maxNodeModuleJsDepth: 0,
  };

  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes(`${path.sep}node_modules${path.sep}`));

  const session = new Session(checker, sourceFiles);
  return session.analyze();
}

class Session {
  private readonly routersBySymbol = new Map<ts.Symbol, RawRouter>();
  private readonly routersByNode = new Map<ts.Node, RawRouter>();
  private readonly allRouters: RawRouter[] = [];
  private readonly namedRouters = new Map<string, RawRouter>();
  private readonly defaultRouters = new Map<string, RawRouter>();
  private readonly namedFunctions = new Map<string, ts.SignatureDeclaration>();
  private readonly defaultFunctions = new Map<string, ts.SignatureDeclaration>();
  private readonly cjsDefaultRouters = new Map<string, RawRouter>();
  private readonly cjsDefaultFunctions = new Map<string, ts.SignatureDeclaration>();
  /** Fastify plugin parameter -> every router that parameter was registered as. */
  private readonly paramBindings = new Map<ts.Symbol, RawRouter[]>();
  private readonly sourceByPath = new Map<string, ts.SourceFile>();
  /** Nearest tsconfig.json, keyed by the directory we searched from. */
  private readonly tsconfigByDir = new Map<string, TsConfigInfo | undefined>();
  private packageEntries: PackageEntry[] | undefined;

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly sourceFiles: readonly ts.SourceFile[],
  ) {
    for (const sf of sourceFiles) {
      this.sourceByPath.set(path.normalize(sf.fileName), sf);
    }
  }

  analyze(): AppDefinition[] {
    for (const sf of this.sourceFiles) this.collectCreations(sf);
    for (const sf of this.sourceFiles) this.linkExports(sf);
    this.bindFastifyPlugins();
    for (const sf of this.sourceFiles) this.collectHttp(sf);
    const nestApp = this.collectNest();

    const mounted = new Set<RawRouter>();
    for (const router of this.allRouters) {
      for (const mount of router.mounts) mounted.add(mount.child);
    }

    // Nest is assembled separately so the synthetic app is not emitted twice.
    const roots = this.allRouters.filter(
      (router) => !mounted.has(router) && router.role === "app" && router.framework !== "nest",
    );
    const orphans = this.allRouters.filter(
      (router) =>
        !mounted.has(router) &&
        router.role === "router" &&
        router.framework !== "nest" &&
        (router.routes.length > 0 || router.mounts.length > 0),
    );

    const apps = [...roots, ...orphans].map((router) => this.emitApp(router));
    if (nestApp) apps.push(nestApp);
    return apps;
  }

  // --- pass 1: constructions -------------------------------------------------

  private collectCreations(sf: ts.SourceFile): void {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node)) {
        if (node.name) this.namedFunctions.set(this.exportKey(sf, node.name.text), node);
        // `export default async function (fastify) {}` has no name but is the module default.
        if (this.hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
          this.defaultFunctions.set(this.fileKey(sf), node);
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.name)
      ) {
        const classification = this.classifyCreation(node.initializer);
        if (classification) {
          const router = this.createRouter(
            classification,
            node.name.text,
            node.name,
            sf,
            node.initializer,
          );
          const symbol = this.checker.getSymbolAtLocation(node.name);
          if (symbol) this.routersBySymbol.set(this.canonical(symbol), router);
          if (this.isVariableExported(node)) {
            this.namedRouters.set(this.exportKey(sf, node.name.text), router);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // --- pass 2: exports and require() ----------------------------------------

  private linkExports(sf: ts.SourceFile): void {
    for (const statement of sf.statements) {
      if (ts.isExportAssignment(statement)) {
        const router = this.resolveRouter(statement.expression);
        if (router) this.defaultRouters.set(this.fileKey(sf), router);
        const fn = this.asSignature(statement.expression);
        if (fn) this.defaultFunctions.set(this.fileKey(sf), fn);
      }

      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name &&
        this.hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ) {
        this.namedFunctions.set(this.exportKey(sf, statement.name.text), statement);
      }

      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const exported = element.name.text;
          const local = (element.propertyName ?? element.name).text;
          if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            const target = this.resolveModule(sf.fileName, statement.moduleSpecifier.text);
            if (!target) continue;
            const router =
              this.namedRouters.get(this.exportKey(target, local)) ??
              (local === "default" ? this.defaultRouters.get(this.fileKey(target)) : undefined);
            if (router) this.namedRouters.set(this.exportKey(sf, exported), router);
            const fn =
              this.namedFunctions.get(this.exportKey(target, local)) ??
              (local === "default" ? this.defaultFunctions.get(this.fileKey(target)) : undefined);
            if (fn) this.namedFunctions.set(this.exportKey(sf, exported), fn);
          } else {
            const router = this.namedRouters.get(this.exportKey(sf, local));
            if (router) this.namedRouters.set(this.exportKey(sf, exported), router);
            const fn = this.namedFunctions.get(this.exportKey(sf, local));
            if (fn) this.namedFunctions.set(this.exportKey(sf, exported), fn);
          }
        }
      }

      this.captureAssignment(statement, sf);
    }

    // `export { x } from` inside a file may refer to a binding recorded on the
    // target only after that file was visited. A second, local-only pass is
    // not enough for chains, so resolve re-exports again in file order once
    // every file has been recorded. Chains of length > 1 are handled below.
    this.copyStarExports(sf);
  }

  /** Second sweep over re-exports, run after every file has local bindings. */
  finalizeReexports(): void {
    // Repeated a few times so `export { a } from './b'` chains settle.
    for (let pass = 0; pass < 4; pass++) {
      for (const sf of this.sourceFiles) this.linkExports(sf);
    }
  }

  private copyStarExports(sf: ts.SourceFile): void {
    for (const statement of sf.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.exportClause ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const target = this.resolveModule(sf.fileName, statement.moduleSpecifier.text);
      if (!target) continue;
      const prefix = `${this.fileKey(target)}::`;
      for (const [key, router] of this.namedRouters) {
        if (key.startsWith(prefix)) {
          const name = key.slice(prefix.length);
          this.namedRouters.set(this.exportKey(sf, name), router);
        }
      }
      for (const [key, fn] of this.namedFunctions) {
        if (key.startsWith(prefix)) {
          const name = key.slice(prefix.length);
          this.namedFunctions.set(this.exportKey(sf, name), fn);
        }
      }
    }
  }

  private captureAssignment(statement: ts.Statement, sf: ts.SourceFile): void {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return;
    const expr = statement.expression;
    if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    if (!this.isModuleExports(expr.left)) return;
    const router = this.resolveRouter(expr.right);
    if (router) this.cjsDefaultRouters.set(this.fileKey(sf), router);
    const fn = this.asSignature(expr.right);
    if (fn) this.cjsDefaultFunctions.set(this.fileKey(sf), fn);
  }

  // --- pass 3: fastify register ----------------------------------------------

  private bindFastifyPlugins(): void {
    // Re-export linking must be finished before plugins are resolved by name.
    this.finalizeReexports();

    const sites: RegisterSite[] = [];
    for (const sf of this.sourceFiles) {
      this.visitCalls(sf, (call) => {
        if (!ts.isPropertyAccessExpression(call.expression)) return;
        if (call.expression.name.text !== "register") return;
        sites.push({ call, sourceFile: sf });
      });
    }

    const applied = new Map<ts.CallExpression, Set<RawRouter>>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const site of sites) {
        const callee = site.call.expression;
        if (!ts.isPropertyAccessExpression(callee)) continue;
        const parents = this.fastifyParents(callee.expression);
        const done = applied.get(site.call) ?? new Set<RawRouter>();
        for (const parent of parents) {
          if (parent.framework !== "fastify" || done.has(parent)) continue;
          this.bindPlugin(parent, site);
          done.add(parent);
          applied.set(site.call, done);
          progress = true;
        }
      }
    }
  }

  private bindPlugin(parent: RawRouter, site: RegisterSite): void {
    const args = site.call.arguments;
    if (args.length === 0) return;
    const fn = this.asSignature(args[0]);
    if (!fn || fn.parameters.length === 0) return;
    const param = fn.parameters[0];
    if (!ts.isIdentifier(param.name)) return;
    const symbol = this.checker.getSymbolAtLocation(param.name);
    if (!symbol) return;

    const prefix = this.fastifyPrefix(args[1]);
    let child = parent;
    if (prefix !== "/") {
      const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : prefix;
      child = this.createRouter(
        { framework: "fastify", role: "router", basePath: "/" },
        name,
        fn.name ?? param.name,
        site.sourceFile,
      );
      child.location = this.locationOf(fn.name ?? fn, site.sourceFile);
      child.filePath = fn.getSourceFile().fileName;
      parent.mounts.push({
        prefix,
        child,
        location: this.locationOf(site.call, site.sourceFile),
      });
    }

    const canonical = this.canonical(symbol);
    const list = this.paramBindings.get(canonical) ?? [];
    if (!list.includes(child)) list.push(child);
    this.paramBindings.set(canonical, list);
  }

  private fastifyParents(expr: ts.Expression): RawRouter[] {
    const symbol = this.symbolOf(expr);
    if (symbol) {
      const bound = this.paramBindings.get(this.canonical(symbol));
      if (bound && bound.length > 0) return bound;
    }
    const router = this.resolveRouter(expr);
    return router ? [router] : [];
  }

  private fastifyPrefix(opts: ts.Expression | undefined): string {
    if (!opts) return "/";
    const unwrapped = this.unwrap(opts);
    if (!ts.isObjectLiteralExpression(unwrapped)) return "/";
    const value = this.propertyValue(unwrapped, "prefix");
    const resolved = value ? this.resolveString(value) : undefined;
    return typeof resolved === "string" ? normalizePath(resolved) : "/";
  }

  // --- pass 4: routes and mounts ---------------------------------------------

  private collectHttp(sf: ts.SourceFile): void {
    this.visitCalls(sf, (call) => {
      if (!ts.isPropertyAccessExpression(call.expression)) return;
      const methodName = call.expression.name.text;
      const lower = methodName.toLowerCase();
      const receiver = call.expression.expression;

      if (lower === "use") {
        this.collectExpressUse(call, receiver, sf);
        return;
      }
      if (methodName === "route") {
        this.collectRouteCall(call, receiver, sf);
        return;
      }
      if (methodName === "on") {
        this.collectHonoOn(call, receiver, sf);
        return;
      }
      if (methodName === "openapi") {
        this.collectHonoOpenApi(call, receiver, sf);
        return;
      }
      if (!HTTP_METHODS.has(lower)) return;

      const chainPath = this.expressChainPath(receiver);
      const targets = this.routeTargets(receiver, chainPath);
      if (targets.length === 0) return;
      const split = this.splitPathAndHandlers([...call.arguments], chainPath);
      if (!split) return;
      const handler = this.handlerFrom(split.handlers);
      for (const target of targets) {
        for (const routePath of split.paths) {
          target.routes.push({
            method: lower.toUpperCase() as HttpMethod,
            path: this.frameworkPath(target.framework, routePath),
            functionName: handler.name,
            docstring: handler.docstring,
            location: this.locationOf(call.expression.name, sf),
          });
        }
      }
    });
  }

  private routeTargets(receiver: ts.Expression, chainPath: string | undefined): RawRouter[] {
    if (chainPath !== undefined) {
      const routeCall = this.findRouteCall(receiver);
      if (routeCall && ts.isPropertyAccessExpression(routeCall.expression)) {
        const router = this.resolveRouter(routeCall.expression.expression);
        return router ? [router] : [];
      }
    }
    const symbol = this.symbolOf(receiver);
    if (symbol) {
      const bound = this.paramBindings.get(this.canonical(symbol));
      if (bound && bound.length > 0) return bound;
    }
    const router = this.resolveRouter(receiver);
    return router ? [router] : [];
  }

  private collectExpressUse(call: ts.CallExpression, receiver: ts.Expression, sf: ts.SourceFile): void {
    const router = this.resolveRouter(receiver);
    if (!router || router.framework !== "express") return;
    const args = [...call.arguments];
    let prefixes = ["/"];
    if (args.length > 0 && this.isPathLike(args[0])) {
      const resolved = this.resolveString(args[0]);
      if (typeof resolved === "string") prefixes = [resolved];
      else if (Array.isArray(resolved)) prefixes = resolved;
      args.shift();
    }
    for (const arg of args) {
      const child = this.resolveRouter(arg);
      if (!child || child === router) continue;
      for (const prefix of prefixes) {
        router.mounts.push({
          prefix,
          child,
          location: this.locationOf(call, sf),
        });
      }
    }
  }

  private collectRouteCall(call: ts.CallExpression, receiver: ts.Expression, sf: ts.SourceFile): void {
    const targets = this.routeTargets(receiver, undefined);
    const arg = call.arguments[0];
    if (!arg) return;

    for (const target of targets) {
      if (target.framework === "hono") {
        const prefix = this.resolveString(arg);
        const child = call.arguments[1] ? this.resolveRouter(call.arguments[1]) : undefined;
        if (typeof prefix === "string" && child && child !== target) {
          target.mounts.push({
            prefix: this.frameworkPath(target.framework, prefix),
            child,
            location: this.locationOf(call, sf),
          });
        }
        continue;
      }
      if (target.framework === "fastify" && ts.isObjectLiteralExpression(this.unwrap(arg))) {
        this.collectFastifyRouteObject(target, this.unwrap(arg) as ts.ObjectLiteralExpression, sf, call);
      }
    }
  }

  private collectFastifyRouteObject(
    router: RawRouter,
    obj: ts.ObjectLiteralExpression,
    sf: ts.SourceFile,
    call: ts.CallExpression,
  ): void {
    const methodValue = this.propertyValue(obj, "method");
    const urlValue = this.propertyValue(obj, "url") ?? this.propertyValue(obj, "path");
    const handlerValue = this.propertyValue(obj, "handler");
    if (!methodValue || !urlValue) return;
    const methods = this.asMethodList(this.resolveString(methodValue));
    const urls = this.asStringList(this.resolveString(urlValue));
    if (!methods || !urls) return;
    const handler = handlerValue
      ? this.handlerFrom([handlerValue])
      : { name: "(anonymous)", docstring: undefined };
    for (const method of methods) {
      for (const url of urls) {
        router.routes.push({
          method,
          path: url,
          functionName: handler.name,
          docstring: handler.docstring,
          location: this.locationOf(call, sf),
        });
      }
    }
  }

  private collectHonoOn(call: ts.CallExpression, receiver: ts.Expression, sf: ts.SourceFile): void {
    const router = this.resolveRouter(receiver);
    if (!router || router.framework !== "hono") return;
    const methods = this.asMethodList(this.resolveString(call.arguments[0]));
    const paths = this.asStringList(this.resolveString(call.arguments[1]));
    if (!methods || !paths) return;
    const handler = this.handlerFrom(call.arguments.slice(2));
    for (const method of methods) {
      for (const routePath of paths) {
        router.routes.push({
          method,
          path: this.frameworkPath(router.framework, routePath),
          functionName: handler.name,
          docstring: handler.docstring,
          location: this.locationOf(call, sf),
        });
      }
    }
  }

  /**
   * `@hono/zod-openapi`: `app.openapi(createRoute({ method, path }), handler)`.
   * The route object may be inline, a local const, or an import.
   */
  private collectHonoOpenApi(call: ts.CallExpression, receiver: ts.Expression, sf: ts.SourceFile): void {
    const router = this.resolveRouter(receiver);
    if (!router || router.framework !== "hono") return;
    const spec = call.arguments[0] ? this.readOpenApiRoute(call.arguments[0]) : undefined;
    if (!spec) return;
    const handler = this.handlerFrom(call.arguments.slice(1));
    for (const method of spec.methods) {
      for (const routePath of spec.paths) {
        router.routes.push({
          method,
          path: this.frameworkPath("hono", routePath),
          functionName: handler.name,
          docstring: handler.docstring,
          location: this.locationOf(
            ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call,
            sf,
          ),
        });
      }
    }
  }

  private readOpenApiRoute(
    expr: ts.Expression,
    seen: Set<ts.Node> = new Set(),
  ): { methods: HttpMethod[]; paths: string[] } | undefined {
    const node = this.unwrap(expr);
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const fromArg = this.readOpenApiRoute(node.arguments[0], seen);
      if (fromArg) return fromArg;
    }
    if (ts.isIdentifier(node)) {
      const resolved = this.resolveValueExpression(node);
      if (resolved && resolved !== node) return this.readOpenApiRoute(resolved, seen);
    }
    if (!ts.isObjectLiteralExpression(node)) return undefined;
    const methodValue = this.propertyValue(node, "method");
    const pathValue = this.propertyValue(node, "path");
    if (!methodValue || !pathValue) return undefined;
    const methods = this.asMethodList(this.resolveString(methodValue));
    const paths = this.asStringList(this.resolveString(pathValue));
    if (!methods || !paths) return undefined;
    return { methods, paths };
  }

  /** Follow a binding or re-export to the expression that created it. */
  private resolveValueExpression(expr: ts.Expression, seen: Set<string> = new Set()): ts.Expression | undefined {
    const node = this.unwrap(expr);
    if (!ts.isIdentifier(node)) return node;
    const symbol = this.checker.getSymbolAtLocation(node);
    const key = `${node.getSourceFile().fileName}:${node.pos}:${node.text}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (symbol) {
      const info = this.directImport(symbol);
      const declForImport = symbol.declarations?.[0];
      if (info && declForImport) {
        const target = this.resolveModule(declForImport.getSourceFile().fileName, info.specifier);
        if (target) {
          const exported = this.findExportedExpression(target, info.exportName, seen);
          if (exported) return this.resolveValueExpression(exported, seen) ?? exported;
        }
      }
      const canonical = this.canonical(symbol);
      const decl = canonical.valueDeclaration ?? canonical.declarations?.[0];
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        return this.resolveValueExpression(decl.initializer, seen) ?? this.unwrap(decl.initializer);
      }
      if (decl && ts.isExportAssignment(decl)) {
        return this.resolveValueExpression(decl.expression, seen) ?? this.unwrap(decl.expression);
      }
    }
    return undefined;
  }

  private findExportedExpression(
    sf: ts.SourceFile,
    name: string,
    seen: Set<string>,
  ): ts.Expression | undefined {
    const visitKey = `export:${this.fileKey(sf)}:${name}`;
    if (seen.has(visitKey)) return undefined;
    seen.add(visitKey);
    for (const statement of sf.statements) {
      if (name === "default" && ts.isExportAssignment(statement)) return statement.expression;
      if (ts.isVariableStatement(statement) && this.hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
            return declaration.initializer;
          }
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== name) continue;
          const local = (element.propertyName ?? element.name).text;
          if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            const target = this.resolveModule(sf.fileName, statement.moduleSpecifier.text);
            if (!target) return undefined;
            return this.findExportedExpression(target, local, seen);
          }
          return this.findLocalInitializer(sf, local);
        }
      }
    }
    return undefined;
  }

  private findLocalInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
    for (const statement of sf.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
      }
    }
    return undefined;
  }

  private frameworkPath(framework: Framework, value: string): string {
    return framework === "hono" ? toHonoPath(value) : value;
  }

  // --- pass 5: NestJS --------------------------------------------------------

  private collectNest(): AppDefinition | undefined {
    let globalPrefix = "/";
    let globalScore = -1;
    let bootstrap: { name: string; location: SourceLocation; filePath: string } | undefined;

    for (const sf of this.sourceFiles) {
      this.visitCalls(sf, (call) => {
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "setGlobalPrefix") {
          const value = this.resolveString(call.arguments[0]);
          if (typeof value === "string") {
            const score = this.nestFileScore(sf.fileName);
            if (score > globalScore) {
              globalScore = score;
              globalPrefix = normalizePath(value);
            }
          }
        }
        if (this.isNestFactoryCreate(call.expression)) {
          const name = this.assignedName(call) ?? "app";
          bootstrap = {
            name,
            location: this.locationOf(call, sf),
            filePath: sf.fileName,
          };
        }
      });
    }

    const controllers: RawRouter[] = [];
    for (const sf of this.sourceFiles) {
      const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node) && node.name) {
          const controller = this.readController(node, sf, globalPrefix);
          if (controller) controllers.push(...controller);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    if (controllers.length === 0) return undefined;

    const anchor = bootstrap ?? {
      name: "app",
      location: controllers[0].location,
      filePath: controllers[0].filePath,
    };
    const appRouter = this.createRouter(
      { framework: "nest", role: "app", basePath: "/" },
      anchor.name,
      undefined,
      this.sourceFiles[0],
    );
    appRouter.location = anchor.location;
    appRouter.filePath = anchor.filePath;
    for (const controller of controllers) {
      const prefix = controller.basePath;
      controller.basePath = "/";
      appRouter.mounts.push({ prefix, child: controller, location: controller.location });
    }
    return this.emitApp(appRouter);
  }

  private readController(
    node: ts.ClassDeclaration,
    sf: ts.SourceFile,
    globalPrefix: string,
  ): RawRouter[] | undefined {
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
    const controllerDec = decorators.find((dec) => this.decoratorExport(dec) === "Controller");
    if (!controllerDec) return undefined;
    const { args } = this.decoratorCall(controllerDec);
    const meta = this.controllerMeta(args);
    const className = node.name?.text ?? "Controller";
    const routers: RawRouter[] = [];
    for (const controllerPath of meta.paths) {
      const prefix = this.nestPrefix(globalPrefix, meta.version, controllerPath);
      const router = this.createRouter(
        { framework: "nest", role: "router", basePath: prefix },
        className,
        node.name,
        sf,
      );
      router.location = this.locationOf(node.name ?? node, sf);
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) && !ts.isPropertyDeclaration(member)) continue;
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        const memberDecorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : [];
        for (const dec of memberDecorators) {
          const exportName = this.decoratorExport(dec);
          if (!exportName) continue;
          const httpMethod = NEST_METHODS[exportName];
          if (!httpMethod) continue;
          const { args: methodArgs } = this.decoratorCall(dec);
          for (const methodPath of this.methodPaths(methodArgs)) {
            router.routes.push({
              method: httpMethod,
              path: methodPath,
              functionName: member.name.text,
              docstring: this.leadingDoc(member),
              location: this.locationOf(dec, sf),
            });
          }
        }
      }
      if (router.routes.length > 0) routers.push(router);
    }
    return routers;
  }

  private nestPrefix(globalPrefix: string, version: string | undefined, controllerPath: string): string {
    let prefix = normalizePath(globalPrefix || "/");
    if (version) prefix = joinPaths(prefix, `v${version.replace(/^v/i, "")}`);
    return joinPaths(prefix, controllerPath || "/");
  }

  private controllerMeta(args: ts.Expression[]): { paths: string[]; version?: string } {
    if (args.length === 0) return { paths: ["/"] };
    const first = this.unwrap(args[0]);
    const resolved = this.resolveString(first);
    if (typeof resolved === "string") return { paths: [resolved] };
    if (Array.isArray(resolved)) return { paths: resolved };
    if (ts.isObjectLiteralExpression(first)) {
      const pathValue = this.propertyValue(first, "path");
      const versionValue = this.propertyValue(first, "version");
      const paths = pathValue ? this.asStringList(this.resolveString(pathValue)) ?? ["/"] : ["/"];
      const versionResolved = versionValue ? this.resolveString(versionValue) : undefined;
      const version = typeof versionResolved === "string"
        ? versionResolved
        : Array.isArray(versionResolved)
          ? versionResolved[0]
          : undefined;
      return { paths, version };
    }
    return { paths: ["/"] };
  }

  private methodPaths(args: ts.Expression[]): string[] {
    if (args.length === 0) return ["/"];
    const first = this.unwrap(args[0]);
    if (ts.isObjectLiteralExpression(first)) {
      const pathValue = this.propertyValue(first, "path");
      if (!pathValue) return ["/"];
      return this.asStringList(this.resolveString(pathValue)) ?? ["/"];
    }
    return this.asStringList(this.resolveString(first)) ?? ["/"];
  }

  private nestFileScore(fileName: string): number {
    const base = path.basename(fileName);
    if (base === "main.ts" || base === "main.js") return 3;
    if (base === "server.ts" || base === "server.js") return 2;
    if (base === "index.ts" || base === "index.js") return 1;
    return 0;
  }

  private isNestFactoryCreate(expr: ts.Expression): boolean {
    if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== "create") return false;
    const ref = this.moduleRef(expr.expression);
    return !!ref && this.packageName(ref.specifier) === "@nestjs/core" && (ref.exportName === "NestFactory" || ref.exportName === "*");
  }

  // --- constructions ---------------------------------------------------------

  private classifyCreation(expr: ts.Expression): Classification | undefined {
    const node = this.unwrap(expr);
    if (ts.isNewExpression(node)) {
      if (this.isHonoRef(node.expression)) {
        return { framework: "hono", role: "app", basePath: "/" };
      }
      return undefined;
    }
    if (!ts.isCallExpression(node)) return undefined;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const prop = callee.name.text;
      if (prop === "Router" && this.isExpressModule(callee.expression)) {
        return { framework: "express", role: "router", basePath: "/" };
      }
      if (prop === "basePath") {
        const parent = this.classifyCreation(callee.expression);
        const parentIsHono =
          parent?.framework === "hono" ||
          this.resolveRouter(callee.expression)?.framework === "hono" ||
          this.isHonoRef(callee.expression);
        if (parentIsHono) {
          const base = this.resolveString(node.arguments[0]);
          const parentBase = parent?.basePath ?? this.resolveRouter(callee.expression)?.basePath ?? "/";
          return {
            framework: "hono",
            role: "app",
            basePath: joinPaths(parentBase, typeof base === "string" ? base : "/"),
          };
        }
      }
      return undefined;
    }
    if (this.isExpressFactory(callee)) return { framework: "express", role: "app", basePath: "/" };
    if (this.isExpressRouterFn(callee)) return { framework: "express", role: "router", basePath: "/" };
    if (this.isHonoRef(callee)) return { framework: "hono", role: "app", basePath: "/" };
    if (this.isFastifyRef(callee)) return { framework: "fastify", role: "app", basePath: "/" };
    return undefined;
  }

  private createRouter(
    classification: Classification,
    name: string,
    nameNode: ts.Node | undefined,
    sf: ts.SourceFile,
    init?: ts.Expression,
  ): RawRouter {
    if (init) {
      const existing = this.routersByNode.get(this.unwrap(init));
      if (existing) return existing;
    }
    const anchor = nameNode ?? init ?? sf;
    const router: RawRouter = {
      name,
      framework: classification.framework,
      role: classification.role,
      basePath: classification.basePath,
      location: this.locationOf(anchor, anchor.getSourceFile()),
      filePath: (nameNode ?? init)?.getSourceFile().fileName ?? sf.fileName,
      routes: [],
      mounts: [],
    };
    this.allRouters.push(router);
    if (init) this.routersByNode.set(this.unwrap(init), router);
    return router;
  }

  // --- resolving values ------------------------------------------------------

  private resolveRouter(expr: ts.Expression, seen: Set<ts.Symbol> = new Set()): RawRouter | undefined {
    const node = this.unwrap(expr);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const symbol = this.symbolOf(node);
      if (symbol) {
        if (seen.has(symbol)) return undefined;
        seen.add(symbol);
        const canonical = this.canonical(symbol);
        const known = this.routersBySymbol.get(canonical);
        if (known) return known;
        const imported = this.routerFromImport(symbol);
        if (imported) return imported;
        const decl = canonical.valueDeclaration ?? canonical.declarations?.[0];
        if (decl && ts.isExportAssignment(decl)) return this.resolveRouter(decl.expression, seen);
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
          return this.resolveRouter(decl.initializer, seen);
        }
      }
      if (ts.isCallExpression(node) || ts.isIdentifier(node)) {
        const required = this.routerFromRequire(node);
        if (required) return required;
      }
      return undefined;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const cached = this.routersByNode.get(node);
      if (cached) return cached;
      if (ts.isCallExpression(node)) {
        const required = this.routerFromRequire(node);
        if (required) return required;
        if (ts.isPropertyAccessExpression(node.expression)) {
          const prop = node.expression.name.text.toLowerCase();
          // Chained `app.get().post()` and `app.openapi()` return the same app.
          // `basePath()` is not included: that call is itself a new Hono with a prefix.
          if (
            prop !== "route" &&
            (HTTP_METHODS.has(prop) || prop === "use" || prop === "on" || prop === "register" || prop === "openapi")
          ) {
            return this.resolveRouter(node.expression.expression, seen);
          }
          if (prop === "route") {
            const inner = this.resolveRouter(node.expression.expression, seen);
            if (inner?.framework === "hono") return inner;
          }
        }
      }
      const classification = this.classifyCreation(node);
      if (!classification) return undefined;
      const name = classification.role === "app" ? "app" : "router";
      return this.createRouter(classification, name, undefined, node.getSourceFile(), node);
    }
    return undefined;
  }

  private routerFromImport(symbol: ts.Symbol): RawRouter | undefined {
    const info = this.directImport(symbol);
    if (!info) return undefined;
    const decl = symbol.declarations?.[0];
    if (!decl) return undefined;
    const target = this.resolveModule(decl.getSourceFile().fileName, info.specifier);
    if (!target) return undefined;
    if (info.exportName === "default" || info.exportName === "*") {
      return (
        this.defaultRouters.get(this.fileKey(target)) ??
        this.cjsDefaultRouters.get(this.fileKey(target)) ??
        this.namedRouters.get(this.exportKey(target, "default"))
      );
    }
    return this.namedRouters.get(this.exportKey(target, info.exportName));
  }

  private routerFromRequire(expr: ts.Expression): RawRouter | undefined {
    const node = this.unwrap(expr);
    let call: ts.CallExpression | undefined;
    if (ts.isCallExpression(node) && this.isRequireCall(node)) call = node;
    if (ts.isIdentifier(node)) {
      const symbol = this.symbolOf(node);
      const decl = symbol ? (this.canonical(symbol).valueDeclaration ?? symbol.declarations?.[0]) : undefined;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && this.isRequireCall(this.unwrap(decl.initializer))) {
        call = this.unwrap(decl.initializer) as ts.CallExpression;
      }
    }
    if (!call || !ts.isStringLiteral(call.arguments[0])) return undefined;
    const spec = call.arguments[0].text;
    if (!spec.startsWith(".")) return undefined;
    const target = this.resolveModule(call.getSourceFile().fileName, spec);
    if (!target) return undefined;
    return this.cjsDefaultRouters.get(this.fileKey(target)) ?? this.defaultRouters.get(this.fileKey(target));
  }

  // --- framework recognition -------------------------------------------------

  private isExpressFactory(expr: ts.Expression): boolean {
    const ref = this.moduleRef(expr);
    if (!ref || this.packageName(ref.specifier) !== "express") return false;
    return ref.exportName === "default" || ref.exportName === "*" || ref.exportName === "express";
  }

  private isExpressRouterFn(expr: ts.Expression): boolean {
    const ref = this.moduleRef(expr);
    if (!ref || this.packageName(ref.specifier) !== "express") return false;
    return ref.exportName === "Router";
  }

  private isExpressModule(expr: ts.Expression): boolean {
    const ref = this.moduleRef(expr);
    if (!ref || this.packageName(ref.specifier) !== "express") return false;
    return ref.exportName === "default" || ref.exportName === "*" || ref.exportName === "express";
  }

  private isHonoRef(expr: ts.Expression): boolean {
    const ref = this.moduleRef(expr);
    if (!ref) return false;
    const pkg = this.packageName(ref.specifier);
    if ((pkg === "hono" || ref.specifier.startsWith("hono/")) && (ref.exportName === "Hono" || ref.exportName === "default")) {
      return true;
    }
    // `@hono/zod-openapi` apps are Hono instances with an extra `openapi()` registrar.
    return pkg === "@hono/zod-openapi" && (ref.exportName === "OpenAPIHono" || ref.exportName === "Hono");
  }

  private isFastifyRef(expr: ts.Expression): boolean {
    const ref = this.moduleRef(expr);
    if (!ref || this.packageName(ref.specifier) !== "fastify") return false;
    return ref.exportName === "default" || ref.exportName === "*" || ref.exportName === "fastify" || ref.exportName === "Fastify";
  }

  private moduleRef(expr: ts.Expression): ModuleRef | undefined {
    const node = this.unwrap(expr);
    if (ts.isIdentifier(node)) return this.importInfoOfIdentifier(node);
    if (ts.isPropertyAccessExpression(node)) {
      const object = this.moduleRef(node.expression);
      if (!object) return undefined;
      if (object.exportName === "*" || object.exportName === "default") {
        return { specifier: object.specifier, exportName: node.name.text };
      }
    }
    if (ts.isCallExpression(node) && this.isRequireCall(node) && ts.isStringLiteral(node.arguments[0])) {
      return { specifier: node.arguments[0].text, exportName: "default" };
    }
    return undefined;
  }

  private importInfoOfIdentifier(expr: ts.Identifier): ModuleRef | undefined {
    const symbol = this.checker.getSymbolAtLocation(expr);
    if (!symbol) return undefined;
    const direct = this.directImport(symbol);
    if (direct) return direct;
    const canonical = this.canonical(symbol);
    const decl = canonical.valueDeclaration ?? canonical.declarations?.[0];
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && this.isRequireCall(this.unwrap(decl.initializer))) {
      const call = this.unwrap(decl.initializer) as ts.CallExpression;
      if (ts.isStringLiteral(call.arguments[0])) {
        return { specifier: call.arguments[0].text, exportName: "default" };
      }
    }
    if (decl && ts.isBindingElement(decl) && ts.isIdentifier(decl.name)) {
      const pattern = decl.parent;
      const variable = pattern.parent;
      if (
        ts.isVariableDeclaration(variable) &&
        variable.initializer &&
        this.isRequireCall(this.unwrap(variable.initializer))
      ) {
        const call = this.unwrap(variable.initializer) as ts.CallExpression;
        if (ts.isStringLiteral(call.arguments[0])) {
          const exported =
            decl.propertyName && ts.isIdentifier(decl.propertyName) ? decl.propertyName.text : decl.name.text;
          return { specifier: call.arguments[0].text, exportName: exported };
        }
      }
    }
    return undefined;
  }

  private directImport(symbol: ts.Symbol): ModuleRef | undefined {
    for (const decl of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(decl)) {
        const statement = this.findImportDeclaration(decl);
        if (!statement || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        return {
          specifier: statement.moduleSpecifier.text,
          exportName: (decl.propertyName ?? decl.name).text,
        };
      }
      if (ts.isImportClause(decl) && decl.name) {
        const statement = decl.parent;
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        return { specifier: statement.moduleSpecifier.text, exportName: "default" };
      }
      if (ts.isNamespaceImport(decl)) {
        const clause = decl.parent;
        const statement = clause.parent;
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        return { specifier: statement.moduleSpecifier.text, exportName: "*" };
      }
      if (ts.isImportEqualsDeclaration(decl) && ts.isExternalModuleReference(decl.moduleReference)) {
        const expression = decl.moduleReference.expression;
        if (ts.isStringLiteral(expression)) return { specifier: expression.text, exportName: "default" };
      }
    }
    return undefined;
  }

  // --- strings, handlers, signatures -----------------------------------------

  private resolveString(
    expr: ts.Expression | undefined,
    seen: Set<ts.Symbol> = new Set(),
  ): string | string[] | undefined {
    if (!expr) return undefined;
    const node = this.unwrap(expr);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = this.resolveString(span.expression, seen);
        if (typeof part !== "string") return undefined;
        value += part + span.literal.text;
      }
      return value;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values: string[] = [];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) return undefined;
        const part = this.resolveString(element, seen);
        if (typeof part === "string") values.push(part);
        else if (Array.isArray(part)) values.push(...part);
        else return undefined;
      }
      return values;
    }
    if (ts.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      if (!symbol || seen.has(symbol)) return undefined;
      seen.add(symbol);
      const canonical = this.canonical(symbol);
      const decl = canonical.valueDeclaration ?? canonical.declarations?.[0];
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        return this.resolveString(decl.initializer, seen);
      }
    }
    return undefined;
  }

  private isPathLike(expr: ts.Expression): boolean {
    const value = this.resolveString(expr);
    return typeof value === "string" || Array.isArray(value);
  }

  private splitPathAndHandlers(
    args: ts.Expression[],
    chainPath: string | undefined,
  ): { paths: string[]; handlers: ts.Expression[] } | undefined {
    if (args.length > 0 && this.isPathLike(args[0])) {
      const value = this.resolveString(args[0]);
      const paths = Array.isArray(value) ? value : typeof value === "string" ? [value] : undefined;
      if (!paths) return undefined;
      return { paths, handlers: args.slice(1) };
    }
    if (chainPath !== undefined) return { paths: [chainPath], handlers: args };
    return undefined;
  }

  private handlerFrom(args: readonly ts.Expression[]): { name: string; docstring?: string } {
    if (args.length === 0) return { name: "(anonymous)" };
    let last: ts.Expression = args[args.length - 1];
    last = this.unwrap(last);
    if (ts.isArrayLiteralExpression(last) && last.elements.length > 0) {
      const element = last.elements[last.elements.length - 1];
      if (!ts.isSpreadElement(element)) last = this.unwrap(element);
    }
    return { name: this.expressionName(last), docstring: this.docOf(last) };
  }

  private expressionName(expr: ts.Expression): string {
    const node = this.unwrap(expr);
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return `${node.expression.getText()}.${node.name.text}`;
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name) return node.name.text;
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const inner = this.expressionName(node.arguments[node.arguments.length - 1]);
      if (inner !== "(anonymous)") return inner;
    }
    return "(anonymous)";
  }

  private asSignature(expr: ts.Expression | undefined, seen: Set<ts.Symbol> = new Set()): ts.SignatureDeclaration | undefined {
    if (!expr) return undefined;
    const node = this.unwrap(expr);
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node)) {
      return node;
    }
    if (ts.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      if (symbol && !seen.has(symbol)) {
        seen.add(symbol);
        const canonical = this.canonical(symbol);
        const decl = canonical.valueDeclaration ?? canonical.declarations?.[0];
        if (
          decl &&
          (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl) || ts.isMethodDeclaration(decl))
        ) {
          return decl;
        }
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
          const fromInit = this.asSignature(decl.initializer, seen);
          if (fromInit) return fromInit;
        }
        if (decl && ts.isExportAssignment(decl)) {
          const fromExport = this.asSignature(decl.expression, seen);
          if (fromExport) return fromExport;
        }
      }
      const imported = symbol ? this.functionFromImport(symbol) : undefined;
      if (imported) return imported;
    }
    if (ts.isCallExpression(node) && this.isRequireCall(node) && ts.isStringLiteral(node.arguments[0])) {
      const target = this.resolveModule(node.getSourceFile().fileName, node.arguments[0].text);
      if (target) return this.cjsDefaultFunctions.get(this.fileKey(target)) ?? this.defaultFunctions.get(this.fileKey(target));
    }
    return undefined;
  }

  private functionFromImport(symbol: ts.Symbol): ts.SignatureDeclaration | undefined {
    const info = this.directImport(symbol);
    if (!info) return undefined;
    const decl = symbol.declarations?.[0];
    if (!decl) return undefined;
    const target = this.resolveModule(decl.getSourceFile().fileName, info.specifier);
    if (!target) return undefined;
    if (info.exportName === "default") {
      return this.defaultFunctions.get(this.fileKey(target)) ?? this.cjsDefaultFunctions.get(this.fileKey(target));
    }
    return this.namedFunctions.get(this.exportKey(target, info.exportName));
  }

  private asMethodList(value: string | string[] | undefined): HttpMethod[] | undefined {
    if (value == null) return undefined;
    const list = Array.isArray(value) ? value : [value];
    const methods: HttpMethod[] = [];
    for (const entry of list) {
      const upper = entry.toUpperCase();
      if (HTTP_METHODS.has(upper.toLowerCase())) methods.push(upper as HttpMethod);
    }
    return methods.length > 0 ? methods : undefined;
  }

  private asStringList(value: string | string[] | undefined): string[] | undefined {
    if (typeof value === "string") return [value];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
    return undefined;
  }

  // --- tree emission ---------------------------------------------------------

  private emitApp(raw: RawRouter): AppDefinition {
    const seen = new Set<RawRouter>([raw]);
    const base = raw.basePath && raw.basePath !== "/" ? raw.basePath : "/";
    return {
      name: raw.name,
      framework: raw.framework,
      filePath: raw.filePath,
      location: raw.location,
      routes: raw.routes.map((route) => this.toRoute(route, base, raw.framework)),
      routers: raw.mounts.map((mount) => this.emitRouter(mount.child, joinPaths(base, mount.prefix), seen)),
    };
  }

  private emitRouter(raw: RawRouter, prefix: string, seen: Set<RawRouter>): RouterDefinition {
    const fullPrefix = joinPaths(prefix, raw.basePath);
    if (seen.has(raw)) {
      return {
        name: raw.name,
        prefix: fullPrefix,
        framework: raw.framework,
        location: raw.location,
        routes: [],
        children: [],
      };
    }
    seen.add(raw);
    const node: RouterDefinition = {
      name: raw.name,
      prefix: fullPrefix,
      framework: raw.framework,
      location: raw.location,
      routes: raw.routes.map((route) => this.toRoute(route, fullPrefix, raw.framework)),
      children: raw.mounts.map((mount) =>
        this.emitRouter(mount.child, joinPaths(fullPrefix, mount.prefix), seen),
      ),
    };
    seen.delete(raw);
    return node;
  }

  private toRoute(route: RawRoute, prefix: string, framework: Framework): RouteDefinition {
    return {
      method: route.method,
      path: joinPaths(prefix, route.path),
      functionName: route.functionName,
      framework,
      location: route.location,
      docstring: route.docstring,
    };
  }

  // --- AST helpers -----------------------------------------------------------

  private expressChainPath(receiver: ts.Expression): string | undefined {
    const node = this.unwrap(receiver);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
    const name = node.expression.name.text;
    if (name === "route") {
      const value = this.resolveString(node.arguments[0]);
      return typeof value === "string" ? value : "/";
    }
    if (HTTP_METHODS.has(name.toLowerCase())) return this.expressChainPath(node.expression.expression);
    return undefined;
  }

  private findRouteCall(receiver: ts.Expression): ts.CallExpression | undefined {
    const node = this.unwrap(receiver);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
    if (node.expression.name.text === "route") return node;
    if (HTTP_METHODS.has(node.expression.name.text.toLowerCase())) return this.findRouteCall(node.expression.expression);
    return undefined;
  }

  private decoratorExport(dec: ts.Decorator): string | undefined {
    const { expr } = this.decoratorCall(dec);
    const ref = this.moduleRef(expr);
    if (!ref || this.packageName(ref.specifier) !== "@nestjs/common") return undefined;
    return ref.exportName;
  }

  private decoratorCall(dec: ts.Decorator): { expr: ts.Expression; args: ts.Expression[] } {
    const expression = dec.expression;
    if (ts.isCallExpression(expression)) return { expr: expression.expression, args: [...expression.arguments] };
    return { expr: expression, args: [] };
  }

  private propertyValue(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    for (const property of obj.properties) {
      if (ts.isPropertyAssignment(property) && this.propertyNameText(property.name) === name) {
        return property.initializer;
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
    }
    return undefined;
  }

  private propertyNameText(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return undefined;
  }

  private assignedName(call: ts.CallExpression): string | undefined {
    const awaited = ts.isAwaitExpression(call.parent) ? call.parent : call;
    if (ts.isVariableDeclaration(awaited.parent) && ts.isIdentifier(awaited.parent.name)) {
      return awaited.parent.name.text;
    }
    return undefined;
  }

  private unwrap(expr: ts.Expression): ts.Expression {
    let current = expr;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  private symbolOf(expr: ts.Expression): ts.Symbol | undefined {
    const node = this.unwrap(expr);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      return this.checker.getSymbolAtLocation(node);
    }
    return undefined;
  }

  private canonical(symbol: ts.Symbol): ts.Symbol {
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    while (current.flags & ts.SymbolFlags.Alias) {
      if (seen.has(current)) break;
      seen.add(current);
      const next = this.checker.getAliasedSymbol(current);
      if (!next || next === current) break;
      if (!next.declarations?.length) break;
      current = next;
    }
    return current;
  }

  private isRequireCall(expr: ts.Expression): expr is ts.CallExpression {
    return (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "require" &&
      expr.arguments.length >= 1 &&
      ts.isStringLiteral(expr.arguments[0])
    );
  }

  private isModuleExports(expr: ts.Expression): boolean {
    return (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === "exports" &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "module"
    );
  }

  private isVariableExported(node: ts.VariableDeclaration): boolean {
    const list = node.parent;
    const statement = list?.parent;
    if (!statement || !ts.isVariableStatement(statement)) return false;
    return this.hasModifier(statement, ts.SyntaxKind.ExportKeyword);
  }

  private hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!modifiers?.some((modifier) => modifier.kind === kind);
  }

  private findImportDeclaration(node: ts.Node): ts.ImportDeclaration | undefined {
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isImportDeclaration(current)) return current;
      current = current.parent;
    }
    return undefined;
  }

  private packageName(specifier: string): string {
    if (specifier.startsWith("@")) {
      const [scope, name] = specifier.split("/");
      return name ? `${scope}/${name}` : specifier;
    }
    return specifier.split("/")[0];
  }

  private resolveModule(fromFile: string, specifier: string): ts.SourceFile | undefined {
    if (specifier.startsWith(".")) {
      return this.lookupSource(path.resolve(path.dirname(fromFile), specifier));
    }
    const fromPaths = this.resolveTsconfigPath(fromFile, specifier);
    if (fromPaths) return fromPaths;
    return this.resolvePackageImport(specifier);
  }

  private lookupSource(base: string): ts.SourceFile | undefined {
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}.mjs`,
      `${base}.cjs`,
      `${base}.mts`,
      `${base}.cts`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
      path.join(base, "index.js"),
      path.join(base, "index.mjs"),
      path.join(base, "index.cjs"),
    ];
    if (base.endsWith(".js")) candidates.push(base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx");
    if (base.endsWith(".mjs")) candidates.push(base.slice(0, -4) + ".mts");
    if (base.endsWith(".cjs")) candidates.push(base.slice(0, -4) + ".cts");
    for (const candidate of candidates) {
      const hit = this.sourceByPath.get(path.normalize(candidate));
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * `paths` in the nearest tsconfig, so `@shop/users` can point at another package.
   * Patterns are matched longest-prefix first.
   */
  private resolveTsconfigPath(fromFile: string, specifier: string): ts.SourceFile | undefined {
    const config = this.tsconfigFor(path.dirname(fromFile));
    if (!config) return undefined;
    for (const pattern of config.patterns) {
      let captured: string | undefined;
      if (pattern.exact) {
        if (specifier === pattern.prefix) captured = "";
      } else if (
        specifier.startsWith(pattern.prefix) &&
        specifier.endsWith(pattern.suffix) &&
        specifier.length >= pattern.prefix.length + pattern.suffix.length
      ) {
        captured = specifier.slice(pattern.prefix.length, specifier.length - pattern.suffix.length);
      }
      if (captured === undefined) continue;
      for (const target of pattern.targets) {
        const replaced = pattern.exact ? target : target.replaceAll("*", captured);
        const hit = this.lookupSource(path.resolve(config.baseUrl, replaced));
        if (hit) return hit;
      }
    }
    return undefined;
  }

  private tsconfigFor(startDir: string): TsConfigInfo | undefined {
    const cached = this.tsconfigByDir.get(startDir);
    if (cached !== undefined || this.tsconfigByDir.has(startDir)) return cached;
    let dir = startDir;
    const seen = new Set<string>();
    while (!seen.has(dir)) {
      seen.add(dir);
      const configPath = path.join(dir, "tsconfig.json");
      if (fs.existsSync(configPath)) {
        const parsed = parseTsConfig(configPath);
        for (const visited of seen) this.tsconfigByDir.set(visited, parsed);
        return parsed;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const visited of seen) this.tsconfigByDir.set(visited, undefined);
    return undefined;
  }

  /** Workspace package name → entry file, including `exports` subpaths. */
  private resolvePackageImport(specifier: string): ts.SourceFile | undefined {
    const packages = this.workspacePackages();
    let best: { name: string; entries: PackageExport[] } | undefined;
    for (const entry of packages) {
      if (specifier !== entry.name && !specifier.startsWith(`${entry.name}/`)) continue;
      if (!best || entry.name.length > best.name.length) best = entry;
    }
    if (!best) return undefined;
    const subpath = specifier === best.name ? "." : `.${specifier.slice(best.name.length)}`;
    for (const item of best.entries) {
      if (!item.key.includes("*")) {
        if (item.key === subpath) {
          const hit = this.lookupSource(item.target);
          if (hit) return hit;
        }
        continue;
      }
      const star = item.key.indexOf("*");
      const prefix = item.key.slice(0, star);
      const suffix = item.key.slice(star + 1);
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
      const hit = this.lookupSource(item.target.replaceAll("*", captured));
      if (hit) return hit;
    }
    return undefined;
  }

  private workspacePackages(): PackageEntry[] {
    if (this.packageEntries) return this.packageEntries;
    const root = commonDirectory(this.sourceFiles.map((sf) => sf.fileName));
    this.packageEntries = collectPackages(root);
    return this.packageEntries;
  }

  private fileKey(sf: ts.SourceFile): string {
    return path.normalize(sf.fileName);
  }

  private exportKey(sf: ts.SourceFile, name: string): string {
    return `${this.fileKey(sf)}::${name}`;
  }

  private locationOf(node: ts.Node, sf: ts.SourceFile): SourceLocation {
    const source = node.getSourceFile() ?? sf;
    const position = source.getLineAndCharacterOfPosition(node.getStart(source, false));
    return { filePath: source.fileName, line: position.line, character: position.character };
  }

  private leadingDoc(node: ts.Node): string | undefined {
    const source = node.getSourceFile();
    const start = node.getStart(source, false);
    const fullStart = node.getFullStart();
    const trivia = source.text.slice(fullStart, start);
    const match = trivia.match(/\/\*\*([\s\S]*?)\*\//);
    if (!match) return undefined;
    const text = match[1]
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("@"))
      .join("\n")
      .trim();
    return text || undefined;
  }

  private docOf(expr: ts.Expression): string | undefined {
    const node = this.unwrap(expr);
    if (ts.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (decl) return this.leadingDoc(decl);
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return this.leadingDoc(node);
    return undefined;
  }

  private visitCalls(sf: ts.SourceFile, fn: (call: ts.CallExpression) => void): void {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) fn(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

interface PathPattern {
  exact: boolean;
  prefix: string;
  suffix: string;
  targets: string[];
}

interface TsConfigInfo {
  baseUrl: string;
  patterns: PathPattern[];
}

interface PackageExport {
  key: string;
  target: string;
}

interface PackageEntry {
  name: string;
  entries: PackageExport[];
}

function parseTsConfig(configPath: string): TsConfigInfo | undefined {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) return undefined;
  const dir = path.dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, configPath);
  const paths = parsed.options.paths ?? {};
  const baseUrl = parsed.options.baseUrl ?? dir;
  const patterns: PathPattern[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!targets || targets.length === 0) continue;
    const star = pattern.indexOf("*");
    patterns.push({
      exact: star === -1,
      prefix: star === -1 ? pattern : pattern.slice(0, star),
      suffix: star === -1 ? "" : pattern.slice(star + 1),
      targets: [...targets],
    });
  }
  patterns.sort((a, b) => b.prefix.length - a.prefix.length);
  return { baseUrl, patterns };
}

function commonDirectory(files: string[]): string {
  if (files.length === 0) return process.cwd();
  let dir = path.dirname(files[0]);
  for (const file of files.slice(1)) {
    while (!file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep) && dir !== path.dirname(dir)) {
      if (file === dir) break;
      dir = path.dirname(dir);
    }
  }
  return dir;
}

function collectPackages(root: string): PackageEntry[] {
  const found: PackageEntry[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === "out" || entry.name === ".git") {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const parsed = readPackageEntry(full);
      if (parsed) found.push(parsed);
    }
  };
  walk(root, 0);
  return found;
}

function readPackageEntry(file: string): PackageEntry | undefined {
  let json: { name?: unknown; main?: unknown; exports?: unknown };
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown; main?: unknown; exports?: unknown };
  } catch {
    return undefined;
  }
  if (typeof json.name !== "string" || json.name.length === 0) return undefined;
  const dir = path.dirname(file);
  const entries: PackageExport[] = [];
  if (typeof json.exports === "string") {
    entries.push({ key: ".", target: path.resolve(dir, json.exports) });
  } else if (json.exports && typeof json.exports === "object" && !Array.isArray(json.exports)) {
    for (const [key, value] of Object.entries(json.exports as Record<string, unknown>)) {
      if (!key.startsWith(".")) continue;
      const target = pickExportTarget(value);
      if (target) entries.push({ key, target: path.resolve(dir, target) });
    }
  }
  if (!entries.some((entry) => entry.key === ".") && typeof json.main === "string") {
    entries.push({ key: ".", target: path.resolve(dir, json.main) });
  }
  if (entries.length === 0) return undefined;
  return { name: json.name, entries };
}

/** Prefer a runnable entry over a `.d.ts` types condition. */
function pickExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["import", "default", "require", "node", "browser"]) {
    const picked = pickExportTarget(record[key]);
    if (picked) return picked;
  }
  return undefined;
}
