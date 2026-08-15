import { Card } from "./Card";
import { Shimmer, ShimmerCircle } from "./Shimmer";

/**
 * Whole-page loading states, one per page archetype.
 *
 * Each page used to hold its first paint with a line of text — "Loading the condition
 * register…" — which tells the reader nothing about what is coming and then replaces
 * itself with a completely different layout, so the page appears to jump. These mirror
 * the geometry of the page they stand in for: the reader sees where the header, the
 * figures, the filters and the rows will be before the data lands, and nothing moves
 * when it does.
 *
 * Every block is a {@link Shimmer}, so the sweep timing, the theme palette and the
 * `prefers-reduced-motion` opt-out are the ones already defined in `index.css` rather
 * than a second animation living here.
 */

/** Row count matches Table's own `SKELETON_ROWS`, so the two skeletons are the same height. */
const SKELETON_ROWS = 10;

/** Register's table geometry, passed to Table as `rowHeight="64px"` with a 40px header. */
const TABLE_ROW_HEIGHT = 64;
const TABLE_HEADER_HEIGHT = 40;

/** Proportional column widths standing in for the register's six columns. */
const COLUMN_WIDTHS = ["24%", "13%", "10%", "15%", "12%", "16%"];

const GUTTER = "var(--spacing-container-xxlarge)";
const HAIRLINE = "1px solid var(--colors-border-neutral-base-subtler)";

/**
 * The list archetype: PageHeader band, stat tiles, filter bar, then the table.
 *
 * Used by the condition register, whose real chrome this reproduces band for band —
 * including the hairlines, which are what make the bands read as separate regions
 * before there is any content to separate.
 */
export function RegisterSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", height: "100%" }}>
      {/* PageHeader */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--spacing-container-medium)",
          padding: `var(--spacing-section-xsmall) ${GUTTER}`,
          backgroundColor: "var(--colors-background-container)",
          borderBottom: HAIRLINE,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-large)" }}>
          <ShimmerCircle size={20} />
          <Shimmer width={190} height={16} />
        </div>
        <Shimmer width="46%" height={12} />
      </div>

      {/* StatCards — same auto-fit grid as the real row, so the tiles land in the same places */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "var(--spacing-container-xlarge)",
          padding: `var(--spacing-container-xlarge) ${GUTTER}`,
          backgroundColor: "var(--colors-background-container)",
          borderBottom: HAIRLINE,
          flexShrink: 0,
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Shimmer width={32} height={32} borderRadius={8} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              <Shimmer width={44} height={18} />
              <Shimmer width="60%" height={11} />
            </div>
          </div>
        ))}
      </div>

      {/* FilterBar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-container-large)",
          padding: `var(--spacing-container-large) ${GUTTER}`,
          backgroundColor: "var(--colors-background-container)",
          borderBottom: HAIRLINE,
          flexShrink: 0,
        }}
      >
        {[104, 92, 132].map((w) => (
          <Shimmer key={w} width={w} height={28} borderRadius={999} />
        ))}
        <div style={{ flex: 1 }} />
        <Shimmer width={240} height={32} borderRadius={999} />
      </div>

      {/* Table header, then rows */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: GUTTER,
          height: TABLE_HEADER_HEIGHT,
          padding: `0 ${GUTTER}`,
          backgroundColor: "var(--colors-background-midground-subtle)",
          borderBottom: HAIRLINE,
          flexShrink: 0,
        }}
      >
        {COLUMN_WIDTHS.map((w, i) => (
          <Shimmer key={i} width={w} height={10} />
        ))}
      </div>

      <div style={{ flex: 1, overflow: "hidden" }}>
        {Array.from({ length: SKELETON_ROWS }).map((_, row) => (
          <div
            key={row}
            style={{
              display: "flex",
              alignItems: "center",
              gap: GUTTER,
              height: TABLE_ROW_HEIGHT,
              padding: `0 ${GUTTER}`,
              backgroundColor: "var(--colors-background-container)",
              borderBottom: HAIRLINE,
            }}
          >
            {COLUMN_WIDTHS.map((w, col) => (
              <Shimmer key={col} width={w} height={col === 0 ? 14 : 12} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The focused single-column archetype — {@link PageShell}'s fixed header over a centred
 * 820px body. Both skeletons that use it pass their own body blocks.
 */
function PageShellSkeleton({ children }: { children: React.ReactNode }) {
  const column = { maxWidth: 820, width: "100%", margin: "0 auto" } as const;

  return (
    <div
      className="ca-skeleton-on-midground"
      style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div style={{ flexShrink: 0, padding: "var(--spacing-section-medium) var(--spacing-section-small) 0" }}>
        <div style={{ ...column, display: "flex", flexDirection: "column", gap: 10 }}>
          <Shimmer width={170} height={16} />
          <Shimmer width="72%" height={11} />
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <div style={{ padding: `${GUTTER} var(--spacing-section-small) var(--spacing-section-medium)` }}>
          <div style={{ ...column, display: "flex", flexDirection: "column", gap: "var(--spacing-section-small)" }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Card heading: glyph, title, and the right-pinned actions the real CardTitle carries. */
function CardTitleSkeleton({ actionWidths = [] }: { actionWidths?: number[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-large)" }}>
      <Shimmer width={16} height={16} borderRadius={4} />
      <Shimmer width={150} height={14} />
      <div style={{ flex: 1 }} />
      {actionWidths.map((w, i) => (
        <Shimmer key={i} width={w} height={20} />
      ))}
    </div>
  );
}

/** Run assessment: the asset picker card, then the run panel below it. */
export function RunAssessmentSkeleton() {
  return (
    <PageShellSkeleton>
      <Card style={{ display: "flex", flexDirection: "column", gap: GUTTER }}>
        <CardTitleSkeleton actionWidths={[28, 68, 88, 44]} />
        <Shimmer width="100%" height={32} borderRadius="var(--border-medium)" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-xlarge)" }}>
            <Shimmer width={16} height={16} borderRadius={4} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              <Shimmer width={i % 2 ? "38%" : "46%"} height={14} />
              <Shimmer width={i % 2 ? "62%" : "54%"} height={11} />
            </div>
            <Shimmer width={64} height={20} borderRadius={999} />
          </div>
        ))}
      </Card>

      <Card style={{ display: "flex", flexDirection: "column", gap: GUTTER }}>
        <CardTitleSkeleton actionWidths={[120]} />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-xlarge)" }}>
            <ShimmerCircle size={16} />
            <Shimmer width={["44%", "52%", "36%"][i]} height={12} />
          </div>
        ))}
      </Card>
    </PageShellSkeleton>
  );
}

/** Baselines: one card per asset category, each holding four estimated fields. */
export function BaselinesSkeleton() {
  return (
    <PageShellSkeleton>
      {Array.from({ length: 3 }).map((_, card) => (
        <Card key={card} style={{ display: "flex", flexDirection: "column", gap: GUTTER }}>
          <CardTitleSkeleton actionWidths={[80, 96]} />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: "var(--spacing-container-xlarge)",
            }}
          >
            {Array.from({ length: 4 }).map((_, field) => (
              <div key={field} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Shimmer width="72%" height={11} />
                <Shimmer width="46%" height={16} />
                <Shimmer width="58%" height={10} />
              </div>
            ))}
          </div>
          <Shimmer width="40%" height={10} />
        </Card>
      ))}
    </PageShellSkeleton>
  );
}

