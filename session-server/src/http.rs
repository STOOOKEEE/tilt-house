//! HTTP API: sessions (docs/sessions.md steps 1, 3, 5) and the live gamblers
//! (docs/gamblers-api.md). JSON in and out; errors are `{"error": "..."}`.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::CorsLayer;

use crate::app::{ApiError, App, CloseReply, CreateReply, CreateRequest, RoundReply, SessionView};
use crate::chain::Chain;
use crate::gamblers::{FootfallReply, GamblerSnapshot, Gamblers};
use crate::limits::RateLimiter;
use crate::session::RoundRequest;

/// Requests are a few hundred bytes; anything larger is not ours.
const BODY_LIMIT: usize = 4 * 1024;
/// Per IP, all endpoints: room for a few players behind one NAT at 20 rounds/s.
const IP_PER_SEC: f64 = 60.0;
const IP_BURST: f64 = 120.0;
/// Per IP, new sessions: each one costs a chain read and a disk write.
const CREATE_PER_SEC: f64 = 0.2;
const CREATE_BURST: f64 = 5.0;
/// docs/sessions.md: 20 rounds per second per session.
const ROUNDS_PER_SEC: f64 = 20.0;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

struct Http<C> {
    app: Arc<App<C>>,
    gamblers: Arc<Gamblers<C>>,
    per_ip: RateLimiter<IpAddr>,
    creates: RateLimiter<IpAddr>,
    /// Keyed by (session id, token): the id is public on chain, so strangers with a wrong token
    /// fill their own bucket, never the player's. In-process gamblers are not limited.
    rounds: RateLimiter<(String, String)>,
}

pub fn router<C: Chain>(app: Arc<App<C>>, gamblers: Arc<Gamblers<C>>) -> Router {
    let http = Arc::new(Http {
        app,
        gamblers,
        per_ip: RateLimiter::new(IP_PER_SEC, IP_BURST),
        creates: RateLimiter::new(CREATE_PER_SEC, CREATE_BURST),
        rounds: RateLimiter::new(ROUNDS_PER_SEC, ROUNDS_PER_SEC),
    });
    Router::new()
        .route("/sessions", post(create::<C>))
        .route("/sessions/{id}", get(view::<C>))
        .route("/sessions/{id}/rounds", post(round::<C>))
        .route("/sessions/{id}/close", post(close::<C>))
        .route("/gamblers/floor", get(gamblers_floor::<C>))
        .route("/gamblers/footfall", get(footfall::<C>))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&http),
            limit_ip::<C>,
        ))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(CorsLayer::permissive())
        .with_state(http)
}

async fn limit_ip<C: Chain>(
    State(http): State<Arc<Http<C>>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    if !http.per_ip.allow(&addr.ip()) {
        return ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many requests").into_response();
    }
    next.run(request).await
}

fn bearer(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "missing bearer token"))
}

async fn create<C: Chain>(
    State(http): State<Arc<Http<C>>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(request): Json<CreateRequest>,
) -> Result<Json<CreateReply>, ApiError> {
    if !http.creates.allow(&addr.ip()) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too many new sessions",
        ));
    }
    http.app.create(request).await.map(Json)
}

async fn round<C: Chain>(
    State(http): State<Arc<Http<C>>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<RoundRequest>,
) -> Result<Json<RoundReply>, ApiError> {
    let token = bearer(&headers)?;
    if !http.rounds.allow(&(id.clone(), token.to_string())) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too many rounds",
        ));
    }
    http.app.play(&id, token, request).await.map(Json)
}

async fn view<C: Chain>(
    State(http): State<Arc<Http<C>>>,
    Path(id): Path<String>,
) -> Result<Json<SessionView>, ApiError> {
    http.app.view(&id).await.map(Json)
}

async fn close<C: Chain>(
    State(http): State<Arc<Http<C>>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<CloseReply>, ApiError> {
    let token = bearer(&headers)?;
    http.app.close(&id, token).await.map(Json)
}

async fn gamblers_floor<C: Chain>(State(http): State<Arc<Http<C>>>) -> Json<Vec<GamblerSnapshot>> {
    Json(http.gamblers.floor_snapshot())
}

#[derive(Deserialize)]
struct FootfallQuery {
    dealer_id: String,
}

async fn footfall<C: Chain>(
    State(http): State<Arc<Http<C>>>,
    Query(query): Query<FootfallQuery>,
) -> Result<Json<FootfallReply>, ApiError> {
    http.gamblers.footfall(&query.dealer_id).await.map(Json)
}
