import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

const SIDEBAR_COLLAPSED_KEY = "condition-assessment.sidebarCollapsed";

interface SidebarContextValue {
  collapsed: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  toggle: () => {},
});

export const useSidebar = () => useContext(SidebarContext);

/**
 * Application shell: fixed top bar over a collapsible rail and the page body.
 *
 * Scrolling deliberately does not live here — this element and its children are `overflow: hidden`,
 * and each page owns its own scroll region. Two shells scrolling at once is what produces the
 * double-scrollbar effect the design never has.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(
    () => window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
  );

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  // Shell height comes from JS, not `100vh`: Chromium keeps serving a stale viewport-unit value
  // after the sidebar's width animation, which leaves the body a few pixels too tall.
  useEffect(() => {
    const setAppHeight = () => {
      document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
    };
    setAppHeight();
    window.addEventListener("resize", setAppHeight);
    window.visualViewport?.addEventListener("resize", setAppHeight);
    return () => {
      window.removeEventListener("resize", setAppHeight);
      window.visualViewport?.removeEventListener("resize", setAppHeight);
    };
  }, []);

  const toggle = () => setCollapsed((prev) => !prev);

  return (
    <SidebarContext.Provider value={{ collapsed, toggle }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "var(--app-height, 100vh)",
          width: "100%",
          overflow: "hidden",
          backgroundColor: "var(--colors-background-canvas)",
        }}
      >
        <TopBar />

        <div
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            position: "relative",
          }}
        >
          {/* The rail is absolutely positioned so its hover-expand can float over the content.
              This spacer reserves the flow width and animates on the same curve, so the body
              slides with the rail rather than snapping when `collapsed` flips. */}
          <div
            aria-hidden
            style={{
              width: collapsed ? 48 : 240,
              flexShrink: 0,
              transition: "width 0.28s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
          <Sidebar collapsed={collapsed} />

          <main
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              backgroundColor: "var(--colors-background-container)",
            }}
          >
            {children}
          </main>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}
