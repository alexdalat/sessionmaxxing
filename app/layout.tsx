import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/geist";
import "@fontsource/courier-prime/400.css";
import "./styles.css";
import { EnvironmentProvider } from "@/app/components/EnvironmentProvider";
import { Sidebar } from "@/app/components/Sidebar";
import { TooltipProvider } from "@/app/components/ui/tooltip";
import { ACTION_LABELS } from "@/app/lib/labels";
import { DARK, LIGHT } from "@/app/lib/palette";
import { DARK_QUERY, THEME_INIT_SCRIPT } from "@/app/lib/theme";
import { PRODUCT_NAME } from "@/shared/product";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: LIGHT.frame },
    { media: DARK_QUERY, color: DARK.frame },
  ],
  // Shrink the layout viewport when the phone keyboard opens so dialogs sized in
  // dvh keep their submit row above it.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: constant pre-paint theme script, see app/lib/theme.ts
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
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
