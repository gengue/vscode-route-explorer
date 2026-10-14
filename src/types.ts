/** Frameworks the explorer knows how to read without starting a server. */
export type Framework = "express" | "hono" | "fastify" | "nest";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "ALL"
  | "TRACE"
  | "CONNECT";

/** 0-based position, matching the VS Code editor. */
export interface SourceLocation {
  filePath: string;
  line: number;
  character: number;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** Absolute path, including every mount prefix. Always starts with `/`. */
  path: string;
  functionName: string;
  framework: Framework;
  location: SourceLocation;
  docstring?: string;
}

export interface RouterDefinition {
  name: string;
  /** Absolute prefix this router is mounted at. */
  prefix: string;
  framework: Framework;
  location: SourceLocation;
  routes: RouteDefinition[];
  children: RouterDefinition[];
}

export interface AppDefinition {
  name: string;
  framework: Framework;
  filePath: string;
  location: SourceLocation;
  /** Routes registered directly on the application, not on a mounted router. */
  routes: RouteDefinition[];
  routers: RouterDefinition[];
}
