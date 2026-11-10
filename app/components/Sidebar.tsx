"use client";
import {
  ChartColumn,
  History,
  LayoutDashboard,
  ListTodo,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { usePolling } from "@/app/hooks/usePolling";
import { ACTIVE_QUEUE_PATH, QUEUE_CHANGED } from "@/app/lib/api";
import { navItems } from "@/app/lib/nav";
import { PRODUCT_NAME } from "@/shared/product";
import type { PendingReview, QueueSnapshot } from "@/shared/types";

const NAV_POLL_MS = 10_000;
const BRAND_PATH =
  "M21.5 10.2C20.3 8.8 18.4 8 16.2 8 13 8 10.8 9.8 10.8 12.3 10.8 18 21.4 14.6 21.4 19.8 21.4 22.3 19.1 24 15.9 24 13.4 24 11.4 23.1 10 21.6";

const NAV_ICONS: Record<string, LucideIcon> = {
  "/": LayoutDashboard,
  "/analytics/": ChartColumn,
  "/queue/": ListTodo,
  "/runs/": History,
};

const normalize = (pathname: string) =>
  pathname === "" || pathname === "/"
    ? "/"
    : pathname.endsWith("/")
      ? pathname
      : `${pathname}/`;

export function Sidebar() {
  const current = normalize(usePathname());
  const { edition } = useEnvironment();
  const { data: review } = usePolling<PendingReview>(
    "/api/runs/pending-review",
    NAV_POLL_MS,
  );
  const { data: queue, reload: reloadQueue } = usePolling<QueueSnapshot>(
    ACTIVE_QUEUE_PATH,
    NAV_POLL_MS,
  );
  useEffect(() => {
    window.addEventListener(QUEUE_CHANGED, reloadQueue);
    return () => window.removeEventListener(QUEUE_CHANGED, reloadQueue);
  }, [reloadQueue]);
  const pending = review?.pending ?? 0;
  const queued =
    queue?.tasks.filter((task) => task.status === "pending").length ?? 0;
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">
            <path
              d={BRAND_PATH}
              fill="none"
              stroke="currentColor"
              strokeWidth="3.6"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="brand-name">{PRODUCT_NAME}</span>
      </div>
      <nav className="nav" aria-label="Main navigation">
        {navItems(edition).map((item) => {
          const Icon = NAV_ICONS[item.href];
          return (
            <Link
              key={item.href}
              href={item.href}
              className="nav-item"
              aria-current={
                normalize(item.href) === current ? "page" : undefined
              }
            >
              <Icon aria-hidden="true" />
              <span className="nav-label">{item.label}</span>
              {item.href === "/runs/" && pending > 0 && (
                <span className="nav-count" data-tone="attention">
                  {pending}
                  <span className="sr-only"> runs need review</span>
                </span>
              )}
              {item.href === "/queue/" && queued > 0 && (
                <span className="nav-count">
                  {queued}
                  <span className="sr-only"> tasks queued</span>
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <ThemeToggle />
      </div>
    </aside>
  );
}
