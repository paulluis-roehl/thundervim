interface RuntimeApi {
  sendMessage(message: unknown): Promise<unknown>;
}

interface BrowserApi {
  runtime?: RuntimeApi;
}

function extensionApi(): BrowserApi | null {
  const globals = globalThis as typeof globalThis & {
    browser?: BrowserApi;
    messenger?: BrowserApi;
  };
  return globals.messenger ?? globals.browser ?? null;
}

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

const dump = must<HTMLTextAreaElement>("dump");
const copyButton = must<HTMLButtonElement>("copy");
const closeButton = must<HTMLButtonElement>("close");
const statusOutput = must<HTMLOutputElement>("status");

async function copyDump(): Promise<void> {
  dump.select();
  try {
    await navigator.clipboard.writeText(dump.value);
    statusOutput.value = "Copied.";
  } catch {
    document.execCommand("copy");
    statusOutput.value = "Selected. Press Cmd+C or Ctrl+C to copy.";
  }
}

copyButton.addEventListener("click", () => void copyDump());
closeButton.addEventListener("click", () => window.close());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
});

void (async () => {
  const id = new URLSearchParams(window.location.search).get("id") ?? "";
  try {
    const response = (await extensionApi()?.runtime?.sendMessage({
      type: "thundervim:get-debug-dump",
      id,
    })) as { text?: unknown } | undefined;
    dump.value = typeof response?.text === "string" ? response.text : "";
  } catch {
    dump.value = "";
  }
  if (!dump.value)
    statusOutput.value = "The diagnostic dump is no longer available.";
  dump.focus();
  dump.select();
})();
