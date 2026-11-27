//! IPC client for talking to the Go agent's broker over the local socket.
//!
//! Wire format and HMAC live in [`envelope`] and must match the Go
//! `agent/internal/ipc` package byte-for-byte.

pub mod caller_verify;
pub mod chat;
pub mod client;
pub mod connection_loss;
pub mod consent;
pub mod desktop;
pub mod envelope;
pub mod message;
pub mod notifications;
pub mod prompt;
pub mod server_identity_unix;
pub mod token;
pub mod transport;
