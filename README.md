# Thundervim

Vim keybindings for editing email in Thunderbird's compose window.

Write email the way you edit code: Normal / Insert / Visual modes, motions,
operators, text objects, search, and paragraph reflow — all inside the
Thunderbird composer, with a mode line and block cursor to match. Works in both
plain-text and rich-text (HTML) compose windows; in HTML, existing formatting
(quoted replies, signatures, bold, links) is preserved while you edit the text.

## Requirements

- **Thunderbird 151 or newer** (developed and tested against 152).
- Works in both plain-text and HTML compose windows. Plain text is the most
  battle-tested; HTML support preserves formatting but is newer — see
  [Rich text (HTML)](#rich-text-html).

## Install

### Permanent (recommended)

Once published, install Thundervim from
[addons.thunderbird.net](https://addons.thunderbird.net). Store builds are
signed, so they survive restarts and update automatically. *(Listing pending.)*

### Try it now (temporary add-on)

You can load the add-on without signing; it stays until you restart Thunderbird.

1. Download `thundervim-<version>.xpi` from the
   [Releases](../../releases) page (or build it yourself — see
   [CONTRIBUTING.md](CONTRIBUTING.md)).
2. In Thunderbird: **Tools → Developer Tools → Debug Add-ons**
   (or open `about:debugging#/runtime/this-firefox`).
3. Click **Load Temporary Add-on…** and select the `.xpi` (or this project's
   `manifest.json`).
4. Open a plain-text compose window and start editing.

Permanent installation of an unsigned build is only possible on
Developer/unbranded Thunderbird with signature enforcement disabled.

## Rich text (HTML)

Thundervim works in both compose modes:

- **Plain text** is the most thoroughly tested. To compose in plain text, hold
  **Shift** while clicking **Write** / **Reply**, or make it the default under
  **Settings → Composition** (or per-account *Account Settings → Composition &
  Addressing* → uncheck *Compose messages in HTML format*).
- **HTML** is supported by editing the text in place while leaving existing
  markup untouched: quote levels, signatures, bold, links, and other formatting
  are preserved as you navigate and edit. Vim itself doesn't *author* new rich
  formatting (that isn't a vim concept), but Thunderbird's own shortcuts
  (`Ctrl-B`, etc.) still work in Insert mode.

HTML support is newer than the plain-text path; if a structural edit ever
misbehaves on a complex message, please file an issue.

## Commands

| Group | Keys |
| --- | --- |
| Motions | `h j k l`, `w W b B e E`, `ge` / `gE`, `0 ^ $`, `gg G`, `{ }`, with counts (`3w`, `5j`) |
| Find in line | `f{char}` `F{char}` `t{char}` `T{char}`, repeat with `;` / `,` (e.g. `df,`, `ct)`) |
| Match bracket | `%` (jumps between `()`/`[]`/`{}`; also an inclusive motion, e.g. `d%`, `c%`) |
| Enter insert | `i a I A o O` |
| Delete | `x`, `X`, `dd`, `d{motion}`, `D` |
| Change | `s`, `S`, `cc`, `c{motion}`, `C` (`cw` behaves like `ce`) |
| Join | `J`, `[count]J`, and `J` over a Visual selection |
| Indent | `>>` / `<<`, `>{motion}` / `<{motion}`, `>ip`, and Visual `>` / `<` |
| Reflow | `gqq` / `[count]gqq`, `gq{motion}`, `gqip` / `gqap`, and Visual `gq` (wraps at column 72, keeps quote markers like `> `) |
| Yank / paste | `yy`, `y{motion}`, `p`, `P` |
| Text objects | `{d,c,y}{i,a}{w W " ' ` ( ) b { } B [ ] < > p}` (e.g. `ciw`, `di"`, `ci(`, `daw`, `dip`); also selectable in Visual mode |
| Replace | `r{char}` |
| Case | `~` (with count), operators `gu` / `gU` / `g~` with motions/text objects (`gUiw`, `guap`), line forms `guu` / `gUU` / `g~~`, and Visual `u` / `U` / `~` |
| Repeat change | `.` (repeats the last change, including typed text; a count substitutes the recorded one) |
| Search | `/pat` `?pat` (smartcase), `*` / `#` (word under cursor), `n` / `N` to step; matches highlight while typing and persist until `Esc` |
| Undo / redo | `u`, `Ctrl-r` |
| Visual | `v`, `V`, then `d` / `c` / `y` on the selection |
| Leave insert | `Esc` |
| Toggle on/off | `Ctrl-Alt-V` |

Counts combine with operators (e.g. `2dd`, `d3w`). Yank/paste use an internal
register, so `y` / `p` never touch your system clipboard — **nothing you edit
leaves your machine.**

## Modes and the status bar

- **Insert mode is the default** when a compose window opens, so you can type
  right away. Press `Esc` to enter Normal mode.
- A **status bar** is pinned to the bottom of the editor showing the current
  mode, plus a vim-style **ruler** on the right with the cursor's `line,column`
  and its `Top` / `Bot` / `All` / percentage position through the message.
- A **block cursor** marks the character under the cursor in Normal / Visual
  mode. The status bar and cursor live outside the message body and are never
  sent.
- In Insert mode the native editor handles typing (IME, spellcheck, and
  reply-quoting all keep working); Thundervim only intercepts the keys that
  leave Insert mode.
- Any `Ctrl` / `Cmd` / `Alt` chord passes straight through to Thunderbird, so
  **Send** (`Ctrl-Enter`), **Save** (`Ctrl-S`), and friends still work. The one
  exception is `Ctrl-r`, which is redo.

## Configuration

Thundervim has no options screen yet. The tunables are constants at the top of
`src/compose.js` — edit them and reload the add-on:

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

`insertEscapeSequence` is off by default (matching vanilla vim, where only
`Esc` leaves Insert mode). Set it to a two-key pair like `'jk'` if you want the
classic escape shortcut as a fallback.

## Limitations

- No `:` ex-commands, marks, named registers, or macros.
- Search is a literal (non-regex) substring match and is not operator-pending
  (`d/pat` is unsupported); an empty query repeats the last search.
- `.` does not repeat Visual-mode operations or `n` / search.
- In HTML, vim edits existing text and preserves formatting but does not author
  new rich formatting (bold/italic/lists) on its own.

## Contributing

Bug reports, ideas, and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the architecture, how to run the tests,
and how to build the package.
