# Contributing to Thundervim

Thanks for your interest in improving Thundervim! This document covers the
architecture, local development, testing, and how releases are built.

## Architecture

Thundervim is split into two pieces with a hard boundary between them:

- **`src/engine.js` — a pure, DOM-free vim state machine.** It operates on a
  plain `state` object (`text`, `cursor`, `mode`, registers, undo stack,
  pending operator, search state, …) and never touches the DOM. Every keystroke
  is `handleKey(state, event)`. Because it has no environment dependencies, it
  is fully unit-tested under `node --test` with zero Thunderbird involvement.
- **`src/compose.js` — a thin adapter.** This is the only file that talks to the
  Thunderbird compose window: it reads the contenteditable body, forwards keys
  to the engine, and renders the engine's state back (buffer text, block cursor,
  highlights, status bar). All user-facing settings live in the `CONFIG` object
  at the top.

Keeping logic in the engine (and out of the adapter) is the core design rule:
if a change can be expressed as engine state, it belongs in `engine.js` with a
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
├── package.json               npm scripts (test, check, build)
├── src/
│   ├── engine.js              pure vim state machine (no DOM)
│   ├── compose.js             compose-window adapter (DOM <-> engine)
│   └── statusbar.css          status bar + block cursor styling
├── test/
│   └── engine.test.js         node --test unit suite for the engine
├── scripts/
│   └── build.sh               packages the add-on into dist/*.xpi
└── .github/workflows/         CI (test + package) and release automation
```

## Prerequisites

- **Node.js 18+** (for `node --test`; no npm dependencies are installed).
- **`zip`** on your PATH (used by the build script; preinstalled on macOS and
  most Linux distros).

## Development workflow

```sh
npm run check   # node --check on both source files
npm test        # runs the node:test engine suite
```

The engine suite covers motions, counts, operators, text objects, undo/redo
granularity, visual mode, search, reflow, and the insert/normal handoff. Add a
test for every engine-level change — it's the fastest feedback loop and the only
thing CI runs.

### Testing in Thunderbird

The adapter (`src/compose.js`) can't be unit-tested, so verify it by loading the
add-on:

1. **Tools → Developer Tools → Debug Add-ons** (or `about:debugging`).
2. **Load Temporary Add-on…** → select `manifest.json`.
3. Open a plain-text compose window and exercise your change. Reload the add-on
   from the same page after each edit.

The browser console (from the Debug Add-ons page) surfaces any adapter errors.

## Adding a command to the engine

A few conventions worth knowing before you touch `engine.js`:

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

This produces `dist/thundervim-<version>.xpi` — a zip with `manifest.json` at
the root and the `src/` files the extension loads, and nothing else (no tests
or tooling). The `.xpi` is what you submit to
[addons.thunderbird.net](https://addons.thunderbird.net) or load temporarily.

## Continuous integration

- **`.github/workflows/ci.yml`** runs on every push to `main` and on pull
  requests: `npm run check` and `npm test` across Node 18/20/22, then builds the
  `.xpi` and uploads it as a build artifact.
- **`.github/workflows/release.yml`** runs when a `v*` tag is pushed. It verifies
  the tag matches `manifest.json`'s `version`, runs the tests, builds the
  `.xpi`, and publishes a GitHub Release with the package attached.

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

- Plain ES5-ish JavaScript, no build step, no runtime dependencies.
- Match the surrounding style; keep the engine pure and the adapter thin.
- Comment intent and non-obvious constraints, not the obvious.
