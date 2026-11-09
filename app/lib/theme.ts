import type { Theme } from "@/app/lib/palette";

export const THEME_STORAGE_KEY = "sessionmaxxing-theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export const parseStoredTheme = (value: string | null): Theme | null =>
  value === "light" || value === "dark" ? value : null;

export const resolveTheme = (
  stored: Theme | null,
  systemPrefersDark: boolean,
): Theme => stored ?? (systemPrefersDark ? "dark" : "light");

/** Runs before first paint so the stored or system theme applies without a flash. */
export const THEME_INIT_SCRIPT = `(()=>{const s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});const t=s==="light"||s==="dark"?s:matchMedia(${JSON.stringify(DARK_QUERY)}).matches?"dark":"light";document.documentElement.dataset.theme=t})()`;
