import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";
import { Sidebar } from "@/app/components/Sidebar";
import { TooltipProvider } from "@/app/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Claude capacity · Local dashboard",
};

export const viewport: Viewport = {
  themeColor: "#08090a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <TooltipProvider>
          <div className="app-shell">
            <a className="skip-link" href="#main">
              Skip to content
            </a>
            <Sidebar />
            <main id="main" tabIndex={-1}>
              {children}
            </main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
