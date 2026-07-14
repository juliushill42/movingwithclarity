// CLARITY Movers — ledger-service
//
// Append-only, hash-chained ledger for payments, payouts, refunds, and
// damage claims. Every entry commits to sha256(prev_hash || payload), so
// the full history can be walked and verified end-to-end. This is the
// simplified audit-chain pattern from JCH-2026-004, applied to the
// specific failure modes CLARITY exists to fix: movers not getting paid,
// and damage claims with no verifiable record.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

const GENESIS_HASH: &str = "genesis";

fn tenant_id_from_headers(headers: &HeaderMap) -> Result<Uuid, (StatusCode, String)> {
    let raw = headers
        .get("x-clarity-tenant-id")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::BAD_REQUEST, "x-clarity-tenant-id header is required".to_string()))?;
    Uuid::parse_str(raw).map_err(|_| (StatusCode::BAD_REQUEST, "invalid x-clarity-tenant-id".to_string()))
}

#[derive(Clone)]
struct AppState {
    pool: PgPool,
}

#[derive(Deserialize)]
struct NewEntry {
    move_id: Uuid,
    entry_type: String,
    amount_cents: i32,
    #[serde(default = "default_details")]
    details: serde_json::Value,
}

fn default_details() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Serialize, sqlx::FromRow)]
struct LedgerEntry {
    seq: i64,
    tenant_id: Uuid,
    move_id: Uuid,
    entry_type: String,
    amount_cents: i32,
    details: serde_json::Value,
    prev_hash: String,
    entry_hash: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

const VALID_ENTRY_TYPES: [&str; 4] = ["payment", "damage_claim", "refund", "payout"];

fn compute_hash(prev_hash: &str, tenant_id: &Uuid, move_id: &Uuid, entry_type: &str, amount_cents: i32, details: &serde_json::Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prev_hash.as_bytes());
    hasher.update(tenant_id.as_bytes());
    hasher.update(move_id.as_bytes());
    hasher.update(entry_type.as_bytes());
    hasher.update(amount_cents.to_be_bytes());
    hasher.update(details.to_string().as_bytes());
    hex::encode(hasher.finalize())
}

async fn create_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<NewEntry>,
) -> Result<Json<LedgerEntry>, (axum::http::StatusCode, String)> {
    let tenant_id = tenant_id_from_headers(&headers)?;

    if !VALID_ENTRY_TYPES.contains(&payload.entry_type.as_str()) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            format!("entry_type must be one of: {}", VALID_ENTRY_TYPES.join(", ")),
        ));
    }
    if payload.amount_cents <= 0 {
        return Err((axum::http::StatusCode::BAD_REQUEST, "amount_cents must be positive".into()));
    }

    let mut tx = state.pool.begin().await.map_err(internal_err)?;

    // Lock the tail of this tenant's chain only — concurrent writers on a
    // different tenant never contend with each other.
    let prev_hash: String = sqlx::query_scalar(
        "SELECT entry_hash FROM ledger_entries WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1 FOR UPDATE",
    )
    .bind(tenant_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal_err)?
    .unwrap_or_else(|| GENESIS_HASH.to_string());

    let entry_hash = compute_hash(&prev_hash, &tenant_id, &payload.move_id, &payload.entry_type, payload.amount_cents, &payload.details);

    let row = sqlx::query_as::<_, LedgerEntry>(
        r#"INSERT INTO ledger_entries (tenant_id, move_id, entry_type, amount_cents, details, prev_hash, entry_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING seq, tenant_id, move_id, entry_type, amount_cents, details, prev_hash, entry_hash, created_at"#,
    )
    .bind(tenant_id)
    .bind(payload.move_id)
    .bind(&payload.entry_type)
    .bind(payload.amount_cents)
    .bind(&payload.details)
    .bind(&prev_hash)
    .bind(&entry_hash)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal_err)?;

    tx.commit().await.map_err(internal_err)?;

    Ok(Json(row))
}

async fn list_entries(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Vec<LedgerEntry>>, (axum::http::StatusCode, String)> {
    let tenant_id = tenant_id_from_headers(&headers)?;

    let rows = if let Some(move_id) = params.get("move_id") {
        let move_uuid = Uuid::parse_str(move_id)
            .map_err(|_| (axum::http::StatusCode::BAD_REQUEST, "invalid move_id".to_string()))?;
        sqlx::query_as::<_, LedgerEntry>(
            "SELECT seq, tenant_id, move_id, entry_type, amount_cents, details, prev_hash, entry_hash, created_at
             FROM ledger_entries WHERE tenant_id = $1 AND move_id = $2 ORDER BY seq",
        )
        .bind(tenant_id)
        .bind(move_uuid)
        .fetch_all(&state.pool)
        .await
        .map_err(internal_err)?
    } else {
        sqlx::query_as::<_, LedgerEntry>(
            "SELECT seq, tenant_id, move_id, entry_type, amount_cents, details, prev_hash, entry_hash, created_at
             FROM ledger_entries WHERE tenant_id = $1 ORDER BY seq",
        )
        .bind(tenant_id)
        .fetch_all(&state.pool)
        .await
        .map_err(internal_err)?
    };
    Ok(Json(rows))
}

#[derive(Serialize)]
struct VerifyResult {
    valid: bool,
    entries_checked: usize,
    first_break_at_seq: Option<i64>,
}

async fn verify_chain(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<VerifyResult>, (axum::http::StatusCode, String)> {
    let tenant_id = tenant_id_from_headers(&headers)?;

    let rows = sqlx::query_as::<_, LedgerEntry>(
        "SELECT seq, tenant_id, move_id, entry_type, amount_cents, details, prev_hash, entry_hash, created_at
         FROM ledger_entries WHERE tenant_id = $1 ORDER BY seq",
    )
    .bind(tenant_id)
    .fetch_all(&state.pool)
    .await
    .map_err(internal_err)?;

    let mut expected_prev = GENESIS_HASH.to_string();
    for entry in &rows {
        if entry.prev_hash != expected_prev {
            return Ok(Json(VerifyResult { valid: false, entries_checked: rows.len(), first_break_at_seq: Some(entry.seq) }));
        }
        let recomputed = compute_hash(&entry.prev_hash, &entry.tenant_id, &entry.move_id, &entry.entry_type, entry.amount_cents, &entry.details);
        if recomputed != entry.entry_hash {
            return Ok(Json(VerifyResult { valid: false, entries_checked: rows.len(), first_break_at_seq: Some(entry.seq) }));
        }
        expected_prev = entry.entry_hash.clone();
    }

    Ok(Json(VerifyResult { valid: true, entries_checked: rows.len(), first_break_at_seq: None }))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "service": "ledger-service"}))
}

fn internal_err<E: std::fmt::Display>(e: E) -> (axum::http::StatusCode, String) {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[tokio::main]
async fn main() {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://clarity:clarity@postgres:5432/clarity".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .expect("failed to connect to postgres");

    let state = AppState { pool };

    let app = Router::new()
        .route("/health", get(health))
        .route("/ledger/entries", post(create_entry).get(list_entries))
        .route("/ledger/verify", get(verify_chain))
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "4003".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    println!("[ledger-service] listening on {port}");
    axum::serve(listener, app).await.unwrap();
}
