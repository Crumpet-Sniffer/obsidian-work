use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Form,
};
use serde::Deserialize;

use crate::{
    auth::{self, ClientIp, CurrentUser},
    errors::AppResult,
    templates::{render, render_status, LoginPage, PageCtx, PasswordPage},
    AppState,
};

#[derive(Deserialize)]
pub struct NextQuery {
    #[serde(default)]
    next: String,
}

pub async fn login_page(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<NextQuery>) -> Response {
    if auth::lookup_session(&st, &headers).await.is_some() {
        return Redirect::to(auth::safe_next(&q.next).unwrap_or("/")).into_response();
    }
    render(&LoginPage {
        page: PageCtx::anonymous(),
        error: None,
        username: String::new(),
        next: auth::safe_next(&q.next).unwrap_or("").to_string(),
    })
}

#[derive(Deserialize)]
pub struct LoginForm {
    username: String,
    password: String,
    #[serde(default)]
    next: String,
}

pub async fn login_submit(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Form(f): Form<LoginForm>,
) -> AppResult {
    let username: String = f.username.trim().chars().take(64).collect();
    let next = auth::safe_next(&f.next).unwrap_or("").to_string();
    let fail_page = |status: StatusCode, msg: &str| {
        render_status(
            status,
            &LoginPage { page: PageCtx::anonymous(), error: Some(msg.into()), username: username.clone(), next: next.clone() },
        )
    };

    let ip_key = format!("ip:{ip}");
    let user_key = format!("user:{}", username.to_lowercase());
    if let Some(wait) = st.limiter.locked(&ip_key).or_else(|| st.limiter.locked(&user_key)) {
        st.db.audit(None, Some(ip.clone()), "login_throttled", username.clone()).await;
        let mins = wait.as_secs().div_ceil(60).max(1);
        return Ok(fail_page(
            StatusCode::TOO_MANY_REQUESTS,
            &format!("Too many failed sign-in attempts. Try again in {mins} minute(s)."),
        ));
    }

    let user = if username.is_empty() || f.password.len() > auth::MAX_PASSWORD_LEN {
        None
    } else {
        st.db.get_user_by_name(username.clone()).await?
    };
    // Always run one Argon2 verification so timing does not reveal valid usernames.
    let hash = user.as_ref().map(|u| u.password_hash.clone()).unwrap_or_else(|| auth::dummy_hash().to_string());
    let valid = auth::verify_password_async(f.password, hash).await;

    let user = match user {
        Some(u) if valid && !u.disabled => u,
        _ => {
            st.limiter.fail(&ip_key, auth::MAX_FAILS_PER_IP);
            st.limiter.fail(&user_key, auth::MAX_FAILS_PER_USER);
            st.db.audit(None, Some(ip), "login_failed", username.clone()).await;
            return Ok(fail_page(StatusCode::UNAUTHORIZED, "Incorrect username or password."));
        }
    };
    st.limiter.reset(&user_key);

    // Fresh random token on every login (prevents session fixation); only its hash is stored.
    let token = auth::random_token(32);
    let ua: String = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect();
    st.db
        .create_session(auth::sha256_hex(&token), user.id, auth::random_token(32), ip.clone(), ua)
        .await?;
    st.db.touch_login(user.id).await?;
    st.db.audit(Some((user.id, user.username.clone())), Some(ip), "login", String::new()).await;

    let dest = if user.must_change_password {
        "/account/password".to_string()
    } else if next.is_empty() {
        "/".to_string()
    } else {
        next
    };
    let mut res = Redirect::to(&dest).into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, auth::session_cookie(&st.cfg, &token, st.cfg.session_max_secs));
    Ok(res)
}

#[derive(Deserialize)]
pub struct CsrfForm {
    pub csrf: String,
}

pub async fn logout(State(st): State<AppState>, ClientIp(ip): ClientIp, user: CurrentUser, Form(f): Form<CsrfForm>) -> AppResult {
    user.check_csrf(&f.csrf)?;
    st.db.delete_session(user.session_hash.clone()).await?;
    st.db.audit(user.audit_id(), Some(ip), "logout", String::new()).await;
    let mut res = Redirect::to("/login").into_response();
    res.headers_mut().insert(header::SET_COOKIE, auth::clear_session_cookie(&st.cfg));
    Ok(res)
}

fn password_page(user: &CurrentUser, error: Option<String>, status: StatusCode) -> Response {
    render_status(
        status,
        &PasswordPage {
            page: PageCtx::for_user(user),
            csrf: user.csrf.clone(),
            error,
            forced: user.must_change_password,
            min_len: auth::MIN_PASSWORD_LEN,
        },
    )
}

pub async fn password_form(user: CurrentUser) -> Response {
    password_page(&user, None, StatusCode::OK)
}

#[derive(Deserialize)]
pub struct PasswordForm {
    csrf: String,
    current: String,
    new_password: String,
    confirm: String,
}

pub async fn password_submit(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Form(f): Form<PasswordForm>,
) -> AppResult {
    user.check_csrf(&f.csrf)?;
    let user_key = format!("user:{}", user.username.to_lowercase());
    if st.limiter.locked(&user_key).is_some() {
        return Ok(password_page(&user, Some("Too many failed attempts. Try again later.".into()), StatusCode::TOO_MANY_REQUESTS));
    }
    let Some(row) = st.db.get_user(user.id).await? else {
        return Ok(Redirect::to("/login").into_response());
    };
    if f.current.len() > auth::MAX_PASSWORD_LEN || !auth::verify_password_async(f.current.clone(), row.password_hash).await {
        st.limiter.fail(&user_key, auth::MAX_FAILS_PER_USER);
        st.db.audit(user.audit_id(), Some(ip), "password_change_failed", String::new()).await;
        return Ok(password_page(&user, Some("Your current password is incorrect.".into()), StatusCode::UNAUTHORIZED));
    }
    if f.new_password != f.confirm {
        return Ok(password_page(&user, Some("The new passwords do not match.".into()), StatusCode::BAD_REQUEST));
    }
    if f.new_password == f.current {
        return Ok(password_page(&user, Some("Choose a password you have not used here before.".into()), StatusCode::BAD_REQUEST));
    }
    if let Err(msg) = auth::validate_new_password(&f.new_password, &user.username) {
        return Ok(password_page(&user, Some(msg), StatusCode::BAD_REQUEST));
    }
    let hash = auth::hash_password_async(f.new_password).await?;
    st.db.set_password(user.id, hash, false).await?;
    // Sign out every other device.
    st.db.delete_user_sessions(user.id, Some(user.session_hash.clone())).await?;
    st.db.audit(user.audit_id(), Some(ip), "password_changed", String::new()).await;
    Ok(Redirect::to("/").into_response())
}
