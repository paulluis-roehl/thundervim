"use strict";

const test = require("node:test");
const assert = require("node:assert");
const vim = require("../src/engine.js");

// ---- helpers ---------------------------------------------------------------

// Build a normalized key event from a compact spec:
//   'a'         -> plain key 'a'
//   '<Esc>'     -> Escape
//   '<C-r>'     -> Ctrl-r
function ev(spec) {
  if (spec === "<Esc>") return { key: "Escape" };
  const m = /^<C-(.)>$/.exec(spec);
  if (m) return { key: m[1], ctrl: true };
  return { key: spec };
}

// Feed a sequence of key specs. A plain string is treated as one key per char.
function feed(state, seq) {
  const specs = Array.isArray(seq) ? seq : seq.split("");
  for (const s of specs) vim.handleKey(state, ev(s));
  return state;
}

// Start a state already in Normal mode with the cursor at `cursor`.
function normal(text, cursor = 0) {
  const s = vim.createState(text, cursor);
  s.mode = vim.MODE.NORMAL;
  s.cursor = vim.clampNormal(text, cursor);
  return s;
}

// ---- motions ---------------------------------------------------------------

test("h/l stay within the line", () => {
  const s = normal("hello", 0);
  feed(s, "lll");
  assert.strictEqual(s.cursor, 3);
  feed(s, "llllll"); // clamps at last char
  assert.strictEqual(s.cursor, 4);
  feed(s, "hhhhhh"); // clamps at line start
  assert.strictEqual(s.cursor, 0);
});

test("word motions w/b/e", () => {
  const s = normal("foo bar baz", 0);
  feed(s, "w");
  assert.strictEqual(s.cursor, 4);
  feed(s, "w");
  assert.strictEqual(s.cursor, 8);
  feed(s, "e");
  assert.strictEqual(s.cursor, 10);
  feed(s, "b");
  assert.strictEqual(s.cursor, 8);
});

test("0, ^ and $", () => {
  const s = normal("  hi there", 5);
  feed(s, "0");
  assert.strictEqual(s.cursor, 0);
  feed(s, "^");
  assert.strictEqual(s.cursor, 2);
  feed(s, "$");
  assert.strictEqual(s.cursor, 9);
});

test("counts multiply motions", () => {
  const s = normal("abcdefgh", 0);
  feed(s, "3l");
  assert.strictEqual(s.cursor, 3);
  feed(s, "2l");
  assert.strictEqual(s.cursor, 5);
});

test("j/k keep desired column", () => {
  const s = normal("long line here\nx\nanother long line", 5);
  feed(s, "j"); // short line -> clamp to its last char
  assert.strictEqual(s.cursor, 15);
  feed(s, "j"); // restore column 5 on the long line
  const lineStart = "long line here\nx\n".length;
  assert.strictEqual(s.cursor, lineStart + 5);
});

test("gg and G", () => {
  const s = normal("one\ntwo\nthree", 0);
  feed(s, "G");
  assert.strictEqual(vim.lineStartAt(s.text, s.cursor), "one\ntwo\n".length);
  feed(s, ["g", "g"]);
  assert.strictEqual(s.cursor, 0);
});

// ---- insert entry ----------------------------------------------------------

test("i enters insert without moving", () => {
  const s = normal("abc", 1);
  feed(s, "i");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.cursor, 1);
});

test("a moves right then inserts", () => {
  const s = normal("abc", 1);
  feed(s, "a");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.cursor, 2);
});

