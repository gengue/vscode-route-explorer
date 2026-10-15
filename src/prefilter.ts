/**
 * Cheap text checks run before any TypeScript parse.
 * A workspace full of unrelated sources must not become ASTs.
 */

export const DEFAULT_MAX_PARSED_FILES = 1_500;
export const DEFAULT_BATCH_SIZE = 40;
export const MAX_FACTORY_DEPTH = 24;
export const MAX_RESOLVE_STEPS = 400_000;
export const MAX_FILE_BYTES = 1_000_000;

/** Directory names dropped even if a caller passes them in. */
export const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "generated",
  ".git",
  ".turbo",
  ".next",
  ".output",
  ".cache",
  ".pnpm",
  "storybook-static",
]);

/**
 * Framework markers only. `Router` alone is intentionally absent: a React
 * workspace would otherwise parse every component that mentions it.
 * Express, Fastify, and Nest stay in the set so those routes are still found.
 */
const FRAMEWORK_TEXT =
  /\b(?:hono|Hono|OpenAPIHono|express|Express|fastify|Fastify|NestFactory|describeRoute|createRoute)\b|@(?:Controller|Get|Post|Put|Patch|Delete|Head|Options|All)\b/;

/** Barrel files (`export { x } from "./y"`) that a route file may import. */
const REEXPORT_TEXT = /(?:^|\n)\s*export\s+(?:type\s+)?(?:\*\s+from|\{[^}]*\}\s*from)\s*['"]/;

export function looksLikeFrameworkSource(text: string): boolean {
  return FRAMEWORK_TEXT.test(text);
}

export function looksLikeReexport(text: string): boolean {
  return REEXPORT_TEXT.test(text);
}

export function hasSkippedDir(filePath: string): boolean {
  const parts = filePath.split(/[/\\]/);
  for (const part of parts) {
    if (SKIP_DIR_NAMES.has(part)) return true;
  }
  return false;
}
