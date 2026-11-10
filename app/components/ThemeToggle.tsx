"use client";
import { Moon, Sun } from "lucide-react";
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
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      className="nav-item"
      aria-pressed={theme === "dark"}
      onClick={toggle}
    >
      <Icon aria-hidden="true" />
      <span className="nav-label">{FIELD_LABELS.darkMode}</span>
    </button>
  );
}
