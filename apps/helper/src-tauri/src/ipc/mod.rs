//! IPC client for talking to the Go agent's broker over the local socket.
//!
//! Wire format and HMAC live in [`envelope`] and must match the Go
//! `agent/internal/ipc` package byte-for-byte.

pub mod envelope;
pub mod token;
pub mod transport;
// client added in later tasks
