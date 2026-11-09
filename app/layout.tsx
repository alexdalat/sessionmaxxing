import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/geist";
import "@fontsource/courier-prime/400.css";
import "./styles.css";
import { EnvironmentProvider } from "@/app/components/EnvironmentProvider";
import { Sidebar } from "@/app/components/Sidebar";
import { TooltipProvider } from "@/app/components/ui/tooltip";
import { ACTION_LABELS } from "@/app/lib/labels";
import { PRODUCT_NAME } from "@/shared/product";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
};

export const viewport: Viewport = {
  themeColor: "#0A0A0A",
  // Shrink the layout viewport when the phone keyboard opens so dialogs sized in
  // dvh keep their submit row above it.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TooltipProvider>
          <EnvironmentProvider>
            <div className="app-shell">
              <a className="skip-link" href="#main">
                {ACTION_LABELS.skipToContent}
              </a>
              <Sidebar />
              <main id="main" tabIndex={-1}>
                {children}
              </main>
            </div>
          </EnvironmentProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
