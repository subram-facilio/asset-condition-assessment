import { useState } from "react";
import type { ReactNode } from "react";
import { FIcon, FText } from "@facilio/dsm-react-wrapper";
import OverlayScrollbar from "./OverlayScrollbar";

/**
 * Chrome for a record page: back link, title, tab strip, and a body split between a collapsible
 * facts rail and a scrolling content column.
 *
 * The rail holds what stays true whichever tab is open, so switching tabs never costs the reader
 * the asset's identity.
 */

export interface DetailTab {
  key: string;
  label: string;
  icon: { group: string; name: string };
  /** Count shown in a small trailing badge. Omitted or 0 renders no badge. */
  badge?: number;
}

const RAIL_WIDTH = 280;
const RAIL_SPINE_WIDTH = 48;

export function DetailShell({
  backHref,
  backLabel = "Back",
  title,
  titleMeta,
  status,
  actions,
  tabs,
  activeTab,
  onTabChange,
  rail,
  railLabel = "Details",
  children,
}: {
  backHref: string;
  backLabel?: string;
  title: string;
  /** Sub-line under the title — manufacturer, model, location. */
  titleMeta?: ReactNode;
  /** Chips beside the title. */
  status?: ReactNode;
  actions?: ReactNode;
  tabs: DetailTab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  rail?: ReactNode;
  railLabel?: string;
  children: ReactNode;
}) {
  const [railOpen, setRailOpen] = useState(true);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", height: "100%" }}>
      {/* ------------------------------------------------------------ header */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--spacing-container-xlarge)",
          padding: "var(--spacing-container-xxlarge) var(--spacing-section-small)",
          flexShrink: 0,
        }}
      >
        <a
          href={backHref}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--spacing-container-medium)",
            width: "fit-content",
            textDecoration: "none",
          }}
        >
          <FIcon
            group="16px-special-case"
            name="left-arrow"
            size={12}
            color="var(--colors-text-main)"
            pressable={false}
          />
          <FText appearance="captionReg12" styleProps={{ color: "textMain" }}>
            {backLabel}
          </FText>
        </a>

        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "var(--spacing-container-xxlarge)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-medium)", minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--spacing-container-xlarge)",
                flexWrap: "wrap",
              }}
            >
              <FText appearance="headingMed16" styleProps={{ color: "textMain" }}>
                {title}
              </FText>
              {status}
            </div>
            {titleMeta && (
              <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
                {titleMeta}
              </FText>
            )}
          </div>
          {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
        </div>
      </div>

      {/* -------------------------------------------------------------- tabs */}
      <div
        style={{
          borderTop: "1px solid var(--colors-border-neutral-base-subtler)",
          borderBottom: "1px solid var(--colors-border-neutral-base-subtler)",
          backgroundColor: "var(--colors-background-midground-subtle)",
          padding: "0 var(--spacing-container-xlarge)",
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-container-xlarge)",
          overflowX: "auto",
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onTabChange(tab.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--spacing-container-large)",
                padding: "var(--spacing-container-large) var(--spacing-container-xlarge)",
                height: 40,
                border: "none",
                borderBottom: `2px solid ${isActive ? "var(--colors-border-primary-default)" : "transparent"}`,
                background: "transparent",
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              <FIcon group={tab.icon.group} name={tab.icon.name} size={16} color="" pressable={false} />
              <FText
                appearance={isActive ? "headingMed14" : "bodyReg14"}
                styleProps={{ color: isActive ? "textPrimaryDefault" : "textDescription" }}
              >
                {tab.label}
              </FText>
              {tab.badge !== undefined && tab.badge > 0 && (
                <span
                  style={{
                    minWidth: 16,
                    height: 16,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 2,
                    borderRadius: 2,
                    border: "1px solid var(--colors-border-neutral-base-subtle)",
                    backgroundColor: "var(--colors-background-container)",
                    fontSize: 10,
                    fontWeight: 500,
                    lineHeight: 1,
                    color: isActive ? "var(--colors-text-primary-default)" : "var(--colors-text-main)",
                  }}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* -------------------------------------------------------------- body */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {rail && (
          <div
            className="ca-rail"
            style={{
              width: railOpen ? RAIL_WIDTH : RAIL_SPINE_WIDTH,
              minWidth: railOpen ? RAIL_WIDTH : RAIL_SPINE_WIDTH,
              flexShrink: 0,
              position: "relative",
              overflow: "hidden",
              borderRight: "1px solid var(--colors-border-neutral-base-subtler)",
              backgroundColor: "var(--colors-background-container)",
            }}
          >
            {/* Collapsed spine — the whole 48px column is the button, not just the chevron. */}
            <button
              type="button"
              className="ca-rail-layer ca-rail-spine"
              data-visible={railOpen ? "false" : "true"}
              aria-label={`Show ${railLabel.toLowerCase()}`}
              onClick={() => setRailOpen(true)}
              style={{
                position: "absolute",
                inset: 0,
                width: RAIL_SPINE_WIDTH,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "var(--spacing-container-xxlarge)",
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "var(--border-small)",
                  border: "1px solid var(--colors-border-neutral-base-subtle)",
                  backgroundColor: "var(--colors-background-midground-subtle)",
                }}
              >
                <FIcon group="16px-special-case" name="chevron-right" size={12} pressable={false} />
              </span>
              <span
                style={{
                  writingMode: "vertical-rl",
                  font: "var(--text-caption-reg-12)",
                  color: "var(--colors-text-caption)",
                  whiteSpace: "nowrap",
                }}
              >
                {railLabel}
              </span>
            </button>

            {/* Expanded panel */}
            <div
              className="ca-rail-layer"
              data-visible={railOpen ? "true" : "false"}
              style={{ position: "absolute", inset: 0, width: RAIL_WIDTH }}
            >
              <OverlayScrollbar style={{ height: "100%" }}>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--spacing-container-xxlarge)",
                    padding: "var(--spacing-container-xxlarge)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
                      {railLabel}
                    </FText>
                    <button
                      type="button"
                      aria-label={`Hide ${railLabel.toLowerCase()}`}
                      onClick={() => setRailOpen(false)}
                      style={{
                        width: 24,
                        height: 24,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: "var(--border-small)",
                        border: "1px solid var(--colors-border-neutral-base-subtle)",
                        backgroundColor: "var(--colors-background-midground-subtle)",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      <FIcon group="16px-special-case" name="chevron-left" size={12} pressable={false} />
                    </button>
                  </div>
                  {rail}
                </div>
              </OverlayScrollbar>
            </div>
          </div>
        )}

        <OverlayScrollbar edgeFade style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--spacing-section-small)",
              padding: "var(--spacing-section-small)",
              boxSizing: "border-box",
            }}
          >
            {children}
          </div>
        </OverlayScrollbar>
      </div>
    </div>
  );
}

/** A label/value pair in the facts rail. */
export function RailFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
        {label}
      </FText>
      <span style={{ font: "var(--text-body-reg-14)", color: "var(--colors-text-main)", minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}
