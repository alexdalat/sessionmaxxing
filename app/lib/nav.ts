import type { Edition } from "@/shared/types";

export type NavItem = { label: string; href: string };

const OVERVIEW: NavItem = { label: "Overview", href: "/" };
const ANALYTICS: NavItem = { label: "Analytics", href: "/analytics/" };
const TASK_QUEUE: NavItem = { label: "Task queue", href: "/queue/" };
const RUNS: NavItem = { label: "Runs", href: "/runs/" };

const FULL_NAV: readonly NavItem[] = [OVERVIEW, ANALYTICS, TASK_QUEUE, RUNS];
const LITE_NAV: readonly NavItem[] = [TASK_QUEUE, RUNS];

export function navItems(edition: Edition): readonly NavItem[] {
  return edition === "lite" ? LITE_NAV : FULL_NAV;
}
