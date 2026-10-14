/**
 * Normalize an HTTP path fragment.
 * Empty and missing values become `/`. A trailing slash is kept only for the root.
 */
export function normalizePath(input: string | undefined | null): string {
  if (input == null) return "/";
  let value = input.trim();
  if (value === "" || value === "/") return "/";
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

/**
 * OpenAPI path params (`{id}`) are shown the way Hono writes them (`:id`).
 * An optional marker after the brace (`{id}?`) becomes `:id?`.
 */
export function toHonoPath(value: string): string {
  return value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}(\??)/g, ":$1$2");
}

/** Join a mount prefix and a route path the way Express, Hono, and Fastify do. */
export function joinPaths(prefix: string, path: string): string {
  const left = normalizePath(prefix);
  const right = normalizePath(path);
  if (right === "/") return left;
  if (left === "/") return right;
  return `${left}${right}`;
}
