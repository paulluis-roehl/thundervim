export interface ShortcutKey {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export type NativeEditorCommand = "selection" | "history";

// Native commands that either depend on the editor selection or can change its
// text/history. Other application shortcuts (Send, Save, Find, etc.) pass
// through untouched and need no post-command editor reconciliation.
export function nativeEditorCommand(
  ev: ShortcutKey,
  isMac: boolean,
): NativeEditorCommand | null {
  const primary = isMac ? ev.meta : ev.ctrl;
  const secondary = isMac ? ev.ctrl : ev.meta;
  if (!primary || secondary || ev.alt) return null;

  const key = ev.key.toLowerCase();
  if (key === "z" || (!isMac && key === "y")) return "history";
  if (["b", "i", "u", "c", "v", "x"].includes(key)) return "selection";
  return null;
}
