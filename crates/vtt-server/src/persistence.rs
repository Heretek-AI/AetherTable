//! Write-through Postgres persistence (availability-first).
//!
//! A background tailer drains each session's in-memory ledger into
//! `narrative_state.event_sourcing_log` within ~1.5 s of commit. The engine
//! NEVER blocks gameplay on the database: connection failure degrades to
//! memory-only operation with a `persistence_failures` counter surfaced in
//! `/metrics`, and successful flushes resume automatically.

use sqlx::PgPool;
use uuid::Uuid;

/// Recovery note: full-state hydration from history is served by the
/// orchestrator's `/api/v1/engine-session/hydrate` endpoint pushing persisted
/// snapshots into `PUT /sessions/{id}/restore`. This module owns incremental
/// event durability only.
///
/// Idempotent DDL mirroring database/postgres/02_event_sourcing_and_session_schema.sql.
/// Executed statement-by-statement: Postgres forbids multiple commands in a
/// single prepared statement, which is what sqlx uses internally.
const ENSURE_DDL: &[&str] = &[
    "CREATE SCHEMA IF NOT EXISTS narrative_state",
    r#"CREATE TABLE IF NOT EXISTS narrative_state.sessions (
        session_id UUID PRIMARY KEY,
        campaign_id UUID,
        session_name TEXT NOT NULL DEFAULT '',
        round_number INT NOT NULL DEFAULT 1,
        is_active BOOL NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )"#,
    r#"CREATE TABLE IF NOT EXISTS narrative_state.event_sourcing_log (
        log_id BIGSERIAL PRIMARY KEY,
        session_id UUID NOT NULL,
        campaign_id UUID,
        actor_id UUID,
        event_type VARCHAR(64),
        payload JSONB,
        state_hash VARCHAR(64),
        sequence_id BIGINT,
        is_reverted BOOL NOT NULL DEFAULT FALSE,
        committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )"#,
    // The migration's `sequence_id` is a BIGSERIAL row id; the ENGINE's
    // logical ledger sequence gets its own column + index (now also declared
    // in database/postgres/02_event_sourcing_and_session_schema.sql). These
    // idempotent statements remain so databases provisioned by OLDER
    // migrations are upgraded in place — without them a fresh-migration DB
    // served by an old binary would silently lose tailer idempotency, and an
    // old-migration DB served by this binary would fail every insert.
    "ALTER TABLE narrative_state.event_sourcing_log \
         ADD COLUMN IF NOT EXISTS ledger_sequence BIGINT",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_ledger_seq \
         ON narrative_state.event_sourcing_log (session_id, ledger_sequence)",
    // GOALS.md Pillar 2: the campaign wizard's SRD 5.1 vs 5.2 choice is durable
    // server-side, not just in the engine's memory. Backfilled with the legacy
    // baseline so rows written by older binaries stay valid.
    r#"ALTER TABLE narrative_state.sessions
           ADD COLUMN IF NOT EXISTS rule_version TEXT NOT NULL DEFAULT 'srd_5_1'"#,
];

pub async fn connect(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect(database_url)
        .await?;
    for stmt in ENSURE_DDL {
        sqlx::query(stmt).execute(&pool).await?;
    }
    Ok(pool)
}

pub async fn ensure_session_row(
    pool: &PgPool,
    session_id: Uuid,
    campaign_id: Uuid,
    session_name: &str,
    round_number: u32,
    rule_version: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO narrative_state.sessions
               (session_id, campaign_id, session_name, round_number, rule_version)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (session_id) DO UPDATE SET
               round_number = EXCLUDED.round_number,
               rule_version = EXCLUDED.rule_version,
               updated_at = now()"#,
    )
    .bind(session_id)
    .bind(campaign_id)
    .bind(session_name)
    .bind(round_number as i32)
    .bind(rule_version)
    .execute(pool)
    .await
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_event(
    pool: &PgPool,
    session_id: Uuid,
    campaign_id: Uuid,
    actor_id: Uuid,
    event_type: &str,
    payload: serde_json::Value,
    state_hash: &str,
    sequence_id: u64,
    is_reverted: bool,
) -> Result<(), sqlx::Error> {
    // ON CONFLICT DO NOTHING makes tailer replays idempotent: after a
    // transient mid-batch failure the next tick re-drains from the old
    // watermark, and already-inserted rows conflict on the unique
    // (session_id, ledger_sequence) index instead of erroring forever.
    sqlx::query(
        r#"INSERT INTO narrative_state.event_sourcing_log
               (session_id, campaign_id, actor_id, event_type, payload,
                state_hash, ledger_sequence, is_reverted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (session_id, ledger_sequence) DO NOTHING"#,
    )
    .bind(session_id)
    .bind(campaign_id)
    .bind(actor_id)
    .bind(event_type)
    .bind(payload)
    .bind(state_hash)
    .bind(sequence_id as i64)
    .bind(is_reverted)
    .execute(pool)
    .await
    .map(|_| ())
}

