import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Drop paths that `git check-ignore` rejects. Tracked files are kept.
 * A missing git binary or a non-repo returns the input unchanged.
 */
export function dropGitignored(root: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return Promise.resolve(files);
  const relative = files.map((file) => path.relative(root, file));
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, "check-ignore", "-z", "--stdin"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (ignored: Set<string>) => {
      if (settled) return;
      settled = true;
      if (ignored.size === 0) {
        resolve(files);
        return;
      }
      resolve(files.filter((_, index) => !ignored.has(relative[index])));
    };
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish(new Set()));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        finish(new Set());
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      finish(new Set(text.split("\0").filter((item) => item.length > 0)));
    });
    child.stdin.write(`${relative.join("\0")}\0`);
    child.stdin.end();
  });
}
