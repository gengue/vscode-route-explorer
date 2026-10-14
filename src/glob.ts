/**
 * Small glob matcher for the include/exclude settings.
 * Supports `*`, `?`, `**`, and `{a,b}` groups. Paths may be absolute.
 */

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function findClosingBrace(pattern: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of body) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Translate one glob into a regex source without anchors. */
function globSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (char === "{") {
      const end = findClosingBrace(pattern, i);
      if (end !== -1) {
        const alternatives = splitAlternatives(pattern.slice(i + 1, end));
        out += `(?:${alternatives.map((part) => globSource(part)).join("|")})`;
        i = end + 1;
        continue;
      }
    }
    out += escapeRegex(char);
    i++;
  }
  return out;
}

export function matchGlob(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const source = globSource(pattern.replace(/\\/g, "/"));
  return new RegExp(`^${source}$`).test(normalized);
}

export function filterSourceFiles(
  files: string[],
  include: string[],
  exclude: string[],
): string[] {
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, "/");
    if (exclude.some((pattern) => matchGlob(normalized, pattern))) return false;
    if (include.length === 0) return true;
    return include.some((pattern) => matchGlob(normalized, pattern));
  });
}

export const DEFAULT_INCLUDE = ["**/*.{js,jsx,mjs,cjs,ts,tsx}"];

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/*.d.ts",
  "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx}",
  "**/__tests__/**",
  "**/.git/**",
  "**/.turbo/**",
  "**/.next/**",
  "**/.output/**",
  "**/.cache/**",
  "**/.pnpm/**",
  "**/storybook-static/**",
];

/**
 * Directories and declarations dropped before `workspace.findFiles` applies its
 * result cap. A pnpm monorepo's `dist/` and `node_modules` are large enough to
 * fill a small cap and hide every `apps/<name>/src` file.
 * Patterns here must not nest `{a,b}` groups; VS Code splits the outer braces on commas.
 */
export const DISCOVERY_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.turbo/**",
  "**/.next/**",
  "**/.output/**",
  "**/.cache/**",
  "**/.pnpm/**",
  "**/storybook-static/**",
  "**/*.d.ts",
];

export function discoveryExcludeGlob(): string {
  return `{${DISCOVERY_EXCLUDES.join(",")}}`;
}

/** Turn `**\/*.{ts,tsx}` into `**\/*.ts` and `**\/*.tsx` so one extension cannot crowd out another. */
export function expandIncludePatterns(patterns: string[]): string[] {
  const expanded: string[] = [];
  for (const pattern of patterns) {
    const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(pattern);
    if (!match) {
      expanded.push(pattern);
      continue;
    }
    const [, prefix, body, suffix] = match;
    for (const alternative of body.split(",")) {
      const piece = alternative.trim();
      if (piece) expanded.push(`${prefix}${piece}${suffix}`);
    }
  }
  return expanded;
}
