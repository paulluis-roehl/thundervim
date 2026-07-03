export interface ToggleConfig {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export interface ThundervimConfig {
  enableOnStart: boolean;
  defaultMode: "insert" | "normal";
  toggle: ToggleConfig;
  insertEscapeSequence: string;
  escapeTimeoutMs: number;
  shiftWidth: number;
  textWidth: number;
}

export const DEFAULT_CONFIG: ThundervimConfig = {
  enableOnStart: true,
  defaultMode: "insert",
  toggle: { ctrl: true, alt: true, shift: false, key: "v" },
  insertEscapeSequence: "",
  escapeTimeoutMs: 500,
  shiftWidth: 4,
  textWidth: 72,
};

const STORAGE_KEY = "config";

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface BrowserApi {
  storage?: { local?: StorageArea };
}

function extensionApi(): BrowserApi | null {
  const globals = globalThis as typeof globalThis & {
    browser?: BrowserApi;
    messenger?: BrowserApi;
  };
  return globals.messenger ?? globals.browser ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function normalizeToggle(value: unknown): ToggleConfig {
  const input = isRecord(value) ? value : {};
  const fallback = DEFAULT_CONFIG.toggle;
  const rawKey = stringValue(input.key, fallback.key).trim();
  return {
    ctrl: bool(input.ctrl, fallback.ctrl),
    alt: bool(input.alt, fallback.alt),
    shift: bool(input.shift, fallback.shift),
    key: (rawKey || fallback.key).slice(0, 1).toLowerCase(),
  };
}

export function normalizeConfig(value: unknown): ThundervimConfig {
  const input = isRecord(value) ? value : {};
  const defaultMode = input.defaultMode === "normal" ? "normal" : "insert";
  const rawEscape = stringValue(
    input.insertEscapeSequence,
    DEFAULT_CONFIG.insertEscapeSequence,
  );

  return {
    enableOnStart: bool(input.enableOnStart, DEFAULT_CONFIG.enableOnStart),
    defaultMode,
    toggle: normalizeToggle(input.toggle),
    insertEscapeSequence: rawEscape.length === 2 ? rawEscape : "",
    escapeTimeoutMs: boundedInt(
      input.escapeTimeoutMs,
      DEFAULT_CONFIG.escapeTimeoutMs,
      100,
      5000,
    ),
    shiftWidth: boundedInt(input.shiftWidth, DEFAULT_CONFIG.shiftWidth, 1, 16),
    textWidth: boundedInt(input.textWidth, DEFAULT_CONFIG.textWidth, 20, 200),
  };
}

function localStorageArea(): StorageArea | null {
  return extensionApi()?.storage?.local ?? null;
}

export async function loadConfig(): Promise<ThundervimConfig> {
  const area = localStorageArea();
  if (!area) return DEFAULT_CONFIG;
  try {
    const stored = await area.get(STORAGE_KEY);
    return normalizeConfig(stored[STORAGE_KEY]);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: ThundervimConfig): Promise<void> {
  const area = localStorageArea();
  if (!area) return;
  await area.set({ [STORAGE_KEY]: normalizeConfig(config) });
}
