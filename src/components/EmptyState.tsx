import type { ReactNode } from "react";
import { FIcon, FText } from "@facilio/dsm-react-wrapper";

/**
 * The "nothing here yet" panel. Centred in whatever region it is dropped into, so it works both as
 * a whole-page state and inside a card.
 */
export function EmptyState({
  icon = { group: "webtabs", name: "asset" },
  title,
  description,
  action,
}: {
  icon?: { group: string; name: string };
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--spacing-container-xlarge)",
        padding: "var(--spacing-section-medium)",
        textAlign: "center",
      }}
    >
      <span
        style={{
          width: 56,
          height: 56,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 16,
          backgroundColor: "var(--colors-background-midground-subtle)",
          border: "1px solid var(--colors-border-neutral-base-subtler)",
        }}
      >
        <FIcon
          group={icon.group}
          name={icon.name}
          size={24}
          color="var(--colors-icon-neutral-light)"
          pressable={false}
        />
      </span>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-medium)", maxWidth: 420 }}>
        <FText appearance="headingMed16" styleProps={{ color: "textMain" }}>
          {title}
        </FText>
        {description && (
          <FText appearance="bodyReg14" styleProps={{ color: "textCaption", display: "block" }}>
            {description}
          </FText>
        )}
      </div>

      {action}
    </div>
  );
}