/**
 * The record archetype: back link, title with its status chips, tab strip, then the facts
 * rail beside the content column. The rail is kept at its real 280px so the content column
 * does not resize when the analysis arrives.
 */
export function AssetDetailSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", height: "100%" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--spacing-container-xlarge)",
          padding: `${GUTTER} var(--spacing-section-small)`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-medium)" }}>
          <Shimmer width={12} height={12} borderRadius={3} />
          <Shimmer width={110} height={11} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-large)" }}>
          <Shimmer width={150} height={20} />
          <Shimmer width={86} height={20} borderRadius={999} />
          <Shimmer width={72} height={20} borderRadius={999} />
          <div style={{ flex: 1 }} />
          <Shimmer width={96} height={32} borderRadius="var(--border-medium)" />
        </div>
        <Shimmer width="34%" height={11} />
      </div>

      {/* Tab strip — 40px with the 2px underline the active tab carries */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-section-small)",
          height: 40,
          padding: `0 var(--spacing-section-small)`,
          borderBottom: HAIRLINE,
          flexShrink: 0,
        }}
      >
        {[76, 82, 86].map((w) => (
          <div key={w} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-medium)" }}>
            <Shimmer width={14} height={14} borderRadius={4} />
            <Shimmer width={w} height={12} />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div
          style={{
            width: 280,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: GUTTER,
            padding: GUTTER,
            borderRight: HAIRLINE,
          }}
        >
          <Shimmer width={70} height={14} />
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Shimmer width="52%" height={10} />
              <Shimmer width={["64%", "48%", "72%", "40%"][i % 4]} height={14} />
            </div>
          ))}
        </div>

        <div
          className="ca-skeleton-on-midground"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-section-small)",
            padding: "var(--spacing-section-small)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--spacing-section-small)" }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
                <Shimmer width="56%" height={20} />
                <Shimmer width="80%" height={11} />
              </Card>
            ))}
          </div>

          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} style={{ display: "flex", flexDirection: "column", gap: GUTTER }}>
              <CardTitleSkeleton />
              {Array.from({ length: 3 }).map((_, line) => (
                <Shimmer key={line} width={["100%", "94%", "68%"][line]} height={12} />
              ))}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
