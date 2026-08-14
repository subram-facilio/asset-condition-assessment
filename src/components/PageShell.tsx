import type { ReactNode } from "react";
import { FText } from "@facilio/dsm-react-wrapper";
import OverlayScrollbar from "./OverlayScrollbar";

/**
 * Shell for a focused, single-column page (Baselines, Run Assessment).
 *
 * Header is fixed and the body is the one scroll region — the shell above is `overflow: hidden`, so
 * without this the page would have no scroller at all. Both regions share a centred column of the
 * same max width and the same inset, which is what keeps the title aligned with the content below
 * it however wide the window gets.
 */
export function PageShell({
  title,
  subtitle,
  action,
  children,
  maxWidth = 820,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  maxWidth?: number;
}) {
  const column = { maxWidth, width: "100%", margin: "0 auto" } as const;

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: "var(--spacing-section-medium) var(--spacing-section-small) 0",
          boxSizing: "border-box",
        }}
      >
        <div style={column}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "var(--spacing-container-xlarge)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <FText appearance="headingMed16" styleProps={{ color: "textMain" }}>
                {title}
              </FText>
              {subtitle && (
                <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                  {subtitle}
                </FText>
              )}
            </div>
            {action && <div style={{ flexShrink: 0 }}>{action}</div>}
          </div>
        </div>
      </div>

      <OverlayScrollbar edgeFade edgeFadeSoft style={{ flex: 1, minHeight: 0 }}>
        <div
          style={{
            padding:
              "var(--spacing-container-xxlarge) var(--spacing-section-small) var(--spacing-section-medium)",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              ...column,
              display: "flex",
              flexDirection: "column",
              gap: "var(--spacing-container-xxlarge)",
              boxSizing: "border-box",
            }}
          >
            {children}
          </div>
        </div>
      </OverlayScrollbar>
    </div>
  );
}
