import { useEffect, useRef, useState } from "react";
import { FIcon, FText } from "@facilio/dsm-react-wrapper";
import Avatar from "./Avatar";
import { useUser } from "../context/UserContext";

/**
 * Avatar in the top bar, opening a small identity card.
 *
 * There is no account management in this app — the menu exists to answer "who am I signed in as",
 * which matters when the same browser has several Facilio orgs open, and to offer Baselines as the
 * one settings surface there is.
 */
export default function ProfileMenu() {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = user?.name || user?.email || "Signed in";

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        aria-label="Account"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "pointer",
          borderRadius: 999,
        }}
      >
        <Avatar name={name} size={28} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: 220,
            padding: "var(--spacing-container-large)",
            borderRadius: "var(--border-large)",
            border: "1px solid var(--colors-border-neutral-base-subtle)",
            backgroundColor: "var(--colors-background-container)",
            boxShadow: "var(--ca-elevation-1)",
            zIndex: 200,
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-container-large)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-container-large)",
              minWidth: 0,
            }}
          >
            <Avatar name={name} size={32} />
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
                {user?.name || "Signed in"}
              </FText>
              {user?.email && (
                <FText
                  appearance="captionReg12"
                  styleProps={{
                    color: "textCaption",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "block",
                  }}
                >
                  {user.email}
                </FText>
              )}
            </div>
          </div>

          <div style={{ height: 1, backgroundColor: "var(--colors-border-neutral-base-subtle)" }} />

          <a
            href="#/settings"
            onClick={() => setOpen(false)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-container-large)",
              height: 32,
              padding: "0 var(--spacing-container-large)",
              borderRadius: "var(--border-medium)",
              textDecoration: "none",
              font: "var(--text-body-reg-14)",
              color: "var(--colors-text-description)",
            }}
          >
            <FIcon group="action" name="settings" size={16} pressable={false} />
            Baselines
          </a>
        </div>
      )}
    </div>
  );
}
