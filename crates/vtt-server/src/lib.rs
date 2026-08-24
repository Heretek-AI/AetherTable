//! # vtt-server: Zero-Trust Authoritative Engine Gateway
//!
//! Library surface so integration tests exercise the exact production app
//! configuration (`configure_app` + `AuthMiddleware`).

pub mod auth;
pub mod persistence;
pub mod server;

pub use auth::{AuthIdentity, AuthMiddleware, AuthVerifier};
pub use server::{configure_app, AppState};
