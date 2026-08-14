import { useCallback, useEffect, useRef, useState } from "react";
import MainNavPanel from "./MainNavPanel";

/**
 * The 240px navigation rail, collapsing to a 48px icon spine.
 *
 * Always absolutely positioned: {@link ./Layout} renders a spacer that reserves the flow width and
 * animates in lock-step, so the page body slides with the rail instead of snapping. Absolute also
 * lets the collapsed rail float over the content when it hover-expands.
 */
export default function Sidebar({ collapsed }: { collapsed: boolean }) {
  const [hovered, setHovered] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const visuallyCollapsed = collapsed && !hovered;

  // A short delay before expanding — without it, a pointer merely crossing the rail on its way
  // somewhere else flings it open.
  const handleEnter = useCallback(() => {
    if (!collapsed) return;
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setHovered(true), 120);
  }, [collapsed]);

  const handleLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHovered(false);
  }, []);

  useEffect(() => {
    if (!collapsed) setHovered(false);
  }, [collapsed]);

  useEffect(
    () => () => {
      if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    },
    []
  );

  return (
    <nav
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        width: visuallyCollapsed ? 48 : 240,
        height: "100%",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--colors-background-neutral-base-subtle)",
        boxSizing: "border-box",
        padding: "var(--spacing-container-large)",
        overflow: "hidden",
        zIndex: collapsed && hovered ? 50 : "auto",
        // The right divider is a painted inset shadow, not a border: a sub-pixel border plus
        // border-box stole width from the 32px nav rows. When hover-expanded the rail floats on an
        // elevation shadow instead, so the divider isn't needed.
        boxShadow:
          collapsed && hovered
            ? "var(--ca-elevation-1)"
            : "inset -1px 0 0 0 var(--colors-border-neutral-base-subtle)",
        transition: "width 0.28s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s ease",
        willChange: "width",
      }}
    >
      <MainNavPanel collapsed={visuallyCollapsed} />
    </nav>
  );
}
