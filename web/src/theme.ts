export type Theme = "system" | "light" | "dark";

const KEY = "joblert-theme";
export const THEMES: Theme[] = ["system", "light", "dark"];

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** "system" removes the attribute so the stylesheet follows prefers-color-scheme. index.html applies it before first paint. */
export function applyTheme(theme: Theme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
}
