// Thundervim compose-window adapter.
//
// This is the only part of the extension that touches Thunderbird / the DOM.
// It bridges the pure `ThundervimEngine` to the plain-text compose editor,
// which is a contenteditable document (`document.body`) whose newlines are
// <br> elements.
//
// Design:
//   * In INSERT mode the native editor owns typing (IME, spellcheck, quoting
//     all keep working); we only intercept the exit-to-normal keys.
//   * In NORMAL / VISUAL mode we intercept keys, run the engine, and write the
//     resulting text + caret back into the DOM.
//   * The mode status bar is attached to <html> (outside <body>) so it is
//     never serialized into the outgoing message.

(function () {
  "use strict";

  // ------------------------------------------------------------------ config
  var CONFIG = {
    enableOnStart: true,
    defaultMode: "insert", // 'insert' | 'normal'
    // Toggle Thundervim on/off for this window. Checked before anything else.
    toggle: { ctrl: true, alt: true, key: "v" },
    // Type these two keys quickly in Insert mode to act as <Esc>. Empty ('')
    // disables it, matching vanilla vim where only <Esc> leaves Insert mode.
    // Set e.g. to "jk" if you want the classic escape-sequence convenience and
    // the window-level Escape binding proves unreliable.
    insertEscapeSequence: "",
    escapeTimeoutMs: 500,
    // Spaces inserted/removed by >> and << (and >{motion} etc.).
    shiftWidth: 4,
    // Column at which gq wraps paragraphs (mirrors mailnews.wraplength).
    textWidth: 72,
  };

  var engine = globalThis.ThundervimEngine;
  if (!engine) return; // engine.js failed to load; do nothing.

  var state = engine.createState("", 0);
  state.shiftwidth = CONFIG.shiftWidth;
  state.textwidth = CONFIG.textWidth;
  state.mode =
    CONFIG.defaultMode === "normal" ? engine.MODE.NORMAL : engine.MODE.INSERT;
  var enabled = CONFIG.enableOnStart;
  var lastInsert = { key: null, time: 0 };
  // Snapshot of the buffer at the moment Insert mode is entered from a command,
  // used to recover the typed text for dot-repeat when Insert mode exits.
  var insertStart = null;
  // Active `/` or `?` prompt: { dir: 1|-1, query: string }, or null.
  var searching = null;
  // Transient status-bar note (e.g. "pattern not found"), shown until next key.
  var searchMsg = "";
  // Set when we consume a key; used to cancel the editor's resulting text-input
  // edit. Thunderbird's editor inserts characters via `beforeinput`, which a
  // content-script `keydown` preventDefault() does not cancel on its own.
  var suppressInput = false;

  // ---------------------------------------------------------- DOM <-> text

  var BLOCK = {
    DIV: 1,
    P: 1,
    BLOCKQUOTE: 1,
    PRE: 1,
    LI: 1,
    H1: 1,
    H2: 1,
    H3: 1,
    H4: 1,
    H5: 1,
    H6: 1,
    TR: 1,
  };

  // A <br> that is the body's last child is Gecko's padding/bogus node, not a
  // real line break. Our own writeBuffer never emits one, so skipping it avoids
  // reading a phantom trailing newline from the editor's native markup.
  function isBogusTrailingBr(node) {
    return (
      node.tagName === "BR" &&
      node.parentNode === document.body &&
      node.parentNode.lastChild === node
    );
  }

  // Serialize the editor body to a linear string and locate the caret offset.
  function readBuffer() {
    var body = document.body;
    if (!body) return null;
    var sel = window.getSelection();
    var focusNode = sel && sel.rangeCount ? sel.focusNode : null;
    var focusOffset = sel && sel.rangeCount ? sel.focusOffset : 0;

    var text = "";
    var caret = null;

    function visit(node) {
      if (node.nodeType === 3) {
        if (node === focusNode) caret = text.length + focusOffset;
        text += node.data;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.id === "thundervim-status") return;
      var tag = node.tagName;
      if (tag === "BR") {
        if (node === focusNode) caret = text.length;
        if (isBogusTrailingBr(node)) return; // padding node, not a newline
        text += "\n";
        return;
      }
      if (BLOCK[tag] && text.length > 0 && text[text.length - 1] !== "\n")
        text += "\n";
      var children = node.childNodes;
      var recordAt = node === focusNode ? focusOffset : -1;
      for (var i = 0; i < children.length; i++) {
        if (recordAt === i) caret = text.length;
        visit(children[i]);
      }
      if (recordAt === children.length) caret = text.length;
    }
    visit(body);
    if (caret == null) caret = text.length;
    return { text: text, caret: caret };
  }

  // Ensure the editor renders literal newlines (so we can store the whole body
  // as one text node with "\n" characters instead of <br> elements).
  function ensurePreWrap() {
    var body = document.body;
    if (body && body.style.whiteSpace !== "pre-wrap")
      body.style.whiteSpace = "pre-wrap";
  }

  // Rebuild the editor body from a linear string and place the caret.
  //
  // The buffer is written as a SINGLE text node containing real "\n"
  // characters. Combined with white-space:pre-wrap this makes every caret
  // offset a valid position (including empty lines and trailing newlines),
  // which avoids the editor snapping the caret off <br>/empty-node boundaries.
  function writeBuffer(text, caret) {
    var body = document.body;
    if (!body) return;
    ensurePreWrap();
    while (body.firstChild) body.removeChild(body.firstChild);
    var tn = document.createTextNode(text);
    body.appendChild(tn);
    // In a pre-wrap contenteditable a trailing "\n" does not yield a reachable
    // empty last line on its own. Append a padding <br> (skipped by readBuffer /
    // domPointAt as a trailing bogus node) so the caret can land there.
    if (text.length === 0 || text.charAt(text.length - 1) === "\n") {
      body.appendChild(document.createElement("br"));
    }
    var off = caret < 0 ? 0 : caret > text.length ? text.length : caret;
    var range = document.createRange();
    range.setStart(tn, off);
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ------------------------------------------------ formatting-preserving write

  function commonPrefixLen(a, b) {
    var m = Math.min(a.length, b.length);
    var i = 0;
    while (i < m && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }
  function commonSuffixLen(a, b, prefix) {
    var m = Math.min(a.length, b.length) - prefix;
    var s = 0;
    while (
      s < m &&
      a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)
    )
      s++;
    return s;
  }

  // Collapse the native selection to a single linear offset.
  function setNativeCaret(offset) {
    var b = domBoundary(offset);
    if (!b) return;
    try {
      var range = document.createRange();
      range.setStart(b.node, b.offset);
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) {
      /* boundary went stale; ignore */
    }
  }

  // Replace linear span [start, end) with `repl` via DOM range surgery. Used
  // when the edit crosses a text-node / <br> / block boundary. Newlines in
  // `repl` are kept as literal "\n" characters, which white-space:pre-wrap
  // renders as breaks and readBuffer/domPointAt both count consistently.
  function generalReplace(start, end, repl) {
    var bs = domBoundary(start);
    var be = domBoundary(end);
    if (!bs || !be) return false;
    try {
      var range = document.createRange();
      range.setStart(bs.node, bs.offset);
      range.setEnd(be.node, be.offset);
      range.deleteContents();
      if (repl) range.insertNode(document.createTextNode(repl));
      return true;
    } catch (err) {
      return false;
    }
  }

  // Nearest ancestor block element (stops at body). Text nodes resolve to their
  // parent's block. Returns null if the node lives directly under body with no
  // block wrapper.
  function nearestBlock(node) {
    var n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== document.body) {
      if (n.nodeType === 1 && BLOCK[n.tagName]) return n;
      n = n.parentNode;
    }
    return null;
  }

  // True if the changed span [p, qOld) crosses a block boundary, i.e. the block
  // holding the last unchanged char before the edit differs from the one holding
  // the first unchanged char after it. A stray body-level node (whitespace, an
  // inserted separator) resolves to a null block, which also counts as crossing.
  function editCrossesBlock(p, qOld, oldLen) {
    var pa = domPointAt(p > 0 ? p - 1 : 0);
    var pb = domPointAt(qOld < oldLen ? qOld : oldLen);
    var ba = pa ? nearestBlock(pa.node) : null;
    var bb = pb ? nearestBlock(pb.node) : null;
    return ba !== bb;
  }

  // Linear [start, end) span of every direct child of body, serialized exactly
  // like readBuffer (synthetic block-boundary newlines included; status/cursor/
  // highlight overlays and the bogus trailing <br> excluded). Lets a structural
  // edit target just the touched top-level blocks instead of the whole body.
  function topLevelSpans() {
    var body = document.body;
    if (!body) return null;
    var acc = 0;
    var lastCh = "";
    function isOverlay(node) {
      return (
        node.nodeType === 1 &&
        (node.id === "thundervim-status" ||
          node.id === "thundervim-cursor" ||
          node.id === "thundervim-highlights")
      );
    }
    function measure(node) {
      if (node.nodeType === 3) {
        acc += node.data.length;
        if (node.data.length) lastCh = node.data.charAt(node.data.length - 1);
        return;
      }
      if (node.nodeType !== 1 || isOverlay(node)) return;
      if (node.tagName === "BR") {
        if (isBogusTrailingBr(node)) return;
        acc += 1;
        lastCh = "\n";
        return;
      }
      if (BLOCK[node.tagName] && acc > 0 && lastCh !== "\n") {
        acc += 1;
        lastCh = "\n";
      }
      var ch = node.childNodes;
      for (var i = 0; i < ch.length; i++) measure(ch[i]);
    }
    var spans = [];
    var kids = body.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var node = kids[i];
      var over = isOverlay(node);
      var s = acc;
      measure(node);
      if (!over) spans.push({ node: node, start: s, end: acc });
    }
    return spans;
  }

  // Index of the span whose [start, end) contains offset o, else the last span
  // starting at or before o.
  function childIndexContaining(spans, o) {
    var best = -1;
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].start <= o && o < spans[i].end) return i;
      if (spans[i].start <= o) best = i;
    }
    return best;
  }

  // Structural edit that re-renders only the top-level blocks the change spans,
  // replacing them with a single pre-wrap <div> of the corresponding slice of
  // newText. Sibling nodes (quoted reply, signature blocks below) are untouched,
  // so a cross-block join no longer flattens the whole body. Returns true once
  // the DOM matches newText.
  function scopedRewrite(oldText, newText, p, qOld, caret, placeCaret) {
    var body = document.body;
    if (!body) return false;
    var spans = topLevelSpans();
    if (!spans || !spans.length) return false;
    var i0 = childIndexContaining(spans, p > 0 ? p - 1 : p);
    var lastOld = oldText.length > 0 ? oldText.length - 1 : 0;
    var i1 = childIndexContaining(
      spans,
      qOld < oldText.length ? qOld : lastOld,
    );
    if (i0 < 0 || i1 < 0 || i1 < i0) return false;
    var startOff = spans[i0].start;
    var endOff = spans[i1].end;
    var newEndOff = endOff + (newText.length - oldText.length);
    if (newEndOff < startOff) return false;
    var slice = newText.slice(startOff, newEndOff);
    var parent = spans[i0].node.parentNode;
    var stop = spans[i1].node.nextSibling;
    var anchor = spans[i0].node;
    if (slice.length > 0) {
      var div = document.createElement("div");
      div.style.whiteSpace = "pre-wrap";
      div.appendChild(document.createTextNode(slice));
      parent.insertBefore(div, anchor);
    }
    var cur = anchor;
    while (cur && cur !== stop) {
      var next = cur.nextSibling;
      parent.removeChild(cur);
      cur = next;
    }
    var chk = readBuffer();
    if (!chk || chk.text !== newText) return false;
    if (placeCaret) setNativeCaret(caret);
    return true;
  }

  // Bring the DOM in line with `newText` by applying only the changed span, so
  // untouched markup (quote levels, bold, links, ...) is preserved. Falls back
  // to a full flat rewrite only if a general edit can't reproduce newText.
  function applyEdit(oldText, newText, caret, placeCaret) {
    if (oldText === newText) {
      if (placeCaret) setNativeCaret(caret);
      return;
    }
    var p = commonPrefixLen(oldText, newText);
    var sfx = commonSuffixLen(oldText, newText, p);
    var qOld = oldText.length - sfx;
    var repl = newText.slice(p, newText.length - sfx);

    // Fast path: the whole changed span lives inside one text node. Splicing its
    // character data touches nothing else, so it is exact and formatting-safe
    // (literal newlines are fine under pre-wrap).
    var a = domPointAt(p);
    var b = domPointAt(qOld);
    if (
      a &&
      b &&
      !a.br &&
      !b.br &&
      a.node === b.node &&
      a.node.nodeType === 3 &&
      a.offset <= b.offset
    ) {
      var d = a.node.data;
      a.node.data = d.slice(0, a.offset) + repl + d.slice(b.offset);
      if (placeCaret) setNativeCaret(caret);
      return;
    }

    // A cross-block edit (e.g. J joining two <p>) can't be spliced: deleting
    // across the boundary strands two blocks and leaves a synthetic newline that
    // no longer matches the model. Re-render just the affected top-level blocks,
    // leaving quoted-reply and other siblings intact. Decide before mutating the
    // DOM so scopedRewrite reads a clean tree.
    if (editCrossesBlock(p, qOld, oldText.length)) {
      if (scopedRewrite(oldText, newText, p, qOld, caret, placeCaret)) return;
    } else if (generalReplace(p, qOld, repl)) {
      // Within-block cross-boundary edit (e.g. spanning a <br> or inline tag).
      // The range surgery preserves surrounding formatting when it reproduces
      // newText exactly.
      var check = readBuffer();
      if (check && check.text === newText) {
        if (placeCaret) setNativeCaret(caret);
        return;
      }
      // The splice didn't reproduce newText; try the scoped re-render before the
      // last-resort flat writer.
      if (scopedRewrite(oldText, newText, p, qOld, caret, placeCaret)) return;
    }
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        "thundervim: flat-render fallback for a structural edit\n" +
          "oldText=" +
          JSON.stringify(oldText) +
          "\nnewText=" +
          JSON.stringify(newText) +
          "\nbodyHTML=" +
          (document.body ? document.body.innerHTML : ""),
      );
    }
    writeBuffer(newText, caret);
  }

  // Render the engine's buffer into the live DOM, preserving formatting.
  // `placeCaret` positions the native caret (needed when entering Insert mode).
  function syncDom(placeCaret) {
    if (!document.body) return;
    var cur = readBuffer();
    applyEdit(cur ? cur.text : "", state.text, state.cursor, placeCaret);
    ensureTrailingPad(state.text);
  }

  // After the app handled a Cmd chord (paste/cut/undo) in Normal mode, pull the
  // engine's buffer back in line with the DOM. A pure formatting or copy command
  // leaves the text unchanged, so we no-op and keep the current mode/cursor.
  function resyncFromDom() {
    var b = readBuffer();
    if (!b || b.text === state.text) return;
    engine.syncFromEditor(state, b.text, b.caret);
    state.mode = engine.MODE.NORMAL;
    syncDom(false);
    updateBar();
  }

  // After a Cmd chord applied to the vim visual selection: a formatting/copy
  // command leaves the text intact (land on the selection start, like a vim
  // operator), while a paste/cut replaces it (resync from the DOM). Either way
  // we drop back to Normal mode and collapse the native selection.
  function afterVisualMeta(caretOffset) {
    var b = readBuffer();
    if (!b) return;
    if (b.text !== state.text) {
      engine.syncFromEditor(state, b.text, b.caret);
    } else {
      state.text = b.text;
      var last = b.text.length > 0 ? b.text.length - 1 : 0;
      state.cursor = caretOffset < last ? caretOffset : last;
    }
    state.mode = engine.MODE.NORMAL;
    state.anchor = null;
    setNativeCaret(state.cursor);
    syncDom(false);
    updateBar();
  }

  // A buffer ending in "\n" (or empty) needs a trailing padding <br> so the last
  // empty line is reachable under pre-wrap; readBuffer/domPointAt skip it as a
  // bogus node. Mirrors the invariant the flat writeBuffer used to maintain.
  function ensureTrailingPad(text) {
    var body = document.body;
    if (!body) return;
    var needs = text.length === 0 || text.charAt(text.length - 1) === "\n";
    var last = body.lastChild;
    var lastIsBr = last && last.nodeType === 1 && last.tagName === "BR";
    if (needs && !lastIsBr) {
      body.appendChild(document.createElement("br"));
    } else if (!needs && lastIsBr && isBogusTrailingBr(last)) {
      body.removeChild(last);
    }
  }

  // ---------------------------------------------------- block cursor overlay

  // Map a linear buffer offset to a DOM point { node, offset, br } by walking
  // the body exactly the way readBuffer serializes it -- including the synthetic
  // newline inserted at a block-element boundary. Keeping this walk in lockstep
  // with readBuffer is what lets offsets stay correct in a rich (non-flat) DOM.
  function domPointAt(target) {
    var body = document.body;
    if (!body) return null;
    var acc = 0;
    var lastCh = ""; // last emitted character ("" = nothing emitted yet)
    var lastLeaf = null; // DOM point just after the last emitted character
    var result = null;
    function visit(node) {
      if (result) return;
      if (node.nodeType === 3) {
        var data = node.data;
        var len = data.length;
        if (target <= acc + len) {
          result = { node: node, offset: target - acc, br: false };
          return;
        }
        acc += len;
        if (len) {
          lastCh = data.charAt(len - 1);
          lastLeaf = { node: node, offset: len };
        }
        return;
      }
      if (node.nodeType !== 1) return;
      if (
        node.id === "thundervim-status" ||
        node.id === "thundervim-cursor" ||
        node.id === "thundervim-highlights"
      )
        return;
      if (node.tagName === "BR") {
        if (isBogusTrailingBr(node)) return; // padding node, not a newline
        if (target === acc) {
          result = { node: node, offset: 0, br: true };
          return;
        }
        acc += 1;
        lastCh = "\n";
        var p = node.parentNode;
        lastLeaf = {
          node: p,
          offset: Array.prototype.indexOf.call(p.childNodes, node) + 1,
        };
        return;
      }
      // Entering a block element emits a newline (unless one is already there),
      // mirroring readBuffer. Its DOM point is the end of the previous line.
      if (BLOCK[node.tagName] && acc > 0 && lastCh !== "\n") {
        if (target === acc) {
          result = lastLeaf || { node: node, offset: 0, br: false };
          return;
        }
        acc += 1;
        lastCh = "\n";
      }
      var children = node.childNodes;
      for (var i = 0; i < children.length && !result; i++) visit(children[i]);
    }
    visit(body);
    return result;
  }

  // A DOM boundary { node, offset } suitable for Range.setStart/setEnd. Unlike a
  // domPointAt result, a `br` newline is expressed as its index in the parent so
  // a range can span (and thus delete) the break itself.
  function domBoundary(offset) {
    var p = domPointAt(offset);
    if (!p) return null;
    if (p.br) {
      var parent = p.node.parentNode;
      return {
        node: parent,
        offset: Array.prototype.indexOf.call(parent.childNodes, p.node),
      };
    }
    return { node: p.node, offset: p.offset };
  }

  // Rect of the character the Normal-mode cursor sits on (viewport coords).
  // Returns { rect, collapsed } where `collapsed` means there is no character
  // under the cursor (empty line / end of line) so a default width is used.
  function cursorRect() {
    var p = domPointAt(state.cursor);
    if (!p) return null;
    var ch =
      !p.br && p.node.nodeType === 3 && p.offset < p.node.data.length
        ? p.node.data[p.offset]
        : null;
    var onChar = ch !== null && ch !== "\n";
    var range = document.createRange();
    try {
      if (onChar) {
        range.setStart(p.node, p.offset);
        range.setEnd(p.node, p.offset + 1);
        var rects = range.getClientRects();
        var rect = rects.length
          ? rects[rects.length - 1]
          : range.getBoundingClientRect();
        return { rect: rect, collapsed: false };
      }
      // Empty line / end of line / newline char: a collapsed range at a line
      // boundary is ambiguous and Gecko often reports the previous line's end,
      // so always measure via an inserted marker which sits in the correct
      // line's flow.
      if (p.br) range.setStartBefore(p.node);
      else range.setStart(p.node, p.offset);
      range.collapse(true);
      return { rect: markerRect(range), collapsed: true };
    } catch (err) {
      return null;
    }
  }

  // Insert a zero-width span at the (collapsed) range, measure it, remove it.
  // Inserting mid-text splits the node, so normalize afterward to restore the
  // single-text-node form. The disturbed native selection does not matter in
  // Normal/Visual mode (we drive the cursor from engine state, not the DOM).
  function markerRect(range) {
    var marker = document.createElement("span");
    marker.textContent = "\u200b";
    range.insertNode(marker);
    var rect = marker.getBoundingClientRect();
    if (marker.parentNode) marker.parentNode.removeChild(marker);
    if (document.body) document.body.normalize();
    return rect;
  }

  function ensureCursor() {
    var el = document.getElementById("thundervim-cursor");
    if (!el) {
      el = document.createElement("div");
      el.id = "thundervim-cursor";
      el.setAttribute("contenteditable", "false");
      (document.documentElement || document.body).appendChild(el);
    }
    return el;
  }

  function updateCursor() {
    var el = ensureCursor();
    var normalish = enabled && state.mode !== engine.MODE.INSERT;
    // Hide the native thin caret while the block cursor is shown.
    if (document.body)
      document.body.style.caretColor = normalish ? "transparent" : "";
    if (!normalish) {
      el.style.display = "none";
      return;
    }
    var cr = cursorRect();
    if (!cr || !cr.rect) {
      el.style.display = "none";
      return;
    }
    var r = cr.rect;
    el.style.display = "block";
    el.style.left = r.left + "px";
    el.style.top = r.top + "px";
    el.style.width = (!cr.collapsed && r.width > 0 ? r.width : 8) + "px";
    el.style.height = (r.height > 0 ? r.height : 16) + "px";
  }

  // ------------------------------------------------ visual selection overlay

  // The selected linear range [start, end) for the current visual mode.
  function selectionRange() {
    if (state.anchor == null) return null;
    if (state.mode === engine.MODE.VISUAL) {
      return {
        start: Math.min(state.anchor, state.cursor),
        end: Math.max(state.anchor, state.cursor) + 1,
      };
    }
    if (state.mode === engine.MODE.VLINE) {
      var text = state.text;
      var lo = Math.min(state.anchor, state.cursor);
      var hi = Math.max(state.anchor, state.cursor);
      return {
        start: engine.lineStartAt(text, lo),
        end: engine.lineEndAt(text, hi),
      };
    }
    return null;
  }

  function buildDomRange(start, end) {
    var ps = domPointAt(start);
    var pe = domPointAt(end);
    if (!ps || !pe) return null;
    var r = document.createRange();
    try {
      r.setStart(ps.node, ps.br ? 0 : ps.offset);
      r.setEnd(pe.node, pe.br ? 0 : pe.offset);
    } catch (err) {
      return null;
    }
    return r;
  }

  // Put the real DOM selection over [start, end) so a native command issued next
  // (Cmd+B/I/U, copy, cut, paste) acts on the vim visual selection -- which is
  // otherwise only an overlay while the native selection stays collapsed.
  function selectRangeInDom(start, end) {
    var r = buildDomRange(start, end);
    if (!r) return false;
    try {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    } catch (err) {
      return false;
    }
  }

  function ensureHighlights() {
    var el = document.getElementById("thundervim-highlights");
    if (!el) {
      el = document.createElement("div");
      el.id = "thundervim-highlights";
      el.setAttribute("contenteditable", "false");
      (document.documentElement || document.body).appendChild(el);
    }
    return el;
  }

  function updateHighlights() {
    var cont = ensureHighlights();
    while (cont.firstChild) cont.removeChild(cont.firstChild);
    if (!enabled) {
      cont.style.display = "none";
      return;
    }

    var ranges = [];
    // Search matches: live preview while typing a query, else persisted hits.
    var sq = searching
      ? searching.query
      : state.hlsearch
        ? state.search.query
        : "";
    if (sq) {
      // A live query being typed is always a plain substring; a committed
      // search may be whole-word (from `*` / `#`).
      var whole = searching ? false : state.search.wholeWord;
      var matches = engine.computeMatches(state.text, sq, whole);
      for (var mi = 0; mi < matches.length; mi++) {
        ranges.push({
          start: matches[mi].start,
          end: matches[mi].end,
          cls: "thundervim-search-hl",
        });
      }
    }
    // Visual selection.
    var visual =
      state.mode === engine.MODE.VISUAL || state.mode === engine.MODE.VLINE;
    if (visual) {
      var sr = selectionRange();
      if (sr)
        ranges.push({ start: sr.start, end: sr.end, cls: "thundervim-hl" });
    }

    if (!ranges.length) {
      cont.style.display = "none";
      return;
    }
    cont.style.display = "block";
    for (var ri = 0; ri < ranges.length; ri++) {
      var range = buildDomRange(ranges[ri].start, ranges[ri].end);
      if (!range) continue;
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.height <= 0) continue;
        var d = document.createElement("div");
        d.className = ranges[ri].cls;
        d.style.left = r.left + "px";
        d.style.top = r.top + "px";
        d.style.width = (r.width > 0 ? r.width : 8) + "px";
        d.style.height = r.height + "px";
        cont.appendChild(d);
      }
    }
  }

  function render() {
    updateCursor();
    updateHighlights();
  }

  // ----------------------------------------------------------- status bar

  function ensureBar() {
    var bar = document.getElementById("thundervim-status");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "thundervim-status";
      bar.setAttribute("contenteditable", "false");
      (document.documentElement || document.body).appendChild(bar);
    }
    if (!bar.querySelector(".tv-left")) {
      var left = document.createElement("span");
      left.className = "tv-left";
      var right = document.createElement("span");
      right.className = "tv-right";
      bar.appendChild(left);
      bar.appendChild(right);
    }
    return bar;
  }
  function setBar(leftText, rightText, mode) {
    var bar = ensureBar();
    bar.querySelector(".tv-left").textContent = leftText;
    bar.querySelector(".tv-right").textContent = rightText || "";
    bar.setAttribute("data-mode", mode);
    render();
  }
  function modeLabel() {
    switch (state.mode) {
      case engine.MODE.NORMAL:
        return "NORMAL";
      case engine.MODE.INSERT:
        return "INSERT";
      case engine.MODE.VISUAL:
        return "VISUAL";
      case engine.MODE.VLINE:
        return "VISUAL LINE";
      default:
        return state.mode;
    }
  }
  function pendingHint() {
    var p = state.pending || {};
    var s = (p.count || "") + (p.op || "") + (p.opCount || "");
    if (p.g) s += "g";
    if (p.replace) s += "r";
    return s ? "  " + s : "";
  }
  // vim-style ruler: 1-based line and column of `pos`, plus a Top/Bot/All/
  // percentage indicator of how far that line sits through `text`.
  function rulerFor(text, pos) {
    if (pos < 0) pos = 0;
    if (pos > text.length) pos = text.length;
    var ls = text.lastIndexOf("\n", pos - 1) + 1;
    var nlEnd = text.indexOf("\n", pos);
    var le = nlEnd === -1 ? text.length : nlEnd;
    var lineNum = text.slice(0, pos).split("\n").length;
    var totalLines = text.split("\n").length;
    // vim shows `0-1` on an empty line (byte col 0, virtual col 1).
    var colText = le - ls === 0 ? "0-1" : String(pos - ls + 1);
    var pos3;
    if (totalLines <= 1) pos3 = "All";
    else if (lineNum === 1) pos3 = "Top";
    else if (lineNum === totalLines) pos3 = "Bot";
    else pos3 = Math.floor(((lineNum - 1) * 100) / (totalLines - 1)) + "%";
    return lineNum + "," + colText + "   " + pos3;
  }
  function ruler() {
    return rulerFor(state.text, state.cursor);
  }
  // In Insert mode the engine's cursor is stale (the native editor owns the
  // caret), so recompute the ruler from the live DOM caret on every caret move.
  function updateRulerLive() {
    if (!enabled || state.mode !== engine.MODE.INSERT) return;
    var b = readBuffer();
    if (!b) return;
    var bar = ensureBar();
    var r = bar.querySelector(".tv-right");
    if (r) r.textContent = rulerFor(b.text, b.caret);
  }
  function updateBar() {
    if (!enabled) {
      setBar("-- vim off --", "", "off");
      return;
    }
    if (searching) {
      setBar((searching.dir > 0 ? "/" : "?") + searching.query, "", "search");
      return;
    }
    var left =
      "-- " +
      modeLabel() +
      " --" +
      pendingHint() +
      (searchMsg ? "  " + searchMsg : "");
    setBar(left, ruler(), state.mode);
  }

  // --------------------------------------------------------- key handling

  function normalize(e) {
    return {
      key: e.key,
      code: e.code,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
    };
  }
  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    suppressInput = true;
    // Clear on the next tick so ONLY the input events synchronously produced by
    // this key (keypress + beforeinput) are cancelled. Otherwise the flag would
    // linger and cancel unrelated input in the window before the next keydown
    // (e.g. clicking the Bold/Italic toolbar button, paste, or IME), which
    // silently breaks those actions.
    setTimeout(function () {
      suppressInput = false;
    }, 0);
  }

  // Input types produced by the plain character insertion / deletion that a
  // swallowed vim key would otherwise cause. Only these are cancelled while
  // `suppressInput` is set. Everything else (formatBold/Italic/Underline,
  // historyUndo/Redo, insertFromPaste, ...) must always go through, so Cmd+B/I/U
  // and the formatting toolbar keep working.
  var TEXT_EDIT_INPUT_TYPES = {
    insertText: 1,
    insertCompositionText: 1,
    insertReplacementText: 1,
    insertLineBreak: 1,
    insertParagraph: 1,
    deleteContent: 1,
    deleteContentBackward: 1,
    deleteContentForward: 1,
    deleteWordBackward: 1,
    deleteWordForward: 1,
  };

  // Cancel the editor edit that a swallowed key would otherwise produce. This
  // fires after our keydown handler ran and set `suppressInput`. The flag stays
  // set only for the current tick (see `swallow`), so both keypress and
  // beforeinput for the same key are cancelled without affecting later,
  // unrelated input events.
  function onInputEvent(e) {
    if (!suppressInput) return;
    // A `beforeinput` carries an inputType; only suppress genuine text edits.
    // Formatting/clipboard/history commands (which have no keypress) pass.
    if (
      e.type === "beforeinput" &&
      e.inputType &&
      !TEXT_EDIT_INPUT_TYPES[e.inputType]
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  function isToggle(ev) {
    var t = CONFIG.toggle;
    return (
      !!t.ctrl === ev.ctrl &&
      !!t.alt === ev.alt &&
      !!t.shift === !!ev.shift &&
      ev.key.toLowerCase() === t.key.toLowerCase()
    );
  }

  // The net text inserted between two buffer snapshots (common prefix/suffix).
  function diffInsert(before, after) {
    var max = Math.min(before.length, after.length);
    var p = 0;
    while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
    var sfx = 0;
    while (
      sfx < max - p &&
      before.charCodeAt(before.length - 1 - sfx) ===
        after.charCodeAt(after.length - 1 - sfx)
    )
      sfx++;
    return after.slice(p, after.length - sfx);
  }

  // Report the text typed during the just-ended Insert session to the engine so
  // `.` can replay it, then clear the snapshot.
  function finalizeInsert(finalText) {
    if (insertStart) {
      engine.finishInsert(state, diffInsert(insertStart.text, finalText));
      insertStart = null;
    }
  }

  // Handle the "jk" style escape sequence while in Insert mode. Returns true if
  // the event was consumed.
  function handleInsertEscape(e, ev) {
    var seq = CONFIG.insertEscapeSequence;
    if (!seq || seq.length !== 2) return false;
    if (ev.ctrl || ev.alt || ev.meta || ev.key.length !== 1) {
      lastInsert = { key: null, time: 0 };
      return false;
    }
    var now = Date.now();
    if (
      ev.key === seq[1] &&
      lastInsert.key === seq[0] &&
      now - lastInsert.time < CONFIG.escapeTimeoutMs
    ) {
      // The first key (seq[0]) was already typed natively; remove it, then exit.
      swallow(e);
      var buf = readBuffer();
      var text = buf.text;
      var caret = buf.caret;
      if (caret > 0 && text[caret - 1] === seq[0]) {
        text = text.slice(0, caret - 1) + text.slice(caret);
        caret = caret - 1;
      }
      finalizeInsert(text);
      engine.syncFromEditor(state, text, caret);
      state.mode = engine.MODE.NORMAL;
      state.cursor = engine.clampNormal(text, caret - 1);
      syncDom(false);
      updateBar();
      lastInsert = { key: null, time: 0 };
      return true;
    }
    lastInsert = { key: ev.key, time: now };
    return false;
  }

  // ------------------------------------------------------------ search prompt

  function beginSearch(dir) {
    searching = { dir: dir, query: "" };
    searchMsg = "";
    updateBar();
  }

  function searchMessage(info) {
    if (!info || !info.found) {
      return "Pattern not found: " + (state.search.query || "");
    }
    if (info.wrapped) {
      return state.search.dir > 0
        ? "search hit BOTTOM, continuing at TOP"
        : "search hit TOP, continuing at BOTTOM";
    }
    return "";
  }

  // Consume a key while the `/`|`?` prompt is open. Returns nothing; always
  // swallows the event.
  function handleSearchKey(e, ev) {
    swallow(e);
    if (ev.key === "Escape") {
      searching = null;
      searchMsg = "";
      updateBar();
      return;
    }
    if (ev.key === "Enter") {
      var q = searching.query;
      var dir = searching.dir;
      searching = null;
      var info = engine.setSearch(state, q, dir);
      searchMsg = searchMessage(info);
      syncDom(false);
      updateBar();
      return;
    }
    if (ev.key === "Backspace") {
      if (searching.query.length > 0) {
        searching.query = searching.query.slice(0, -1);
      } else {
        searching = null; // backspace past the prompt cancels
      }
      updateBar();
      return;
    }
    if (!ev.ctrl && !ev.meta && !ev.alt && ev.key.length === 1) {
      searching.query += ev.key;
      updateBar();
      return;
    }
    // Ignore anything else (arrows, function keys) but keep the prompt open.
  }

  function onKeydown(e) {
    suppressInput = false;
    var ev = normalize(e);

    // The enable/disable toggle works even while Thundervim is off.
    if (isToggle(ev)) {
      swallow(e);
      enabled = !enabled;
      if (enabled) {
        var b = readBuffer();
        engine.syncFromEditor(state, b ? b.text : "", b ? b.caret : 0);
        state.mode = engine.MODE.NORMAL;
        syncDom(false);
      }
      updateBar();
      return;
    }

    // Debug chord (Ctrl-Alt-D): dump the DOM + linear model. Works regardless of
    // enabled state so it can capture round-trip bug reports. Match on ev.code
    // (physical KeyD): on macOS the Option/Alt key rewrites ev.key (Option+D ->
    // a dead key), so ev.key would never equal "d" while Alt is held.
    if (
      ev.ctrl &&
      ev.alt &&
      !ev.meta &&
      (ev.code === "KeyD" || ev.key.toLowerCase() === "d")
    ) {
      swallow(e);
      dumpState("manual");
      return;
    }

    if (!enabled) return;

    // Ignore standalone modifier presses. Their keydown fires between a prefix
    // key (r, i, a, ...) and the real character, and must not disturb pending
    // engine state (e.g. `rH` or `ci(` where the char needs Shift).
    if (
      ev.key === "Shift" ||
      ev.key === "Control" ||
      ev.key === "Alt" ||
      ev.key === "Meta" ||
      ev.key === "CapsLock" ||
      ev.key === "AltGraph"
    ) {
      return;
    }

    // The search prompt owns every key while it is open.
    if (searching) {
      handleSearchKey(e, ev);
      return;
    }

    // Cmd (meta) chords belong to the application, not vim. macOS binds Cmd+B/
    // I/U to Bold/Italic/Underline and Cmd+C/V/X/Z to clipboard & undo; vim has
    // no Cmd bindings. Never swallow these in any mode, or e.g. Cmd+B is read as
    // the `b` motion and the formatting command never reaches Thunderbird.
    if (ev.meta) {
      var vis =
        state.mode === engine.MODE.VISUAL || state.mode === engine.MODE.VLINE;
      if (vis) {
        // The visual selection is only an overlay; the native selection stays
        // collapsed. Materialize it now so the command acts on the highlighted
        // text, then reconcile on the next tick.
        var sr = selectionRange();
        var caret = sr ? sr.start : state.cursor;
        if (sr) selectRangeInDom(sr.start, sr.end);
        setTimeout(function () {
          afterVisualMeta(caret);
        }, 0);
      } else if (state.mode !== engine.MODE.INSERT) {
        // A native edit (paste/cut/undo) can change the buffer; resync after.
        setTimeout(resyncFromDom, 0);
      }
      return;
    }

    if (state.mode === engine.MODE.INSERT) {
      if (ev.key === "Escape") {
        var buf = readBuffer();
        finalizeInsert(buf.text);
        // Keep the raw insert caret (it may sit past the last char); the engine's
        // Escape handler performs the single Normal-mode "move left".
        state.text = buf.text;
        state.cursor = buf.caret;
        var r = engine.handleKey(state, ev); // -> Normal, cursor left once
        if (r.handled) {
          swallow(e);
          syncDom(false);
          updateBar();
        }
        return;
      }
      if (handleInsertEscape(e, ev)) return;
      return; // let the native editor type
    }

    // Open the search prompt (`/` forward, `?` backward) from Normal mode.
    if (
      state.mode === engine.MODE.NORMAL &&
      (ev.key === "/" || ev.key === "?")
    ) {
      swallow(e);
      beginSearch(ev.key === "/" ? 1 : -1);
      return;
    }
    // A fresh action clears any lingering search message.
    searchMsg = "";

    // Normal / Visual: the engine's state is authoritative here (we are the only
    // thing editing the buffer), so we do NOT re-read the caret from the DOM per
    // key — doing so lets Gecko's caret normalization on empty lines desync
    // vertical motion. Mouse repositioning is handled by the mouseup listener.
    var res = engine.handleKey(state, ev);
    if (!res.handled) {
      updateBar(); // reflect pending count/operator
      return; // modifier chords etc. pass through to Thunderbird
    }
    swallow(e);
    // n/N surface a wrap / not-found note in the status bar.
    if (ev.key === "n" || ev.key === "N") {
      searchMsg = searchMessage(state.lastSearchInfo);
    }
    // A command just entered Insert mode: snapshot the buffer so the typed text
    // can be recovered for dot-repeat when Insert mode exits.
    if (state.mode === engine.MODE.INSERT) {
      insertStart = { text: state.text, cursor: state.cursor };
    }
    syncDom(state.mode === engine.MODE.INSERT);
    updateBar();
  }

  // ---------------------------------------------------------------- init

  // Diagnostic: dump the live DOM and the linear model. Neither the content-
  // script console nor the clipboard APIs are usable in Thunderbird's compose
  // sandbox (console output is hidden; navigator.clipboard is undefined and
  // execCommand("copy") silently no-ops inside the contenteditable). So we show
  // the JSON in a visible, pre-selected textarea overlay: the user copies it
  // with a native Cmd+C and dismisses it with Esc. Triggered by Ctrl-Alt-D.
  function dumpState(label) {
    var b = readBuffer();
    var info = {
      label: label || "",
      mode: state.mode,
      cursor: state.cursor,
      text: b ? b.text : null,
      caret: b ? b.caret : null,
      html: document.body ? document.body.innerHTML : null,
    };
    var json = JSON.stringify(info, null, 2);
    if (typeof console !== "undefined" && console.log)
      console.log("thundervim dump", info);
    showDumpOverlay(json);
    return info;
  }

  var dumpOverlay = null;
  function closeDumpOverlay() {
    if (dumpOverlay && dumpOverlay.parentNode)
      dumpOverlay.parentNode.removeChild(dumpOverlay);
    dumpOverlay = null;
    if (document.body && document.body.focus) document.body.focus();
    updateBar();
  }
  function showDumpOverlay(text) {
    closeDumpOverlay();
    var doc = document;
    var host = doc.body || doc.documentElement;
    var overlay = doc.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.55);" +
      "display:flex;flex-direction:column;padding:24px;box-sizing:border-box;";
    var hint = doc.createElement("div");
    hint.textContent =
      "thundervim dump \u2014 press Cmd+C to copy, Esc to close";
    hint.style.cssText =
      "color:#fff;font:13px/1.4 monospace;margin-bottom:8px;flex:0 0 auto;";
    var ta = doc.createElement("textarea");
    ta.value = text;
    ta.style.cssText =
      "flex:1 1 auto;width:100%;box-sizing:border-box;font:12px/1.4 monospace;" +
      "padding:8px;resize:none;background:#111;color:#eee;border:1px solid #555;";
    ta.addEventListener("keydown", function (e) {
      // Keep the vim keydown handler out; let native copy/select work here.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        closeDumpOverlay();
      }
    });
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) closeDumpOverlay(); // click backdrop to close
    });
    overlay.appendChild(hint);
    overlay.appendChild(ta);
    host.appendChild(overlay);
    dumpOverlay = overlay;
    ta.focus();
    ta.select();
    setBar(
      "-- thundervim: dump ready (Cmd+C to copy, Esc to close) --",
      "",
      "normal",
    );
  }
  if (typeof window !== "undefined") window.thundervim_dump = dumpState;

  function init() {
    ensurePreWrap();
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("keypress", onInputEvent, true);
    document.addEventListener("beforeinput", onInputEvent, true);
    // While typing in Insert mode the engine cursor is stale, so keep the ruler
    // live from the DOM caret. `selectionchange` covers typing, arrows and clicks.
    document.addEventListener("selectionchange", updateRulerLive);
    // Keep the block cursor and selection aligned when the view moves without
    // a keystroke.
    window.addEventListener("scroll", render, true);
    window.addEventListener("resize", render, true);
    document.addEventListener(
      "mouseup",
      function () {
        if (enabled && state.mode !== engine.MODE.INSERT) {
          var b = readBuffer();
          if (b) engine.syncFromEditor(state, b.text, b.caret);
          render();
        }
      },
      true,
    );
    updateBar();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
