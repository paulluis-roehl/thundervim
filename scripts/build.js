// Build the Thundervim add-on package.
//
// Bundles the TypeScript source into a single compose content script, lays out
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
}

const options = {
  entryPoints: [path.join(root, "src", "compose.ts")],
  bundle: true,
  format: "iife",
  target: ["firefox115"],
  outfile: path.join(pkgDir, "compose.js"),
  legalComments: "none",
  logLevel: "info",
};

await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(pkgDir, { recursive: true });
await copyAssets();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`watching… (load ${path.relative(root, pkgDir)}/ in Thunderbird)`);
} else {
  await esbuild.build(options);
  const xpi = path.join(root, "dist", `thundervim-${version}.xpi`);
  execFileSync(
    "zip",
    ["-r", "-X", xpi, "manifest.json", "compose.js", "statusbar.css"],
    { cwd: pkgDir, stdio: "ignore" },
  );
  console.log(`Built ${path.relative(root, xpi)}`);
}
