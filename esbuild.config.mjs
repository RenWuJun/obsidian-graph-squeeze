import { context } from "esbuild";

const watch = process.argv.includes("--watch");
const build = await context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2020",
  outfile: "main.js",
  sourcemap: watch ? "inline" : false,
  banner: { js: "/* Graph Squeeze — generated from src/. */" },
});
if (watch) await build.watch();
else {
  await build.rebuild();
  await build.dispose();
}
