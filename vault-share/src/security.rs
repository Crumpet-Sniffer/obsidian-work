//! Response hardening headers and cross-site request blocking.

use axum::{
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::AppState;

pub const PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; \
    img-src 'self' data: https:; media-src 'self'; font-src 'self'; connect-src 'self'; \
    form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

/// CSP for user-uploaded files: even if an SVG/HTML-ish file is opened directly it runs
/// in a sandboxed, script-less opaque origin.
pub const FILE_CSP: &str =
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

fn set_if_absent(res: &mut Response, name: HeaderName, value: &'static str) {
    if !res.headers().contains_key(&name) {
        res.headers_mut().insert(name, HeaderValue::from_static(value));
    }
}

pub async fn security_headers(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    set_if_absent(&mut res, header::CONTENT_SECURITY_POLICY, PAGE_CSP);
    set_if_absent(&mut res, header::CACHE_CONTROL, "no-store");
    set_if_absent(&mut res, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set_if_absent(&mut res, header::X_FRAME_OPTIONS, "DENY");
    set_if_absent(&mut res, header::REFERRER_POLICY, "same-origin");
    set_if_absent(&mut res, HeaderName::from_static("cross-origin-opener-policy"), "same-origin");
    set_if_absent(&mut res, HeaderName::from_static("cross-origin-resource-policy"), "same-origin");
    set_if_absent(&mut res, HeaderName::from_static("x-robots-tag"), "noindex, nofollow");
    set_if_absent(
        &mut res,
        HeaderName::from_static("permissions-policy"),
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    );
    if st.cfg.cookie_secure {
        set_if_absent(&mut res, header::STRICT_TRANSPORT_SECURITY, "max-age=31536000");
    }
    res.headers_mut().remove(header::SERVER);
    res
}

/// Block state-changing requests that come from another site (defence in depth on top of
/// per-session CSRF tokens and SameSite cookies).
pub async fn origin_check(State(st): State<AppState>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    let headers = req.headers();

    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if site != "same-origin" && site != "none" {
            return blocked();
        }
    }

    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin = origin.to_str().unwrap_or("");
        let ok = match &st.cfg.public_origin {
            Some(expected) => origin.eq_ignore_ascii_case(expected),
            None => {
                let forwarded = st
                    .cfg
                    .trust_proxy
                    .then(|| headers.get("x-forwarded-host").and_then(|v| v.to_str().ok()))
                    .flatten();
                let host = forwarded.or_else(|| headers.get(header::HOST).and_then(|v| v.to_str().ok()));
                match (origin.split_once("://"), host) {
                    (Some((_, origin_host)), Some(host)) => origin_host.eq_ignore_ascii_case(host.trim()),
                    _ => false,
                }
            }
        };
        if !ok {
            return blocked();
        }
    }
    next.run(req).await
}

fn blocked() -> Response {
    tracing::warn!("blocked cross-origin state-changing request");
    (StatusCode::FORBIDDEN, "Cross-site request blocked.").into_response()
}
