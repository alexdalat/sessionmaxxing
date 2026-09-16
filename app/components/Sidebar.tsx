"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePolling } from "@/app/hooks/usePolling";
import type { PendingReview } from "@/shared/types";

const REVIEW_POLL_MS = 10_000;

const NAV_ITEMS = [
  { label: "Overview", href: "/" },
  { label: "Analytics", href: "/analytics/" },
  { label: "Task queue", href: "/queue/" },
  { label: "Runs", href: "/runs/" },
];

const normalize = (pathname: string) =>
  pathname === "" || pathname === "/"
    ? "/"
    : pathname.endsWith("/")
      ? pathname
      : `${pathname}/`;

export function Sidebar() {
  const current = normalize(usePathname());
  const { data: review } = usePolling<PendingReview>(
    "/api/runs/pending-review",
    REVIEW_POLL_MS,
  );
  const pending = review?.pending ?? 0;
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          C
        </span>{" "}
        Capacity
      </div>
      <p className="sidebar-caption">CLAUDE · LOCAL</p>
      <nav aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
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
          </Link>
        ))}
      </nav>
    </aside>
  );
}
