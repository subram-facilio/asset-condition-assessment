import { FIcon, FSpinner } from "@facilio/dsm-react-wrapper";

/**
 * The two pill buttons the agent banners and card footers use.
 *
 * Not `FButton`: the design's banner CTAs are 32px full-round pills with a near-black fill, which
 * DSM's button appearances don't include — `primary` is the blue brand fill and `secondary` is a
 * squared hairline. Everything else in the app does use `FButton`.
 */

interface ButtonProps {
  label: string;
  icon?: { group: string; name: string };
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
}

const BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--spacing-container-large)",
  height: 32,
  padding: "0 var(--spacing-container-xlarge)",
  borderRadius: "var(--border-xlarge)",
  cursor: "pointer",
  flexShrink: 0,
  font: "var(--text-heading-med-14)",
};

export function DarkButton({ label, icon, onClick, disabled, loading }: ButtonProps) {
  const off = disabled || loading;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      style={{
        ...BASE,
        border: "1px solid transparent",
        // A literal, not a token: this is the design's "ink" button and it stays near-black in both
        // themes, where every neutral token flips.
        backgroundColor: "#0F0F0F",
        color: "#FFFFFF",
        cursor: off ? "default" : "pointer",
        opacity: off ? 0.6 : 1,
      }}
    >
      {loading ? (
        <FSpinner size={16} />
      ) : (
        icon && <FIcon group={icon.group} name={icon.name} size={16} color="white" pressable={false} />
      )}
      {label}
    </button>
  );
}

export function OutlineButton({ label, icon, onClick, disabled, loading }: ButtonProps) {
  const off = disabled || loading;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      style={{
        ...BASE,
        border: "1px solid var(--colors-border-neutral-base-subtle)",
        backgroundColor: "var(--colors-background-container)",
        color: "var(--colors-text-main)",
        cursor: off ? "default" : "pointer",
        opacity: off ? 0.6 : 1,
      }}
    >
      {loading ? (
        <FSpinner size={16} />
      ) : (
        icon && <FIcon group={icon.group} name={icon.name} size={16} pressable={false} />
      )}
      {label}
    </button>
  );
}
