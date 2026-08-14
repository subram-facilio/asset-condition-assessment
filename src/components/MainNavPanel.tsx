import { useRoute } from "../lib/ui";
import NavPanel from "./NavPanel";
import { NavItem } from "./NavItem";
import { HorizontalDivider } from "./navPrimitives";
import { NAV_TOP, NAV_FOOTER, isNavItemActive } from "./navConfig";

/**
 * The sidebar's nav list: the working surfaces on top, Baselines pinned to the bottom
 * (where the design puts Settings). `syncKey` tells {@link ./NavPanel} when the pill has to
 * re-measure — route change and collapse are the only two things that move a row.
 */
export default function MainNavPanel({ collapsed }: { collapsed: boolean }) {
  const { path } = useRoute();

  return (
    <NavPanel syncKey={`main|${path}|${collapsed}`}>
      {NAV_TOP.map((entry) => (
        <NavItem
          key={entry.to}
          to={entry.to}
          icon={entry.icon}
          group={entry.group}
          label={entry.label}
          active={isNavItemActive(entry, path)}
          collapsed={collapsed}
        />
      ))}

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--spacing-container-medium)",
          paddingTop: "var(--spacing-container-large)",
        }}
      >
        <HorizontalDivider />
        <NavItem
          to={NAV_FOOTER.to}
          icon={NAV_FOOTER.icon}
          group={NAV_FOOTER.group}
          label={NAV_FOOTER.label}
          active={isNavItemActive(NAV_FOOTER, path)}
          collapsed={collapsed}
        />
      </div>
    </NavPanel>
  );
}
