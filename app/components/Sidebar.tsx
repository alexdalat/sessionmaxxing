"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

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
          </Link>
        ))}
      </nav>
    </aside>
  );
}
