/**
 * Static route discovery that does not keep a TypeScript program or any AST.
 *
 * Each file is read as text, rejected unless it looks like a framework (or a
 * re-export barrel a framework file imports), then parsed with
 * `createSourceFile`. The walk copies plain facts and drops the source file
 * before the next file. Linking uses those facts only.
 *
 * Factory calls and re-exports stop on a visited set and a depth cap so a
 * cycle cannot recurse without bound.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_PARSED_FILES,
  MAX_FACTORY_DEPTH,
  MAX_FILE_BYTES,
  MAX_RESOLVE_STEPS,
  SKIP_DIR_NAMES,
  hasSkippedDir,
  looksLikeFrameworkSource,
  looksLikeReexport,
} from "./prefilter";
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

const CHAIN_METHODS = new Set(["use", "on", "register", "openapi"]);

export interface AnalyzeStats {
  candidates: number;
  matched: number;
  parsed: number;
  capped: boolean;
  factoryDepthHits: number;
  prefilterMs: number;
  parseMs: number;
  linkMs: number;
  elapsedMs: number;
}

export interface AnalyzeOptions {
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
  maxFiles?: number;
  batchSize?: number;
  maxFactoryDepth?: number;
  stats?: AnalyzeStats;
}

export function emptyStats(): AnalyzeStats {
  return {
    candidates: 0,
    matched: 0,
    parsed: 0,
    capped: false,
    factoryDepthHits: 0,
    prefilterMs: 0,
    parseMs: 0,
    linkMs: 0,
    elapsedMs: 0,
  };
}

type Value =
  | { t: "str"; v: string }
  | { t: "num"; v: string }
  | { t: "arr"; items: Value[] }
  | { t: "tpl"; parts: Array<{ t: "s"; v: string } | { t: "v"; v: Value }> }
  | { t: "obj"; props: Array<{ name: string; v: Value }> }
  | { t: "ref"; id: string }
  | { t: "param"; fn: string; name: string }
  | { t: "mod"; spec: string; name: string; from: string }
  | { t: "req"; spec: string }
  | { t: "call"; id: string; callee: Value; args: Value[] }
  | { t: "new"; id: string; callee: Value; args: Value[] }
  | { t: "member"; obj: Value; name: string }
  | { t: "fn"; id: string }
  | { t: "unknown" };

interface Binding {
  id: string;
  name: string;
  file: string;
  value: Value;
  loc: SourceLocation;
  doc?: string;
}

interface FnFact {
  id: string;
  name?: string;
  file: string;
  loc: SourceLocation;
  params: string[];
  returns: Value[];
  doc?: string;
  walked: boolean;
}

interface CallRec {
  id: string;
  file: string;
  loc: SourceLocation;
  callee: Value;
  args: Value[];
  assigned?: string;
}

interface ExportRec {
  owner: string;
  name: string;
  bindingId?: string;
  value?: Value;
  fromSpec?: string;
  fromName?: string;
}

interface MethodFact {
  name: string;
  doc?: string;
  method: HttpMethod;
  args: Value[];
  loc: SourceLocation;
}

interface ControllerFact {
  name: string;
  file: string;
  loc: SourceLocation;
  args: Value[];
  methods: MethodFact[];
}

interface FileFacts {
  filePath: string;
  bindings: Binding[];
  fns: FnFact[];
  calls: CallRec[];
  exports: ExportRec[];
  stars: string[];
  specs: string[];
  controllers: ControllerFact[];
}

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
  id: string;
  name: string;
  framework: Framework;
  role: "app" | "router";
  basePath: string;
  location: SourceLocation;
  filePath: string;
  routes: RawRoute[];
  mounts: RawMount[];
}

export async function analyzeFiles(filePaths: string[], options: AnalyzeOptions = {}): Promise<AppDefinition[]> {
  const stats = options.stats ?? emptyStats();
  const started = Date.now();
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_PARSED_FILES;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const cancelled = () => options.isCancelled?.() === true;
  const candidates = [
    ...new Set(
      filePaths
        .map((file) => path.normalize(path.resolve(file)))
        .filter((file) => !hasSkippedDir(file) && !file.endsWith(".d.ts")),
    ),
  ];
  stats.candidates = candidates.length;

  const facts: FileFacts[] = [];
  const parsed = new Set<string>();
  const resolver = new ModuleResolver(candidates);
  let parseMs = 0;
  const prefilterStarted = Date.now();

  const parseOne = (file: string, text: string) => {
    if (parsed.has(file)) return;
    if (parsed.size >= maxFiles) {
      stats.capped = true;
      return;
    }
    parsed.add(file);
    resolver.remember(file);
    const t0 = Date.now();
    facts.push(extractFile(file, text));
    parseMs += Date.now() - t0;
  };

  for (let index = 0; index < candidates.length; index++) {
    if (cancelled()) return finish([], stats, started, parseMs, 0);
    if (index % batchSize === 0) {
      options.onProgress?.(`Checking sources ${index} / ${candidates.length}`);
      await yieldToHost();
    }
    const file = candidates[index];
    let text: string;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!looksLikeFrameworkSource(text)) continue;
    stats.matched++;
    parseOne(file, text);
  }

  for (let round = 0; round < 8 && !stats.capped; round++) {
    if (cancelled()) return finish([], stats, started, parseMs, 0);
    let added = false;
    for (const fact of [...facts]) {
      for (const spec of fact.specs) {
        if (stats.capped) break;
        const target = resolver.lookupImport(fact.filePath, spec, "disk");
        if (!target || parsed.has(target) || hasSkippedDir(target)) continue;
        let text: string;
        try {
          if (fs.statSync(target).size > MAX_FILE_BYTES) continue;
          text = fs.readFileSync(target, "utf8");
        } catch {
          continue;
        }
        if (!looksLikeFrameworkSource(text) && !looksLikeReexport(text)) continue;
        const before = parsed.size;
        parseOne(target, text);
        if (parsed.size > before) added = true;
      }
    }
    if (!added) break;
    options.onProgress?.(`Following imports (${parsed.size} files)`);
    await yieldToHost();
  }

  stats.parsed = parsed.size;
  stats.prefilterMs = Date.now() - prefilterStarted - parseMs;
  stats.parseMs = parseMs;
  if (cancelled()) return finish([], stats, started, parseMs, 0);

  options.onProgress?.(`Linking ${parsed.size} files`);
  await yieldToHost();
  const linkStarted = Date.now();
  const linker = new Linker(facts, resolver, options, stats);
  const apps = linker.link();
  const linkMs = Date.now() - linkStarted;
  return finish(apps, stats, started, parseMs, linkMs);
}

function finish(
  apps: AppDefinition[],
  stats: AnalyzeStats,
  started: number,
  parseMs: number,
  linkMs: number,
): AppDefinition[] {
  stats.parseMs = parseMs;
  stats.linkMs = linkMs;
  stats.elapsedMs = Date.now() - started;
  return apps;
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function extractFile(file: string, text: string): FileFacts {
  const scriptKind = scriptKindFor(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, scriptKind);
  const facts: FileFacts = {
    filePath: file,
    bindings: [],
    fns: [],
    calls: [],
    exports: [],
    stars: [],
    specs: [],
    controllers: [],
  };
  const scopes: Array<Map<string, Value>> = [new Map()];
  const fnStack: FnFact[] = [];
  const values = new Map<ts.Node, Value>();
  const declared = new Map<ts.FunctionDeclaration, FnFact>();
  let seq = 0;

  const locOf = (node: ts.Node): SourceLocation => {
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source, false));
    return { filePath: file, line: pos.line, character: pos.character };
  };

  const leadingDoc = (node: ts.Node): string | undefined => {
    const start = node.getStart(source, false);
    const trivia = source.text.slice(node.getFullStart(), start);
    return docFromTrivia(trivia);
  };

  const docOf = (node: ts.Node): string | undefined => {
    const direct = leadingDoc(node);
    if (direct) return direct;
    if (ts.canHaveDecorators(node)) {
      const decorators = ts.getDecorators(node);
      if (decorators && decorators.length > 0) return leadingDoc(decorators[0]);
    }
    return undefined;
  };

  const lookup = (name: string): Value | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = scopes[i].get(name);
      if (hit) return hit;
    }
    return undefined;
  };

  const scopeSet = (name: string, value: Value) => {
    scopes[scopes.length - 1].set(name, value);
  };

  const addBinding = (name: string, value: Value, loc: SourceLocation, doc?: string): Binding => {
    const binding: Binding = { id: `${file}#b${seq++}`, name, file, value, loc, doc };
    facts.bindings.push(binding);
    return binding;
  };

  const makeFn = (node: ts.SignatureDeclaration): FnFact => {
    const name = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
    const fn: FnFact = {
      id: `${file}#f${seq++}`,
      name,
      file,
      loc: locOf(node.name && ts.isIdentifier(node.name) ? node.name : node),
      params: paramNames(node),
      returns: [],
      doc: docOf(node),
      walked: false,
    };
    facts.fns.push(fn);
    return fn;
  };

  const unwrap = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isVoidExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };

  const valueOf = (node: ts.Expression): Value => {
    const cached = values.get(node);
    if (cached) return cached;
    const inner = unwrap(node);
    if (inner !== node) {
      const value = valueOf(inner);
      values.set(node, value);
      return value;
    }
    const value = build(node);
    values.set(node, value);
    return value;
  };

  const build = (node: ts.Expression): Value => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { t: "str", v: node.text };
    if (ts.isNumericLiteral(node)) return { t: "num", v: node.text };
    if (ts.isTemplateExpression(node)) {
      const parts: Array<{ t: "s"; v: string } | { t: "v"; v: Value }> = [{ t: "s", v: node.head.text }];
      for (const span of node.templateSpans) {
        parts.push({ t: "v", v: valueOf(span.expression) });
        parts.push({ t: "s", v: span.literal.text });
      }
      return { t: "tpl", parts };
    }
    if (ts.isArrayLiteralExpression(node)) {
      return {
        t: "arr",
        items: node.elements.map((element) => (ts.isSpreadElement(element) ? { t: "unknown" } : valueOf(element))),
      };
    }
    if (ts.isObjectLiteralExpression(node)) {
      const props: Array<{ name: string; v: Value }> = [];
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const name = propertyName(prop.name);
          if (name) props.push({ name, v: valueOf(prop.initializer) });
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          props.push({ name: prop.name.text, v: valueOf(prop.name) });
        }
      }
      return { t: "obj", props };
    }
    if (ts.isIdentifier(node)) {
      if (
        node.text === "require" &&
        !lookup("require")
      ) {
        return { t: "unknown" };
      }
      return lookup(node.text) ?? { t: "unknown" };
    }
    if (ts.isPropertyAccessExpression(node)) {
      return { t: "member", obj: valueOf(node.expression), name: node.name.text };
    }
    if (ts.isCallExpression(node) && isRequireCall(node)) {
      const spec = (node.arguments[0] as ts.StringLiteral).text;
      facts.specs.push(spec);
      return { t: "req", spec };
    }
    if (ts.isCallExpression(node)) {
      const callee = valueOf(node.expression);
      const args = node.arguments.map((arg) => valueOf(arg));
      const value: Value = { t: "call", id: `${file}#e${seq++}`, callee, args };
      const locNode = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      facts.calls.push({
        id: value.id,
        file,
        loc: locOf(locNode),
        callee,
        args,
        assigned: assignedName(node),
      });
      return value;
    }
    if (ts.isNewExpression(node)) {
      const args = node.arguments ? node.arguments.map((arg) => valueOf(arg)) : [];
      return { t: "new", id: `${file}#e${seq++}`, callee: valueOf(node.expression), args };
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const fn = makeFn(node);
      walkFn(fn, node);
      return { t: "fn", id: fn.id };
    }
    return { t: "unknown" };
  };

  const walkFn = (fn: FnFact, node: ts.FunctionLikeDeclaration) => {
    if (fn.walked) return;
    fn.walked = true;
    fn.params = paramNames(node);
    scopes.push(new Map());
    fnStack.push(fn);
    if (node.name && ts.isIdentifier(node.name)) scopeSet(node.name.text, { t: "fn", id: fn.id });
    for (const param of fn.params) {
      if (param) scopeSet(param, { t: "param", fn: fn.id, name: param });
    }
    const body = node.body;
    if (body && ts.isBlock(body)) {
      predeclare(body.statements);
      for (const statement of body.statements) visitStmt(statement);
    } else if (body) {
      fn.returns.push(valueOf(body));
    }
    fnStack.pop();
    scopes.pop();
  };

  const predeclare = (statements: readonly ts.Statement[]) => {
    for (const statement of statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || declared.has(statement)) continue;
      const fn = makeFn(statement);
      declared.set(statement, fn);
      const binding = addBinding(statement.name.text, { t: "fn", id: fn.id }, locOf(statement.name), fn.doc);
      scopeSet(statement.name.text, { t: "ref", id: binding.id });
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        facts.exports.push({ owner: file, name: statement.name.text, bindingId: binding.id });
      }
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        facts.exports.push({ owner: file, name: "default", value: { t: "fn", id: fn.id } });
      }
    }
  };

  const visitStmt = (statement: ts.Statement) => {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) return;
    if (ts.isFunctionDeclaration(statement)) {
      const fn = statement.name ? declared.get(statement) : undefined;
      if (fn) {
        walkFn(fn, statement);
        return;
      }
      if (!statement.name && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        const created = makeFn(statement);
        walkFn(created, statement);
        facts.exports.push({ owner: file, name: "default", value: { t: "fn", id: created.id } });
      }
      return;
    }
    if (ts.isClassDeclaration(statement)) {
      readClass(statement);
      return;
    }
    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const value: Value = decl.initializer ? valueOf(decl.initializer) : { t: "unknown" };
          const binding = addBinding(decl.name.text, value, locOf(decl.name), docOf(decl) ?? docOf(statement));
          scopeSet(decl.name.text, { t: "ref", id: binding.id });
          if (exported) facts.exports.push({ owner: file, name: decl.name.text, bindingId: binding.id });
          continue;
        }
        if (ts.isObjectBindingPattern(decl.name) && decl.initializer && isRequireCall(unwrap(decl.initializer))) {
          const call = unwrap(decl.initializer) as ts.CallExpression;
          const spec = (call.arguments[0] as ts.StringLiteral).text;
          facts.specs.push(spec);
          for (const element of decl.name.elements) {
            if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
            const exportedName =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            const value: Value = { t: "mod", spec, name: exportedName, from: file };
            scopeSet(element.name.text, value);
          }
        }
      }
      return;
    }
    if (ts.isExportAssignment(statement)) {
      facts.exports.push({ owner: file, name: "default", value: valueOf(statement.expression) });
      return;
    }
    if (ts.isExportDeclaration(statement)) {
      readExport(statement);
      return;
    }
    if (ts.isExpressionStatement(statement)) {
      const expr = statement.expression;
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken && isModuleExports(expr.left)) {
        facts.exports.push({ owner: file, name: "cjs", value: valueOf(expr.right) });
        return;
      }
      valueOf(expr);
      return;
    }
    if (ts.isReturnStatement(statement)) {
      const fn = fnStack[fnStack.length - 1];
      if (fn && statement.expression) fn.returns.push(valueOf(statement.expression));
      return;
    }
    if (ts.isBlock(statement)) {
      scopes.push(new Map());
      predeclare(statement.statements);
      for (const child of statement.statements) visitStmt(child);
      scopes.pop();
      return;
    }
    if (ts.isIfStatement(statement)) {
      visitStmt(statement.thenStatement);
      if (statement.elseStatement) visitStmt(statement.elseStatement);
      return;
    }
    ts.forEachChild(statement, (child) => {
      if (ts.isStatement(child) || ts.isBlock(child)) visitStmt(child as ts.Statement);
    });
  };

  const readExport = (statement: ts.ExportDeclaration) => {
    if (!statement.exportClause) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        facts.stars.push(statement.moduleSpecifier.text);
        facts.specs.push(statement.moduleSpecifier.text);
      }
      return;
    }
    if (!ts.isNamedExports(statement.exportClause)) return;
    const fromSpec = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
    if (fromSpec) facts.specs.push(fromSpec);
    for (const element of statement.exportClause.elements) {
      const exported = element.name.text;
      const local = (element.propertyName ?? element.name).text;
      if (fromSpec) {
        facts.exports.push({ owner: file, name: exported, fromSpec, fromName: local });
        continue;
      }
      const found = lookup(local);
      if (found?.t === "ref") facts.exports.push({ owner: file, name: exported, bindingId: found.id });
      else if (found) facts.exports.push({ owner: file, name: exported, value: found });
    }
  };

  const readClass = (node: ts.ClassDeclaration) => {
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
    const controller = decorators
      .map((dec) => decoratorFact(dec))
      .find((dec) => dec?.spec && packageName(dec.spec) === "@nestjs/common" && dec.name === "Controller");
    if (!controller || !node.name) return;
    const methods: MethodFact[] = [];
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      const memberDecorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : [];
      for (const dec of memberDecorators) {
        const fact = decoratorFact(dec);
        if (!fact?.spec || packageName(fact.spec) !== "@nestjs/common") continue;
        const httpMethod = NEST_METHODS[fact.name];
        if (!httpMethod) continue;
        methods.push({
          name: member.name.text,
          doc: docOf(member),
          method: httpMethod,
          args: fact.args,
          loc: fact.loc,
        });
      }
    }
    if (methods.length === 0) return;
    facts.controllers.push({
      name: node.name.text,
      file,
      loc: locOf(node.name),
      args: controller.args,
      methods,
    });
  };

  const decoratorFact = (
    dec: ts.Decorator,
  ): { name: string; spec?: string; args: Value[]; loc: SourceLocation } | undefined => {
    let target: ts.Expression = ts.isCallExpression(dec.expression) ? dec.expression.expression : dec.expression;
    const args = ts.isCallExpression(dec.expression) ? dec.expression.arguments.map((arg) => valueOf(arg)) : [];
    target = unwrap(target);
    if (ts.isIdentifier(target)) {
      const found = lookup(target.text);
      if (found?.t === "mod") return { name: found.name, spec: found.spec, args, loc: locOf(dec) };
      return { name: target.text, args, loc: locOf(dec) };
    }
    if (ts.isPropertyAccessExpression(target)) {
      const obj = valueOf(target.expression);
      if (obj.t === "mod") return { name: target.name.text, spec: obj.spec, args, loc: locOf(dec) };
    }
    return undefined;
  };

  const addImport = (statement: ts.ImportDeclaration) => {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) return;
    const spec = statement.moduleSpecifier.text;
    facts.specs.push(spec);
    const clause = statement.importClause;
    if (!clause) return;
    if (clause.name) scopeSet(clause.name.text, { t: "mod", spec, name: "default", from: file });
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) {
      scopeSet(bindings.name.text, { t: "mod", spec, name: "*", from: file });
      return;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const exported = (element.propertyName ?? element.name).text;
      scopeSet(element.name.text, { t: "mod", spec, name: exported, from: file });
    }
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) addImport(statement);
    else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      const spec = statement.moduleReference.expression.text;
      facts.specs.push(spec);
      scopeSet(statement.name.text, { t: "req", spec });
    }
  }
  predeclare(source.statements);
  for (const statement of source.statements) visitStmt(statement);
  return facts;
}

class Linker {
  private readonly bindingById = new Map<string, Binding>();
  private readonly fnById = new Map<string, FnFact>();
  private readonly exportsByKey = new Map<string, ExportRec[]>();
  private readonly stars = new Map<string, string[]>();
  private readonly calls: CallRec[] = [];
  private readonly controllers: ControllerFact[] = [];
  private readonly routersByExpr = new Map<string, RawRouter>();
  private readonly routersByBinding = new Map<string, RawRouter>();
  private readonly paramBindings = new Map<string, RawRouter[]>();
  private readonly factoryCache = new Map<string, RawRouter | undefined>();
  private readonly resolving = new Set<string>();
  private readonly allRouters: RawRouter[] = [];
  private steps = 0;
  private stopped = false;
  private readonly maxFactoryDepth: number;

  constructor(
    facts: FileFacts[],
    private readonly resolver: ModuleResolver,
    private readonly options: AnalyzeOptions,
    private readonly stats: AnalyzeStats,
  ) {
    this.maxFactoryDepth = options.maxFactoryDepth ?? MAX_FACTORY_DEPTH;
    for (const fact of facts) {
      for (const binding of fact.bindings) this.bindingById.set(binding.id, binding);
      for (const fn of fact.fns) this.fnById.set(fn.id, fn);
      for (const entry of fact.exports) {
        const key = `${entry.owner}::${entry.name}`;
        const list = this.exportsByKey.get(key) ?? [];
        list.push(entry);
        this.exportsByKey.set(key, list);
      }
      if (fact.stars.length > 0) this.stars.set(fact.filePath, fact.stars);
      this.calls.push(...fact.calls);
      this.controllers.push(...fact.controllers);
    }
  }

  link(): AppDefinition[] {
    if (this.options.isCancelled?.()) return [];
    for (const binding of this.bindingById.values()) {
      const router = this.asRouter(binding.value, binding.name, binding.loc, binding.file, 0, new Set());
      if (router) this.routersByBinding.set(binding.id, router);
    }
    this.bindFastify();
    this.collectCalls();
    const nest = this.collectNest();
    const mounted = new Set<RawRouter>();
    for (const router of this.allRouters) {
      for (const mount of router.mounts) mounted.add(mount.child);
    }
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
    if (nest) apps.push(nest);
    return apps;
  }

  private tick(): boolean {
    if (this.stopped) return false;
    this.steps++;
    if (this.steps > MAX_RESOLVE_STEPS) {
      this.stopped = true;
      this.stats.capped = true;
      return false;
    }
    return true;
  }

  private bindFastify(): void {
    const done = new Set<string>();
    let progress = true;
    while (progress && !this.stopped) {
      progress = false;
      for (const call of this.calls) {
        if (!this.isRegister(call)) continue;
        const parents = this.resolveRouters(this.receiver(call));
        for (const parent of parents) {
          if (parent.framework !== "fastify") continue;
          const key = `${call.id}::${parent.id}`;
          if (done.has(key)) continue;
          if (this.bindPlugin(parent, call)) {
            done.add(key);
            progress = true;
          }
        }
      }
    }
  }

  private bindPlugin(parent: RawRouter, call: CallRec): boolean {
    const fn = this.resolveFn(call.args[0], 0, new Set());
    if (!fn || !fn.params[0]) return false;
    const prefix = this.fastifyPrefix(call.args[1]);
    let child = parent;
    if (prefix !== "/") {
      child = this.createRouter(
        { framework: "fastify", role: "router", basePath: "/" },
        fn.name || prefix,
        fn.loc,
        fn.file,
        `reg:${call.id}:${parent.id}`,
      );
      parent.mounts.push({ prefix, child, location: call.loc });
    }
    const paramKey = `${fn.id}::${fn.params[0]}`;
    const list = this.paramBindings.get(paramKey) ?? [];
    if (!list.includes(child)) list.push(child);
    this.paramBindings.set(paramKey, list);
    return true;
  }

  private collectCalls(): void {
    for (const call of this.calls) {
      if (this.stopped) return;
      const name = this.calleeName(call.callee);
      if (!name || !call.callee || call.callee.t !== "member") continue;
      const receiver = call.callee.obj;
      const lower = name.toLowerCase();
      if (lower === "use") {
        this.collectUse(call, receiver);
        continue;
      }
      if (name === "route") {
        this.collectRoute(call, receiver);
        continue;
      }
      if (name === "on") {
        this.collectOn(call, receiver);
        continue;
      }
      if (name === "openapi") {
        this.collectOpenApi(call, receiver);
        continue;
      }
      if (!HTTP_METHODS.has(lower)) continue;
      const chainPath = this.expressChainPath(receiver);
      const targets = chainPath !== undefined ? this.expressChainTargets(receiver) : this.resolveRouters(receiver);
      if (targets.length === 0) continue;
      const split = this.splitPathAndHandlers(call.args, chainPath);
      if (!split) continue;
      const handler = this.handlerFrom(split.handlers);
      for (const target of targets) {
        for (const routePath of split.paths) {
          target.routes.push({
            method: lower.toUpperCase() as HttpMethod,
            path: this.frameworkPath(target.framework, routePath),
            functionName: this.handlerLabel(target.framework, split.handlers, handler.name),
            docstring: handler.doc,
            location: call.loc,
          });
        }
      }
    }
  }

  private collectUse(call: CallRec, receiver: Value): void {
    const router = this.oneRouter(receiver);
    if (!router || router.framework !== "express") return;
    const args = [...call.args];
    let prefixes = ["/"];
    if (args.length > 0 && this.isPathLike(args[0])) {
      const resolved = this.resolveString(args[0]);
      if (typeof resolved === "string") prefixes = [resolved];
      else if (Array.isArray(resolved)) prefixes = resolved;
      args.shift();
    }
    for (const arg of args) {
      const child = this.oneRouter(arg);
      if (!child || child === router) continue;
      for (const prefix of prefixes) {
        router.mounts.push({ prefix, child, location: call.loc });
      }
    }
  }

  private collectRoute(call: CallRec, receiver: Value): void {
    const arg = call.args[0];
    if (!arg) return;
    for (const target of this.resolveRouters(receiver)) {
      if (target.framework === "hono") {
        const prefix = this.resolveString(arg);
        const child = call.args[1] ? this.oneRouter(call.args[1]) : undefined;
        if (typeof prefix === "string" && child && child !== target) {
          target.mounts.push({
            prefix: this.frameworkPath("hono", prefix),
            child,
            location: call.loc,
          });
        }
        continue;
      }
      if (target.framework === "fastify" && arg.t === "obj") this.collectFastifyRoute(target, arg, call);
    }
  }

  private collectFastifyRoute(router: RawRouter, obj: Extract<Value, { t: "obj" }>, call: CallRec): void {
    const methodValue = this.prop(obj, "method");
    const urlValue = this.prop(obj, "url") ?? this.prop(obj, "path");
    if (!methodValue || !urlValue) return;
    const methods = this.asMethodList(this.resolveString(methodValue));
    const urls = this.asStringList(this.resolveString(urlValue));
    if (!methods || !urls) return;
    const handler = this.prop(obj, "handler");
    const named = handler ? this.handlerFrom([handler]) : { name: "(anonymous)", doc: undefined };
    for (const method of methods) {
      for (const url of urls) {
        router.routes.push({
          method,
          path: url,
          functionName: named.name,
          docstring: named.doc,
          location: call.loc,
        });
      }
    }
  }

  private collectOn(call: CallRec, receiver: Value): void {
    const router = this.oneRouter(receiver);
    if (!router || router.framework !== "hono") return;
    const methods = this.asMethodList(this.resolveString(call.args[0]));
    const paths = this.asStringList(this.resolveString(call.args[1]));
    if (!methods || !paths) return;
    const handler = this.handlerFrom(call.args.slice(2));
    for (const method of methods) {
      for (const routePath of paths) {
        router.routes.push({
          method,
          path: this.frameworkPath("hono", routePath),
          functionName: this.handlerLabel("hono", call.args.slice(2), handler.name),
          docstring: handler.doc,
          location: call.loc,
        });
      }
    }
  }

  private collectOpenApi(call: CallRec, receiver: Value): void {
    const router = this.oneRouter(receiver);
    if (!router || router.framework !== "hono") return;
    const spec = this.readOpenApi(call.args[0], new Set());
    if (!spec) return;
    const handler = this.handlerFrom(call.args.slice(1));
    for (const method of spec.methods) {
      for (const routePath of spec.paths) {
        router.routes.push({
          method,
          path: this.frameworkPath("hono", routePath),
          functionName: this.handlerLabel("hono", call.args.slice(1), handler.name),
          docstring: handler.doc,
          location: call.loc,
        });
      }
    }
  }

  private readOpenApi(
    value: Value | undefined,
    seen: Set<string>,
  ): { methods: HttpMethod[]; paths: string[] } | undefined {
    if (!value || !this.tick()) return undefined;
    if (value.t === "call") return this.readOpenApi(value.args[0], seen);
    if (value.t === "ref") {
      if (seen.has(value.id)) return undefined;
      seen.add(value.id);
      const binding = this.bindingById.get(value.id);
      return binding ? this.readOpenApi(binding.value, seen) : undefined;
    }
    if (value.t === "mod") {
      const key = `mod:${value.from}:${value.spec}:${value.name}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      return this.readOpenApi(this.exportValue(value.from, value.spec, value.name, seen), seen);
    }
    if (value.t !== "obj") return undefined;
    const methodValue = this.prop(value, "method");
    const pathValue = this.prop(value, "path");
    if (!methodValue || !pathValue) return undefined;
    const methods = this.asMethodList(this.resolveString(methodValue));
    const paths = this.asStringList(this.resolveString(pathValue));
    if (!methods || !paths) return undefined;
    return { methods, paths };
  }

  private collectNest(): AppDefinition | undefined {
    let globalPrefix = "/";
    let globalScore = -1;
    let bootstrap: { name: string; location: SourceLocation; filePath: string } | undefined;
    for (const call of this.calls) {
      if (this.calleeName(call.callee) === "setGlobalPrefix") {
        const value = this.resolveString(call.args[0]);
        if (typeof value === "string") {
          const score = nestFileScore(call.file);
          if (score > globalScore) {
            globalScore = score;
            globalPrefix = normalizePath(value);
          }
        }
      }
      if (this.isNestCreate(call)) {
        bootstrap = { name: call.assigned ?? "app", location: call.loc, filePath: call.file };
      }
    }
    if (this.controllers.length === 0) return undefined;
    const anchor = bootstrap ?? {
      name: "app",
      location: this.controllers[0].loc,
      filePath: this.controllers[0].file,
    };
    const appRouter = this.createRouter(
      { framework: "nest", role: "app", basePath: "/" },
      anchor.name,
      anchor.location,
      anchor.filePath,
      `nest:${anchor.filePath}`,
    );
    for (const controller of this.controllers) {
      for (const router of this.controllerRouters(controller, globalPrefix)) {
        const prefix = router.basePath;
        router.basePath = "/";
        appRouter.mounts.push({ prefix, child: router, location: router.location });
      }
    }
    return this.emitApp(appRouter);
  }

  private controllerRouters(controller: ControllerFact, globalPrefix: string): RawRouter[] {
    const meta = this.controllerMeta(controller.args);
    const routers: RawRouter[] = [];
    for (const controllerPath of meta.paths) {
      const prefix = nestPrefix(globalPrefix, meta.version, controllerPath);
      const router = this.createRouter(
        { framework: "nest", role: "router", basePath: prefix },
        controller.name,
        controller.loc,
        controller.file,
        `ctl:${controller.file}:${controller.name}:${prefix}`,
      );
      for (const method of controller.methods) {
        for (const methodPath of this.methodPaths(method.args)) {
          router.routes.push({
            method: method.method,
            path: methodPath,
            functionName: method.name,
            docstring: method.doc,
            location: method.loc,
          });
        }
      }
      if (router.routes.length > 0) routers.push(router);
    }
    return routers;
  }

  private controllerMeta(args: Value[]): { paths: string[]; version?: string } {
    if (args.length === 0) return { paths: ["/"] };
    const first = args[0];
    const resolved = this.resolveString(first);
    if (typeof resolved === "string") return { paths: [resolved] };
    if (Array.isArray(resolved)) return { paths: resolved };
    if (first.t === "obj") {
      const pathValue = this.prop(first, "path");
      const versionValue = this.prop(first, "version");
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

  private methodPaths(args: Value[]): string[] {
    if (args.length === 0) return ["/"];
    const first = args[0];
    if (first.t === "obj") {
      const pathValue = this.prop(first, "path");
      if (!pathValue) return ["/"];
      return this.asStringList(this.resolveString(pathValue)) ?? ["/"];
    }
    return this.asStringList(this.resolveString(first)) ?? ["/"];
  }

  private asRouter(
    value: Value | undefined,
    hintName: string | undefined,
    loc: SourceLocation,
    file: string,
    depth: number,
    seen: Set<string>,
  ): RawRouter | undefined {
    if (!value || depth > 48 || !this.tick()) return undefined;
    if (value.t === "ref") {
      const key = `b:${value.id}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      const known = this.routersByBinding.get(value.id);
      if (known) {
        seen.delete(key);
        return known;
      }
      const binding = this.bindingById.get(value.id);
      const resolved = binding
        ? this.routerFromRequire(binding.value, binding.file) ??
          this.asRouter(binding.value, binding.name, binding.loc, binding.file, depth + 1, seen)
        : undefined;
      if (resolved) this.routersByBinding.set(value.id, resolved);
      seen.delete(key);
      return resolved;
    }
    if (value.t === "mod") return this.routerFromMod(value, depth, seen);
    if (value.t === "param") return this.paramBindings.get(`${value.fn}::${value.name}`)?.[0];
    if (value.t === "req") return this.routerFromRequire(value, file);
    if (value.t === "call" || value.t === "new") {
      const cached = this.routersByExpr.get(value.id);
      if (cached) return cached;
      if (value.t === "call" && value.callee.t === "member") {
        const prop = value.callee.name.toLowerCase();
        if (prop !== "route" && (HTTP_METHODS.has(prop) || CHAIN_METHODS.has(prop))) {
          return this.asRouter(value.callee.obj, hintName, loc, file, depth + 1, seen);
        }
        if (value.callee.name === "route") {
          const inner = this.asRouter(value.callee.obj, hintName, loc, file, depth + 1, seen);
          if (inner?.framework === "hono") return inner;
        }
      }
      if (value.t === "call") {
        const required = this.routerFromRequire(value, file);
        if (required) return required;
        const factory = this.routerFromFactory(value, depth, seen);
        if (factory) return factory;
      }
      const classification = this.classify(value, 0);
      if (!classification) return undefined;
      return this.createRouter(
        classification,
        hintName || (classification.role === "app" ? "app" : "router"),
        loc,
        file,
        value.id,
      );
    }
    return undefined;
  }

  private resolveRouters(value: Value | undefined): RawRouter[] {
    if (!value) return [];
    if (value.t === "param") return this.paramBindings.get(`${value.fn}::${value.name}`) ?? [];
    if (value.t === "ref") {
      const binding = this.bindingById.get(value.id);
      if (binding?.value.t === "param") {
        return this.paramBindings.get(`${binding.value.fn}::${binding.value.name}`) ?? [];
      }
    }
    const one = this.asRouter(value, undefined, blankLoc(value), "", 0, new Set());
    return one ? [one] : [];
  }

  private oneRouter(value: Value | undefined): RawRouter | undefined {
    return this.resolveRouters(value)[0];
  }

  private routerFromMod(value: Extract<Value, { t: "mod" }>, depth: number, seen: Set<string>): RawRouter | undefined {
    const target = this.resolver.lookupImport(value.from, value.spec, "facts");
    if (!target) return undefined;
    const names = value.name === "default" || value.name === "*" ? ["default", "cjs"] : [value.name];
    for (const name of names) {
      const exported = this.resolveExport(target, name, depth + 1, seen);
      if (!exported) continue;
      const router = this.asRouter(exported, undefined, blankLoc(exported), target, depth + 1, seen);
      if (router) return router;
    }
    return undefined;
  }

  private routerFromRequire(value: Value, fromFile: string): RawRouter | undefined {
    if (value.t !== "req" || !value.spec.startsWith(".")) return undefined;
    const target = this.resolver.lookupImport(fromFile, value.spec, "facts");
    if (!target) return undefined;
    for (const name of ["cjs", "default"]) {
      const exported = this.resolveExport(target, name, 0, new Set());
      if (!exported) continue;
      const router = this.asRouter(exported, undefined, blankLoc(exported), target, 0, new Set());
      if (router) return router;
    }
    return undefined;
  }

  private routerFromFactory(call: Extract<Value, { t: "call" }>, depth: number, seen: Set<string>): RawRouter | undefined {
    const fn = this.resolveFn(call.callee, depth, seen);
    if (!fn) return undefined;
    if (this.factoryCache.has(fn.id)) return this.factoryCache.get(fn.id);
    if (this.resolving.has(fn.id) || this.resolving.size >= this.maxFactoryDepth) {
      this.stats.factoryDepthHits++;
      return undefined;
    }
    this.resolving.add(fn.id);
    let found: RawRouter | undefined;
    for (const returned of fn.returns) {
      found = this.asRouter(returned, fn.name, fn.loc, fn.file, depth + 1, seen);
      if (found) break;
    }
    this.resolving.delete(fn.id);
    this.factoryCache.set(fn.id, found);
    return found;
  }

  private resolveFn(value: Value | undefined, depth: number, seen: Set<string>): FnFact | undefined {
    if (!value || depth > 24 || !this.tick()) return undefined;
    if (value.t === "fn") return this.fnById.get(value.id);
    if (value.t === "ref") {
      if (seen.has(`fn:${value.id}`)) return undefined;
      seen.add(`fn:${value.id}`);
      const binding = this.bindingById.get(value.id);
      if (!binding) return undefined;
      if (binding.value.t === "fn") return this.fnById.get(binding.value.id);
      return this.resolveFn(binding.value, depth + 1, seen);
    }
    if (value.t === "mod") {
      const names = value.name === "default" || value.name === "*" ? ["default", "cjs"] : [value.name];
      const target = this.resolver.lookupImport(value.from, value.spec, "facts");
      if (!target) return undefined;
      for (const name of names) {
        const exported = this.resolveExport(target, name, depth + 1, seen);
        const fn = exported ? this.resolveFn(exported, depth + 1, seen) : undefined;
        if (fn) return fn;
      }
    }
    if (value.t === "req" && value.spec.startsWith(".")) {
      const target = this.resolver.lookupImport("", value.spec, "facts");
      if (!target) return undefined;
      for (const name of ["cjs", "default"]) {
        const exported = this.resolveExport(target, name, depth + 1, seen);
        const fn = exported ? this.resolveFn(exported, depth + 1, seen) : undefined;
        if (fn) return fn;
      }
    }
    return undefined;
  }

  private resolveExport(file: string, name: string, depth: number, seen: Set<string>): Value | undefined {
    const key = `${file}::${name}`;
    if (depth > 24 || seen.has(key) || !this.tick()) return undefined;
    seen.add(key);
    for (const entry of this.exportsByKey.get(key) ?? []) {
      if (entry.fromSpec && entry.fromName) {
        const target = this.resolver.lookupImport(entry.owner, entry.fromSpec, "facts");
        if (!target) continue;
        const exported = this.resolveExport(target, entry.fromName, depth + 1, seen);
        if (exported) return exported;
        continue;
      }
      if (entry.bindingId) return { t: "ref", id: entry.bindingId };
      if (entry.value) return entry.value;
    }
    for (const spec of this.stars.get(file) ?? []) {
      const target = this.resolver.lookupImport(file, spec, "facts");
      if (!target) continue;
      const exported = this.resolveExport(target, name, depth + 1, seen);
      if (exported) return exported;
    }
    return undefined;
  }

  private exportValue(fromFile: string, spec: string, name: string, seen: Set<string>): Value | undefined {
    const target = this.resolver.lookupImport(fromFile, spec, "facts");
    if (!target) return undefined;
    return this.resolveExport(target, name, 0, seen);
  }

  private classify(value: Value, depth: number): Classification | undefined {
    if (depth > 16) return undefined;
    if (value.t === "new") {
      if (this.isHonoRef(value.callee)) return { framework: "hono", role: "app", basePath: "/" };
      return undefined;
    }
    if (value.t !== "call") return undefined;
    const callee = value.callee;
    if (callee.t === "member") {
      if (callee.name === "Router" && this.isExpressModule(callee.obj)) {
        return { framework: "express", role: "router", basePath: "/" };
      }
      if (callee.name === "basePath") {
        const parent = this.classify(callee.obj, depth + 1);
        const parentIsHono =
          parent?.framework === "hono" ||
          this.isHonoRef(callee.obj) ||
          this.peekRouter(callee.obj)?.framework === "hono";
        if (parentIsHono) {
          const base = this.resolveString(value.args[0]);
          const parentBase = parent?.basePath ?? this.peekRouter(callee.obj)?.basePath ?? "/";
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

  private peekRouter(value: Value): RawRouter | undefined {
    if (value.t === "call" || value.t === "new") return this.routersByExpr.get(value.id);
    if (value.t === "ref") return this.routersByBinding.get(value.id);
    return undefined;
  }

  private createRouter(
    classification: Classification,
    name: string,
    loc: SourceLocation,
    file: string,
    key: string,
  ): RawRouter {
    const existing = this.routersByExpr.get(key);
    if (existing) return existing;
    const router: RawRouter = {
      id: key,
      name,
      framework: classification.framework,
      role: classification.role,
      basePath: classification.basePath,
      location: loc.filePath ? loc : { filePath: file, line: loc.line, character: loc.character },
      filePath: file || loc.filePath,
      routes: [],
      mounts: [],
    };
    this.routersByExpr.set(key, router);
    this.allRouters.push(router);
    return router;
  }

  private resolveString(value: Value | undefined, seen = new Set<string>()): string | string[] | undefined {
    if (!value || !this.tick()) return undefined;
    if (value.t === "str" || value.t === "num") return value.v;
    if (value.t === "arr") {
      const items: string[] = [];
      for (const item of value.items) {
        const part = this.resolveString(item, seen);
        if (typeof part === "string") items.push(part);
        else if (Array.isArray(part)) items.push(...part);
        else return undefined;
      }
      return items;
    }
    if (value.t === "tpl") {
      let text = "";
      for (const part of value.parts) {
        if (part.t === "s") text += part.v;
        else {
          const inner = this.resolveString(part.v, seen);
          if (typeof inner !== "string") return undefined;
          text += inner;
        }
      }
      return text;
    }
    if (value.t === "ref") {
      if (seen.has(value.id)) return undefined;
      seen.add(value.id);
      const binding = this.bindingById.get(value.id);
      return binding ? this.resolveString(binding.value, seen) : undefined;
    }
    return undefined;
  }

  private isPathLike(value: Value): boolean {
    const resolved = this.resolveString(value);
    return typeof resolved === "string" || Array.isArray(resolved);
  }

  private expressChainPath(receiver: Value | undefined): string | undefined {
    if (!receiver || receiver.t !== "call" || receiver.callee.t !== "member") return undefined;
    const name = receiver.callee.name;
    if (name === "route" && receiver.args.length === 1) {
      const value = this.resolveString(receiver.args[0]);
      return typeof value === "string" ? value : "/";
    }
    if (HTTP_METHODS.has(name.toLowerCase())) return this.expressChainPath(receiver.callee.obj);
    return undefined;
  }

  private expressChainTargets(receiver: Value): RawRouter[] {
    const routeCall = this.findRouteCall(receiver);
    if (!routeCall || routeCall.callee.t !== "member") return [];
    return this.resolveRouters(routeCall.callee.obj);
  }

  private findRouteCall(receiver: Value | undefined): Extract<Value, { t: "call" }> | undefined {
    if (!receiver || receiver.t !== "call" || receiver.callee.t !== "member") return undefined;
    if (receiver.callee.name === "route") return receiver;
    if (HTTP_METHODS.has(receiver.callee.name.toLowerCase())) return this.findRouteCall(receiver.callee.obj);
    return undefined;
  }

  private splitPathAndHandlers(
    args: Value[],
    chainPath: string | undefined,
  ): { paths: string[]; handlers: Value[] } | undefined {
    if (args.length > 0 && this.isPathLike(args[0])) {
      const value = this.resolveString(args[0]);
      const paths = Array.isArray(value) ? value : typeof value === "string" ? [value] : undefined;
      if (!paths) return undefined;
      return { paths, handlers: args.slice(1) };
    }
    if (chainPath !== undefined) return { paths: [chainPath], handlers: args };
    return undefined;
  }

  private handlerFrom(args: readonly Value[]): { name: string; doc?: string } {
    if (args.length === 0) return { name: "(anonymous)" };
    let last = args[args.length - 1];
    if (last.t === "arr" && last.items.length > 0) last = last.items[last.items.length - 1];
    return { name: this.expressionName(last), doc: this.docOf(last) };
  }

  private handlerLabel(framework: Framework, handlers: readonly Value[], fallback: string): string {
    if (fallback && fallback !== "(anonymous)") return fallback;
    if (framework !== "hono") return fallback;
    const meta = this.describeRouteMeta(handlers);
    return meta?.operationId || meta?.summary || "";
  }

  private describeRouteMeta(handlers: readonly Value[]): { summary?: string; operationId?: string } | undefined {
    for (const handler of handlers) {
      if (handler.t !== "call") continue;
      if (this.calleeName(handler.callee) !== "describeRoute" || !handler.args[0]) continue;
      const config = handler.args[0];
      if (config.t !== "obj") continue;
      const summary = this.literalProp(config, "summary");
      const operationId = this.literalProp(config, "operationId");
      if (!summary && !operationId) continue;
      return { summary, operationId };
    }
    return undefined;
  }

  private literalProp(obj: Extract<Value, { t: "obj" }>, name: string): string | undefined {
    const value = this.prop(obj, name);
    const resolved = value ? this.resolveString(value) : undefined;
    return typeof resolved === "string" ? resolved : undefined;
  }

  private expressionName(value: Value): string {
    if (value.t === "ref") return this.bindingById.get(value.id)?.name ?? "(anonymous)";
    if (value.t === "fn") return this.fnById.get(value.id)?.name || "(anonymous)";
    if (value.t === "member") return `${this.expressionName(value.obj)}.${value.name}`;
    if (value.t === "call" && value.args.length > 0) {
      const inner = this.expressionName(value.args[value.args.length - 1]);
      if (inner !== "(anonymous)") return inner;
    }
    if (value.t === "mod") return value.name === "default" ? "(anonymous)" : value.name;
    return "(anonymous)";
  }

  private docOf(value: Value): string | undefined {
    if (value.t === "ref") {
      const binding = this.bindingById.get(value.id);
      if (binding?.doc) return binding.doc;
      if (binding?.value.t === "fn") return this.fnById.get(binding.value.id)?.doc;
    }
    if (value.t === "fn") return this.fnById.get(value.id)?.doc;
    return undefined;
  }

  private moduleInfo(value: Value | undefined, depth = 0, seen = new Set<string>()): { spec: string; name: string } | undefined {
    if (!value || depth > 12) return undefined;
    if (value.t === "mod") return { spec: value.spec, name: value.name };
    if (value.t === "req") return { spec: value.spec, name: "default" };
    if (value.t === "member") {
      const object = this.moduleInfo(value.obj, depth + 1, seen);
      if (!object) return undefined;
      if (object.name === "*" || object.name === "default") return { spec: object.spec, name: value.name };
      return undefined;
    }
    if (value.t === "ref") {
      if (seen.has(value.id)) return undefined;
      seen.add(value.id);
      const binding = this.bindingById.get(value.id);
      return binding ? this.moduleInfo(binding.value, depth + 1, seen) : undefined;
    }
    return undefined;
  }

  private isExpressFactory(value: Value): boolean {
    const info = this.moduleInfo(value);
    if (!info || packageName(info.spec) !== "express") return false;
    return info.name === "default" || info.name === "*" || info.name === "express";
  }

  private isExpressRouterFn(value: Value): boolean {
    const info = this.moduleInfo(value);
    return !!info && packageName(info.spec) === "express" && info.name === "Router";
  }

  private isExpressModule(value: Value): boolean {
    return this.isExpressFactory(value);
  }

  private isHonoRef(value: Value): boolean {
    const info = this.moduleInfo(value);
    if (!info) return false;
    const pkg = packageName(info.spec);
    if ((pkg === "hono" || info.spec.startsWith("hono/")) && (info.name === "Hono" || info.name === "default")) return true;
    return pkg === "@hono/zod-openapi" && (info.name === "OpenAPIHono" || info.name === "Hono");
  }

  private isFastifyRef(value: Value): boolean {
    const info = this.moduleInfo(value);
    if (!info || packageName(info.spec) !== "fastify") return false;
    return info.name === "default" || info.name === "*" || info.name === "fastify" || info.name === "Fastify";
  }

  private isNestCreate(call: CallRec): boolean {
    if (call.callee.t !== "member" || call.callee.name !== "create") return false;
    const info = this.moduleInfo(call.callee.obj);
    return !!info && packageName(info.spec) === "@nestjs/core" && (info.name === "NestFactory" || info.name === "*");
  }

  private isRegister(call: CallRec): boolean {
    return call.callee.t === "member" && call.callee.name === "register";
  }

  private calleeName(callee: Value): string {
    if (callee.t === "member") return callee.name;
    if (callee.t === "mod") return callee.name;
    if (callee.t === "ref") return this.bindingById.get(callee.id)?.name ?? "";
    return "";
  }

  private receiver(call: CallRec): Value | undefined {
    return call.callee.t === "member" ? call.callee.obj : undefined;
  }

  private prop(obj: Extract<Value, { t: "obj" }>, name: string): Value | undefined {
    return obj.props.find((item) => item.name === name)?.v;
  }

  private fastifyPrefix(value: Value | undefined): string {
    if (!value || value.t !== "obj") return "/";
    const prefix = this.prop(value, "prefix");
    const resolved = prefix ? this.resolveString(prefix) : undefined;
    return typeof resolved === "string" ? normalizePath(resolved) : "/";
  }

  private frameworkPath(framework: Framework, value: string): string {
    return framework === "hono" ? toHonoPath(value) : value;
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
      children: raw.mounts.map((mount) => this.emitRouter(mount.child, joinPaths(fullPrefix, mount.prefix), seen)),
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
}

class ModuleResolver {
  private readonly files: Set<string>;
  private readonly tsconfigByDir = new Map<string, TsConfigInfo | undefined>();
  private packageEntries: PackageEntry[] | undefined;

  constructor(files: string[]) {
    this.files = new Set();
    this.packageEntries = collectPackages(commonDirectory(files));
  }

  remember(file: string): void {
    this.files.add(file);
  }

  lookupImport(fromFile: string, spec: string, mode: "disk" | "facts"): string | undefined {
    if (spec.startsWith(".")) return this.lookupFile(path.resolve(path.dirname(fromFile), spec), mode);
    const fromPaths = this.resolveTsconfigPath(fromFile, spec, mode);
    if (fromPaths) return fromPaths;
    return this.resolvePackageImport(spec, mode);
  }

  private lookupFile(base: string, mode: "disk" | "facts"): string | undefined {
    for (const candidate of sourceCandidates(base)) {
      const normalized = path.normalize(candidate);
      if (hasSkippedDir(normalized)) continue;
      if (mode === "facts") {
        if (this.files.has(normalized)) return normalized;
        continue;
      }
      try {
        if (fs.statSync(normalized).isFile()) return normalized;
      } catch {
        // try the next extension
      }
    }
    return undefined;
  }

  private resolveTsconfigPath(fromFile: string, spec: string, mode: "disk" | "facts"): string | undefined {
    const config = this.tsconfigFor(path.dirname(fromFile));
    if (!config) return undefined;
    for (const pattern of config.patterns) {
      let captured: string | undefined;
      if (pattern.exact) {
        if (spec === pattern.prefix) captured = "";
      } else if (
        spec.startsWith(pattern.prefix) &&
        spec.endsWith(pattern.suffix) &&
        spec.length >= pattern.prefix.length + pattern.suffix.length
      ) {
        captured = spec.slice(pattern.prefix.length, spec.length - pattern.suffix.length);
      }
      if (captured === undefined) continue;
      for (const target of pattern.targets) {
        const replaced = pattern.exact ? target : target.replaceAll("*", captured);
        const hit = this.lookupFile(path.resolve(config.baseUrl, replaced), mode);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  private tsconfigFor(startDir: string): TsConfigInfo | undefined {
    if (this.tsconfigByDir.has(startDir)) return this.tsconfigByDir.get(startDir);
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

  private resolvePackageImport(spec: string, mode: "disk" | "facts"): string | undefined {
    const packages = this.packageEntries ?? [];
    let best: PackageEntry | undefined;
    for (const entry of packages) {
      if (spec !== entry.name && !spec.startsWith(`${entry.name}/`)) continue;
      if (!best || entry.name.length > best.name.length) best = entry;
    }
    if (!best) return undefined;
    const subpath = spec === best.name ? "." : `.${spec.slice(best.name.length)}`;
    for (const item of best.entries) {
      if (!item.key.includes("*")) {
        if (item.key === subpath) {
          const hit = this.lookupFile(item.target, mode);
          if (hit) return hit;
        }
        continue;
      }
      const star = item.key.indexOf("*");
      const prefix = item.key.slice(0, star);
      const suffix = item.key.slice(star + 1);
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
      const hit = this.lookupFile(item.target.replaceAll("*", captured), mode);
      if (hit) return hit;
    }
    return undefined;
  }
}

function blankLoc(value: Value): SourceLocation {
  if (value.t === "ref") return { filePath: "", line: 0, character: 0 };
  return { filePath: "", line: 0, character: 0 };
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function paramNames(node: ts.SignatureDeclaration): string[] {
  return node.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : ""));
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((modifier) => modifier.kind === kind);
}

function isRequireCall(node: ts.Expression): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length >= 1 &&
    ts.isStringLiteral(node.arguments[0])
  );
}

function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "exports" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module"
  );
}

function assignedName(node: ts.CallExpression): string | undefined {
  let current: ts.Node = node;
  if (current.parent && ts.isAwaitExpression(current.parent)) current = current.parent;
  if (current.parent && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
    return current.parent.name.text;
  }
  return undefined;
}

function docFromTrivia(trivia: string): string | undefined {
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

function packageName(spec: string): string {
  if (spec.startsWith("@")) {
    const [scope, name] = spec.split("/");
    return name ? `${scope}/${name}` : spec;
  }
  return spec.split("/")[0];
}

function nestFileScore(fileName: string): number {
  const base = path.basename(fileName);
  if (base === "main.ts" || base === "main.js") return 3;
  if (base === "server.ts" || base === "server.js") return 2;
  if (base === "index.ts" || base === "index.js") return 1;
  return 0;
}

function nestPrefix(globalPrefix: string, version: string | undefined, controllerPath: string): string {
  let prefix = normalizePath(globalPrefix || "/");
  if (version) prefix = joinPaths(prefix, `v${version.replace(/^v/i, "")}`);
  return joinPaths(prefix, controllerPath || "/");
}

function sourceCandidates(base: string): string[] {
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
  return candidates;
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
  const config = read.config as
    | {
        compilerOptions?: { baseUrl?: unknown; paths?: unknown };
      }
    | undefined;
  if (!config?.compilerOptions) return undefined;
  const dir = path.dirname(configPath);
  const options = config.compilerOptions;
  const baseUrl = typeof options.baseUrl === "string" ? path.resolve(dir, options.baseUrl) : dir;
  const paths = options.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return { baseUrl, patterns: [] };
  const patterns: PathPattern[] = [];
  for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => typeof target !== "string")) continue;
    const star = pattern.indexOf("*");
    patterns.push({
      exact: star === -1,
      prefix: star === -1 ? pattern : pattern.slice(0, star),
      suffix: star === -1 ? "" : pattern.slice(star + 1),
      targets: targets as string[],
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
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) return [];
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
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
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
  if (typeof json.exports === "string") entries.push({ key: ".", target: path.resolve(dir, json.exports) });
  else if (json.exports && typeof json.exports === "object" && !Array.isArray(json.exports)) {
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
