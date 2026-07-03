type Mode = "insert" | "normal" | "visual" | "visual-line" | "off" | "search";

interface ModeMessage {
  type: "thundervim:mode";
  mode: Mode;
  left: string;
  right: string;
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

interface ComposeActionApi {
  setTitle(details: { tabId?: number; title: string }): Promise<void>;
  setLabel(details: { tabId?: number; label: string }): Promise<void>;
  setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
  setBadgeBackgroundColor(details: {
    tabId?: number;
    color: string | [number, number, number, number];
  }): Promise<void>;
}

interface BrowserApi {
  runtime: BrowserRuntime;
  composeAction?: ComposeActionApi;
}

declare const browser: BrowserApi;

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
      return "INS";
    case "normal":
      return "NOR";
    case "visual":
      return "VIS";
    case "visual-line":
      return "VL";
    case "search":
      return "/";
    case "off":
      return "OFF";
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

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (!isModeMessage(message) || !browser.composeAction) return;

  const tabId = sender.tab?.id;
  const title = [message.left, message.right].filter(Boolean).join("  ");
  const details = tabId === undefined ? {} : { tabId };

  await Promise.all([
    browser.composeAction.setTitle({ ...details, title }),
    browser.composeAction.setLabel({ ...details, label: badgeFor(message.mode) }),
    browser.composeAction.setBadgeText({ ...details, text: badgeFor(message.mode) }),
    browser.composeAction.setBadgeBackgroundColor({
      ...details,
      color: colorFor(message.mode),
    }),
  ]);
});
