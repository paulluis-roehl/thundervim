type Mode = "insert" | "normal" | "visual" | "visual-line" | "off" | "search";

interface ModeMessage {
  type: "thundervim:mode";
  mode: Mode;
  left: string;
  right: string;
}

interface ComposeDetails {
  isPlainText?: boolean;
  plainTextBody?: string;
  body?: string;
}

interface BrowserRuntime {
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: { tab?: { id?: number } },
      ) => void | Promise<void>,
    ): void;
  };
}

interface TabInfo {
  id?: number;
}

interface ComposeActionApi {
  onClicked?: {
    addListener(listener: (tab: TabInfo) => void | Promise<void>): void;
  };
  setTitle(details: { tabId?: number; title: string }): Promise<void>;
  setLabel(details: { tabId?: number; label: string }): Promise<void>;
  setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
  setBadgeBackgroundColor(details: {
    tabId?: number;
    color: string | [number, number, number, number];
  }): Promise<void>;
}

interface TabsApi {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

interface ComposeApi {
  onBeforeSend?: {
    addListener(
      listener: (
        tab: TabInfo,
        details: ComposeDetails,
      ) =>
        | void
        | Promise<void | { cancel?: boolean; details?: ComposeDetails }>
        | { cancel?: boolean; details?: ComposeDetails },
    ): void;
  };
}

interface BrowserApi {
  runtime: BrowserRuntime;
  composeAction?: ComposeActionApi;
  compose?: ComposeApi;
  tabs?: TabsApi;
}

function extensionApi(): BrowserApi | null {
  const globals = globalThis as typeof globalThis & {
    browser?: BrowserApi;
    messenger?: BrowserApi;
  };
  return globals.messenger ?? globals.browser ?? null;
}

function isModeMessage(message: unknown): message is ModeMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "thundervim:mode" &&
    typeof (message as { mode?: unknown }).mode === "string" &&
    typeof (message as { left?: unknown }).left === "string" &&
    typeof (message as { right?: unknown }).right === "string"
  );
}

function badgeFor(mode: Mode): string {
  switch (mode) {
    case "insert":
      return "I";
    case "normal":
      return "N";
    case "visual":
      return "V";
    case "visual-line":
      return "L";
    case "search":
      return "/";
    case "off":
      return "";
  }
}

function colorFor(mode: Mode): string {
  switch (mode) {
    case "insert":
      return "#2e7d32";
    case "visual":
    case "visual-line":
      return "#6a1b9a";
    case "search":
      return "#b07d00";
    case "off":
      return "#606060";
    case "normal":
      return "#202225";
  }
}

const STATUS_MARKER = "\u2063\u200c\u200d\u2063";
const MARKED_STATUS_LINE_RE = new RegExp(
  String.raw`(?:\r?\n)*[^\r\n]*${STATUS_MARKER}[^\r\n]*$`,
  "u",
);
const LEGACY_STATUS_LINE_RE =
  /(?:\r?\n)*(?:--\s*(?:INSERT|NORMAL|VISUAL(?: LINE)?|vim off)\s*--|[/?][^\r\n]*)(?:\s*\d+,\S+\s+(?:Top|Bot|All|\d+%))?\s*$/;

function scrubPlainTextBody(body: string): string {
  return body
    .replace(MARKED_STATUS_LINE_RE, "")
    .replace(LEGACY_STATUS_LINE_RE, "");
}

function scrubHtmlBody(body: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  let changed = false;
  for (const id of ["thundervim-status", "thundervim-status-host"]) {
    const node = doc.getElementById(id);
    if (node) {
      node.remove();
      changed = true;
    }
  }
  if (doc.body) {
    const text = doc.body.textContent ?? "";
    const scrubbed = scrubPlainTextBody(text);
    if (scrubbed !== text) {
      doc.body.textContent = scrubbed;
      changed = true;
    }
    return changed ? doc.body.innerHTML : body;
  }
  return body.replace(
    /<[^>]+id=["']thundervim-status(?:-host)?["'][\s\S]*?<\/[^>]+>/g,
    "",
  );
}

function scrubDetails(details: ComposeDetails): ComposeDetails | null {
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

extensionApi()?.composeAction?.onClicked?.addListener(async (tab) => {
  const api = extensionApi();
  if (tab.id === undefined || !api?.tabs) return;
  await api.tabs.sendMessage(tab.id, { type: "thundervim:toggle" });
});

extensionApi()?.compose?.onBeforeSend?.addListener(async (tab, details) => {
  const api = extensionApi();
  if (tab.id !== undefined && api?.tabs) {
    try {
      await api.tabs.sendMessage(tab.id, { type: "thundervim:before-send" });
    } catch {
      // The compose script may already be gone; still scrub the outgoing body.
    }
  }
  const cleaned = scrubDetails(details);
  return cleaned ? { cancel: false, details: cleaned } : undefined;
});

extensionApi()?.runtime.onMessage.addListener(async (message, sender) => {
  const api = extensionApi();
  if (!isModeMessage(message) || !api?.composeAction) return;

  const tabId = sender.tab?.id;
  const status = [message.left, message.right].filter(Boolean).join("  ");
  const details = tabId === undefined ? {} : { tabId };
  const badge = badgeFor(message.mode);
  const title = status
    ? `Thundervim: ${status}. Click to ${message.mode === "off" ? "enable" : "disable"}.`
    : "Thundervim";

  await Promise.all([
    api.composeAction.setTitle({ ...details, title }),
    api.composeAction.setLabel({ ...details, label: "Vim" }),
    api.composeAction.setBadgeText({ ...details, text: badge }),
    api.composeAction.setBadgeBackgroundColor({
      ...details,
      color: colorFor(message.mode),
    }),
  ]);
});
