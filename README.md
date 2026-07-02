# Thundervim

Vim keybindings for editing **plain-text** email in the Thunderbird compose window.

Built and verified against **Thunderbird 152** (Manifest V3, `compose_scripts`).

## Scope (v1)

- **Plain-text compose only.** The rich-text (HTML) composer is out of scope; see
  [Composing in plain text](#composing-in-plain-text).
- Modes: **Normal**, **Insert**, **Visual** (charwise `v`) and **Visual Line** (`V`).
- The vim engine is pure and DOM-free (`src/engine.js`); a thin adapter
  (`src/compose.js`) bridges it to the compose editor. The engine is fully unit
  tested with `node --test` — no Thunderbird required.

## Supported commands

| Group | Keys |
| --- | --- |
| Motions | `h j k l`, `w W b B e E`, `ge` / `gE`, `0 ^ $`, `gg G`, `{ }`, with counts (`3w`, `5j`) |
| Find in line | `f{char}` `F{char}` `t{char}` `T{char}`, repeat with `;` / `,` (compose: `df,`, `ct)`) |
| Match bracket | `%` (jumps between `()`/`[]`/`{}`; works as an inclusive motion, e.g. `d%`, `c%`) |
| Enter insert | `i a I A o O` |
| Delete | `x`, `X`, `dd`, `d{motion}`, `D` |
| Change | `s`, `S`, `cc`, `c{motion}`, `C` (`cw` behaves like `ce`) |
| Join | `J`, `[count]J`, and `J` over a Visual selection |
| Indent | `>>` / `<<`, `>{motion}` / `<{motion}`, `>ip`, and Visual `>` / `<` (spaces, `shiftWidth` in `compose.js`) |
| Reflow | `gqq` / `[count]gqq`, `gq{motion}`, `gqip` / `gqap`, and Visual `gq` (wraps at `textWidth`, preserves quote leaders like `> `) |
| Yank / paste | `yy`, `y{motion}`, `p`, `P` (internal register, charwise + linewise) |
| Text objects | `{d,c,y}{i,a}{w W " ' ` ( ) b { } B [ ] < > p}` (e.g. `ciw`, `di"`, `ci(`, `daw`, `dip`); also selectable in Visual mode |
| Replace | `r{char}` |
| Case | `~` (toggle, with count), operators `gu` / `gU` / `g~` with motions/text objects (`gUiw`, `guap`), line forms `guu` / `gUU` / `g~~`, and Visual `u` / `U` / `~` |
| Repeat change | `.` (repeats the last change, including typed text; a count substitutes the recorded one) |
| Search | `/pat` `?pat` (literal, smartcase), `*` / `#` (whole word under cursor), `n` / `N` to step with wrap; matches highlight live while typing and persist until `Esc` |
| Undo / redo | `u`, `Ctrl-r` |
| Visual | `v`, `V`, then `d` / `c` / `y` on the selection |
| Leave insert | `Esc`, or the `jk` sequence |
| Toggle on/off | `Ctrl-Alt-V` |

Counts combine with operators (e.g. `2dd`, `d3w`). Yank/paste use an internal
register, so `y`/`p` never touch your system clipboard.

## Behavior notes

- **Default mode is Insert** when a compose window opens, so you can start typing
  immediately. Press `Esc` (or `jk`) to enter Normal mode.
- The current mode is shown in a **status bar** pinned to the bottom of the
  editor, and a **block cursor** highlights the character under the cursor in
  Normal/Visual mode. Both live outside the message body and are never sent.
- In Insert mode the native editor handles typing normally (IME, spellcheck and
  reply-quoting keep working); Thundervim only intercepts the keys that leave
  Insert mode.
- Any `Ctrl` / `Cmd` / `Alt` chord passes straight through to Thunderbird, so
  **Send** (`Ctrl-Enter`), **Save** (`Ctrl-S`), etc. still work. (`Ctrl-r` is the
  one exception — it is redo.)
- **Insert-mode escape:** `Esc` returns to Normal mode. An optional two-key
  escape sequence (e.g. `jk`) can be enabled via `insertEscapeSequence` in
  `src/compose.js` as a fallback if Thunderbird's window-level `Esc` proves
  unreliable. It is disabled by default, matching vanilla vim.

## Install (temporary add-on)

1. In Thunderbird: **Tools → Developer Tools → Debug Add-ons** (or go to
   `about:debugging#/runtime/this-firefox`).
2. Click **Load Temporary Add-on…** and select `thundervim/manifest.json`.
3. Open a **plain-text** compose window (see below) and start editing.

Temporary add-ons are removed when Thunderbird restarts. To install permanently
you must sign the add-on via [addons.thunderbird.net](https://addons.thunderbird.net)
or run an unbranded/Developer Edition build with signature enforcement disabled.

### Composing in plain text

Thundervim targets the plain-text composer. To open one:

- Hold **Shift** while clicking **Write** / **Reply**, or
- Set plain text as the default: **Settings → Composition** (or per-account
  *Account Settings → Composition & Addressing* → uncheck *Compose messages in
  HTML format*).

In an HTML compose window the engine still loads, but Normal-mode edits rewrite
the body as plain text and will strip formatting — so use it in plain-text mode.

## Configuration

All tunables are constants at the top of `src/compose.js`:

```js
var CONFIG = {
  enableOnStart: true,
  defaultMode: 'insert',              // 'insert' | 'normal'
  toggle: { ctrl: true, alt: true, key: 'v' },
  insertEscapeSequence: '',           // e.g. 'jk'; '' = only <Esc> leaves Insert
  escapeTimeoutMs: 500,
  shiftWidth: 4,                      // spaces for >> / <<
  textWidth: 72                       // wrap column for gq
};
```

## Development

```sh
cd thundervim
npm test          # runs the node:test engine suite (zero dependencies)
```

The engine suite (`test/engine.test.js`) covers motions, counts, operators,
undo/redo granularity, visual mode, and the insert/normal handoff. The adapter
(`src/compose.js`) is verified manually by loading the temporary add-on.

## Project layout

```
thundervim/
├── manifest.json         MV3 manifest; injects the compose script + CSS
├── src/
│   ├── engine.js         pure vim state machine (no DOM)
│   ├── compose.js        compose-window adapter (DOM <-> engine)
│   └── statusbar.css     mode status bar styling
└── test/
    └── engine.test.js    node --test unit suite
```

## Known limitations (v1)

- No `:` ex-commands, marks, named registers, or macros. These are deferred.
- Search is a literal substring match (no regex) and is not operator-pending
  (`d/pat` is unsupported); an empty query repeats the last search.
- `.` does not repeat Visual-mode operations or search/`n`.
- HTML compose is unsupported.
