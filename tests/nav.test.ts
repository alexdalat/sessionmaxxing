import { describe, expect, it } from "vitest";
import { navItems } from "../app/lib/nav";

describe("navItems", () => {
  it("lists only Task queue and Runs in the lite edition", () => {
    expect(navItems("lite")).toEqual([
      { label: "Task queue", href: "/queue/" },
      { label: "Runs", href: "/runs/" },
    ]);
  });

  it("lists Overview, Analytics, Task queue and Runs in the full edition", () => {
    expect(navItems("full")).toEqual([
      { label: "Overview", href: "/" },
      { label: "Analytics", href: "/analytics/" },
      { label: "Task queue", href: "/queue/" },
      { label: "Runs", href: "/runs/" },
    ]);
  });

  it("links the lite edition to neither the Overview nor the Analytics page", () => {
    const hrefs = navItems("lite").map((item) => item.href);
    expect(hrefs).not.toContain("/");
    expect(hrefs).not.toContain("/analytics/");
  });
});
