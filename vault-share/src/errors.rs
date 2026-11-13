use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::templates::{render_status, MessagePage, PageCtx};

#[derive(Debug)]
pub enum AppError {
    NotFound,
    Forbidden(String),
    BadRequest(String),
    Internal(anyhow::Error),
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError::Internal(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, title, message) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "Not found", "That page does not exist, or you do not have access to it.".to_string()),
            AppError::Forbidden(m) => (StatusCode::FORBIDDEN, "Not allowed", m),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, "Something is not right", m),
            AppError::Internal(e) => {
                // Log details server-side only; never leak internals to the browser.
                tracing::error!("internal error: {e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Server error", "Something went wrong on our side. Please try again.".to_string())
            }
        };
        render_status(
            status,
            &MessagePage {
                page: PageCtx::anonymous(),
                title: title.to_string(),
                message,
                secret: None,
                back_href: "/".into(),
                back_label: "Back to start".into(),
            },
        )
    }
}

pub type AppResult<T = Response> = Result<T, AppError>;
