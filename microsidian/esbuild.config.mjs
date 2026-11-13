import esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const watch = process.argv.includes("--watch");

// Where to install the built plugin: $OBSIDIAN_VAULT, or the path in the untracked file install-target.txt.
// With neither, the build only writes main.js here.
function vaultPath() {
  if (process.env.OBSIDIAN_VAULT) return resolve(process.env.OBSIDIAN_VAULT);
  if (existsSync("install-target.txt")) {
    const p = readFileSync("install-target.txt", "utf8").trim();
    if (p) return resolve(p);
  }
  return null;
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "main.js",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  plugins: [
    {
      name: "install-into-vault",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length) return;
          const vault = vaultPath();
          if (!vault || !existsSync(vault)) return;
          const dest = join(vault, ".obsidian", "plugins", "microsidian");
          mkdirSync(dest, { recursive: true });
          for (const f of ["main.js", "manifest.json", "styles.css"]) {
            if (existsSync(f)) copyFileSync(f, join(dest, f));
          }
          console.log("installed ->", dest);
        });
      },
    },
  ],
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
