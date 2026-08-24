/**
 * Engine telemetry client — GET /api/v1/engine/metrics.
 *
 * Read-only proxy to the Rust engine's public GET /metrics (unauthenticated
 * per crates/vtt-server/src/auth.rs PUBLIC_PATHS). Every field here is a real
 * counter maintained by vtt-server; the UI must render null as "—", never
 * invent values when the engine is unreachable.
 */

export interface EngineMetrics {
  /** Percentage of adjudicated actions that executed without rejection. */
  mechanical_compliance_rate_pct: number;
  total_actions: number;
  valid_actions: number;
  rejected_actions: number;
  auditor_total: number;
  auditor_rejection_rate_pct: number;
  persistence_failures: number;
  target_sla_ms: number;
}

export type EngineMetricsResult =
  | { status: 'live'; metrics: EngineMetrics }
  | { status: 'unreachable' };

/**
 * Fetch live engine telemetry. Returns `unreachable` instead of throwing so
 * callers render an explicit degraded state rather than stale/fake numbers.
 */
export async function fetchEngineMetrics(): Promise<EngineMetricsResult> {
  try {
    const resp = await fetch('/api/v1/engine/metrics');
    if (!resp.ok) return { status: 'unreachable' };
    const metrics = (await resp.json()) as EngineMetrics;
    return { status: 'live', metrics };
  } catch {
    return { status: 'unreachable' };
  }
}

/** Render helper: an absent/undefined numeric metric shows as an em dash. */
export const metricOrDash = (value: number | undefined, format?: (n: number) => string): string =>
  value === undefined || value === null || Number.isNaN(value)
    ? '—'
    : format
      ? format(value)
      : String(value);
