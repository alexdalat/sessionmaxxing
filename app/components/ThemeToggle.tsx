"use client";
import { useEffect, useState } from "react";
import { FIELD_LABELS } from "@/app/lib/labels";
import type { Theme } from "@/app/lib/palette";
import {
  DARK_QUERY,
  parseStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
} from "@/app/lib/theme";

const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    const media = matchMedia(DARK_QUERY);
    const sync = () => {
      const next = resolveTheme(
        parseStoredTheme(localStorage.getItem(THEME_STORAGE_KEY)),
        media.matches,
      );
      applyTheme(next);
      setTheme(next);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
    setTheme(next);
  };
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={theme === "dark"}
      onClick={toggle}
    >
      {FIELD_LABELS.darkMode}
    </button>
  );
}
