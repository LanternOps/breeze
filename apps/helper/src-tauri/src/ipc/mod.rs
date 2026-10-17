//! IPC client for talking to the Go agent's broker over the local socket.
//!
//! Wire format and HMAC live in [`envelope`] and must match the Go
//! `agent/internal/ipc` package byte-for-byte.

pub mod caller_verify;
pub mod chat;
pub mod client;
pub mod consent;
pub mod desktop;
pub mod envelope;
pub mod message;
pub mod token;
pub mod transport;
