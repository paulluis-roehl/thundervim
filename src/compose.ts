// Thundervim compose-window adapter.
//
// This is the only part of the extension that touches Thunderbird / the DOM.
// It bridges the pure vim engine to the plain-text compose editor, which is a
// contenteditable document (`document.body`) whose newlines are <br> elements.
//
// Design:
//   * In INSERT mode the native editor owns typing (IME, spellcheck, quoting
//     all keep working); we only intercept the exit-to-normal keys.
//   * In NORMAL / VISUAL mode we intercept keys, run the engine, and write the
//     resulting text + caret back into the DOM.
//   * The mode status bar is attached to <html> (outside <body>) so it is
//     never serialized into the outgoing message.

import {
  MODE,
  createState,
  handleKey,
  finishInsert,
  setSearch,
  computeMatches,
  syncFromEditor,
  clampNormal,
  lineStartAt,
  lineEndAt,
} from "./engine.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import type { State, Mode, SearchInfo } from "./engine.ts";
import type { ThundervimConfig } from "./config.ts";

// Diagnostic hook exposed on the window for manual bug reports (Ctrl-Alt-D).
declare global {
  interface Window {
    thundervim_dump?: (label?: string) => unknown;
  }
}

// ------------------------------------------------------------------ config
let config: ThundervimConfig = DEFAULT_CONFIG;

function applyConfig(next: ThundervimConfig): void {
  config = next;
  state.shiftwidth = config.shiftWidth;
  state.textwidth = config.textWidth;
}

