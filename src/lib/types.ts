/** Shapes returned by the condition-engine handlers and the photo-validation agent. */

export type Severity = "low" | "medium" | "high" | "critical" | "unknown";
export type RecurrenceStatus = "isolated" | "recurring" | "highly_recurring" | "insufficient_evidence";
export type Trend = "increasing" | "decreasing" | "stable" | "recurring" | "insufficient_evidence";

export interface GatheredPhoto {
  attachment_id: number;
  filename: string;
  content_type: string;
  url: string;
  size?: number;
}

export interface GatheredWo {
  wo_id: number;
  subject: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  event_date: string;
  photos: GatheredPhoto[];
  attachmentError: string;
}

export interface Bundle {
  asset: {
    asset_id: number;
    asset_name: string;
    asset_type: string;
    manufacturer: string;
    model: string;
    location: string;
    purchasedDate: string;
  };
  total_corrective_work_orders: number;
  work_orders_pulled: number;
  capped: boolean;
  photos_available: number;
  analyzed_attachment_ids: number[];
  work_orders: GatheredWo[];
  inspections: unknown[];
}

export interface RecurringIssue {
  issue_id: string;
  issue: string;
  display_name: string;
  occurrence_count: number;
  occurrence_rate: number;
  status: RecurrenceStatus;
  affected_components: Array<{ component: string; occurrence_count: number }>;
  severity: { overall: Severity; observed_levels: Severity[] };
  first_occurrence: { work_order_id: string; date: string } | null;
  last_occurrence: { work_order_id: string; date: string } | null;
  trend: Trend;
  work_order_references: string[];
  evidence: string[];
  confidence: number;
  evidence_sources?: string[];
}

export interface Analysis {
  asset: Record<string, string>;
  analysis_scope: {
    work_order_type: string;
    corrective_work_orders_analyzed: number;
    photos_analyzed: number;
    before_photos_only: boolean;
    work_orders_with_usable_photos: number;
    work_orders_with_insufficient_photos: number;
    usable_photos?: number;
    unusable_photos?: number;
  };
  recurring_issues: RecurringIssue[];
  component_analysis: Array<{
    component: string;
    corrective_work_order_count: number;
    issue_count: number;
    issues: string[];
    highest_severity: Severity;
    risk_level: string;
  }>;
  issue_summary: {
    distinct_recurring_issues: number;
    most_frequent_issue: string;
    most_frequent_issue_count: number;
    highest_severity_issue?: string;
    highest_severity_level?: Severity;
    most_affected_component: string;
    most_affected_component_count: number;
  };
  asset_risk: {
    risk_level: string;
    risk_score: number;
    risk_drivers: Array<{ driver: string; occurrence_count: number; severity: Severity }>;
  };
  overall_analysis: {
    primary_recurring_issue: string;
    primary_issue_occurrence_count: number;
    most_affected_component: string;
    summary: string;
    recurrence_finding: string;
    asset_pattern: string;
    risk_reason: string;
  };
  data_quality: {
    photo_evidence_confidence: number;
    assessment_limited: boolean;
    limitations: string[];
    photo_backed_findings?: number;
    text_derived_findings?: number;
  };
  photo_analysis: Array<{
    work_order_id: string;
    photo_id: string;
    usable: boolean;
    quality_score: number;
    quality_issues: string[];
    asset_type_match: string;
    component_match: string;
    defects: Array<{
      type: string;
      severity: Severity;
      confidence: number;
      extent_percent: number;
      component: string;
      location: string;
      evidence: string[];
      work_order_id: string;
      photo_id: string;
    }>;
  }>;
  analysis_source?: string;
}

export interface Assessment {
  asset_id: number;
  asset_name: string;
  category: string;
  score: number;
  grade: string;
  dominant_issue: string;
  dominant_issue_label: string;
  dominant_recurrence_pct: number;
  trend_direction: string;
  deterioration: string;
  rul_years: number;
  risk_score: number;
  risk_level: string;
  visual_risk_level: string;
  visual_risk_score: number;
  repair_spend: number;
  replacement_cost: number;
  capex_priority: string;
  recommendation: string;
  corrective_wo_count: number;
  assessed_at: string;
  evidence?: {
    inputs: Record<string, string | number>;
    formulas: Record<string, string>;
    cost_basis: string;
  };
}

export interface Finding {
  wo_id: number;
  attachment_id: number;
  source: "photo" | "wo_text" | "inspection";
  issue_code: string;
  issue_label: string;
  component: string;
  location: string;
  severity: Severity;
  confidence: number;
  extent_percent: number;
  evidence: string[];
  photo_file_id: number;
  photo_usable: boolean;
  photo_quality_score: number;
  asset_type_match: string;
  component_match: string;
  event_date: string;
}

export interface AssetDetail {
  assessment: Assessment | null;
  analysis: Analysis | null;
  engine_overrides: { count_mismatches?: string[] } | null;
  findings: Finding[];
  issue_matrix: { years: string[]; rows: Array<{ issue: string; label: string; counts: number[] }> };
  history: Array<{ score: number; risk_score: number; rul_years: number; assessed_at: string }>;
}

export interface AssetRow {
  asset_id: number;
  name: string;
  category: string;
  manufacturer: string;
  model: string;
  purchasedDate: string;
  assessed: boolean;
  score: number | null;
  grade: string | null;
  risk_score: number | null;
  risk_level: string | null;
  recommendation: string | null;
  capex_priority: string | null;
  assessed_at: string | null;
}
