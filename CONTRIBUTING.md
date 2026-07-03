# Contributing to Thundervim

Thanks for your interest in improving Thundervim! This document covers the
architecture, local development, testing, and how releases are built.

## Architecture

Thundervim is split into two pieces with a hard boundary between them:

- **`src/engine.ts` — a pure, DOM-free vim state machine.** It operates on a
  plain `State` object (`text`, `cursor`, `mode`, registers, undo stack,
  pending operator, search state, …) and never touches the DOM. Every keystroke
  is `handleKey(state, event)`. Because it has no environment dependencies, it
  is fully unit-tested under `node --test` with zero Thunderbird involvement.
- **`src/compose.ts` — a thin adapter.** This is the only file that talks to the
  Thunderbird compose window: it reads the contenteditable body, forwards keys
  to the engine, and renders the engine's state back (buffer text, block cursor,
  highlights, status bar). All user-facing settings live in the `CONFIG` object
  at the top. It `import`s the engine directly; the two are bundled into one
  content script at build time.

Keeping logic in the engine (and out of the adapter) is the core design rule:
if a change can be expressed as engine state, it belongs in `engine.ts` with a
test, not in the adapter.

### Rendering: formatting-preserving diff writes

The adapter never rebuilds the compose body wholesale (doing so would flatten
HTML formatting). Instead, after every command it diffs the engine's new
`state.text` against the DOM's current serialization and applies only the
changed span:

- `readBuffer()` serializes the live DOM to a linear string (block elements and
  `<br>` become `\n`); `domPointAt()` maps a linear offset back to a DOM point.
  **These two must stay in lockstep** — `domPointAt` mirrors `readBuffer`'s
  block-boundary newline accounting, or offsets desync in a rich DOM.
- `applyEdit()` computes the single changed span (common prefix/suffix). Its
  **fast path** handles edits within one text node by splicing that node's
  character data — exact and formatting-safe. Its **general path** (edits that
  cross a text-node / `<br>` / block boundary) uses range surgery, then verifies
  it reproduced `newText`; if not, it falls back to the flat `writeBuffer`
  (which loses formatting but keeps the model consistent).
- Newlines introduced by edits are stored as literal `\n` characters rendered
  via `white-space: pre-wrap`, which both `readBuffer` and `domPointAt` count
  identically.

In Insert mode the native editor edits the DOM directly; the engine re-syncs
from `readBuffer()` on `Esc`.

## Project layout

```
thundervim/
├── manifest.json              MV3 manifest; injects the compose script + CSS
├── package.json               npm scripts (typecheck, test, check, build)
├── tsconfig.json              strict TypeScript config
├── src/
│   ├── engine.ts              pure vim state machine (no DOM)
│   ├── compose.ts             compose-window adapter (DOM <-> engine)
│   └── statusbar.css          status bar + block cursor styling
├── test/
│   └── engine.test.ts         node --test unit suite for the engine
├── scripts/
│   └── build.js               bundles + packages the add-on into dist/
└── .github/workflows/         CI (typecheck + test + package) and release
```

## Prerequisites

- **Node.js 24+** — the test suite runs `.ts` files directly via Node's native
  type stripping, and the build uses esbuild.
- **`zip`** on your PATH (used by the build script; preinstalled on macOS and
  most Linux distros).
- Install dev dependencies once with `npm install` (TypeScript + esbuild).

## Development workflow

```sh
npm run typecheck   # tsc --noEmit (strict)
npm test            # runs the node:test engine suite on the .ts sources
npm run check       # typecheck + test
```

The engine suite covers motions, counts, operators, text objects, undo/redo
granularity, visual mode, search, reflow, and the insert/normal handoff. Add a
test for every engine-level change — it's the fastest feedback loop and the only
thing CI runs.

### Testing in Thunderbird

The adapter (`src/compose.ts`) can't be unit-tested, so verify it by building
and loading the add-on:

1. `npm run build` (or `npm run watch` to rebuild on every save).
2. **Tools → Developer Tools → Debug Add-ons** (or `about:debugging`).
3. **Load Temporary Add-on…** → select **`dist/thundervim/manifest.json`** (the
   built, unpacked package — not the repo-root manifest).
4. Open a compose window and exercise your change. With `npm run watch` running,
   just click **Reload** on the Debug Add-ons page after each edit.

## Adding a command to the engine

A few conventions worth knowing before you touch `engine.ts`:

- **Operators** live in `state.pending.op` and must be handled in *both*
  `applyOperator` (for motions) and `applyRange` (for text objects). Doubled
  forms (`dd`, `>>`, `gqq`) and `g`-prefixed forms are dispatched explicitly.
- **Motions** return `{ pos, kind }` where `kind` is `excl`, `incl`,
  `incl-eol`, or `line`. `MOTION_KEYS` gates which keys dispatch as motions.
- **Dot-repeat** records the Normal-mode key sequence; insert-involving changes
  are captured by the adapter and replayed. Don't record undo/redo/`.` itself.

When in doubt, copy the structure of an existing, similar command and mirror it
everywhere it's referenced.

## Building the package

```sh
npm run build
```

This bundles `src/compose.ts` + `src/engine.ts` into a single content script and
produces both a loadable, unpacked package at `dist/thundervim/` and
`dist/thundervim-<version>.xpi` (a zip with `manifest.json` at the root plus the
bundled `compose.js` and `statusbar.css`, and nothing else — no tests, TypeScript
sources, or tooling). The `.xpi` is what you submit to
[addons.thunderbird.net](https://addons.thunderbird.net) or load temporarily.

## Continuous integration

- **`.github/workflows/ci.yml`** runs on every push to `main` and on pull
  requests (Node 24): `npm run typecheck`, `npm test`, then builds the `.xpi`
  and uploads it as a build artifact.
- **`.github/workflows/release.yml`** runs when a `v*` tag is pushed. It verifies
  the tag matches `manifest.json`'s `version`, type-checks, runs the tests,
  builds the `.xpi`, and publishes a GitHub Release with the package attached.

## Cutting a release

1. Bump `version` in **both** `manifest.json` and `package.json` (keep them in
   sync — the release workflow fails otherwise).
2. Commit the bump.
3. Tag and push:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. The release workflow builds `thundervim-0.2.0.xpi` and attaches it to the
   GitHub Release. Download it there, then upload to addons.thunderbird.net to
   ship a signed build.

## Code style

- Idiomatic, strict TypeScript compiled with no emit checks (`tsc --noEmit`) and
  bundled with esbuild. Source uses ES modules and erasable-only type syntax
  (no `enum`/`namespace`) so Node can run the tests directly.
- Match the surrounding style; keep the engine pure and the adapter thin.
- Comment intent and non-obvious constraints, not the obvious.
