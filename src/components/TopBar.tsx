import { FButton, FIcon, FText } from "@facilio/dsm-react-wrapper";
import Divider from "./Divider";
import Tooltip from "./Tooltip";
import ThemeToggle from "./ThemeToggle";
import ProfileMenu from "./ProfileMenu";
import { useSidebar } from "./Layout";

/** Header rules are `Type=Vertical, Size=1` — 12px beside the brand, 20px in the account cluster. */
function HeaderRule({ length }: { length: number }) {
  return (
    <Divider
      orientation="vertical"
      thickness={1}
      length={length}
      color="var(--colors-border-neutral-base-subtle)"
    />
  );
}

/**
 * Fixed 56px application top bar: sidebar toggle, brand, then the theme/account cluster.
 *
 * The brand mark is a tinted square rather than a coloured agent glyph: the icon library has no
 * `ai-agent-colored/condition-assessment`, and reusing another agent's mark would misbrand this
 * app. The square gives the same visual weight the design expects at that position.
 */
export default function TopBar() {
  const { toggle } = useSidebar();

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--spacing-container-xlarge)",
        padding: "0 var(--spacing-container-xlarge)",
        height: 56,
        minHeight: 56,
        flexShrink: 0,
        boxSizing: "border-box",
        backgroundColor: "var(--colors-background-container)",
        boxShadow: "inset 0 -1px 0 0 var(--colors-border-neutral-base-subtle)",
        zIndex: 100,
      }}
    >
      <Tooltip content="Toggle sidebar" placement="bottom" delay={600}>
        <FButton
          appearance="tertiary"
          size="medium"
          iconButton
          icon={{ group: "action", name: "side-panel-close" }}
          onButtonClick={toggle}
        />
      </Tooltip>

      <HeaderRule length={12} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-container-medium)",
          flexShrink: 0,
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
            borderRadius: "var(--border-medium)",
            backgroundColor: "var(--colors-background-neutral-base-subtle)",
          }}
        >
          <FIcon
            group="webtabs"
            name="asset"
            size={16}
            color="var(--colors-icon-primary-default)"
            pressable={false}
          />
        </span>
        <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
          Condition Assessment
        </FText>
      </div>

      <div style={{ flex: 1 }} />

      <ThemeToggle />
      <HeaderRule length={20} />
      <ProfileMenu />
    </header>
  );
}
