use std::sync::Arc;
use tokio::sync::RwLock;

/// In-memory, updatable helper token. Never persisted to disk.
/// Cloneable handle: all clones share the same underlying cell.
#[derive(Clone, Default)]
pub struct HelperToken {
    inner: Arc<RwLock<Option<String>>>,
}

impl HelperToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the stored token.
    pub async fn set(&self, token: String) {
        *self.inner.write().await = Some(token);
    }

    /// Return a copy of the current token, or None if not yet received.
    pub async fn get(&self) -> Option<String> {
        self.inner.read().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn set_and_get() {
        let cell = HelperToken::new();
        assert_eq!(cell.get().await, None);
        cell.set("brz_a".into()).await;
        assert_eq!(cell.get().await.as_deref(), Some("brz_a"));
        cell.set("brz_b".into()).await;
        assert_eq!(cell.get().await.as_deref(), Some("brz_b"));
    }
}
