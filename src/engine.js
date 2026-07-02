// Thundervim engine — a pure, DOM-free vim state machine.
//
// It operates on an abstract buffer state:
//   { text, cursor, mode, register, undoStack, redoStack, pending, desiredCol, anchor }
//
// `cursor` is an offset into `text` in the range [0, text.length] and is
// interpreted as the character the cursor sits ON (vim style). Lines are
// separated by "\n".
//
// The engine has no knowledge of Thunderbird or the DOM. The compose-window
// adapter feeds it normalized key events and applies the resulting
// {text, cursor, mode} back onto the editor.
//
// Public API:
//   createState(text, cursor)      -> state
//   handleKey(state, ev)           -> { state, handled }
//   syncFromEditor(state, text, c) -> state   (call when returning from Insert)
//
// `ev` is a normalized key: { key, shift, ctrl, alt, meta }.

(function (root) {
  "use strict";

  var MODE = {
    NORMAL: "normal",
    INSERT: "insert",
    VISUAL: "visual",
    VLINE: "visual-line",
  };
  var MAX_UNDO = 500;
  var SHIFTWIDTH = 4; // spaces inserted/removed by >> and <<
  var TEXTWIDTH = 72; // gq wrap column (mirrors Thunderbird's mailnews.wraplength)

  // ---- buffer helpers -------------------------------------------------------

  function lineStartAt(text, pos) {
    return text.lastIndexOf("\n", pos - 1) + 1;
  }
  function lineEndAt(text, pos) {
    var i = text.indexOf("\n", pos);
    return i === -1 ? text.length : i;
  }
  function buildLines(text) {
    var lines = [];
    var start = 0;
    for (var i = 0; i <= text.length; i++) {
      if (i === text.length || text[i] === "\n") {
        lines.push({ start: start, end: i });
        start = i + 1;
      }
    }
    return lines;
  }
  function lineOf(lines, pos) {
    for (var i = 0; i < lines.length; i++) {
      if (pos >= lines[i].start && pos <= lines[i].end) return i;
    }
    return lines.length - 1;
  }
  // Clamp a cursor so it sits on a real character (never on the trailing "\n",
  // unless the line is empty).
  function clampNormal(text, pos) {
    if (pos < 0) pos = 0;
    if (pos > text.length) pos = text.length;
    var ls = lineStartAt(text, pos);
    var le = lineEndAt(text, pos);
    if (le > ls) {
      if (pos > le - 1) pos = le - 1;
    } else {
      pos = ls;
    }
    if (pos < ls) pos = ls;
    return pos;
  }
  function firstNonBlank(text, pos) {
    var ls = lineStartAt(text, pos);
    var le = lineEndAt(text, pos);
    var i = ls;
    while (i < le && (text[i] === " " || text[i] === "\t")) i++;
    return i < le ? i : ls;
  }

  function isWordChar(ch) {
    return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  }

  // Character classes for word motions. 0 = whitespace, 1 = word, 2 = punct.
  function classAt(text, i, big) {
    var ch = text[i];
    if (ch === undefined) return -1;
    if (ch === "\n" || ch === " " || ch === "\t") return 0;
    if (big) return 1;
    return /[A-Za-z0-9_]/.test(ch) ? 1 : 2;
  }
  function wordForward(text, pos, big) {
    var n = text.length;
    var i = pos;
    if (i >= n) return n;
    var start = classAt(text, i, big);
    if (start !== 0) while (i < n && classAt(text, i, big) === start) i++;
    while (i < n && classAt(text, i, big) === 0) i++;
    return i;
  }
  function wordEnd(text, pos, big) {
    var n = text.length;
    var i = pos + 1;
    while (i < n && classAt(text, i, big) === 0) i++;
    if (i >= n) return Math.max(pos, n - 1);
    var c = classAt(text, i, big);
    while (i + 1 < n && classAt(text, i + 1, big) === c) i++;
    return i;
  }
  function wordBack(text, pos, big) {
    var i = pos - 1;
    while (i > 0 && classAt(text, i, big) === 0) i--;
    if (i <= 0) return 0;
    var c = classAt(text, i, big);
    while (i - 1 >= 0 && classAt(text, i - 1, big) === c) i--;
    return i;
  }
  // Backward to the end of the previous word (the reverse of `e`).
  function wordEndBack(text, pos, big) {
    for (var i = pos - 1; i >= 0; i--) {
      var c = classAt(text, i, big);
      if (c !== 0 && classAt(text, i + 1, big) !== c) return i;
    }
    return 0;
  }
  function paragraphForward(text, pos) {
    var lines = buildLines(text);
    var li = lineOf(lines, pos);
    for (var i = li + 1; i < lines.length; i++) {
      if (lines[i].end === lines[i].start) return lines[i].start;
    }
    return text.length;
  }
  function paragraphBack(text, pos) {
    var lines = buildLines(text);
    var li = lineOf(lines, pos);
    for (var i = li - 1; i >= 0; i--) {
      if (lines[i].end === lines[i].start) return lines[i].start;
    }
    return 0;
  }

  // ---- text objects ---------------------------------------------------------

  // Resolve a text object (iw, aw, i(, a", ip, ...) into a { start, end } range.
  function resolveTextObject(state, inner, key) {
    var text = state.text;
    var pos = state.cursor;
    switch (key) {
      case "w":
        return wordObject(text, pos, inner, false);
      case "W":
        return wordObject(text, pos, inner, true);
      case '"':
        return quoteObject(text, pos, inner, '"');
      case "'":
        return quoteObject(text, pos, inner, "'");
      case "`":
        return quoteObject(text, pos, inner, "`");
      case "(":
      case ")":
      case "b":
        return pairObject(text, pos, inner, "(", ")");
      case "{":
      case "}":
      case "B":
        return pairObject(text, pos, inner, "{", "}");
      case "[":
      case "]":
        return pairObject(text, pos, inner, "[", "]");
      case "<":
      case ">":
        return pairObject(text, pos, inner, "<", ">");
      case "p":
        return paragraphObject(text, pos, inner);
      case "s":
        return sentenceObject(text, pos, inner);
      default:
        return null;
    }
  }

  function wordObject(text, pos, inner, big) {
    if (text.length === 0) return { start: 0, end: 0 };
    if (pos >= text.length) pos = text.length - 1;
    var cl = classAt(text, pos, big);
    var s = pos,
      e = pos;
    while (s > 0 && classAt(text, s - 1, big) === cl) s--;
    while (e + 1 < text.length && classAt(text, e + 1, big) === cl) e++;
    var start = s,
      end = e + 1;
    if (!inner) {
      var te = end;
      while (
        te < text.length &&
        text[te] !== "\n" &&
        classAt(text, te, big) === 0
      )
        te++;
      if (te > end) {
        end = te;
      } else {
        while (
          start > 0 &&
          text[start - 1] !== "\n" &&
          classAt(text, start - 1, big) === 0
        )
          start--;
      }
    }
    return { start: start, end: end };
  }

  function quoteObject(text, pos, inner, q) {
    var ls = lineStartAt(text, pos);
    var le = lineEndAt(text, pos);
    var idxs = [];
    for (var i = ls; i < le; i++) if (text[i] === q) idxs.push(i);
    for (var k = 0; k + 1 < idxs.length; k += 2) {
      var a = idxs[k],
        b = idxs[k + 1];
      if (pos >= a && pos <= b) return quoteRange(text, a, b, le, inner);
    }
    if (idxs.length >= 2) return quoteRange(text, idxs[0], idxs[1], le, inner);
    return null;
  }
  function quoteRange(text, a, b, le, inner) {
    if (inner) return { start: a + 1, end: b };
    var end = b + 1;
    while (end < le && (text[end] === " " || text[end] === "\t")) end++;
    return { start: a, end: end };
  }

  function pairObject(text, pos, inner, open, close) {
    var depth = 0,
      openIdx = -1,
      i;
    for (i = pos; i >= 0; i--) {
      var c = text[i];
      if (c === close && i < pos) depth++;
      else if (c === open) {
        if (depth === 0) {
          openIdx = i;
          break;
        }
        depth--;
      }
    }
    if (openIdx < 0) return null;
    var d = 0,
      closeIdx = -1;
    for (i = openIdx + 1; i < text.length; i++) {
      var cc = text[i];
      if (cc === open) d++;
      else if (cc === close) {
        if (d === 0) {
          closeIdx = i;
          break;
        }
        d--;
      }
    }
    if (closeIdx < 0) return null;
    if (inner) return { start: openIdx + 1, end: closeIdx };
    return { start: openIdx, end: closeIdx + 1 };
  }

  function paragraphObject(text, pos, inner) {
    var lines = buildLines(text);
    var li = lineOf(lines, pos);
    function blank(n) {
      return lines[n].start === lines[n].end;
    }
    var s = li,
      e = li;
    if (blank(li)) {
      while (e + 1 < lines.length && blank(e + 1)) e++;
      while (s - 1 >= 0 && blank(s - 1)) s--;
    } else {
      while (s - 1 >= 0 && !blank(s - 1)) s--;
      while (e + 1 < lines.length && !blank(e + 1)) e++;
    }
    var end = lines[e].end;
    if (!inner) {
      var te = e;
      while (te + 1 < lines.length && blank(te + 1)) te++;
      if (te > e) end = lines[te].end;
    }
    return { start: lines[s].start, end: end };
  }

  // A sentence ends at '.', '!' or '?' (with any trailing ) ] " ' ) followed by
  // whitespace or the paragraph end. Sentences never cross a blank line, so the
  // scan is limited to the block of non-blank lines around the cursor.
  function sentenceObject(text, pos, inner) {
    if (text.length === 0) return { start: 0, end: 0 };
    if (pos >= text.length) pos = text.length - 1;
    var lines = buildLines(text);
    var li = lineOf(lines, pos);
    function blank(n) {
      return lines[n].start === lines[n].end;
    }
    if (blank(li)) return { start: lines[li].start, end: lines[li].start };
    var s = li,
      e = li;
    while (s - 1 >= 0 && !blank(s - 1)) s--;
    while (e + 1 < lines.length && !blank(e + 1)) e++;
    var pStart = lines[s].start;
    var pEnd = lines[e].end;

    function isWs(i) {
      var c = text[i];
      return c === " " || c === "\t" || c === "\n";
    }
    function isCloser(c) {
      return c === ")" || c === "]" || c === '"' || c === "'";
    }
    // Split the paragraph into { start, contentEnd, end } sentences, where
    // [contentEnd, end) is the whitespace that trails the sentence.
    var sentences = [];
    var i = pStart;
    while (i < pEnd) {
      var start = i;
      while (start < pEnd && isWs(start)) start++;
      if (start >= pEnd) break;
      var j = start;
      var contentEnd = -1;
      while (j < pEnd) {
        var c = text[j];
        if (c === "." || c === "!" || c === "?") {
          var k = j + 1;
          while (k < pEnd && isCloser(text[k])) k++;
          if (k >= pEnd || isWs(k)) {
            contentEnd = k;
            break;
          }
          j = k;
        } else {
          j++;
        }
      }
      if (contentEnd < 0) contentEnd = pEnd;
      var end = contentEnd;
      while (end < pEnd && isWs(end)) end++;
      sentences.push({ start: start, contentEnd: contentEnd, end: end });
      i = end;
    }
    if (sentences.length === 0) return { start: pStart, end: pStart };

    var sel = sentences[sentences.length - 1];
    for (var m = 0; m < sentences.length; m++) {
      if (pos < sentences[m].end) {
        sel = sentences[m];
        break;
      }
    }
    if (inner) return { start: sel.start, end: sel.contentEnd };
    // "a sentence" adds the trailing whitespace; when there is none (the last
    // sentence in the paragraph) it takes the leading whitespace instead, the
    // same fallback `aw` uses.
    if (sel.end > sel.contentEnd) return { start: sel.start, end: sel.end };
    var st = sel.start;
    while (st > pStart && isWs(st - 1)) st--;
    return { start: st, end: sel.contentEnd };
  }

  // ---- motions --------------------------------------------------------------

  // Resolve a motion key into { pos, kind } where kind is one of
  // 'excl' (exclusive), 'incl' (inclusive), 'incl-eol' ($), 'line' (linewise).
  function resolveMotion(state, key, count, big) {
    var text = state.text;
    var pos = state.cursor;
    count = count || 1;
    var p, le, i;

    switch (key) {
      case "h":
        p = pos;
        le = lineStartAt(text, pos);
        for (i = 0; i < count && p > le; i++) p--;
        return { pos: p, kind: "excl" };
      case "l":
        p = pos;
        le = lineEndAt(text, pos);
        for (i = 0; i < count && p < le; i++) p++;
        return { pos: p, kind: "excl" };
      case "0":
        return { pos: lineStartAt(text, pos), kind: "excl" };
      case "^":
        return { pos: firstNonBlank(text, pos), kind: "excl" };
      case "$": {
        var cur = pos;
        for (i = 0; i < count - 1; i++) {
          var ne = lineEndAt(text, cur);
          if (ne >= text.length) break;
          cur = ne + 1;
        }
        return { pos: lineEndAt(text, cur), kind: "incl-eol" };
      }
      case "w":
      case "W": {
        p = pos;
        for (i = 0; i < count; i++)
          p = wordForward(text, p, key === "W" || big);
        return { pos: p, kind: "excl" };
      }
      case "b":
      case "B": {
        p = pos;
        for (i = 0; i < count; i++) p = wordBack(text, p, key === "B" || big);
        return { pos: p, kind: "excl" };
      }
      case "e":
      case "E": {
        p = pos;
        for (i = 0; i < count; i++) p = wordEnd(text, p, key === "E" || big);
        return { pos: p, kind: "incl" };
      }
      case "ge":
      case "gE": {
        p = pos;
        for (i = 0; i < count; i++)
          p = wordEndBack(text, p, key === "gE" || big);
        return { pos: p, kind: "incl" };
      }
      case "{":
        return { pos: paragraphBack(text, pos), kind: "excl" };
      case "}":
        return { pos: paragraphForward(text, pos), kind: "excl" };
      case "j":
      case "k": {
        var v = moveVertical(
          text,
          pos,
          count,
          key === "j" ? 1 : -1,
          state.desiredCol,
        );
        return { pos: v.pos, kind: "line", desiredCol: v.desiredCol };
      }
      case "G": {
        var lines = buildLines(text);
        var idx = state._hadCount
          ? Math.min(count, lines.length) - 1
          : lines.length - 1;
        return { pos: firstNonBlank(text, lines[idx].start), kind: "line" };
      }
      case "gg": {
        var lines2 = buildLines(text);
        var idx2 = state._hadCount ? Math.min(count, lines2.length) - 1 : 0;
        return { pos: firstNonBlank(text, lines2[idx2].start), kind: "line" };
      }
      case "%": {
        var mb = matchBracket(text, pos);
        return mb < 0 ? null : { pos: mb, kind: "incl" };
      }
      default:
        return null;
    }
  }

  // For `%`: from the bracket under the cursor (or the first bracket forward on
  // the current line), find the position of its match. Returns -1 if none.
  function matchBracket(text, pos) {
    var open = { "(": ")", "[": "]", "{": "}" };
    var close = { ")": "(", "]": "[", "}": "{" };
    var le = lineEndAt(text, pos);
    var i = pos,
      ch = null;
    if (text[pos] && (open[text[pos]] || close[text[pos]])) {
      ch = text[pos];
    } else {
      for (i = pos; i < le; i++) {
        if (open[text[i]] || close[text[i]]) {
          ch = text[i];
          break;
        }
      }
      if (ch === null) return -1;
    }
    var depth = 0,
      j;
    if (open[ch]) {
      for (j = i; j < text.length; j++) {
        if (text[j] === ch) depth++;
        else if (text[j] === open[ch] && --depth === 0) return j;
      }
    } else {
      for (j = i; j >= 0; j--) {
        if (text[j] === ch) depth++;
        else if (text[j] === close[ch] && --depth === 0) return j;
      }
    }
    return -1;
  }

  function moveVertical(text, pos, count, dir, desiredCol) {
    var lines = buildLines(text);
    var li = lineOf(lines, pos);
    var col = desiredCol != null ? desiredCol : pos - lines[li].start;
    var ti = Math.max(0, Math.min(lines.length - 1, li + dir * count));
    var L = lines[ti];
    var len = L.end - L.start;
    var c = Math.min(col, len > 0 ? len - 1 : 0);
    return { pos: L.start + c, desiredCol: col };
  }

  // f/F/t/T: search within the current line for `ch`. Returns a motion object
  // ({ pos, kind }) or null if not found. `repeat` distinguishes a `;`/`,`
  // repeat (which steps over an adjacent match so t/T don't get stuck).
  function findMotion(text, pos, cmd, ch, count, repeat) {
    var ls = lineStartAt(text, pos);
    var le = lineEndAt(text, pos);
    var c = count || 1;
    var i,
      target = -1;
    if (cmd === "f" || cmd === "t") {
      i = pos + 1;
      if (cmd === "t" && repeat && i < le && text[i] === ch) i++;
      for (; i < le; i++) {
        if (text[i] === ch && --c === 0) {
          target = i;
          break;
        }
      }
      if (target < 0) return null;
      if (cmd === "t") target -= 1;
      return { pos: target, kind: "incl" };
    } else {
      i = pos - 1;
      if (cmd === "T" && repeat && i >= ls && text[i] === ch) i--;
      for (; i >= ls; i--) {
        if (text[i] === ch && --c === 0) {
          target = i;
          break;
        }
      }
      if (target < 0) return null;
      if (cmd === "T") target += 1;
      return { pos: target, kind: "excl" };
    }
  }
  function reverseFind(cmd) {
    return { f: "F", F: "f", t: "T", T: "t" }[cmd];
  }

  // ---- mutation core --------------------------------------------------------

  function pushUndo(state) {
    state.undoStack.push({ text: state.text, cursor: state.cursor });
    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
    state.redoStack = [];
  }
  function replaceRange(state, start, end, insert) {
    state.text = state.text.slice(0, start) + insert + state.text.slice(end);
  }

  function deleteLines(state, count) {
    var text = state.text;
    var lines = buildLines(text);
    var li = lineOf(lines, state.cursor);
    var last = Math.min(lines.length - 1, li + count - 1);
    var start = lines[li].start;
    var end = lines[last].end;
    var removed;
    if (end < text.length) {
      removed = text.slice(start, end) + "\n"; // include trailing newline
      end = end + 1;
    } else if (start > 0) {
      removed = text.slice(start, end) + "\n"; // consume preceding newline
      start = start - 1;
    } else {
      removed = text.slice(start, end) + "\n";
    }
    state.register = { text: removed, linewise: true };
    state.text = text.slice(0, start) + text.slice(end);
    state.cursor = clampNormal(
      state.text,
      firstNonBlank(state.text, Math.min(start, state.text.length)),
    );
  }

  // ---- case change ----------------------------------------------------------

  function caseKindOf(op) {
    return op === "gu"
      ? "lower"
      : op === "gU"
        ? "upper"
        : op === "g~"
          ? "toggle"
          : null;
  }
  function caseTransform(str, kind) {
    if (kind === "lower") return str.toLowerCase();
    if (kind === "upper") return str.toUpperCase();
    var out = "";
    for (var i = 0; i < str.length; i++) {
      var c = str[i],
        lo = c.toLowerCase(),
        up = c.toUpperCase();
      out += c === lo && c !== up ? up : c === up && c !== lo ? lo : c;
    }
    return out;
  }

  // ---- indent / dedent ------------------------------------------------------

  // Shift lines [lo, hi] by `multiplier` shiftwidths. dir +1 indents (prepend
  // spaces), -1 dedents (strip leading whitespace). Empty lines are untouched.
  function shiftLines(state, dir, lo, hi, multiplier) {
    var amount =
      (state.shiftwidth || SHIFTWIDTH) * Math.max(1, multiplier || 1);
    var pad = repeatChar(" ", amount);
    var lines = buildLines(state.text);
    var parts = [];
    for (var i = 0; i < lines.length; i++) {
      var content = state.text.slice(lines[i].start, lines[i].end);
      if (i >= lo && i <= hi && content.length > 0) {
        if (dir > 0) {
          content = pad + content;
        } else {
          var j = 0;
          while (
            j < content.length &&
            j < amount &&
            (content[j] === " " || content[j] === "\t")
          )
            j++;
          content = content.slice(j);
        }
      }
      parts.push(content);
    }
    state.text = parts.join("\n");
    var nl = buildLines(state.text);
    state.cursor = clampNormal(
      state.text,
      firstNonBlank(state.text, nl[lo].start),
    );
  }

  // ---- reflow (gq) ----------------------------------------------------------

  // Leading whitespace plus any run of quote markers, preserved on every
  // wrapped line so quoted email stays quoted.
  function leaderOf(line) {
    var m = /^([ \t]*(?:>+[ \t]*)*)/.exec(line);
    return m ? m[1] : "";
  }

  // Reflow one paragraph (array of physical lines) to `width` columns. The
  // first line's leader is applied to every output line; words never split.
  function reflowParagraph(para, width) {
    var leader = leaderOf(para[0]);
    var words = [];
    for (var i = 0; i < para.length; i++) {
      var body = para[i].slice(leaderOf(para[i]).length);
      var toks = body.split(/\s+/);
      for (var j = 0; j < toks.length; j++)
        if (toks[j].length) words.push(toks[j]);
    }
    if (!words.length) return para.slice();
    var out = [];
    var cur = leader + words[0];
    for (var k = 1; k < words.length; k++) {
      if (cur.length + 1 + words[k].length > width) {
        out.push(cur);
        cur = leader + words[k];
      } else {
        cur += " " + words[k];
      }
    }
    out.push(cur);
    return out;
  }

  // Reflow every paragraph overlapping physical lines [lo, hi]. Blank
  // (whitespace-only) lines separate paragraphs and pass through untouched.
  function formatLines(state, lo, hi) {
    var lines = buildLines(state.text);
    var content = [];
    for (var i = 0; i < lines.length; i++)
      content.push(state.text.slice(lines[i].start, lines[i].end));
    var width = state.textwidth || TEXTWIDTH;
    var out = [];
    var p = lo;
    while (p <= hi) {
      if (content[p].replace(/[ \t]/g, "") === "") {
        out.push(content[p]);
        p++;
        continue;
      }
      var para = [];
      while (p <= hi && content[p].replace(/[ \t]/g, "") !== "") {
        para.push(content[p]);
        p++;
      }
      var reflowed = reflowParagraph(para, width);
      for (var q = 0; q < reflowed.length; q++) out.push(reflowed[q]);
    }
    var merged = content.slice(0, lo).concat(out, content.slice(hi + 1));
    state.text = merged.join("\n");
    var nlines = buildLines(state.text);
    var target = Math.min(nlines.length - 1, lo + out.length - 1);
    state.cursor = clampNormal(
      state.text,
      firstNonBlank(state.text, nlines[target].start),
    );
  }

  // Visual-mode gq: reflow the line span covered by the selection.
  function formatVisual(state) {
    var lines = buildLines(state.text);
    var a = lineOf(lines, state.anchor);
    var b = lineOf(lines, state.cursor);
    pushUndo(state);
    formatLines(state, Math.min(a, b), Math.max(a, b));
    state.anchor = null;
    state.mode = MODE.NORMAL;
    resetPending(state);
    return { state: state, handled: true };
  }

  // Apply an operator ('d','c','y','gu','gU','g~','>','<','gq') over a motion.
  function applyOperator(state, op, motion) {
    if (op === ">" || op === "<") {
      var sl = buildLines(state.text);
      var sa = lineOf(sl, state.cursor);
      var sb = lineOf(sl, motion.pos);
      shiftLines(
        state,
        op === ">" ? 1 : -1,
        Math.min(sa, sb),
        Math.max(sa, sb),
        1,
      );
      return;
    }
    if (op === "gq") {
      var ql = buildLines(state.text);
      var qa = lineOf(ql, state.cursor);
      var qb = lineOf(ql, motion.pos);
      formatLines(state, Math.min(qa, qb), Math.max(qa, qb));
      return;
    }
    var caseKind = caseKindOf(op);
    if (motion.kind === "line") {
      var lines = buildLines(state.text);
      var a = lineOf(lines, state.cursor);
      var b = lineOf(lines, motion.pos);
      var lo = Math.min(a, b);
      var hi = Math.max(a, b);
      if (caseKind) {
        var cs = lines[lo].start,
          ce = lines[hi].end;
        replaceRange(
          state,
          cs,
          ce,
          caseTransform(state.text.slice(cs, ce), caseKind),
        );
        state.cursor = clampNormal(state.text, cs);
        return;
      }
      if (op === "y") {
        var chunk = state.text.slice(lines[lo].start, lines[hi].end) + "\n";
        state.register = { text: chunk, linewise: true };
        state.cursor = clampNormal(state.text, lines[lo].start);
        return;
      }
      state.cursor = lines[lo].start;
      deleteLines(state, hi - lo + 1);
      if (op === "c") {
        var at = lineStartAt(state.text, state.cursor);
        replaceRange(state, at, at, "\n");
        state.cursor = at;
        state.mode = MODE.INSERT;
      }
      return;
    }

    var start = Math.min(state.cursor, motion.pos);
    var end = Math.max(state.cursor, motion.pos);
    if (motion.kind === "incl") end += 1;
    if (motion.kind === "incl-eol") end = motion.pos;
    if (start === end) return;

    if (caseKind) {
      replaceRange(
        state,
        start,
        end,
        caseTransform(state.text.slice(start, end), caseKind),
      );
      state.cursor = clampNormal(state.text, start);
      return;
    }

    var removedText = state.text.slice(start, end);
    state.register = { text: removedText, linewise: false };
    if (op === "y") {
      state.cursor = clampNormal(state.text, start);
      return;
    }
    replaceRange(state, start, end, "");
    if (op === "c") {
      state.cursor = start;
      state.mode = MODE.INSERT;
    } else {
      state.cursor = clampNormal(state.text, start);
    }
  }

  // Apply a charwise operator to an explicit [start, end) range (text objects).
  function applyRange(state, op, start, end) {
    if (start > end) {
      var t = start;
      start = end;
      end = t;
    }
    if (op === ">" || op === "<") {
      var rl = buildLines(state.text);
      var ra = lineOf(rl, start);
      var rb = lineOf(rl, Math.max(start, end - 1));
      shiftLines(
        state,
        op === ">" ? 1 : -1,
        Math.min(ra, rb),
        Math.max(ra, rb),
        1,
      );
      return;
    }
    if (op === "gq") {
      var gl = buildLines(state.text);
      var ga = lineOf(gl, start);
      var gb = lineOf(gl, Math.max(start, end - 1));
      formatLines(state, Math.min(ga, gb), Math.max(ga, gb));
      return;
    }
    var caseKind = caseKindOf(op);
    if (caseKind) {
      replaceRange(
        state,
        start,
        end,
        caseTransform(state.text.slice(start, end), caseKind),
      );
      state.cursor = clampNormal(state.text, start);
      return;
    }
    state.register = { text: state.text.slice(start, end), linewise: false };
    if (op === "y") {
      state.cursor = clampNormal(state.text, start);
      return;
    }
    replaceRange(state, start, end, "");
    if (op === "c") {
      state.cursor = start;
      state.mode = MODE.INSERT;
    } else {
      state.cursor = clampNormal(state.text, start);
    }
  }

  // ---- paste ----------------------------------------------------------------

  function paste(state, after, count) {
    var reg = state.register;
    if (!reg || !reg.text) return;
    count = count || 1;
    var payload = "";
    var i;
    if (reg.linewise) {
      for (i = 0; i < count; i++) payload += reg.text;
      var le = lineEndAt(state.text, state.cursor);
      var ls = lineStartAt(state.text, state.cursor);
      if (after) {
        if (le >= state.text.length) {
          replaceRange(state, le, le, "\n" + rstrip1(payload));
          state.cursor = clampNormal(state.text, le + 1);
        } else {
          replaceRange(state, le + 1, le + 1, payload);
          state.cursor = clampNormal(state.text, le + 1);
        }
      } else {
        replaceRange(state, ls, ls, payload);
        state.cursor = clampNormal(state.text, ls);
      }
    } else {
      for (i = 0; i < count; i++) payload += reg.text;
      var at = after
        ? Math.min(state.cursor + 1, lineEndAt(state.text, state.cursor))
        : state.cursor;
      if (state.text.length === 0) at = 0;
      replaceRange(state, at, at, payload);
      state.cursor = clampNormal(state.text, at + payload.length - 1);
    }
  }
  function rstrip1(s) {
    return s.charAt(s.length - 1) === "\n" ? s.slice(0, -1) : s;
  }

  // ---- pending / dispatch ---------------------------------------------------

  function resetPending(state) {
    state.pending = {
      count: "",
      op: null,
      opCount: "",
      g: false,
      replace: false,
      textobj: null,
      find: null,
    };
  }

  // Apply a resolved motion object as an operator target (if one is pending) or
  // as a plain cursor move. Clears pending state afterwards.
  function dispatchMotion(state, motion) {
    if (motion) {
      if (state.pending.op) {
        pushUndo(state);
        applyOperator(state, state.pending.op, motion);
      } else {
        state.desiredCol = null;
        state.cursor = clampNormal(state.text, motion.pos);
      }
    }
    resetPending(state);
    return { state: state, handled: true };
  }

  // `;` / `,`: repeat the last f/F/t/T. `reverse` flips the direction (`,`).
  function repeatFind(state, reverse) {
    if (!state.lastFind) {
      resetPending(state);
      return { state: state, handled: true };
    }
    var cmd = reverse ? reverseFind(state.lastFind.cmd) : state.lastFind.cmd;
    var count = effectiveCount(state);
    var m = findMotion(
      state.text,
      state.cursor,
      cmd,
      state.lastFind.char,
      count,
      true,
    );
    return dispatchMotion(state, m);
  }
  function currentCount(state) {
    return state.pending.op ? state.pending.opCount : state.pending.count;
  }
  function effectiveCount(state) {
    var c1 = state.pending.count ? parseInt(state.pending.count, 10) : 0;
    var c2 = state.pending.opCount ? parseInt(state.pending.opCount, 10) : 0;
    state._hadCount = !!(c1 || c2);
    if (c1 && c2) return c1 * c2;
    return c1 || c2 || 1;
  }
  function repeatChar(ch, n) {
    var s = "";
    for (var i = 0; i < n; i++) s += ch;
    return s;
  }

  var MOTION_KEYS = {
    h: 1,
    j: 1,
    k: 1,
    l: 1,
    w: 1,
    W: 1,
    b: 1,
    B: 1,
    e: 1,
    E: 1,
    0: 1,
    $: 1,
    "^": 1,
    "{": 1,
    "}": 1,
    G: 1,
    "%": 1,
  };

  // ---- dot-repeat recording -------------------------------------------------

  function leadingCountLen(seq) {
    if (!seq.length || !/[1-9]/.test(seq[0])) return 0;
    var n = 1;
    while (n < seq.length && /[0-9]/.test(seq[n])) n++;
    return n;
  }
  function stripLeadingCount(seq) {
    return seq.slice(leadingCountLen(seq));
  }
  function leadingCount(seq) {
    var n = leadingCountLen(seq);
    return n ? parseInt(seq.slice(0, n).join(""), 10) : 0;
  }
  // True while the engine is mid-command and expecting more keys.
  function pendingActive(state) {
    var p = state.pending;
    return !!(
      p.op ||
      p.replace ||
      p.textobj ||
      p.find ||
      p.g ||
      p.count ||
      p.opCount
    );
  }

  // Public entry point. Wraps handleKeyInner with change recording so `.` can
  // replay the last buffer-modifying command.
  function handleKey(state, ev) {
    if (state._replaying) return handleKeyInner(state, ev);

    var key = ev.key;
    var wasInsert = state.mode === MODE.INSERT;
    var beforeMode = state.mode;
    var beforeText = state.text;
    state._noRecord = false;

    // Only sequences that begin in Normal mode are dot-recordable.
    if (!wasInsert && beforeMode === MODE.NORMAL && key !== "Escape") {
      state._seq.push(key);
    }

    var res = handleKeyInner(state, ev);

    if (key === "Escape") {
      state._seq = [];
    } else if (!wasInsert && beforeMode === MODE.NORMAL) {
      if (state.mode === MODE.INSERT) {
        // A command opened Insert mode; the typed text is captured on Escape.
        state._insertPending = {
          keys: stripLeadingCount(state._seq),
          count: leadingCount(state._seq),
        };
        state._seq = [];
      } else if (!pendingActive(state)) {
        if (state.text !== beforeText && !state._noRecord) {
          state._dot = {
            keys: stripLeadingCount(state._seq),
            count: leadingCount(state._seq),
            insertText: null,
          };
        }
        state._seq = [];
      }
      // else: still mid-command, keep accumulating into _seq.
    } else if (beforeMode !== MODE.NORMAL && state.mode !== MODE.INSERT) {
      // Visual-mode commands are not dot-recorded (v1).
      state._seq = [];
    }
    return res;
  }

  // Called by the adapter when leaving Insert mode, with the text that was typed
  // during the insert session. Finalizes a pending insert-based change for `.`.
  function finishInsert(state, insertText) {
    if (state._insertPending) {
      state._dot = {
        keys: state._insertPending.keys,
        count: state._insertPending.count,
        insertText: insertText || "",
      };
      state._insertPending = null;
    }
  }

  // `.` : replay the last recorded change. `countOverride` (>0) replaces the
  // recorded count, matching vim.
  function repeatDot(state, countOverride) {
    var dot = state._dot;
    if (!dot) return;
    var saved = state._dot;
    state._replaying = true;
    resetPending(state);
    try {
      var count = countOverride || dot.count || 0;
      var seq = (count ? String(count).split("") : []).concat(dot.keys);
      for (var i = 0; i < seq.length; i++)
        handleKeyInner(state, { key: seq[i] });
      if (state.mode === MODE.INSERT) {
        if (dot.insertText) {
          replaceRange(state, state.cursor, state.cursor, dot.insertText);
          state.cursor += dot.insertText.length;
        }
        state.mode = MODE.NORMAL;
        state.cursor = clampNormal(state.text, state.cursor - 1);
      }
    } finally {
      state._replaying = false;
      state._dot = saved;
      resetPending(state);
    }
  }

  function handleKeyInner(state, ev) {
    var key = ev.key;

    // In Insert mode the native editor owns typing; only Escape is ours.
    if (state.mode === MODE.INSERT) {
      if (key === "Escape") {
        state.mode = MODE.NORMAL;
        state.cursor = clampNormal(state.text, state.cursor - 1);
        resetPending(state);
        return { state: state, handled: true };
      }
      return { state: state, handled: false };
    }

    // Ctrl-r = redo (the one modifier chord we consume inside the editor).
    if (ev.ctrl && (key === "r" || key === "R")) {
      state._noRecord = true;
      redo(state);
      resetPending(state);
      return { state: state, handled: true };
    }
    // All other modifier chords pass straight through to Thunderbird.
    if (ev.ctrl || ev.alt || ev.meta) {
      return { state: state, handled: false };
    }

    if (key === "Escape") {
      state.mode = MODE.NORMAL;
      state.anchor = null;
      state.hlsearch = false;
      resetPending(state);
      return { state: state, handled: true };
    }

    // Awaiting a character for `r`.
    if (state.pending.replace) {
      if (key.length === 1) {
        var rn = effectiveCount(state);
        var rle = lineEndAt(state.text, state.cursor);
        if (state.cursor + rn <= rle) {
          pushUndo(state);
          replaceRange(
            state,
            state.cursor,
            state.cursor + rn,
            repeatChar(key, rn),
          );
          state.cursor = clampNormal(state.text, state.cursor + rn - 1);
        }
      }
      resetPending(state);
      return { state: state, handled: true };
    }

    // Awaiting the object char for a text object (iw, a(, ...).
    if (state.pending.textobj) {
      var inner = state.pending.textobj === "i";
      var visualTO = state.mode === MODE.VISUAL || state.mode === MODE.VLINE;
      var op = state.pending.op;
      var range = resolveTextObject(state, inner, key);
      if (range) {
        if (visualTO) {
          state.anchor = range.start;
          state.cursor = clampNormal(
            state.text,
            Math.max(range.start, range.end - 1),
          );
          if (state.mode === MODE.VLINE) state.mode = MODE.VISUAL;
        } else if (op) {
          pushUndo(state);
          applyRange(state, op, range.start, range.end);
        }
      }
      resetPending(state);
      return { state: state, handled: true };
    }

    // Awaiting the target char for f/F/t/T.
    if (state.pending.find) {
      if (key.length === 1) {
        state.lastFind = { cmd: state.pending.find, char: key };
        var fcount = effectiveCount(state);
        var fm = findMotion(
          state.text,
          state.cursor,
          state.pending.find,
          key,
          fcount,
          false,
        );
        return dispatchMotion(state, fm);
      }
      resetPending(state);
      return { state: state, handled: true };
    }

    // Count accumulation ("0" is a motion unless a count is already building).
    if (/[0-9]/.test(key) && !(key === "0" && !currentCount(state))) {
      if (state.pending.op) state.pending.opCount += key;
      else state.pending.count += key;
      return { state: state, handled: true };
    }

    // `g` prefix (gg, gu, gU, g~).
    if (state.pending.g) {
      state.pending.g = false;
      if (key === "g") return runMotionOrOperator(state, "gg");
      if (key === "e" || key === "E")
        return runMotionOrOperator(state, key === "e" ? "ge" : "gE");
      if (key === "u" || key === "U" || key === "~") {
        var gop = key === "u" ? "gu" : key === "U" ? "gU" : "g~";
        if (state.mode === MODE.VISUAL || state.mode === MODE.VLINE) {
          return applyCaseVisual(state, caseKindOf(gop));
        }
        state.pending.op = gop;
        return { state: state, handled: true };
      }
      if (key === "q") {
        if (state.mode === MODE.VISUAL || state.mode === MODE.VLINE) {
          return formatVisual(state);
        }
        state.pending.op = "gq";
        return { state: state, handled: true };
      }
      resetPending(state);
      return { state: state, handled: true };
    }
    if (key === "g") {
      state.pending.g = true;
      return { state: state, handled: true };
    }

    // Pending operator: expect a motion, a text object, or a doubled operator.
    if (state.pending.op) {
      var op = state.pending.op;
      if (key === "i" || key === "a") {
        state.pending.textobj = key;
        return { state: state, handled: true };
      }
      if (key === "f" || key === "F" || key === "t" || key === "T") {
        state.pending.find = key;
        return { state: state, handled: true };
      }
      if (key === ";") return repeatFind(state, false);
      if (key === ",") return repeatFind(state, true);
      // Doubled case operator (guu / gUU / g~~): linewise on the current line(s).
      if (
        (op === "gu" && key === "u") ||
        (op === "gU" && key === "U") ||
        (op === "g~" && key === "~")
      ) {
        var gc = effectiveCount(state);
        var glines = buildLines(state.text);
        var gli = lineOf(glines, state.cursor);
        var gtarget = Math.min(glines.length - 1, gli + gc - 1);
        pushUndo(state);
        applyOperator(state, op, { pos: glines[gtarget].start, kind: "line" });
        resetPending(state);
        return { state: state, handled: true };
      }
      // Doubled shift (>> / <<): count lines by one shiftwidth.
      if ((op === ">" && key === ">") || (op === "<" && key === "<")) {
        var sc = effectiveCount(state);
        var slines = buildLines(state.text);
        var sli = lineOf(slines, state.cursor);
        var shi = Math.min(slines.length - 1, sli + sc - 1);
        pushUndo(state);
        shiftLines(state, op === ">" ? 1 : -1, sli, shi, 1);
        resetPending(state);
        return { state: state, handled: true };
      }
      // Doubled reflow (gqq): count lines.
      if (op === "gq" && key === "q") {
        var qc = effectiveCount(state);
        var qlines = buildLines(state.text);
        var qli = lineOf(qlines, state.cursor);
        var qhi = Math.min(qlines.length - 1, qli + qc - 1);
        pushUndo(state);
        formatLines(state, qli, qhi);
        resetPending(state);
        return { state: state, handled: true };
      }
      if (key === op) {
        var cnt = effectiveCount(state);
        pushUndo(state);
        if (op === "y") yankLines(state, cnt);
        else if (op === "c") changeLines(state, cnt);
        else deleteLines(state, cnt);
        resetPending(state);
        return { state: state, handled: true };
      }
      if (MOTION_KEYS[key]) return runMotionOrOperator(state, key);
      resetPending(state); // invalid operator target
      return { state: state, handled: true };
    }

    return runNormalCommand(state, key);
  }

  function yankLines(state, count) {
    var lines = buildLines(state.text);
    var li = lineOf(lines, state.cursor);
    var last = Math.min(lines.length - 1, li + count - 1);
    state.register = {
      text: state.text.slice(lines[li].start, lines[last].end) + "\n",
      linewise: true,
    };
    state.cursor = clampNormal(state.text, lines[li].start);
  }
  function changeLines(state, count) {
    var lines = buildLines(state.text);
    var li = lineOf(lines, state.cursor);
    var indent = state.text.slice(
      lines[li].start,
      firstNonBlank(state.text, state.cursor),
    );
    deleteLines(state, count);
    var at = lineStartAt(state.text, state.cursor);
    replaceRange(state, at, at, indent + "\n");
    state.cursor = at + indent.length;
    state.mode = MODE.INSERT;
  }

  // Resolve a motion under a pending operator, or move the cursor if none.
  function runMotionOrOperator(state, key) {
    var count = effectiveCount(state);
    // vim special case: `cw`/`cW` on a non-blank behaves like `ce`/`cE`
    // (it does not swallow the trailing whitespace).
    var mkey = key;
    if (
      state.pending.op === "c" &&
      (key === "w" || key === "W") &&
      classAt(state.text, state.cursor, key === "W") !== 0
    ) {
      mkey = key === "w" ? "e" : "E";
    }
    var motion = resolveMotion(state, mkey, count, false);
    if (!motion) {
      resetPending(state);
      return { state: state, handled: true };
    }

    if (state.pending.op) {
      pushUndo(state);
      applyOperator(state, state.pending.op, motion);
      resetPending(state);
      return { state: state, handled: true };
    }

    state.desiredCol = motion.desiredCol != null ? motion.desiredCol : null;
    state.cursor = clampNormal(state.text, motion.pos);
    resetPending(state);
    return { state: state, handled: true };
  }

  function runNormalCommand(state, key) {
    var visual = state.mode === MODE.VISUAL || state.mode === MODE.VLINE;

    if (MOTION_KEYS[key]) return runMotionOrOperator(state, key);

    // In visual mode, `i`/`a` begin a text-object selection instead of Insert.
    if (visual && (key === "i" || key === "a")) {
      state.pending.textobj = key;
      return { state: state, handled: true };
    }

    switch (key) {
      case "i":
        pushUndo(state);
        state.mode = MODE.INSERT;
        resetPending(state);
        return { state: state, handled: true };
      case "a":
        pushUndo(state);
        if (state.text.length > 0)
          state.cursor = Math.min(
            state.cursor + 1,
            lineEndAt(state.text, state.cursor),
          );
        state.mode = MODE.INSERT;
        resetPending(state);
        return { state: state, handled: true };
      case "I":
        pushUndo(state);
        state.cursor = firstNonBlank(state.text, state.cursor);
        state.mode = MODE.INSERT;
        resetPending(state);
        return { state: state, handled: true };
      case "A":
        pushUndo(state);
        state.cursor = lineEndAt(state.text, state.cursor);
        state.mode = MODE.INSERT;
        resetPending(state);
        return { state: state, handled: true };
      case "o":
        pushUndo(state);
        openLine(state, true);
        state.mode = MODE.INSERT;
        resetPending(state);
        return { state: state, handled: true };
      case "O":
        pushUndo(state);
        openLine(state, false);
        state.mode = MODE.INSERT;
        resetPending(state);
        return { state: state, handled: true };
      case "x": {
        if (visual) return visualOperator(state, "d");
        var n = effectiveCount(state);
        var le = lineEndAt(state.text, state.cursor);
        var end = Math.min(state.cursor + n, le);
        if (end > state.cursor) {
          pushUndo(state);
          state.register = {
            text: state.text.slice(state.cursor, end),
            linewise: false,
          };
          replaceRange(state, state.cursor, end, "");
          state.cursor = clampNormal(state.text, state.cursor);
        }
        resetPending(state);
        return { state: state, handled: true };
      }
      case "s": {
        if (visual) return visualOperator(state, "c");
        var sn = effectiveCount(state);
        var sle = lineEndAt(state.text, state.cursor);
        var send = Math.min(state.cursor + sn, sle);
        pushUndo(state);
        if (send > state.cursor) {
          state.register = {
            text: state.text.slice(state.cursor, send),
            linewise: false,
          };
          replaceRange(state, state.cursor, send, "");
        }
        state.mode = MODE.INSERT;
        resetPending(state);
        return { state: state, handled: true };
      }
      case "S": {
        if (visual) {
          state.mode = MODE.VLINE;
          return visualOperator(state, "c");
        }
        pushUndo(state);
        changeLines(state, effectiveCount(state));
        resetPending(state);
        return { state: state, handled: true };
      }
      case "X": {
        if (visual) {
          state.mode = MODE.VLINE;
          return visualOperator(state, "d");
        }
        var xn = effectiveCount(state);
        var xls = lineStartAt(state.text, state.cursor);
        var xstart = Math.max(state.cursor - xn, xls);
        if (state.cursor > xstart) {
          pushUndo(state);
          state.register = {
            text: state.text.slice(xstart, state.cursor),
            linewise: false,
          };
          replaceRange(state, xstart, state.cursor, "");
          state.cursor = clampNormal(state.text, xstart);
        }
        resetPending(state);
        return { state: state, handled: true };
      }
      case "D": {
        pushUndo(state);
        var le2 = lineEndAt(state.text, state.cursor);
        state.register = {
          text: state.text.slice(state.cursor, le2),
          linewise: false,
        };
        replaceRange(state, state.cursor, le2, "");
        state.cursor = clampNormal(state.text, state.cursor);
        resetPending(state);
        return { state: state, handled: true };
      }
      case "C": {
        pushUndo(state);
        var le3 = lineEndAt(state.text, state.cursor);
        state.register = {
          text: state.text.slice(state.cursor, le3),
          linewise: false,
        };
        replaceRange(state, state.cursor, le3, "");
        state.mode = MODE.INSERT;
        resetPending(state);
        return { state: state, handled: true };
      }
      case "J": {
        if (visual) {
          var jl = buildLines(state.text);
          var ja = lineOf(jl, state.anchor);
          var jb = lineOf(jl, state.cursor);
          var jlo = Math.min(ja, jb),
            jhi = Math.max(ja, jb);
          pushUndo(state);
          state.cursor = jl[jlo].start;
          joinLines(state, Math.max(1, jhi - jlo));
          state.mode = MODE.NORMAL;
          state.anchor = null;
          resetPending(state);
          return { state: state, handled: true };
        }
        var jn = effectiveCount(state);
        pushUndo(state);
        joinLines(state, jn <= 2 ? 1 : jn - 1);
        resetPending(state);
        return { state: state, handled: true };
      }
      case "d":
        if (visual) return visualOperator(state, "d");
        state.pending.op = "d";
        return { state: state, handled: true };
      case "c":
        if (visual) return visualOperator(state, "c");
        state.pending.op = "c";
        return { state: state, handled: true };
      case "y":
        if (visual) return visualOperator(state, "y");
        state.pending.op = "y";
        return { state: state, handled: true };
      case "p":
        pushUndo(state);
        paste(state, true, effectiveCount(state));
        resetPending(state);
        return { state: state, handled: true };
      case "P":
        pushUndo(state);
        paste(state, false, effectiveCount(state));
        resetPending(state);
        return { state: state, handled: true };
      case "r":
        state.pending.replace = true;
        return { state: state, handled: true };
      case "f":
      case "F":
      case "t":
      case "T":
        state.pending.find = key;
        return { state: state, handled: true };
      case ";":
        return repeatFind(state, false);
      case ",":
        return repeatFind(state, true);
      case ".": {
        state._noRecord = true;
        var dotCount = effectiveCount(state);
        repeatDot(state, state._hadCount ? dotCount : 0);
        resetPending(state);
        return { state: state, handled: true };
      }
      case "n":
        searchNext(state, false);
        resetPending(state);
        return { state: state, handled: true };
      case "N":
        searchNext(state, true);
        resetPending(state);
        return { state: state, handled: true };
      case "*":
        if (!visual) searchWord(state, 1);
        resetPending(state);
        return { state: state, handled: true };
      case "#":
        if (!visual) searchWord(state, -1);
        resetPending(state);
        return { state: state, handled: true };
      case "u":
        if (visual) return applyCaseVisual(state, "lower");
        state._noRecord = true;
        undo(state);
        resetPending(state);
        return { state: state, handled: true };
      case "U":
        if (visual) return applyCaseVisual(state, "upper");
        resetPending(state);
        return { state: state, handled: true };
      case "~": {
        if (visual) return applyCaseVisual(state, "toggle");
        var tn = effectiveCount(state);
        var tle = lineEndAt(state.text, state.cursor);
        var tend = Math.min(state.cursor + tn, tle);
        if (tend > state.cursor) {
          pushUndo(state);
          replaceRange(
            state,
            state.cursor,
            tend,
            caseTransform(state.text.slice(state.cursor, tend), "toggle"),
          );
          state.cursor = clampNormal(state.text, tend);
        }
        resetPending(state);
        return { state: state, handled: true };
      }
      case ">":
        if (visual) return shiftVisual(state, 1);
        state.pending.op = ">";
        return { state: state, handled: true };
      case "<":
        if (visual) return shiftVisual(state, -1);
        state.pending.op = "<";
        return { state: state, handled: true };
      case "v":
        if (state.mode === MODE.VISUAL) {
          state.mode = MODE.NORMAL;
          state.anchor = null;
        } else {
          state.mode = MODE.VISUAL;
          state.anchor = state.cursor;
        }
        resetPending(state);
        return { state: state, handled: true };
      case "V":
        if (state.mode === MODE.VLINE) {
          state.mode = MODE.NORMAL;
          state.anchor = null;
        } else {
          state.mode = MODE.VLINE;
          state.anchor = state.cursor;
        }
        resetPending(state);
        return { state: state, handled: true };
      default:
        // Swallow stray printable keys in Normal mode so they don't get typed.
        resetPending(state);
        return { state: state, handled: key.length === 1 };
    }
  }

  function openLine(state, below) {
    if (below) {
      var le = lineEndAt(state.text, state.cursor);
      replaceRange(state, le, le, "\n");
      state.cursor = le + 1;
    } else {
      var ls = lineStartAt(state.text, state.cursor);
      replaceRange(state, ls, ls, "\n");
      state.cursor = ls;
    }
  }

  // Join `joins` following lines onto the current one. Leading whitespace of each
  // joined line is removed and a single space inserted, unless the current line
  // already ends in whitespace or the joined text starts with ")".
  function joinLines(state, joins) {
    var lastPos = state.cursor;
    for (var k = 0; k < joins; k++) {
      var le = lineEndAt(state.text, state.cursor);
      if (le >= state.text.length) break; // no line below to join
      var ns = le + 1;
      while (
        ns < state.text.length &&
        (state.text[ns] === " " || state.text[ns] === "\t")
      )
        ns++;
      var curEndsWs =
        le > 0 && (state.text[le - 1] === " " || state.text[le - 1] === "\t");
      var nextEmpty = ns >= state.text.length || state.text[ns] === "\n";
      var sep = !nextEmpty && !curEndsWs && state.text[ns] !== ")" ? " " : "";
      state.text = state.text.slice(0, le) + sep + state.text.slice(ns);
      lastPos = sep ? le : Math.max(0, le - 1);
      state.cursor = le;
    }
    state.cursor = clampNormal(state.text, lastPos);
  }

  function visualOperator(state, op) {
    var start, end, linewise;
    if (state.mode === MODE.VLINE) {
      linewise = true;
      var lines = buildLines(state.text);
      var a = lineOf(lines, state.anchor);
      var b = lineOf(lines, state.cursor);
      var lo = Math.min(a, b),
        hi = Math.max(a, b);
      start = lines[lo].start;
      end = lines[hi].end;
      state.register = {
        text: state.text.slice(start, end) + "\n",
        linewise: true,
      };
      // Extend the deletion range to swallow one newline so no blank line is
      // left behind (trailing newline, or the preceding one on the last line).
      if (op !== "y") {
        if (end < state.text.length) end += 1;
        else if (start > 0) start -= 1;
      }
    } else {
      linewise = false;
      start = Math.min(state.anchor, state.cursor);
      end = Math.max(state.anchor, state.cursor) + 1;
      state.register = { text: state.text.slice(start, end), linewise: false };
    }
    pushUndo(state);
    state.anchor = null;
    if (op === "y") {
      state.mode = MODE.NORMAL;
      state.cursor = clampNormal(state.text, start);
      resetPending(state);
      return { state: state, handled: true };
    }
    replaceRange(state, start, end, "");
    if (op === "c") {
      state.mode = MODE.INSERT;
      state.cursor = start;
    } else {
      state.mode = MODE.NORMAL;
      state.cursor = clampNormal(state.text, start);
    }
    resetPending(state);
    return { state: state, handled: true };
  }

  // Apply a case change ('lower','upper','toggle') to the visual selection and
  // return to Normal mode.
  function applyCaseVisual(state, kind) {
    var start, end;
    if (state.mode === MODE.VLINE) {
      var lines = buildLines(state.text);
      var a = lineOf(lines, state.anchor);
      var b = lineOf(lines, state.cursor);
      start = lines[Math.min(a, b)].start;
      end = lines[Math.max(a, b)].end;
    } else {
      start = Math.min(state.anchor, state.cursor);
      end = Math.max(state.anchor, state.cursor) + 1;
    }
    pushUndo(state);
    replaceRange(
      state,
      start,
      end,
      caseTransform(state.text.slice(start, end), kind),
    );
    state.anchor = null;
    state.mode = MODE.NORMAL;
    state.cursor = clampNormal(state.text, start);
    resetPending(state);
    return { state: state, handled: true };
  }

  // Visual `>` / `<`: shift the selected lines; a count is a shiftwidth
  // multiplier (vim's Visual-mode behavior).
  function shiftVisual(state, dir) {
    var mult = effectiveCount(state);
    var lines = buildLines(state.text);
    var a = lineOf(lines, state.anchor);
    var b = lineOf(lines, state.cursor);
    pushUndo(state);
    shiftLines(state, dir, Math.min(a, b), Math.max(a, b), mult);
    state.anchor = null;
    state.mode = MODE.NORMAL;
    resetPending(state);
    return { state: state, handled: true };
  }

  // ---- undo / redo ----------------------------------------------------------

  function undo(state) {
    if (!state.undoStack.length) return;
    state.redoStack.push({ text: state.text, cursor: state.cursor });
    var s = state.undoStack.pop();
    state.text = s.text;
    state.cursor = clampNormal(state.text, s.cursor);
  }
  function redo(state) {
    if (!state.redoStack.length) return;
    state.undoStack.push({ text: state.text, cursor: state.cursor });
    var s = state.redoStack.pop();
    state.text = s.text;
    state.cursor = clampNormal(state.text, s.cursor);
  }

  // ---- search ---------------------------------------------------------------

  // Literal, smartcase substring matches. Case-insensitive unless the query
  // contains an uppercase letter. When `wholeWord` is set, matches must be
  // bounded by non-word characters (used by `*` / `#`). Returns non-overlapping
  // { start, end } ranges.
  function computeMatches(text, query, wholeWord) {
    if (!query) return [];
    var n = query.length;
    if (n === 0) return [];
    var insensitive = !/[A-Z]/.test(query);
    var hay = insensitive ? text.toLowerCase() : text;
    var needle = insensitive ? query.toLowerCase() : query;
    var out = [],
      i = 0,
      idx;
    while ((idx = hay.indexOf(needle, i)) >= 0) {
      if (
        !wholeWord ||
        (!isWordChar(text[idx - 1]) && !isWordChar(text[idx + n]))
      ) {
        out.push({ start: idx, end: idx + n });
      }
      i = idx + n;
    }
    return out;
  }

  // Move the cursor to the next match in `dir` (+1 forward, -1 backward),
  // wrapping around the buffer ends.
  function searchJump(state, dir) {
    var m = computeMatches(
      state.text,
      state.search.query,
      state.search.wholeWord,
    );
    if (!m.length) return { found: false, wrapped: false, total: 0 };
    var cur = state.cursor,
      target = -1,
      wrapped = false,
      i;
    if (dir > 0) {
      for (i = 0; i < m.length; i++)
        if (m[i].start > cur) {
          target = i;
          break;
        }
      if (target < 0) {
        target = 0;
        wrapped = true;
      }
    } else {
      for (i = m.length - 1; i >= 0; i--)
        if (m[i].start < cur) {
          target = i;
          break;
        }
      if (target < 0) {
        target = m.length - 1;
        wrapped = true;
      }
    }
    state.cursor = clampNormal(state.text, m[target].start);
    return { found: true, wrapped: wrapped, total: m.length, index: target };
  }

  // Commit a `/` or `?` search. An empty query reuses the previous one.
  function setSearch(state, query, dir) {
    if (query) state.search.query = query;
    state.search.wholeWord = false;
    state.search.dir = dir || 1;
    state.hlsearch = true;
    state.lastSearchInfo = searchJump(state, state.search.dir);
    return state.lastSearchInfo;
  }

  // The word under (or, failing that, forward from) the cursor: its text and
  // start index. Returns null when the rest of the line has no word character.
  function wordUnderCursor(state) {
    var text = state.text;
    var pos = state.cursor;
    var le = lineEndAt(text, pos);
    if (!isWordChar(text[pos])) {
      var j = pos;
      while (j < le && !isWordChar(text[j])) j++;
      if (j >= le) return null;
      pos = j;
    }
    var s = pos;
    while (s > 0 && isWordChar(text[s - 1])) s--;
    var e = pos;
    while (e < text.length && isWordChar(text[e])) e++;
    return { text: text.slice(s, e), start: s };
  }

  // `*` / `#`: search for the whole word under the cursor.
  function searchWord(state, dir) {
    var w = wordUnderCursor(state);
    if (!w) return { found: false, wrapped: false, total: 0 };
    state.search.query = w.text;
    state.search.wholeWord = true;
    state.search.dir = dir;
    state.hlsearch = true;
    state.cursor = w.start; // so the match under the cursor is skipped
    state.lastSearchInfo = searchJump(state, dir);
    return state.lastSearchInfo;
  }

  // `n` / `N`: repeat the last search. `reverse` flips the stored direction.
  function searchNext(state, reverse) {
    if (!state.search.query) return { found: false, wrapped: false, total: 0 };
    state.hlsearch = true;
    var dir = reverse ? -state.search.dir : state.search.dir;
    state.lastSearchInfo = searchJump(state, dir);
    return state.lastSearchInfo;
  }

  // ---- construction / sync --------------------------------------------------

  function createState(text, cursor) {
    var s = {
      text: text || "",
      cursor: 0,
      mode: MODE.INSERT,
      register: { text: "", linewise: false },
      undoStack: [],
      redoStack: [],
      desiredCol: null,
      anchor: null,
      lastFind: null,
      shiftwidth: SHIFTWIDTH,
      textwidth: TEXTWIDTH,
      search: { query: "", dir: 1, wholeWord: false },
      hlsearch: false,
      lastSearchInfo: null,
      pending: {
        count: "",
        op: null,
        opCount: "",
        g: false,
        replace: false,
        textobj: null,
        find: null,
      },
      _hadCount: false,
      _seq: [],
      _dot: null,
      _insertPending: null,
      _replaying: false,
      _noRecord: false,
    };
    // Default mode is Insert, where the cursor may legitimately sit at EOL, so
    // only bound it to the buffer rather than applying Normal-mode clamping.
    var c = cursor || 0;
    s.cursor = c < 0 ? 0 : c > s.text.length ? s.text.length : c;
    return s;
  }

  // Called by the adapter when leaving Insert mode: the native editor may have
  // changed the buffer, so re-read it before Normal-mode commands run.
  function syncFromEditor(state, text, cursor) {
    state.text = text;
    state.cursor = clampNormal(text, cursor);
    return state;
  }

  var api = {
    MODE: MODE,
    createState: createState,
    handleKey: handleKey,
    finishInsert: finishInsert,
    setSearch: setSearch,
    searchNext: searchNext,
    computeMatches: computeMatches,
    syncFromEditor: syncFromEditor,
    clampNormal: clampNormal,
    lineStartAt: lineStartAt,
    lineEndAt: lineEndAt,
  };

  root.ThundervimEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
