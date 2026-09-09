import { scrubDetails } from "./send-scrubber.ts";
import type { ComposeDetails } from "./send-scrubber.ts";

type Mode = "insert" | "normal" | "visual" | "visual-line" | "off" | "search";

interface ModeMessage {
  type: "thundervim:mode";
  mode: Mode;
  left: string;
  right: string;
}

interface DebugDumpMessage {
  type: "thundervim:debug-dump";
  text: string;
}

interface DebugDumpRequest {
  type: "thundervim:get-debug-dump";
  id: string;
}

interface BrowserRuntime {
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: { tab?: { id?: number } },
      ) => void | { text: string } | Promise<void | { text: string }>,
    ): void;
  };
  getURL(path: string): string;
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

interface ExtensionWindowsApi {
  create(details: {
    url: string;
    type: "popup";
    width: number;
    height: number;
  }): Promise<unknown>;
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
  windows?: ExtensionWindowsApi;
}

function extensionApi(): BrowserApi | null {
  const globals = globalThis as typeof globalThis & {
    browser?: BrowserApi;
    messenger?: BrowserApi;
  };
  return globals.messenger ?? globals.browser ?? null;
}

function isDebugDumpMessage(message: unknown): message is DebugDumpMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "thundervim:debug-dump" &&
    typeof (message as { text?: unknown }).text === "string"
  );
}

function isDebugDumpRequest(message: unknown): message is DebugDumpRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "thundervim:get-debug-dump" &&
    typeof (message as { id?: unknown }).id === "string"
  );
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

const pendingDebugDumps = new Map<string, string>();
let nextDebugDumpId = 0;

extensionApi()?.runtime.onMessage.addListener(async (message, sender) => {
  const api = extensionApi();
  if (!api) return;

  if (isDebugDumpMessage(message)) {
    const id = `${Date.now()}-${++nextDebugDumpId}`;
    pendingDebugDumps.clear();
    pendingDebugDumps.set(id, message.text);
    try {
      if (!api.windows) throw new Error("windows API unavailable");
      await api.windows.create({
        url: api.runtime.getURL(`debug.html?id=${encodeURIComponent(id)}`),
        type: "popup",
        width: 900,
        height: 700,
      });
    } catch (error) {
      pendingDebugDumps.delete(id);
      throw error;
    }
    return;
  }

  if (isDebugDumpRequest(message)) {
    const text = pendingDebugDumps.get(message.id) ?? "";
    pendingDebugDumps.delete(message.id);
    return { text };
  }

  if (!isModeMessage(message) || !api.composeAction) return;

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
  return undefined;
});
