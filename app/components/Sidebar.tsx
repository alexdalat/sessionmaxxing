"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useEnvironment } from "@/app/components/EnvironmentProvider";
import { usePolling } from "@/app/hooks/usePolling";
import { ACTIVE_QUEUE_PATH, QUEUE_CHANGED } from "@/app/lib/api";
import { navItems } from "@/app/lib/nav";
import { PRODUCT_NAME } from "@/shared/product";
import type { PendingReview, QueueSnapshot } from "@/shared/types";

const NAV_POLL_MS = 10_000;

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
        <span className="brand-mark" aria-hidden="true">
          {PRODUCT_NAME[0]}
        </span>{" "}
        {PRODUCT_NAME}
      </div>
      <p className="sidebar-caption">CLAUDE · LOCAL</p>
      <nav aria-label="Main navigation">
        {navItems(edition).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={normalize(item.href) === current ? "page" : undefined}
          >
            {item.label}
            {item.href === "/runs/" && pending > 0 && (
              <span className="nav-count">
                {pending}
                <span className="sr-only"> runs need review</span>
              </span>
            )}
            {item.href === "/queue/" && queued > 0 && (
              <span className="nav-count nav-count-muted">
                {queued}
                <span className="sr-only"> tasks queued</span>
              </span>
            )}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
