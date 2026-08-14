import { useEffect, useMemo, useState } from "react";
import { FButton, FText } from "@facilio/dsm-react-wrapper";
import { fn, usd } from "../lib/vibe";
import type { Assessment } from "../lib/types";
import { Empty, ErrorBanner, pretty, useRoute } from "../lib/ui";
import PageHeader from "../components/PageHeader";
import StatCards from "../components/StatCards";
import type { StatCard } from "../components/StatCards";
import FilterBar from "../components/FilterBar";
import type { FilterDefinition } from "../components/FilterBar";
import Pagination from "../components/Pagination";
import Table from "../components/Table";
import type { TableColumn } from "../components/tableTypes";
import { EmptyState } from "../components/EmptyState";
import { StatusTag, gradeTone, priorityTone, recommendationTone, riskTone } from "../components/StatusTag";

/**
 * The condition register — the continuously updated health record for every assessed asset.
 *
 * Laid out on the suite's list archetype: page header, summary tiles, filter bar, a record-count +
 * pagination strip, then the table. Every band is full-bleed and shares one horizontal inset, so the
 * asset column, the first filter chip and the page title all sit on the same left edge.
 *
 * Filtering and sorting stay client-side. `register` returns the whole portfolio in one call — there
 * is no server-side query to page against, and re-fetching per page would be slower than sorting an
 * array of a few hundred rows.
 */

const PAGE_SIZE = 25;
const ALL = "__all__";

interface Filters {
  grade: string | null;
  risk: string | null;
  recommendation: string | null;
}

const NO_FILTERS: Filters = { grade: null, risk: null, recommendation: null };

const FILTER_DEFINITIONS: FilterDefinition[] = [
  {
    key: "grade",
    label: "Condition",
    icon: { group: "chart-data", name: "bar-graph" },
    options: [
      { value: ALL, label: "All conditions" },
      { value: "GOOD", label: "Good" },
      { value: "FAIR", label: "Fair" },
      { value: "AVERAGE", label: "Average" },
      { value: "POOR", label: "Poor" },
      { value: "CRITICAL", label: "Critical" },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    icon: { group: "alert", name: "triangle-warning-filled" },
    options: [
      { value: ALL, label: "All risk levels" },
      { value: "HIGH", label: "High" },
      { value: "MEDIUM", label: "Medium" },
      { value: "LOW", label: "Low" },
    ],
  },
  {
    key: "recommendation",
    label: "Recommendation",
    icon: { group: "files", name: "document" },
    options: [
      { value: ALL, label: "All recommendations" },
      { value: "REPLACE", label: "Replace" },
      { value: "REFURBISH", label: "Refurbish" },
      { value: "REPAIR", label: "Repair" },
      { value: "MONITOR", label: "Monitor" },
    ],
  },
];

/** Stacked cell — the asset's name over the context that makes the row identifiable. */
function CellStack({ title, meta }: { title: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      {title}
      {meta && (
        <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
          {meta}
        </FText>
      )}
    </div>
  );
}

/** MTBF for a row: the mean interval and which way it is moving, or an honest dash. */
function MtbfCell({ row }: { row: Assessment }) {
  const mean = row.dominant_issue_mtbf?.mean_months ?? row.mtbf?.mean_months;
  const verdict = row.dominant_issue_mtbf?.verdict ?? row.mtbf?.verdict;

  if (!mean?.available || mean.value === null) {
    return <span style={{ color: "var(--colors-text-caption)" }}>—</span>;
  }

  const contracting = verdict?.available && verdict.value === "contracting";
  const lengthening = verdict?.available && verdict.value === "lengthening";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
      {mean.value}mo
      <span
        style={{
          color: contracting
            ? "var(--colors-icon-semantic-red, #d64545)"
            : lengthening
            ? "var(--colors-icon-semantic-green)"
            : "var(--colors-text-caption)",
          fontWeight: contracting ? 700 : 400,
        }}
      >
        {contracting ? "↓" : lengthening ? "↑" : "→"}
      </span>
    </span>
  );
}

/** The KPI block `register` returns alongside the rows. */
interface RegisterKpis {
  assets_assessed: number;
  high_risk: number;
  replace_count: number;
  total_capex_exposure: number;
}

