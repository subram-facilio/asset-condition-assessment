/**
 * Sidebar destinations. Paths are hash routes (`#/register`), matching the app's existing
 * `useRoute` router — deep links have to survive a refresh on static Vibe hosting.
 */

export interface NavItemEntry {
  to: string;
  icon: string;
  group: string;
  label: string;
  /**
   * Extra path prefix(es) that should also light this item up. The asset summary lives at
   * `/asset/:id` but is reached from the register, so it highlights the register.
   */
  match?: string[];
  /** Match `to` exactly rather than as a prefix. */
  exact?: boolean;
}

/** Top group — the three working surfaces. */
export const NAV_TOP: NavItemEntry[] = [
  { to: "/", icon: "home", group: "action", label: "Home", exact: true },
  {
    to: "/register",
    icon: "asset",
    group: "webtabs",
    label: "Condition Register",
    match: ["/register", "/asset/"],
  },
  { to: "/run", icon: "inspection", group: "webtabs", label: "Run Assessment" },
];

/** Pinned to the bottom of the rail, where the design puts Settings. */
export const NAV_FOOTER: NavItemEntry = {
  to: "/settings",
  icon: "settings",
  group: "action",
  label: "Baselines",
};

/** True when `path` should light up `entry`. */
export function isNavItemActive(entry: NavItemEntry, path: string): boolean {
  if (entry.exact && !entry.match) return path === entry.to;
  return (entry.match ?? [entry.to]).some((p) => path.startsWith(p));
}
