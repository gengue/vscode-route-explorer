const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Bundle the extension host entry. The TypeScript compiler stays external so it can read its own lib files. */
async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode", "typescript"],
    format: "cjs",
    platform: "node",
    target: "node18",
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
    return;
  }

  await ctx.rebuild();
  await ctx.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