// The adapter's normalized key event: a structural superset of the engine's
// KeyEvent (it also carries `code`, used by the macOS debug chord).
interface NormKey {
  key: string;
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

const state: State = createState("", 0);
state.shiftwidth = config.shiftWidth;
state.textwidth = config.textWidth;
state.mode = config.defaultMode === "normal" ? MODE.NORMAL : MODE.INSERT;
let enabled = config.enableOnStart;
let lastInsert: { key: string | null; time: number } = { key: null, time: 0 };
// Snapshot of the buffer at the moment Insert mode is entered from a command,
// used to recover the typed text for dot-repeat when Insert mode exits.
let insertStart: { text: string; cursor: number } | null = null;
// Active `/` or `?` prompt: { dir: 1|-1, query: string }, or null.
let searching: { dir: number; query: string } | null = null;
// Transient status-bar note (e.g. "pattern not found"), shown until next key.
let searchMsg = "";
// Set when we consume a key; used to cancel the editor's resulting text-input
// edit. Thunderbird's editor inserts characters via `beforeinput`, which a
// content-script `keydown` preventDefault() does not cancel on its own.
let suppressInput = false;

// ---------------------------------------------------------- DOM <-> text

const BLOCK: Record<string, number> = {
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

// Narrowing helpers that mirror the original numeric nodeType checks.
function isText(node: Node): node is Text {
  return node.nodeType === 3;
}
function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

// A serialized read of the editor body: linear text plus the caret offset.
interface ReadResult {
  text: string;
  caret: number;
}
// A resolved DOM position. `br` marks a point that sits on a <br> newline.
interface DomPoint {
  node: Node;
  offset: number;
  br?: boolean;
}
// A DOM boundary suitable for Range.setStart / setEnd.
interface Boundary {
  node: Node;
  offset: number;
}
// A [start, end) linear span of one top-level body child.
interface Span {
  node: ChildNode;
  start: number;
  end: number;
}
// A [start, end) linear selection span.
interface LinearRange {
  start: number;
  end: number;
}

// A <br> that is the body's last child is Gecko's padding/bogus node, not a
// real line break. Our own writeBuffer never emits one, so skipping it avoids
// reading a phantom trailing newline from the editor's native markup.
function isBogusTrailingBr(node: Node): boolean {
  return (
    node instanceof Element &&
    node.tagName === "BR" &&
    node.parentNode === document.body &&
    node.parentNode.lastChild === node
  );
}

// Serialize the editor body to a linear string and locate the caret offset.
function readBuffer(): ReadResult | null {
  const body = document.body;
  if (!body) return null;
  const sel = window.getSelection();
  const focusNode: Node | null = sel && sel.rangeCount ? sel.focusNode : null;
  const focusOffset = sel && sel.rangeCount ? sel.focusOffset : 0;

  let text = "";
  let caret: number | null = null;

  function visit(node: Node): void {
    if (isText(node)) {
      if (node === focusNode) caret = text.length + focusOffset;
      text += node.data;
      return;
    }
    if (!isElement(node)) return;
    if (node.id === "thundervim-status") return;
    const tag = node.tagName;
    if (tag === "BR") {
      if (node === focusNode) caret = text.length;
      if (isBogusTrailingBr(node)) return; // padding node, not a newline
      text += "\n";
      return;
    }
    if (BLOCK[tag] && text.length > 0 && text[text.length - 1] !== "\n")
      text += "\n";
    const children = node.childNodes;
    const recordAt = node === focusNode ? focusOffset : -1;
    for (let i = 0; i < children.length; i++) {
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
function ensurePreWrap(): void {
  const body = document.body;
  if (body && body.style.whiteSpace !== "pre-wrap")
    body.style.whiteSpace = "pre-wrap";
}

// Rebuild the editor body from a linear string and place the caret.
//
// The buffer is written as a SINGLE text node containing real "\n"
// characters. Combined with white-space:pre-wrap this makes every caret
// offset a valid position (including empty lines and trailing newlines),
// which avoids the editor snapping the caret off <br>/empty-node boundaries.
function writeBuffer(text: string, caret: number): void {
  const body = document.body;
  if (!body) return;
  ensurePreWrap();
  while (body.firstChild) body.removeChild(body.firstChild);
  const tn = document.createTextNode(text);
  body.appendChild(tn);
  // In a pre-wrap contenteditable a trailing "\n" does not yield a reachable
  // empty last line on its own. Append a padding <br> (skipped by readBuffer /
  // domPointAt as a trailing bogus node) so the caret can land there.
  if (text.length === 0 || text.charAt(text.length - 1) === "\n") {
    body.appendChild(document.createElement("br"));
  }
  const off = caret < 0 ? 0 : caret > text.length ? text.length : caret;
  const range = document.createRange();
  range.setStart(tn, off);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

// ------------------------------------------------ formatting-preserving write

function commonPrefixLen(a: string, b: string): number {
  const m = Math.min(a.length, b.length);
  let i = 0;
  while (i < m && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
function commonSuffixLen(a: string, b: string, prefix: number): number {
  const m = Math.min(a.length, b.length) - prefix;
  let s = 0;
  while (
    s < m &&
    a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)
  )
    s++;
  return s;
}

// Collapse the native selection to a single linear offset.
function setNativeCaret(offset: number): void {
  const b = domBoundary(offset);
  if (!b) return;
  try {
    const range = document.createRange();
    range.setStart(b.node, b.offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* boundary went stale; ignore */
  }
}

// Replace linear span [start, end) with `repl` via DOM range surgery. Used
// when the edit crosses a text-node / <br> / block boundary. Newlines in
// `repl` are kept as literal "\n" characters, which white-space:pre-wrap
// renders as breaks and readBuffer/domPointAt both count consistently.
function generalReplace(start: number, end: number, repl: string): boolean {
  const bs = domBoundary(start);
  const be = domBoundary(end);
  if (!bs || !be) return false;
  try {
    const range = document.createRange();
    range.setStart(bs.node, bs.offset);
    range.setEnd(be.node, be.offset);
    range.deleteContents();
    if (repl) range.insertNode(document.createTextNode(repl));
    return true;
  } catch {
    return false;
  }
}

// Nearest ancestor block element (stops at body). Text nodes resolve to their
// parent's block. Returns null if the node lives directly under body with no
// block wrapper.
function nearestBlock(node: Node): Element | null {
  let n: Node | null = node && isText(node) ? node.parentNode : node;
  while (n && n !== document.body) {
    if (isElement(n) && BLOCK[n.tagName]) return n;
    n = n.parentNode;
  }
  return null;
}

// True if the changed span [p, qOld) crosses a block boundary, i.e. the block
// holding the last unchanged char before the edit differs from the one holding
// the first unchanged char after it. A stray body-level node (whitespace, an
// inserted separator) resolves to a null block, which also counts as crossing.
function editCrossesBlock(p: number, qOld: number, oldLen: number): boolean {
  const pa = domPointAt(p > 0 ? p - 1 : 0);
  const pb = domPointAt(qOld < oldLen ? qOld : oldLen);
  const ba = pa ? nearestBlock(pa.node) : null;
  const bb = pb ? nearestBlock(pb.node) : null;
  return ba !== bb;
}

// Linear [start, end) span of every direct child of body, serialized exactly
// like readBuffer (synthetic block-boundary newlines included; status/cursor/
// highlight overlays and the bogus trailing <br> excluded). Lets a structural
// edit target just the touched top-level blocks instead of the whole body.
function topLevelSpans(): Span[] | null {
  const body = document.body;
  if (!body) return null;
  let acc = 0;
  let lastCh = "";
  function isOverlay(node: Node): boolean {
    return (
      isElement(node) &&
      (node.id === "thundervim-status" ||
        node.id === "thundervim-cursor" ||
        node.id === "thundervim-highlights")
    );
  }
  function measure(node: Node): void {
    if (isText(node)) {
      acc += node.data.length;
      if (node.data.length) lastCh = node.data.charAt(node.data.length - 1);
      return;
    }
    if (!isElement(node) || isOverlay(node)) return;
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
    const ch = node.childNodes;
    for (let i = 0; i < ch.length; i++) measure(ch[i]);
  }
  const spans: Span[] = [];
  const kids = body.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    const over = isOverlay(node);
    const s = acc;
    measure(node);
    if (!over) spans.push({ node: node, start: s, end: acc });
  }
  return spans;
}

// Index of the span whose [start, end) contains offset o, else the last span
// starting at or before o.
function childIndexContaining(spans: Span[], o: number): number {
  let best = -1;
  for (let i = 0; i < spans.length; i++) {
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
function scopedRewrite(
  oldText: string,
  newText: string,
  p: number,
  qOld: number,
  caret: number,
  placeCaret: boolean,
): boolean {
  const body = document.body;
  if (!body) return false;
  const spans = topLevelSpans();
  if (!spans || !spans.length) return false;
  const i0 = childIndexContaining(spans, p > 0 ? p - 1 : p);
  const lastOld = oldText.length > 0 ? oldText.length - 1 : 0;
  const i1 = childIndexContaining(
    spans,
    qOld < oldText.length ? qOld : lastOld,
  );
  if (i0 < 0 || i1 < 0 || i1 < i0) return false;
  const startOff = spans[i0].start;
  const endOff = spans[i1].end;
  const newEndOff = endOff + (newText.length - oldText.length);
  if (newEndOff < startOff) return false;
  const slice = newText.slice(startOff, newEndOff);
  const parent = spans[i0].node.parentNode!;
  const stop = spans[i1].node.nextSibling;
  const anchor = spans[i0].node;
  if (slice.length > 0) {
    const div = document.createElement("div");
    div.style.whiteSpace = "pre-wrap";
    div.appendChild(document.createTextNode(slice));
    parent.insertBefore(div, anchor);
  }
  let cur: ChildNode | null = anchor;
  while (cur && cur !== stop) {
    const next: ChildNode | null = cur.nextSibling;
    parent.removeChild(cur);
    cur = next;
  }
  const chk = readBuffer();
  if (!chk || chk.text !== newText) return false;
  if (placeCaret) setNativeCaret(caret);
  return true;
}

// Bring the DOM in line with `newText` by applying only the changed span, so
// untouched markup (quote levels, bold, links, ...) is preserved. Falls back
// to a full flat rewrite only if a general edit can't reproduce newText.
function applyEdit(
  oldText: string,
  newText: string,
  caret: number,
  placeCaret: boolean,
): void {
  if (oldText === newText) {
    if (placeCaret) setNativeCaret(caret);
    return;
  }
  const p = commonPrefixLen(oldText, newText);
  const sfx = commonSuffixLen(oldText, newText, p);
  const qOld = oldText.length - sfx;
  const repl = newText.slice(p, newText.length - sfx);

  // Fast path: the whole changed span lives inside one text node. Splicing its
  // character data touches nothing else, so it is exact and formatting-safe
  // (literal newlines are fine under pre-wrap).
  const a = domPointAt(p);
  const b = domPointAt(qOld);
  if (
    a &&
    b &&
    !a.br &&
    !b.br &&
    a.node === b.node &&
    isText(a.node) &&
    a.offset <= b.offset
  ) {
    const d = a.node.data;
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
    const check = readBuffer();
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
function syncDom(placeCaret: boolean): void {
  if (!document.body) return;
  const cur = readBuffer();
  applyEdit(cur ? cur.text : "", state.text, state.cursor, placeCaret);
  ensureTrailingPad(state.text);
}

// After the app handled a Cmd chord (paste/cut/undo) in Normal mode, pull the
// engine's buffer back in line with the DOM. A pure formatting or copy command
// leaves the text unchanged, so we no-op and keep the current mode/cursor.
function resyncFromDom(): void {
  const b = readBuffer();
  if (!b || b.text === state.text) return;
  syncFromEditor(state, b.text, b.caret);
  state.mode = MODE.NORMAL;
  syncDom(false);
  updateBar();
}

// After a Cmd chord applied to the vim visual selection: a formatting/copy
// command leaves the text intact (land on the selection start, like a vim
// operator), while a paste/cut replaces it (resync from the DOM). Either way
// we drop back to Normal mode and collapse the native selection.
function afterVisualMeta(caretOffset: number): void {
  const b = readBuffer();
  if (!b) return;
  if (b.text !== state.text) {
    syncFromEditor(state, b.text, b.caret);
  } else {
    state.text = b.text;
    const last = b.text.length > 0 ? b.text.length - 1 : 0;
    state.cursor = caretOffset < last ? caretOffset : last;
  }
  state.mode = MODE.NORMAL;
  state.anchor = null;
  setNativeCaret(state.cursor);
  syncDom(false);
  updateBar();
}

// A buffer ending in "\n" (or empty) needs a trailing padding <br> so the last
// empty line is reachable under pre-wrap; readBuffer/domPointAt skip it as a
// bogus node. Mirrors the invariant the flat writeBuffer used to maintain.
function ensureTrailingPad(text: string): void {
  const body = document.body;
  if (!body) return;
  const needs = text.length === 0 || text.charAt(text.length - 1) === "\n";
  const last = body.lastChild;
  const lastIsBr = last instanceof Element && last.tagName === "BR";
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
function domPointAt(target: number): DomPoint | null {
  const body = document.body;
  if (!body) return null;
  let acc = 0;
  let lastCh = ""; // last emitted character ("" = nothing emitted yet)
  let lastLeaf: Boundary | null = null; // DOM point just after the last emitted character
  let result: DomPoint | null = null;
  function visit(node: Node): void {
    if (result) return;
    if (isText(node)) {
      const data = node.data;
      const len = data.length;
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
    if (!isElement(node)) return;
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
      const p = node.parentNode!;
      lastLeaf = {
        node: p,
        offset: Array.from<Node>(p.childNodes).indexOf(node) + 1,
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
    const children = node.childNodes;
    for (let i = 0; i < children.length && !result; i++) visit(children[i]);
  }
  visit(body);
  return result;
}

// A DOM boundary { node, offset } suitable for Range.setStart/setEnd. Unlike a
// domPointAt result, a `br` newline is expressed as its index in the parent so
// a range can span (and thus delete) the break itself.
function domBoundary(offset: number): Boundary | null {
  const p = domPointAt(offset);
  if (!p) return null;
  if (p.br) {
    const parent = p.node.parentNode!;
    return {
      node: parent,
      offset: Array.from<Node>(parent.childNodes).indexOf(p.node),
    };
  }
  return { node: p.node, offset: p.offset };
}

// Rect of the character the Normal-mode cursor sits on (viewport coords).
// Returns { rect, collapsed } where `collapsed` means there is no character
// under the cursor (empty line / end of line) so a default width is used.
function cursorRect(): { rect: DOMRect; collapsed: boolean } | null {
  const p = domPointAt(state.cursor);
  if (!p) return null;
  const ch =
    !p.br && isText(p.node) && p.offset < p.node.data.length
      ? p.node.data[p.offset]
      : null;
  const onChar = ch !== null && ch !== "\n";
  const range = document.createRange();
  try {
    if (onChar && isText(p.node)) {
      range.setStart(p.node, p.offset);
      range.setEnd(p.node, p.offset + 1);
      const rects = range.getClientRects();
      const rect = rects.length
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
  } catch {
    return null;
  }
}

// Insert a zero-width span at the (collapsed) range, measure it, remove it.
// Inserting mid-text splits the node, so normalize afterward to restore the
// single-text-node form. The disturbed native selection does not matter in
// Normal/Visual mode (we drive the cursor from engine state, not the DOM).
function markerRect(range: Range): DOMRect {
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  range.insertNode(marker);
  const rect = marker.getBoundingClientRect();
  if (marker.parentNode) marker.parentNode.removeChild(marker);
  if (document.body) document.body.normalize();
  return rect;
}

function ensureCursor(): HTMLElement {
  let el = document.getElementById("thundervim-cursor");
  if (!el) {
    el = document.createElement("div");
    el.id = "thundervim-cursor";
    el.setAttribute("contenteditable", "false");
    (document.documentElement || document.body).appendChild(el);
  }
  return el;
}

function updateCursor(): void {
  const el = ensureCursor();
  const normalish = enabled && state.mode !== MODE.INSERT;
  // Hide the native thin caret while the block cursor is shown.
  if (document.body)
    document.body.style.caretColor = normalish ? "transparent" : "";
  if (!normalish) {
    el.style.display = "none";
    return;
  }
  const cr = cursorRect();
  if (!cr || !cr.rect) {
    el.style.display = "none";
    return;
  }
  const r = cr.rect;
  el.style.display = "block";
  el.style.left = r.left + "px";
  el.style.top = r.top + "px";
  el.style.width = (!cr.collapsed && r.width > 0 ? r.width : 8) + "px";
  el.style.height = (r.height > 0 ? r.height : 16) + "px";
}

// ------------------------------------------------ visual selection overlay

// The selected linear range [start, end) for the current visual mode.
function selectionRange(): LinearRange | null {
  if (state.anchor == null) return null;
  if (state.mode === MODE.VISUAL) {
    return {
      start: Math.min(state.anchor, state.cursor),
      end: Math.max(state.anchor, state.cursor) + 1,
    };
  }
  if (state.mode === MODE.VLINE) {
    const text = state.text;
    const lo = Math.min(state.anchor, state.cursor);
    const hi = Math.max(state.anchor, state.cursor);
    return {
      start: lineStartAt(text, lo),
      end: lineEndAt(text, hi),
    };
  }
  return null;
}

function buildDomRange(start: number, end: number): Range | null {
  const ps = domPointAt(start);
  const pe = domPointAt(end);
  if (!ps || !pe) return null;
  const r = document.createRange();
  try {
    r.setStart(ps.node, ps.br ? 0 : ps.offset);
    r.setEnd(pe.node, pe.br ? 0 : pe.offset);
  } catch {
    return null;
  }
  return r;
}

// Put the real DOM selection over [start, end) so a native command issued next
// (Cmd+B/I/U, copy, cut, paste) acts on the vim visual selection -- which is
// otherwise only an overlay while the native selection stays collapsed.
function selectRangeInDom(start: number, end: number): boolean {
  const r = buildDomRange(start, end);
  if (!r) return false;
  try {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  } catch {
    return false;
  }
}

function ensureHighlights(): HTMLElement {
  let el = document.getElementById("thundervim-highlights");
  if (!el) {
    el = document.createElement("div");
    el.id = "thundervim-highlights";
    el.setAttribute("contenteditable", "false");
    (document.documentElement || document.body).appendChild(el);
  }
  return el;
}

function updateHighlights(): void {
  const cont = ensureHighlights();
  while (cont.firstChild) cont.removeChild(cont.firstChild);
  if (!enabled) {
    cont.style.display = "none";
    return;
  }

  const ranges: { start: number; end: number; cls: string }[] = [];
  // Search matches: live preview while typing a query, else persisted hits.
  const sq = searching
    ? searching.query
    : state.hlsearch
      ? state.search.query
      : "";
  if (sq) {
    // A live query being typed is always a plain substring; a committed
    // search may be whole-word (from `*` / `#`).
    const whole = searching ? false : state.search.wholeWord;
    const matches = computeMatches(state.text, sq, whole);
    for (let mi = 0; mi < matches.length; mi++) {
      ranges.push({
        start: matches[mi].start,
        end: matches[mi].end,
        cls: "thundervim-search-hl",
      });
    }
  }
  // Visual selection.
  const visual = state.mode === MODE.VISUAL || state.mode === MODE.VLINE;
  if (visual) {
    const sr = selectionRange();
    if (sr) ranges.push({ start: sr.start, end: sr.end, cls: "thundervim-hl" });
  }

  if (!ranges.length) {
    cont.style.display = "none";
    return;
  }
  cont.style.display = "block";
  for (let ri = 0; ri < ranges.length; ri++) {
    const range = buildDomRange(ranges[ri].start, ranges[ri].end);
    if (!range) continue;
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.height <= 0) continue;
      const d = document.createElement("div");
      d.className = ranges[ri].cls;
      d.style.left = r.left + "px";
      d.style.top = r.top + "px";
      d.style.width = (r.width > 0 ? r.width : 8) + "px";
      d.style.height = r.height + "px";
      cont.appendChild(d);
    }
  }
}

function render(): void {
  updateCursor();
  updateHighlights();
}

function removeChromeOverlays(): void {
  for (const id of [
    "thundervim-status",
    "thundervim-status-host",
    "thundervim-cursor",
    "thundervim-highlights",
  ]) {
    document.getElementById(id)?.remove();
  }
  if (dumpOverlay) {
    dumpOverlay.remove();
    dumpOverlay = null;
  }
}

function beforeSendCleanup(): void {
  removeChromeOverlays();
  window.setTimeout(() => {
    if (document.body?.isConnected) updateBar();
  }, 1000);
}

// ----------------------------------------------------------- status bar

function ensureBar(): HTMLElement {
  // Remove status bars from older versions that lived in the light DOM. Even
  // textless canvases there appear to be unsafe in Thunderbird's send encoder,
  // and CSS/generated text definitely leaks into plain-text messages.
  for (const old of Array.from(
    document.querySelectorAll("#thundervim-status"),
  )) {
    old.remove();
  }

  let host = document.getElementById("thundervim-status-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "thundervim-status-host";
    host.setAttribute("contenteditable", "false");
    (document.documentElement || document.body).appendChild(host);
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  let bar = shadow.getElementById("thundervim-status");
  if (!bar) {
    shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = `
      #thundervim-status {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 2147483647;
        box-sizing: border-box;
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 2px 8px;
        font-family: Menlo, Monaco, "DejaVu Sans Mono", monospace;
        font-size: 12px;
        line-height: 1.5;
        letter-spacing: 0.02em;
        color: #e6e6e6;
        background: #202225;
        border-top: 1px solid #000;
        pointer-events: none;
        user-select: none;
        white-space: pre;
      }
      #thundervim-status canvas { display: block; }
      #thundervim-status .tv-right { margin-left: 16px; }
      #thundervim-status[data-mode="insert"] { background: #2e7d32; color: #fff; }
      #thundervim-status[data-mode="normal"] { background: #202225; color: #e6e6e6; }
      #thundervim-status[data-mode="visual"],
      #thundervim-status[data-mode="visual-line"] { background: #6a1b9a; color: #fff; }
      #thundervim-status[data-mode="off"] { background: #4a4a4a; color: #bdbdbd; }
      #thundervim-status[data-mode="search"] { background: #202225; color: #ffd54f; }
    `;
    bar = document.createElement("div");
    bar.id = "thundervim-status";
    const left = document.createElement("canvas");
    left.className = "tv-left";
    const right = document.createElement("canvas");
    right.className = "tv-right";
    bar.appendChild(left);
    bar.appendChild(right);
    shadow.appendChild(style);
    shadow.appendChild(bar);
  }
  return bar;
}
function drawStatusText(canvas: HTMLCanvasElement, text: string): void {
  const bar = canvas.parentElement!;
  const style = getComputedStyle(bar);
  const dpr = window.devicePixelRatio || 1;
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text || " ").width + 2);
  const height = Math.ceil(parseFloat(style.lineHeight) || 18);

  canvas.width = Math.max(1, Math.ceil(width * dpr));
  canvas.height = Math.max(1, Math.ceil(height * dpr));
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";

  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "middle";
  ctx.globalAlpha = canvas.classList.contains("tv-right") ? 0.85 : 1;
  ctx.fillText(text, 0, height / 2);
}
function setBar(leftText: string, rightText: string, mode: string): void {
  const bar = ensureBar();
  bar.setAttribute("data-mode", mode);
  drawStatusText(bar.querySelector(".tv-left")!, leftText);
  drawStatusText(bar.querySelector(".tv-right")!, rightText || "");
  render();
}
function modeLabel(): string {
  switch (state.mode) {
    case MODE.NORMAL:
      return "NORMAL";
    case MODE.INSERT:
      return "INSERT";
    case MODE.VISUAL:
      return "VISUAL";
    case MODE.VLINE:
      return "VISUAL LINE";
    default:
      return state.mode;
  }
}
function pendingHint(): string {
  const p = state.pending;
  let s = (p.count || "") + (p.op || "") + (p.opCount || "");
  if (p.g) s += "g";
  if (p.replace) s += "r";
  return s ? "  " + s : "";
}
// vim-style ruler: 1-based line and column of `pos`, plus a Top/Bot/All/
// percentage indicator of how far that line sits through `text`.
function rulerFor(text: string, pos: number): string {
  if (pos < 0) pos = 0;
  if (pos > text.length) pos = text.length;
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  const nlEnd = text.indexOf("\n", pos);
  const le = nlEnd === -1 ? text.length : nlEnd;
  const lineNum = text.slice(0, pos).split("\n").length;
  const totalLines = text.split("\n").length;
  // vim shows `0-1` on an empty line (byte col 0, virtual col 1).
  const colText = le - ls === 0 ? "0-1" : String(pos - ls + 1);
  let pos3: string;
  if (totalLines <= 1) pos3 = "All";
  else if (lineNum === 1) pos3 = "Top";
  else if (lineNum === totalLines) pos3 = "Bot";
  else pos3 = Math.floor(((lineNum - 1) * 100) / (totalLines - 1)) + "%";
  return lineNum + "," + colText + "   " + pos3;
}
function ruler(): string {
  return rulerFor(state.text, state.cursor);
}
// In Insert mode the engine's cursor is stale (the native editor owns the
// caret), so recompute the ruler from the live DOM caret on every caret move.
function updateRulerLive(): void {
  if (!enabled || state.mode !== MODE.INSERT) return;
  const b = readBuffer();
  if (!b) return;
  const bar = ensureBar();
  const r = bar.querySelector(".tv-right");
  if (r) r.textContent = rulerFor(b.text, b.caret);
}
function updateBar(): void {
  if (!enabled) {
    setBar("-- vim off --", "", "off");
    return;
  }
  if (searching) {
    setBar((searching.dir > 0 ? "/" : "?") + searching.query, "", "search");
    return;
  }
  const left =
    "-- " +
    modeLabel() +
    " --" +
    pendingHint() +
    (searchMsg ? "  " + searchMsg : "");
  setBar(left, ruler(), state.mode);
}

// --------------------------------------------------------- key handling

function normalize(e: KeyboardEvent): NormKey {
  return {
    key: e.key,
    code: e.code,
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}
function swallow(e: Event): void {
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
const TEXT_EDIT_INPUT_TYPES: Record<string, number> = {
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
function onInputEvent(e: Event): void {
  if (!suppressInput) return;
  // A `beforeinput` carries an inputType; only suppress genuine text edits.
  // Formatting/clipboard/history commands (which have no keypress) pass.
  if (
    e.type === "beforeinput" &&
    (e as InputEvent).inputType &&
    !TEXT_EDIT_INPUT_TYPES[(e as InputEvent).inputType]
  ) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}
function isToggle(ev: NormKey): boolean {
  const t = config.toggle;
  return (
    !!t.ctrl === ev.ctrl &&
    !!t.alt === ev.alt &&
    !!t.shift === !!ev.shift &&
    ev.key.toLowerCase() === t.key.toLowerCase()
  );
}

// The net text inserted between two buffer snapshots (common prefix/suffix).
function diffInsert(before: string, after: string): string {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let sfx = 0;
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
function finalizeInsert(finalText: string): void {
  if (insertStart) {
    finishInsert(state, diffInsert(insertStart.text, finalText));
    insertStart = null;
  }
}

// Handle the "jk" style escape sequence while in Insert mode. Returns true if
// the event was consumed.
function handleInsertEscape(e: KeyboardEvent, ev: NormKey): boolean {
  const seq = config.insertEscapeSequence;
  if (!seq || seq.length !== 2) return false;
  if (ev.ctrl || ev.alt || ev.meta || ev.key.length !== 1) {
    lastInsert = { key: null, time: 0 };
    return false;
  }
  const now = Date.now();
  if (
    ev.key === seq[1] &&
    lastInsert.key === seq[0] &&
    now - lastInsert.time < config.escapeTimeoutMs
  ) {
    // The first key (seq[0]) was already typed natively; remove it, then exit.
    swallow(e);
    const buf = readBuffer()!;
    let text = buf.text;
    let caret = buf.caret;
    if (caret > 0 && text[caret - 1] === seq[0]) {
      text = text.slice(0, caret - 1) + text.slice(caret);
      caret = caret - 1;
    }
    finalizeInsert(text);
    syncFromEditor(state, text, caret);
    state.mode = MODE.NORMAL;
    state.cursor = clampNormal(text, caret - 1);
    syncDom(false);
    updateBar();
    lastInsert = { key: null, time: 0 };
    return true;
  }
  lastInsert = { key: ev.key, time: now };
  return false;
}

// ------------------------------------------------------------ search prompt

function beginSearch(dir: number): void {
  searching = { dir: dir, query: "" };
  searchMsg = "";
  updateBar();
}

function searchMessage(info: SearchInfo | null): string {
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
function handleSearchKey(e: KeyboardEvent, ev: NormKey): void {
  const s = searching;
  if (!s) return;
  swallow(e);
  if (ev.key === "Escape") {
    searching = null;
    searchMsg = "";
    updateBar();
    return;
  }
  if (ev.key === "Enter") {
    const q = s.query;
    const dir = s.dir;
    searching = null;
    const info = setSearch(state, q, dir);
    searchMsg = searchMessage(info);
    syncDom(false);
    updateBar();
    return;
  }
  if (ev.key === "Backspace") {
    if (s.query.length > 0) {
      s.query = s.query.slice(0, -1);
    } else {
      searching = null; // backspace past the prompt cancels
    }
    updateBar();
    return;
  }
  if (!ev.ctrl && !ev.meta && !ev.alt && ev.key.length === 1) {
    s.query += ev.key;
    updateBar();
    return;
  }
  // Ignore anything else (arrows, function keys) but keep the prompt open.
}

function onKeydown(e: KeyboardEvent): void {
  suppressInput = false;
  const ev = normalize(e);

  // The enable/disable toggle works even while Thundervim is off.
  if (isToggle(ev)) {
    swallow(e);
    enabled = !enabled;
    if (enabled) {
      const b = readBuffer();
      syncFromEditor(state, b ? b.text : "", b ? b.caret : 0);
      state.mode = MODE.NORMAL;
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
    const vis = state.mode === MODE.VISUAL || state.mode === MODE.VLINE;
    if (vis) {
      // The visual selection is only an overlay; the native selection stays
      // collapsed. Materialize it now so the command acts on the highlighted
      // text, then reconcile on the next tick.
      const sr = selectionRange();
      const caret = sr ? sr.start : state.cursor;
      if (sr) selectRangeInDom(sr.start, sr.end);
      setTimeout(function () {
        afterVisualMeta(caret);
      }, 0);
    } else if (state.mode !== MODE.INSERT) {
      // A native edit (paste/cut/undo) can change the buffer; resync after.
      setTimeout(resyncFromDom, 0);
    }
    return;
  }

  if (state.mode === MODE.INSERT) {
    if (ev.key === "Escape") {
      const buf = readBuffer()!;
      finalizeInsert(buf.text);
      // Keep the raw insert caret (it may sit past the last char); the engine's
      // Escape handler performs the single Normal-mode "move left".
      state.text = buf.text;
      state.cursor = buf.caret;
      const r = handleKey(state, ev); // -> Normal, cursor left once
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
  if (state.mode === MODE.NORMAL && (ev.key === "/" || ev.key === "?")) {
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
  const res = handleKey(state, ev);
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
  // can be recovered for dot-repeat when Insert mode exits. handleKey may have
  // switched the mode; cast past the stale narrowing from the earlier Insert
  // check above, which TS can't know handleKey invalidated.
  const enteredInsert = (state.mode as Mode) === MODE.INSERT;
  if (enteredInsert) {
    insertStart = { text: state.text, cursor: state.cursor };
  }
  syncDom(enteredInsert);
  updateBar();
}

// ---------------------------------------------------------------- init

// Diagnostic: dump the live DOM and the linear model. Neither the content-
// script console nor the clipboard APIs are usable in Thunderbird's compose
// sandbox (console output is hidden; navigator.clipboard is undefined and
// execCommand("copy") silently no-ops inside the contenteditable). So we show
// the JSON in a visible, pre-selected textarea overlay: the user copies it
// with a native Cmd+C and dismisses it with Esc. Triggered by Ctrl-Alt-D.
function dumpState(label?: string) {
  const b = readBuffer();
  const info = {
    label: label || "",
    mode: state.mode,
    cursor: state.cursor,
    text: b ? b.text : null,
    caret: b ? b.caret : null,
    html: document.body ? document.body.innerHTML : null,
  };
  const json = JSON.stringify(info, null, 2);
  if (typeof console !== "undefined" && console.log)
    console.log("thundervim dump", info);
  showDumpOverlay(json);
  return info;
}

let dumpOverlay: HTMLElement | null = null;
function closeDumpOverlay(): void {
  if (dumpOverlay && dumpOverlay.parentNode)
    dumpOverlay.parentNode.removeChild(dumpOverlay);
  dumpOverlay = null;
  if (document.body && document.body.focus) document.body.focus();
  updateBar();
}
function showDumpOverlay(text: string): void {
  closeDumpOverlay();
  const doc = document;
  const host = doc.body || doc.documentElement;
  const overlay = doc.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.55);" +
    "display:flex;flex-direction:column;padding:24px;box-sizing:border-box;";
  const hint = doc.createElement("div");
  hint.textContent = "thundervim dump \u2014 press Cmd+C to copy, Esc to close";
  hint.style.cssText =
    "color:#fff;font:13px/1.4 monospace;margin-bottom:8px;flex:0 0 auto;";
  const ta = doc.createElement("textarea");
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

async function init(): Promise<void> {
  applyConfig(await loadConfig());
  state.mode = config.defaultMode === "normal" ? MODE.NORMAL : MODE.INSERT;
  enabled = config.enableOnStart;
  ensurePreWrap();
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("keypress", onInputEvent, true);
  document.addEventListener("beforeinput", onInputEvent, true);
  // While typing in Insert mode the engine cursor is stale, so keep the ruler
  // live from the DOM caret. `selectionchange` covers typing, arrows and clicks.
  document.addEventListener("selectionchange", updateRulerLive);
  // Last line of defense: remove all Thundervim chrome before Thunderbird
  // serializes the compose document for sending. If sending is canceled, the
  // status bar is recreated shortly after.
  window.addEventListener("compose-send-message", beforeSendCleanup, true);
  window.addEventListener("beforeunload", removeChromeOverlays, true);
  window.addEventListener("pagehide", removeChromeOverlays, true);
  // Keep the block cursor and selection aligned when the view moves without
  // a keystroke.
  window.addEventListener("scroll", render, true);
  window.addEventListener("resize", render, true);
  document.addEventListener(
    "mouseup",
    function () {
      if (enabled && state.mode !== MODE.INSERT) {
        const b = readBuffer();
        if (b) syncFromEditor(state, b.text, b.caret);
        render();
      }
    },
    true,
  );
  updateBar();
}
if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      void init();
    },
    { once: true },
  );
} else {
  void init();
}
