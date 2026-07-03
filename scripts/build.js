// Build the Thundervim add-on package.
//
// Bundles the TypeScript sources into extension scripts, lays out
// a loadable extension directory (dist/thundervim/), and zips it into an
// installable .xpi. Pass --watch to rebuild on change (for `Reload` during
// development); the unpacked dist/thundervim/ dir is what you load in
// Thunderbird's Debug Add-ons page.
import * as esbuild from "esbuild";
import { rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "dist", "thundervim");
const watch = process.argv.includes("--watch");

const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const version = manifest.version;

async function copyAssets() {
  await copyFile(
    path.join(root, "manifest.json"),
    path.join(pkgDir, "manifest.json"),
  );
  await copyFile(
    path.join(root, "src", "statusbar.css"),
    path.join(pkgDir, "statusbar.css"),
  );
  await copyFile(
    path.join(root, "src", "options.html"),
    path.join(pkgDir, "options.html"),
  );
  await copyFile(
    path.join(root, "src", "options.css"),
    path.join(pkgDir, "options.css"),
  );

  const iconsDir = path.join(pkgDir, "assets", "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of [48, 96, 128]) {
    await copyFile(
      path.join(root, "assets", "icons", `icon-${size}.png`),
      path.join(iconsDir, `icon-${size}.png`),
    );
  }
}

const options = {
  entryPoints: {
    background: path.join(root, "src", "background.ts"),
    compose: path.join(root, "src", "compose.ts"),
    options: path.join(root, "src", "options.ts"),
  },
  bundle: true,
  format: "iife",
  target: ["firefox115"],
  outdir: pkgDir,
  entryNames: "[name]",
  legalComments: "none",
  logLevel: "info",
};

await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(pkgDir, { recursive: true });
await copyAssets();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(
    `watching… (load ${path.relative(root, pkgDir)}/ in Thunderbird)`,
  );
} else {
  await esbuild.build(options);
  const xpi = path.join(root, "dist", `thundervim-${version}.xpi`);
  execFileSync(
    "zip",
    [
      "-r",
      "-X",
      xpi,
      "manifest.json",
      "background.js",
      "compose.js",
      "statusbar.css",
      "options.html",
      "options.css",
      "options.js",
      "assets",
    ],
    { cwd: pkgDir, stdio: "ignore" },
  );
  console.log(`Built ${path.relative(root, xpi)}`);
}