export function Register() {
  const { navigate } = useRoute();
  const [rows, setRows] = useState<Assessment[] | null>(null);
  const [kpis, setKpis] = useState<RegisterKpis | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    fn<{ register: Assessment[]; kpis: RegisterKpis }>("register")
      .then((r) => {
        setRows(r.register);
        setKpis(r.kpis);
      })
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = search.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (filters.grade && r.grade !== filters.grade) return false;
        if (filters.risk && String(r.risk_level).toUpperCase() !== filters.risk) return false;
        if (filters.recommendation && r.recommendation !== filters.recommendation) return false;
        if (!needle) return true;
        return (
          String(r.asset_name).toLowerCase().includes(needle) ||
          String(r.category).toLowerCase().includes(needle) ||
          String(r.dominant_issue_label || "").toLowerCase().includes(needle)
        );
      })
      // Riskiest first: this page exists to answer "what do I deal with next".
      .sort((a, b) => b.risk_score - a.risk_score);
  }, [rows, filters, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp rather than reset: narrowing the filters while on page 4 should land on the last page
  // that still has rows, not silently jump to an empty one.
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  /**
   * Portfolio totals, taken from the engine's own KPI block rather than recomputed here.
   * Summing `replacement_cost` over the CAPEX-priority rows looks equivalent but is not — the
   * engine applies its own exposure rule — and two tiles labelled "CAPEX exposure" showing
   * different figures on Home and here is worse than either number alone.
   */
  const summary: StatCard[] = useMemo(
    () => [
      {
        key: "assessed",
        label: "Assets assessed",
        value: String(kpis?.assets_assessed ?? 0),
        icon: { group: "webtabs", name: "asset" },
        tone: "blue",
      },
      {
        key: "high-risk",
        label: "High risk",
        value: String(kpis?.high_risk ?? 0),
        icon: { group: "alert", name: "triangle-warning-filled" },
        tone: "amber",
      },
      {
        key: "replace",
        label: "Marked for replacement",
        value: String(kpis?.replace_count ?? 0),
        icon: { group: "files", name: "document" },
        tone: "purple",
      },
      {
        key: "capex",
        label: "CAPEX exposure",
        value: usd(kpis?.total_capex_exposure ?? 0),
        icon: { group: "chart-data", name: "bar-graph" },
        tone: "green",
      },
    ],
    [kpis]
  );

  const columns: TableColumn<Assessment>[] = [
    {
      key: "asset_name",
      title: "Asset",
      width: "260px",
      mainColumn: true,
      render: (_v, row) => (
        <CellStack
          title={
            <FText appearance="bodyReg14" styleProps={{ color: "textPrimaryDefault" }}>
              {row.asset_name}
            </FText>
          }
          meta={`${row.category} · ${row.corrective_wo_count} corrective WOs`}
        />
      ),
    },
    {
      key: "score",
      title: "Condition",
      width: "150px",
      render: (_v, row) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-container-large)" }}>
          {row.score.toFixed(2)}
          <StatusTag tone={gradeTone(row.grade)}>{row.grade}</StatusTag>
        </span>
      ),
    },
    {
      key: "risk_score",
      title: "Risk",
      width: "110px",
      render: (_v, row) => <StatusTag tone={riskTone(row.risk_level)}>{row.risk_score}</StatusTag>,
    },
    {
      key: "dominant_issue_label",
      title: "Dominant issue",
      width: "200px",
      render: (_v, row) => (
        <CellStack
          title={
            <FText appearance="bodyReg14" styleProps={{ color: "textDescription" }}>
              {row.dominant_issue_label || "—"}
            </FText>
          }
          meta={row.dominant_recurrence_pct ? `${row.dominant_recurrence_pct}% of findings` : undefined}
        />
      ),
    },
    {
      key: "mtbf",
      title: "MTBF",
      width: "120px",
      disableTooltip: true,
      render: (_v, row) => <MtbfCell row={row} />,
    },
    {
      key: "deterioration",
      title: "Deterioration",
      width: "140px",
      render: (_v, row) => (
        <span
          style={{
            color:
              row.deterioration === "accelerating"
                ? "var(--colors-icon-semantic-red, #d64545)"
                : row.deterioration === "improving"
                ? "var(--colors-icon-semantic-green)"
                : "var(--colors-text-caption)",
          }}
        >
          {row.deterioration === "accelerating" ? "↑ " : row.deterioration === "improving" ? "↓ " : "→ "}
          {pretty(row.deterioration)}
        </span>
      ),
    },
    {
      key: "rul_years",
      title: "RUL",
      width: "100px",
      align: "right",
      render: (_v, row) =>
        row.rul?.available === false ? (
          <span style={{ color: "var(--colors-text-caption)" }}>n/a</span>
        ) : (
          `${row.rul_years}y`
        ),
    },
    {
      key: "repair_spend",
      title: "Repair spend",
      width: "130px",
      align: "right",
      render: (_v, row) => usd(row.repair_spend),
    },
    {
      key: "replacement_cost",
      title: "Replacement",
      width: "130px",
      align: "right",
      render: (_v, row) => usd(row.replacement_cost),
    },
    {
      key: "capex_priority",
      title: "CAPEX",
      width: "110px",
      render: (_v, row) =>
        row.capex_priority === "-" ? (
          <span style={{ color: "var(--colors-text-caption)" }}>—</span>
        ) : (
          <StatusTag tone={priorityTone(row.capex_priority)}>{row.capex_priority}</StatusTag>
        ),
    },
    {
      key: "recommendation",
      title: "Recommendation",
      width: "170px",
      render: (_v, row) => (
        <StatusTag tone={recommendationTone(row.recommendation)}>{row.recommendation}</StatusTag>
      ),
    },
  ];

  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%" }}>
        <PageHeader
          title="Condition Register"
          description="Every asset that has been assessed, ranked by risk."
          showNewButton={false}
        />
        <div style={{ padding: "var(--spacing-container-xxlarge)" }}>
          <ErrorBanner>Could not load the register: {error}</ErrorBanner>
        </div>
      </div>
    );
  }

  if (!rows) return <Empty>Loading the condition register…</Empty>;

  const isFiltered = search.trim() !== "" || Object.values(filters).some(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", height: "100%" }}>
      <PageHeader
        title="Condition Register"
        description="The continuously updated health record for every assessed asset. Re-running an assessment updates the row and appends to its history."
        iconGroup="webtabs"
        iconName="asset"
        newButtonLabel="Run assessment"
        onNewClick={() => navigate("/run")}
      />

      <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", position: "relative" }}>
        <StatCards cards={summary} />

        {/* Outside the empty-state gate on purpose: a filter matching nothing would otherwise hide
            the only control that can clear it. */}
        <FilterBar
          filters={FILTER_DEFINITIONS}
          selected={{
            grade: filters.grade ?? ALL,
            risk: filters.risk ?? ALL,
            recommendation: filters.recommendation ?? ALL,
          }}
          onChange={(key, value) => {
            setFilters((prev) => ({ ...prev, [key]: value === ALL ? null : value }));
            setPage(1);
          }}
          onClearAll={() => {
            setFilters(NO_FILTERS);
            setSearch("");
            setPage(1);
          }}
          search={search}
          onSearchChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          searchPlaceholder="Search asset, category, issue…"
        />

        {filtered.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 var(--spacing-container-xxlarge)",
              backgroundColor: "var(--colors-background-container)",
              borderBottom: "1px solid var(--colors-border-neutral-base-subtler)",
              height: 48,
              flexShrink: 0,
              gap: 48,
            }}
          >
            <FText appearance="bodyReg14" styleProps={{ color: "textCaption" }}>
              {Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
              {isFiltered ? ` of ${rows.length}` : ""} assets
            </FText>
            {totalPages > 1 && (
              <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} />
            )}
          </div>
        )}

        {filtered.length === 0 ? (
          <EmptyState
            title={isFiltered ? "No asset matches these filters" : "Nothing assessed yet"}
            description={
              isFiltered
                ? "Clear a filter, or widen the search."
                : "Run an assessment and the asset's condition record appears here."
            }
            action={
              isFiltered ? (
                <FButton
                  appearance="secondary"
                  size="medium"
                  onButtonClick={() => {
                    setFilters(NO_FILTERS);
                    setSearch("");
                  }}
                >
                  Clear filters
                </FButton>
              ) : (
                <FButton appearance="primary" size="medium" onButtonClick={() => navigate("/run")}>
                  Run assessment
                </FButton>
              )
            }
          />
        ) : (
          <Table
            columns={columns}
            data={pageRows}
            rowKey="asset_id"
            rowHeight="64px"
            stickyFirstColumn
            mainFieldClick={(row) => navigate(`/asset/${row.asset_id}`)}
          />
        )}
      </div>
    </div>
  );
}
