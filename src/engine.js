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
      default:
        return null;
    }
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

  // Apply an operator ('d','c','y') over a resolved motion.
  function applyOperator(state, op, motion) {
    if (motion.kind === "line") {
      var lines = buildLines(state.text);
      var a = lineOf(lines, state.cursor);
      var b = lineOf(lines, motion.pos);
      var lo = Math.min(a, b);
      var hi = Math.max(a, b);
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
    };
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
  };

  function handleKey(state, ev) {
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

    // Count accumulation ("0" is a motion unless a count is already building).
    if (/[0-9]/.test(key) && !(key === "0" && !currentCount(state))) {
      if (state.pending.op) state.pending.opCount += key;
      else state.pending.count += key;
      return { state: state, handled: true };
    }

    // `g` prefix (for gg).
    if (state.pending.g) {
      state.pending.g = false;
      if (key === "g") return runMotionOrOperator(state, "gg");
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
      case "u":
        undo(state);
        resetPending(state);
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
      pending: { count: "", op: null, opCount: "", g: false, replace: false },
      _hadCount: false,
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
    syncFromEditor: syncFromEditor,
    clampNormal: clampNormal,
    lineStartAt: lineStartAt,
    lineEndAt: lineEndAt,
  };

  root.ThundervimEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
