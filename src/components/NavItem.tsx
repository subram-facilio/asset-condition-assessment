import type React from "react";
import { FIcon } from "@facilio/dsm-react-wrapper";

/**
 * One row in the sidebar rail.
 *
 * The row paints no background of its own — the sliding active/hover pills in {@link ./NavPanel}
 * do that, and they find their target through the `data-nav-active` / `data-nav-hoverable`
 * attributes set here. Ported from fm-planner with `<Link>` swapped for a hash `<a>`, since this
 * app routes on `window.location.hash` rather than react-router.
 */

export interface NavItemProps {
  /** Hash route without the `#` — e.g. `/register`. */
  to: string;
  icon: string;
  group: string;
  label: string;
  active?: boolean;
  /** Collapsed rail: the label fades out but stays mounted so its width animates. */
  collapsed?: boolean;
}

export function NavItem({ to, icon, group, label, active, collapsed }: NavItemProps) {
  const containerStyle: React.CSSProperties = {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: collapsed ? 0 : "var(--spacing-container-large)",
    height: 32,
    padding: "0 var(--spacing-container-large)",
    borderRadius: "var(--border-medium)",
    width: "100%",
    boxSizing: "border-box",
    cursor: "pointer",
    textDecoration: "none",
    border: "none",
    outline: "none",
    backgroundColor: "transparent",
  };

  return (
    <a
      href={`#${to}`}
      data-nav-active={active ? "true" : undefined}
      data-nav-hoverable="true"
      style={containerStyle}
      // Without this the anchor takes focus on press and the browser paints its own
      // focus ring underneath the pill.
      onMouseDown={(e) => e.preventDefault()}
    >
      <FIcon
        name={icon}
        group={group}
        size={16}
        pressable={false}
        color={
          active ? "var(--colors-icon-neutral-main)" : "var(--colors-icon-neutral-medium)"
        }
      />
      <span
        className="nav-item-label"
        style={{
          flex: 1,
          minWidth: 0,
          opacity: collapsed ? 0 : 1,
          overflow: "hidden",
          textOverflow: "clip",
          whiteSpace: "nowrap",
          willChange: "opacity",
          font: active ? "var(--text-heading-med-14)" : "var(--text-body-reg-14)",
          color: "var(--colors-text-description)",
          transition: "opacity 0.4s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {label}
      </span>
    </a>
  );
}
