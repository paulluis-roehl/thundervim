export interface ComposeDetails {
  isPlainText?: boolean;
  plainTextBody?: string;
  body?: string;
}

interface ParsedHtmlDocument {
  body: { innerHTML: string; readonly textContent?: string | null } | null;
  getElementById(id: string): { remove(): void } | null;
}

export interface HtmlParser {
  parseFromString(body: string, type: "text/html"): ParsedHtmlDocument;
}

const STATUS_MARKER = "\u2063\u200c\u200d\u2063";
// Thunderbird can serialize an out-of-body status element directly after the
// message, so remove from the unique marker rather than deleting its whole line.
const MARKED_STATUS_LINE_RE = new RegExp(
  String.raw`(?:\r?\n)*[ \t]*${STATUS_MARKER}[^\r\n]*$`,
  "u",
);
const LEGACY_STATUS_LINE_RE =
  /(?:^|(?:\r?\n)+)(?:--\s*(?:INSERT|NORMAL|VISUAL(?: LINE)?|vim off)\s*--|[/?][^\r\n]*)(?:\s*\d+,\S+\s+(?:Top|Bot|All|\d+%))?\s*$/;

export function scrubPlainTextBody(body: string): string {
  return body
    .replace(MARKED_STATUS_LINE_RE, "")
    .replace(LEGACY_STATUS_LINE_RE, "");
}

export function scrubHtmlBody(
  body: string,
  parser: HtmlParser = new DOMParser(),
): string {
  const doc = parser.parseFromString(body, "text/html");
  // Never scrub doc.body.textContent: assigning it would flatten all HTML
  // structure, including the elements that preserve visible line breaks.
  let changed = false;
  for (const id of ["thundervim-status", "thundervim-status-host"]) {
    const node = doc.getElementById(id);
    if (node) {
      node.remove();
      changed = true;
    }
  }
  return changed && doc.body ? doc.body.innerHTML : body;
}

export function scrubDetails(details: ComposeDetails): ComposeDetails | null {
  const cleaned: ComposeDetails = {};
  let changed = false;
  if (typeof details.plainTextBody === "string") {
    const plainTextBody = scrubPlainTextBody(details.plainTextBody);
    if (plainTextBody !== details.plainTextBody) {
      cleaned.plainTextBody = plainTextBody;
      changed = true;
    }
  }
  if (typeof details.body === "string") {
    const body = scrubHtmlBody(details.body);
    if (body !== details.body) {
      cleaned.body = body;
      changed = true;
    }
  }
  if (changed && details.isPlainText !== undefined) {
    cleaned.isPlainText = details.isPlainText;
  }
  return changed ? cleaned : null;
}
