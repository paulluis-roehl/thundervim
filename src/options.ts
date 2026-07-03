import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type ThundervimConfig,
} from "./config.ts";

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const form = must<HTMLFormElement>("options-form");
const enableOnStart = must<HTMLInputElement>("enable-on-start");
const defaultMode = must<HTMLSelectElement>("default-mode");
const toggleCtrl = must<HTMLInputElement>("toggle-ctrl");
const toggleAlt = must<HTMLInputElement>("toggle-alt");
const toggleShift = must<HTMLInputElement>("toggle-shift");
const toggleKey = must<HTMLInputElement>("toggle-key");
const insertEscapeSequence = must<HTMLInputElement>("insert-escape-sequence");
const escapeTimeoutMs = must<HTMLInputElement>("escape-timeout-ms");
const shiftWidth = must<HTMLInputElement>("shift-width");
const textWidth = must<HTMLInputElement>("text-width");
const reset = must<HTMLButtonElement>("reset");
const status = must<HTMLOutputElement>("status");

function setStatus(message: string): void {
  status.value = message;
}

function setForm(config: ThundervimConfig): void {
  enableOnStart.checked = config.enableOnStart;
  defaultMode.value = config.defaultMode;
  toggleCtrl.checked = config.toggle.ctrl;
  toggleAlt.checked = config.toggle.alt;
  toggleShift.checked = config.toggle.shift;
  toggleKey.value = config.toggle.key;
  insertEscapeSequence.value = config.insertEscapeSequence;
  escapeTimeoutMs.value = String(config.escapeTimeoutMs);
  shiftWidth.value = String(config.shiftWidth);
  textWidth.value = String(config.textWidth);
}

function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function readForm(): ThundervimConfig | null {
  const key = toggleKey.value.trim().slice(0, 1).toLowerCase();
  if (!key) {
    setStatus("Choose a toggle key.");
    toggleKey.focus();
    return null;
  }

  const sequence = insertEscapeSequence.value;
  if (sequence.length !== 0 && sequence.length !== 2) {
    setStatus("Escape sequence must be empty or exactly two characters.");
    insertEscapeSequence.focus();
    return null;
  }

  return {
    enableOnStart: enableOnStart.checked,
    defaultMode: defaultMode.value === "normal" ? "normal" : "insert",
    toggle: {
      ctrl: toggleCtrl.checked,
      alt: toggleAlt.checked,
      shift: toggleShift.checked,
      key,
    },
    insertEscapeSequence: sequence,
    escapeTimeoutMs: readNumber(
      escapeTimeoutMs,
      DEFAULT_CONFIG.escapeTimeoutMs,
    ),
    shiftWidth: readNumber(shiftWidth, DEFAULT_CONFIG.shiftWidth),
    textWidth: readNumber(textWidth, DEFAULT_CONFIG.textWidth),
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = readForm();
  if (!config) return;
  await saveConfig(config);
  setForm(await loadConfig());
  setStatus("Saved. New compose windows will use these settings.");
});

reset.addEventListener("click", async () => {
  await saveConfig(DEFAULT_CONFIG);
  setForm(await loadConfig());
  setStatus("Defaults restored.");
});

void (async () => {
  setForm(await loadConfig());
  setStatus("");
})();