test("A jumps to end of line", () => {
  const s = normal("abc\ndef", 0);
  feed(s, "A");
  assert.strictEqual(s.cursor, 3);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("o opens a line below", () => {
  const s = normal("abc\ndef", 1);
  feed(s, "o");
  assert.strictEqual(s.text, "abc\n\ndef");
  assert.strictEqual(s.cursor, 4);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("O opens a line above", () => {
  const s = normal("abc\ndef", 5);
  feed(s, "O");
  assert.strictEqual(s.text, "abc\n\ndef");
  assert.strictEqual(s.cursor, 4);
});

// ---- delete / change / yank / paste ---------------------------------------

test("x deletes the character under the cursor", () => {
  const s = normal("hello", 1);
  feed(s, "x");
  assert.strictEqual(s.text, "hllo");
  assert.strictEqual(s.cursor, 1);
});

test("x with count", () => {
  const s = normal("hello", 0);
  feed(s, "3x");
  assert.strictEqual(s.text, "lo");
});

test("dw deletes a word", () => {
  const s = normal("foo bar baz", 0);
  feed(s, "dw");
  assert.strictEqual(s.text, "bar baz");
  assert.strictEqual(s.cursor, 0);
});

test("de deletes to end of word (inclusive)", () => {
  const s = normal("foo bar", 0);
  feed(s, "de");
  assert.strictEqual(s.text, " bar");
});

test("dd deletes a whole line", () => {
  const s = normal("one\ntwo\nthree", 4);
  feed(s, "dd");
  assert.strictEqual(s.text, "one\nthree");
});

test("dd on the last line consumes the preceding newline", () => {
  const s = normal("one\ntwo", 4);
  feed(s, "dd");
  assert.strictEqual(s.text, "one");
});

test("2dd deletes two lines", () => {
  const s = normal("a\nb\nc\nd", 0);
  feed(s, ["2", "d", "d"]);
  assert.strictEqual(s.text, "c\nd");
});

test("D deletes to end of line", () => {
  const s = normal("hello world", 5);
  feed(s, "D");
  assert.strictEqual(s.text, "hello");
});

test("cw changes a word and enters insert", () => {
  const s = normal("foo bar", 0);
  feed(s, "cw");
  assert.strictEqual(s.text, " bar");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("yy then p pastes a line below", () => {
  const s = normal("one\ntwo", 0);
  feed(s, ["y", "y"]);
  feed(s, "p");
  assert.strictEqual(s.text, "one\none\ntwo");
});

test("yw then p pastes charwise after cursor", () => {
  const s = normal("foo bar", 0);
  feed(s, ["y", "w"]); // yanks "foo "
  feed(s, "p");
  assert.strictEqual(s.text, "ffoo oo bar");
});

test("dd then p round-trips a line", () => {
  const s = normal("one\ntwo\nthree", 0);
  feed(s, ["d", "d"]); // delete "one"
  feed(s, "p"); // paste below current line (two)
  assert.strictEqual(s.text, "two\none\nthree");
});

test("r replaces a single character", () => {
  const s = normal("cat", 0);
  feed(s, ["r", "b"]);
  assert.strictEqual(s.text, "bat");
  assert.strictEqual(s.cursor, 0);
});

// ---- undo / redo -----------------------------------------------------------

test("u undoes and Ctrl-r redoes a delete", () => {
  const s = normal("hello", 0);
  feed(s, "x");
  assert.strictEqual(s.text, "ello");
  feed(s, "u");
  assert.strictEqual(s.text, "hello");
  feed(s, ["<C-r>"]);
  assert.strictEqual(s.text, "ello");
});

test("undo granularity is per command (dd is one undo)", () => {
  const s = normal("a\nb\nc", 0);
  feed(s, ["d", "d"]);
  feed(s, ["d", "d"]);
  assert.strictEqual(s.text, "c");
  feed(s, "u");
  assert.strictEqual(s.text, "b\nc");
  feed(s, "u");
  assert.strictEqual(s.text, "a\nb\nc");
});

// ---- visual mode -----------------------------------------------------------

test("visual v + l + d deletes the selection (inclusive)", () => {
  const s = normal("hello", 0);
  feed(s, "v");
  feed(s, "l"); // select "he"
  feed(s, "d");
  assert.strictEqual(s.text, "llo");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
});

test("visual line V + d deletes whole lines", () => {
  const s = normal("one\ntwo\nthree", 4);
  feed(s, "V");
  feed(s, "d");
  assert.strictEqual(s.text, "one\nthree");
});

test("visual y yanks and returns to normal, p pastes", () => {
  const s = normal("abcdef", 0);
  feed(s, "v");
  feed(s, "ll"); // select "abc"
  feed(s, "y");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
  assert.strictEqual(s.cursor, 0);
  feed(s, "p");
  assert.strictEqual(s.text, "aabcbcdef");
});

// ---- Escape / insert handoff ----------------------------------------------

test("Escape from insert moves cursor left and returns to normal", () => {
  const s = vim.createState("hello", 5); // insert mode, cursor at end
  feed(s, ["<Esc>"]);
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
  assert.strictEqual(s.cursor, 4);
});

test("engine does not handle plain keys in insert mode", () => {
  const s = vim.createState("", 0);
  const r = vim.handleKey(s, ev("a"));
  assert.strictEqual(r.handled, false);
});

test("normal mode swallows stray printable keys", () => {
  const s = normal("abc", 0);
  const r = vim.handleKey(s, ev("z"));
  assert.strictEqual(r.handled, true);
  assert.strictEqual(s.text, "abc");
});

// ---- text objects ----------------------------------------------------------

test("ciw changes the inner word", () => {
  const s = normal("foo bar baz", 5); // on 'a' of bar
  feed(s, "ciw");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.text, "foo  baz");
  assert.strictEqual(s.cursor, 4);
});

test("daw deletes a word including trailing space", () => {
  const s = normal("foo bar baz", 4); // on 'b' of bar
  feed(s, "daw");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
  assert.strictEqual(s.text, "foo baz");
});

test("ci( changes inside parentheses", () => {
  const s = normal("call(a, b)", 6); // inside parens
  feed(s, ["c", "i", "("]);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.text, "call()");
  assert.strictEqual(s.cursor, 5);
});

test("ci( works from the cursor on the opening paren", () => {
  const s = normal("call(a, b)", 4); // on '('
  feed(s, ["c", "i", "("]);
  assert.strictEqual(s.text, "call()");
});

test('di" deletes inside double quotes', () => {
  const s = normal('say "hi" now', 6); // inside quotes
  feed(s, ["d", "i", '"']);
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
  assert.strictEqual(s.text, 'say "" now');
});

test("da( deletes around parentheses", () => {
  const s = normal("x(y)z", 2); // inside
  feed(s, ["d", "a", "("]);
  assert.strictEqual(s.text, "xz");
});

test("ci( picks the innermost of nested pairs", () => {
  const s = normal("a(b(c)d)e", 4); // on 'c' inside inner pair
  feed(s, ["c", "i", "("]);
  assert.strictEqual(s.text, "a(b()d)e");
});

test("ci{ works via the B alias too", () => {
  const s = normal("fn { body }", 6);
  feed(s, ["c", "i", "B"]);
  assert.strictEqual(s.text, "fn {}");
});

test("visual i( selects inside parentheses", () => {
  const s = normal("call(a, b)", 6);
  feed(s, ["v", "i", "("]);
  assert.strictEqual(s.mode, vim.MODE.VISUAL);
  assert.strictEqual(s.anchor, 5);
  assert.strictEqual(s.cursor, 8); // last char inside parens ('b')
  feed(s, "d");
  assert.strictEqual(s.text, "call()");
});

test("yiw yanks the inner word without changing text", () => {
  const s = normal("foo bar", 0);
  feed(s, "yiw");
  assert.strictEqual(s.text, "foo bar");
  assert.strictEqual(s.register.text, "foo");
  assert.strictEqual(s.register.linewise, false);
});

test("dip deletes the inner paragraph", () => {
  const s = normal("a\nb\n\nc", 0);
  feed(s, ["d", "i", "p"]);
  assert.strictEqual(s.text, "\n\nc");
});
