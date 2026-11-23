//! Graph view settings, kept per account per vault: groups, display, forces and filters. Each account also saves
//! named presets for a vault, and can load anyone's presets for that vault (only their own can be changed).

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::CurrentUser,
    handlers::{
        edit::{check_csrf, ok, ApiErr, ApiResult},
        vaults::authorize,
    },
    AppState,
};

/// Largest settings object stored (20 groups with long values fit easily).
const MAX_SETTINGS_BYTES: usize = 32 * 1024;
/// Presets one account may have for one vault.
const MAX_PRESETS: i64 = 50;
const MAX_NAME: usize = 60;

fn check_settings(v: &Value) -> Result<String, ApiErr> {
    if !v.is_object() {
        return Err(ApiErr::Bad("Graph settings must be an object.".into()));
    }
    let s = v.to_string();
    if s.len() > MAX_SETTINGS_BYTES {
        return Err(ApiErr::TooLarge("These graph settings are too large to save.".into()));
    }
    Ok(s)
}

fn parse(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(json!({}))
}

/// The settings in use, the account's own presets, and everyone else's for this vault.
pub async fn get(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let current = st.db.graph_state(user.id, v.id.clone()).await?.map(|s| parse(&s));
    let presets = st.db.graph_presets(v.id).await?;
    let view = |p: &crate::db::GraphPreset| {
        json!({ "id": p.id, "name": p.name, "by": p.username, "settings": parse(&p.settings), "updatedAt": p.updated_at })
    };
    let mine: Vec<Value> = presets.iter().filter(|p| p.user_id == user.id).map(view).collect();
    let others: Vec<Value> = presets.iter().filter(|p| p.user_id != user.id).map(view).collect();
    ok(json!({ "current": current, "mine": mine, "others": others }))
}

#[derive(Deserialize)]
pub struct StateBody {
    settings: Value,
}

/// Save the settings in use (the graph page sends them a moment after each change).
pub async fn put(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(b): Json<StateBody>,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = check_settings(&b.settings)?;
    st.db.set_graph_state(user.id, v.id, s).await?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub struct PresetBody {
    name: String,
    settings: Value,
}

/// Save a preset (a preset of the same name of this account is replaced).
pub async fn save_preset(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(b): Json<PresetBody>,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let name: String = b.name.trim().chars().filter(|c| !c.is_control()).take(MAX_NAME).collect();
    if name.is_empty() {
        return Err(ApiErr::Bad("Give the preset a name.".into()));
    }
    let s = check_settings(&b.settings)?;
    match st.db.save_graph_preset(user.id, v.id, name.clone(), s, MAX_PRESETS).await? {
        Some(pid) => ok(json!({ "id": pid, "name": name })),
        None => Err(ApiErr::Bad(format!("You can have at most {MAX_PRESETS} presets for one vault. Delete one first."))),
    }
}

pub async fn delete_preset(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, pid)): Path<(String, i64)>,
    headers: HeaderMap,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    if !st.db.delete_graph_preset(user.id, v.id, pid).await? {
        return Err(ApiErr::NotFound);
    }
    ok(json!({ "ok": true }))
}
