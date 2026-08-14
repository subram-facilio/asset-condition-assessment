import { useState } from "react";
import { FIcon } from "@facilio/dsm-react-wrapper";
import Tooltip from "./Tooltip";
import { useTheme } from "../context/ThemeContext";

/** Sun/moon switch in the top bar. The glyph shows the theme now in effect, not the one a click would give. */
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const [hover, setHover] = useState(false);
  const isDark = theme === "dark";
  const label = isDark ? "Dark theme" : "Light theme";

  return (
    <Tooltip content={label} placement="bottom" delay={600}>
      <button
        aria-label={label}
        onClick={toggleTheme}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          borderRadius: "var(--border-small)",
          cursor: "pointer",
          padding: 0,
          flexShrink: 0,
          color: "var(--colors-icon-neutral-main)",
          backgroundColor: hover ? "var(--colors-background-selection)" : "transparent",
          transition: "background-color 0.14s ease",
        }}
      >
        <FIcon
          group="weather"
          name={isDark ? "clear-night" : "clear-day"}
          size={16}
          pressable={false}
        />
      </button>
    </Tooltip>
  );
}
