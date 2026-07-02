# Changelog

## v0.2.0

New editing commands and a batch of rich-text (HTML) fixes.

### Added

- **Sentence text object** `s`: `das`, `dis`, `cas`, `cis`, `yas`, and Visual
  `as` / `is`. A sentence ends at `.`, `!`, or `?` (with any trailing `)`, `]`,
  `"`, `'`) followed by whitespace, and never crosses a blank line.
- **`r<Enter>`** replaces the character under the cursor with a newline, so you
  can break a line in place (e.g. turn a space into a line break). Works with a
  count (`3r<Enter>` collapses several characters into one break).

### Fixed

- Formatting shortcuts and the toolbar work again in HTML compose windows.
  `Cmd`/`Ctrl` + B/I/U now apply to the vim Visual selection, and clicking a
  toolbar button no longer stops working after a vim edit.
- Clipboard and undo shortcuts (`Cmd`/`Ctrl` + C/V/X/Z) pass through cleanly in
  every mode, with the engine resyncing after a native edit so vim motions stay
  accurate.

## v0.1.0 — first release

**Welcome to ThunderVIM!**

If you've ever finished writing an email and instinctively reached for `dd` or
`ciw`, this one's for you. Thundervim brings vim keybindings into Thunderbird's
compose window, so you can write mail the same way you write code — Normal,
Insert, and Visual modes, motions, operators, text objects, search, and all.

This is the very first public build. It's been in daily use and the plain-text
path is well tested, but you're among the first to try it — feedback and bug
reports are hugely appreciated.

### What you get

- **Modes** — Normal / Insert / Visual (and Visual-line), with a pinned status
  bar and a block cursor so you always know where you are.
- **Motions** — `h j k l`, `w W b B e E`, `ge`/`gE`, `0 ^ $`, `gg G`, `{ }`,
  `f F t T` with `;`/`,`, and `%` to hop between brackets. Counts work
  everywhere (`3w`, `2dd`, `d3w`).
- **Operators & text objects** — `d c y`, `x s`, the `D C S` line forms, and the
  full `i`/`a` text objects (`ciw`, `di"`, `ci(`, `daw`, `dip`, …).
- **Editing niceties** — join (`J`), indent (`>>` / `<<` / `>ip`), case
  (`~`, `gu`, `gU`, `g~`), replace (`r`), and repeat with `.`.
- **Reflow** — `gq` wraps paragraphs at column 72 and keeps quote markers
  (`> `) intact, which is exactly what you want in a reply.
- **Search** — `/` and `?` with smartcase, `*` / `#` for the word under the
  cursor, and `n` / `N` to step. Matches highlight as you type.
- **Undo / redo** — vim's own `u` and `Ctrl-r`, with an independent undo stack.
- **Private by design** — `y` / `p` use an internal register, so nothing you
  edit ever touches the system clipboard or leaves your machine. The status bar
  and cursor live outside the message body and are never sent.

### Rich text (HTML)

Thundervim works in both plain-text and HTML compose windows. In HTML, it edits
the text in place while leaving your existing formatting — quoted replies,
signatures, bold, links — untouched. Thunderbird's own shortcuts (Cmd/Ctrl-B,
-I, -U) keep working for bold/italic/underline, including over a Visual
selection. Vim itself doesn't author new rich formatting, since that isn't a vim
concept.

### Getting started

- **Insert mode is the default** when a compose window opens, so you can just
  start typing. Press `Esc` to drop into Normal mode.
- Toggle Thundervim on and off any time with `Ctrl-Alt-V`.
- `Ctrl-Enter` (Send), `Ctrl-S` (Save), and other app shortcuts pass straight
  through.

To try it now, grab `thundervim-0.1.0.xpi` from the release assets and load it
via **Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on…**. See
the [README](README.md) for full install instructions and the complete command
reference.

### Good to know

- There's no options screen yet — settings live as constants at the top of
  `src/compose.js` (wrap column, toggle chord, optional `jk` escape, …).
- Search is a literal substring match, not regex, and isn't operator-pending
  (`d/pat` isn't supported yet).
- `.` doesn't repeat Visual-mode operations or searches.
- No `:` ex-commands, marks, named registers, or macros.
- HTML support is newer than the plain-text path; if a structural edit ever
  misbehaves on a complex message, please file an issue.

Happy editing — and may you never touch the mouse again.
