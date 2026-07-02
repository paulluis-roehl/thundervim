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
    // Type these two keys quickly in Insert mode to act as <Esc>. Set to ''
    // to disable. Useful because a compose script cannot always block the
    // window-level Escape binding.
    insertEscapeSequence: "jk",
    escapeTimeoutMs: 500,
    // Spaces inserted/removed by >> and << (and >{motion} etc.).
    shiftWidth: 4,
  };

  var engine = globalThis.ThundervimEngine;
  if (!engine) return; // engine.js failed to load; do nothing.

  var state = engine.createState("", 0);
  state.shiftwidth = CONFIG.shiftWidth;
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

  // ---------------------------------------------------- block cursor overlay

  // Map a linear buffer offset to a DOM point { node, offset, br } by walking
  // the body the same way readBuffer serializes it.
  function domPointAt(target) {
    var body = document.body;
    if (!body) return null;
    var acc = 0;
    var result = null;
    function visit(node) {
      if (result) return;
      if (node.nodeType === 3) {
        var len = node.data.length;
        if (target <= acc + len) {
          result = { node: node, offset: target - acc, br: false };
          return;
        }
        acc += len;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.id === "thundervim-status" || node.id === "thundervim-cursor")
        return;
      if (node.tagName === "BR") {
        if (isBogusTrailingBr(node)) return; // padding node, not a newline
        if (target === acc) {
          result = { node: node, offset: 0, br: true };
          return;
        }
        acc += 1;
        return;
      }
      var children = node.childNodes;
      for (var i = 0; i < children.length && !result; i++) visit(children[i]);
    }
    visit(body);
    return result;
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
      var matches = engine.computeMatches(state.text, sq);
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
    return bar;
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
  function updateBar() {
    var bar = ensureBar();
    if (!enabled) {
      bar.textContent = "-- vim off --";
      bar.setAttribute("data-mode", "off");
      render();
      return;
    }
    if (searching) {
      bar.textContent = (searching.dir > 0 ? "/" : "?") + searching.query;
      bar.setAttribute("data-mode", "search");
      render();
      return;
    }
    bar.textContent =
      "-- " +
      modeLabel() +
      " --" +
      pendingHint() +
      (searchMsg ? "  " + searchMsg : "");
    bar.setAttribute("data-mode", state.mode);
    render();
  }

  // --------------------------------------------------------- key handling

  function normalize(e) {
    return {
      key: e.key,
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
  }

  // Cancel the editor edit that a swallowed key would otherwise produce. This
  // fires after our keydown handler ran and set `suppressInput`. We do NOT clear
  // the flag here so that both keypress and beforeinput for the same key are
  // cancelled; it is reset at the start of the next keydown.
  function onInputEvent(e) {
    if (!suppressInput) return;
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
      writeBuffer(state.text, state.cursor);
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
      writeBuffer(state.text, state.cursor);
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
        writeBuffer(state.text, state.cursor);
      }
      updateBar();
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
          writeBuffer(state.text, state.cursor);
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
    writeBuffer(state.text, state.cursor);
    updateBar();
  }

  // ---------------------------------------------------------------- init

  function init() {
    ensurePreWrap();
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("keypress", onInputEvent, true);
    document.addEventListener("beforeinput", onInputEvent, true);
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
