use futures_util::StreamExt;
use reqwest::{header::HeaderMap, Client, Identity, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Agent config types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AgentConfig {
    pub api_url: String,
    pub token: String,
    pub agent_id: String,
    pub has_mtls: bool,
}

/// Internal struct that also holds the raw PEM material (never sent to frontend).
#[derive(Debug, Clone)]
struct AgentConfigFull {
    api_url: String,
    token: String,
    agent_id: String,
    mtls_cert_pem: Option<String>,
    mtls_key_pem: Option<String>,
}

// ---------------------------------------------------------------------------
// Platform-specific config path
// ---------------------------------------------------------------------------

fn agent_config_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/Breeze/agent.yaml")
    }
    #[cfg(target_os = "windows")]
    {
        let program_data =
            std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
        PathBuf::from(program_data).join("Breeze").join("agent.yaml")
    }
    #[cfg(target_os = "linux")]
    {
        PathBuf::from("/etc/breeze/agent.yaml")
    }
}

/// Parse the agent YAML config from disk.
fn load_agent_config_full() -> Result<AgentConfigFull, String> {
    let path = agent_config_path();

    let contents = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "Failed to read agent config at {}: {}",
            path.display(),
            e
        )
    })?;

    let yaml: serde_yaml::Value = serde_yaml::from_str(&contents)
        .map_err(|e| format!("Failed to parse agent config: {}", e))?;

    let api_url = yaml
        .get("api_url")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'api_url' in agent config")?
        .to_string();

    let token = yaml
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'token' in agent config")?
        .to_string();

    let agent_id = yaml
        .get("agent_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'agent_id' in agent config")?
        .to_string();

    let mtls_cert_pem = yaml
        .get("mtls_cert_pem")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    let mtls_key_pem = yaml
        .get("mtls_key_pem")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    Ok(AgentConfigFull {
        api_url,
        token,
        agent_id,
        mtls_cert_pem,
        mtls_key_pem,
    })
}

// ---------------------------------------------------------------------------
// HTTP client state (cached per-app)
// ---------------------------------------------------------------------------

struct HttpClientState {
    client: Client,
    config: AgentConfigFull,
}

/// Global singleton for the HTTP client + config.
/// We use OnceLock<Mutex<Option<...>>> so the first call to helper_fetch or
/// read_agent_config lazily initializes it, and it can be rebuilt if needed.
static HTTP_STATE: OnceLock<Mutex<Option<HttpClientState>>> = OnceLock::new();

fn get_http_state_lock() -> &'static Mutex<Option<HttpClientState>> {
    HTTP_STATE.get_or_init(|| Mutex::new(None))
}

/// Build a reqwest::Client, optionally with mTLS identity.
fn build_client(cfg: &AgentConfigFull) -> Result<Client, String> {
    let mut builder = Client::builder().use_rustls_tls();

    if let (Some(cert_pem), Some(key_pem)) = (&cfg.mtls_cert_pem, &cfg.mtls_key_pem) {
        // reqwest Identity expects PEM with both cert and key concatenated.
        let combined_pem = format!("{}\n{}", cert_pem, key_pem);
        let identity = Identity::from_pem(combined_pem.as_bytes())
            .map_err(|e| format!("Failed to build mTLS identity: {}", e))?;
        builder = builder.identity(identity);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Ensure the HTTP state is initialized, returning a reference. Caller holds the mutex guard.
async fn ensure_http_state() -> Result<(), String> {
    let lock = get_http_state_lock();
    let mut guard = lock.lock().await;
    if guard.is_none() {
        let cfg = load_agent_config_full()?;
        let client = build_client(&cfg)?;
        *guard = Some(HttpClientState { client, config: cfg });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Window helpers (tray integration)
// ---------------------------------------------------------------------------

/// Show the main window and bring it to focus.
fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.show() {
            eprintln!("[helper] Failed to show window: {}", e);
        }
        if let Err(e) = window.set_focus() {
            eprintln!("[helper] Failed to focus window: {}", e);
        }
    }
}

/// Hide the main window (back to tray-only mode).
#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.hide() {
            eprintln!("[helper] Failed to hide window: {}", e);
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn read_agent_config() -> Result<AgentConfig, String> {
    // Also initializes the HTTP client as a side effect.
    ensure_http_state().await?;

    let lock = get_http_state_lock();
    let guard = lock.lock().await;
    let state = guard.as_ref().unwrap();

    Ok(AgentConfig {
        api_url: state.config.api_url.clone(),
        token: state.config.token.clone(),
        agent_id: state.config.agent_id.clone(),
        has_mtls: state.config.mtls_cert_pem.is_some() && state.config.mtls_key_pem.is_some(),
    })
}

// -- helper_fetch types -----------------------------------------------------

#[derive(Debug, Deserialize)]
struct HelperFetchRequest {
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    /// When true, the response body is streamed as Tauri events instead of
    /// being returned in the response. Each chunk is emitted under the event
    /// name `helper-fetch-stream` with a unique `stream_id`.
    stream: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
struct HelperFetchResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
    /// Populated only when `stream: true` was requested. The frontend should
    /// listen for `helper-fetch-stream` events with this `stream_id`.
    stream_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct StreamChunkEvent {
    stream_id: String,
    /// Base-64-encoded chunk of bytes, or null if this is the terminal event.
    chunk: Option<String>,
    /// True when this is the final event for this stream.
    done: bool,
    /// Non-null when an error occurred while reading the stream.
    error: Option<String>,
}

#[tauri::command]
async fn helper_fetch(
    app: AppHandle,
    request: HelperFetchRequest,
) -> Result<HelperFetchResponse, String> {
    ensure_http_state().await?;

    let (client, token, api_url) = {
        let lock = get_http_state_lock();
        let guard = lock.lock().await;
        let state = guard.as_ref().unwrap();
        (state.client.clone(), state.config.token.clone(), state.config.api_url.clone())
    };

    // Validate that the request URL targets the configured API server.
    // This prevents SSRF and token leakage to arbitrary hosts.
    if !request.url.starts_with(&api_url) {
        return Err(format!(
            "Request URL must start with the configured API URL ({})",
            api_url
        ));
    }

    // Build the request
    let method: Method = request
        .method
        .as_deref()
        .unwrap_or("GET")
        .parse()
        .map_err(|e| format!("Invalid HTTP method: {}", e))?;

    let mut req_builder = client.request(method, &request.url);

    // Apply caller-specified headers (excluding Authorization which is always set by us)
    if let Some(hdrs) = &request.headers {
        let mut header_map = HeaderMap::new();
        for (k, v) in hdrs {
            // Prevent overriding the Authorization header
            if k.eq_ignore_ascii_case("authorization") {
                continue;
            }
            let name = k
                .parse::<reqwest::header::HeaderName>()
                .map_err(|e| format!("Invalid header name '{}': {}", k, e))?;
            let val = v
                .parse::<reqwest::header::HeaderValue>()
                .map_err(|e| format!("Invalid header value for '{}': {}", k, e))?;
            header_map.insert(name, val);
        }
        req_builder = req_builder.headers(header_map);
    }

    // Set Authorization header last so it cannot be overridden
    req_builder = req_builder.header("Authorization", format!("Bearer {}", token));

    if let Some(body) = &request.body {
        req_builder = req_builder.body(body.clone());
    }

    let response = req_builder
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status().as_u16();

    // Collect response headers
    let mut resp_headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(v) = value.to_str() {
            resp_headers.insert(name.to_string(), v.to_string());
        }
    }

    let wants_stream = request.stream.unwrap_or(false);
    let is_success = status >= 200 && status < 300;

    if wants_stream && is_success {
        // Stream mode: emit chunks via Tauri events.
        // Only stream on success; error responses are returned inline so
        // the frontend can inspect the body synchronously.
        let stream_id = format!("stream-{}", uuid_v4());

        let sid = stream_id.clone();
        let app_clone = app.clone();

        // Spawn a background task to read the body and emit events
        tauri::async_runtime::spawn(async move {
            let mut byte_stream = response.bytes_stream();

            while let Some(chunk_result) = byte_stream.next().await {
                match chunk_result {
                    Ok(bytes) => {
                        // Send as UTF-8 text. SSE data is always text.
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        let event = StreamChunkEvent {
                            stream_id: sid.clone(),
                            chunk: Some(text),
                            done: false,
                            error: None,
                        };
                        if let Err(e) = app_clone.emit("helper-fetch-stream", &event) {
                            eprintln!("[helper] Failed to emit stream chunk: {}", e);
                        }
                    }
                    Err(e) => {
                        let event = StreamChunkEvent {
                            stream_id: sid.clone(),
                            chunk: None,
                            done: true,
                            error: Some(format!("Stream read error: {}", e)),
                        };
                        if let Err(e) = app_clone.emit("helper-fetch-stream", &event) {
                            eprintln!("[helper] Failed to emit stream error event: {}", e);
                        }
                        return;
                    }
                }
            }

            // Terminal event
            let event = StreamChunkEvent {
                stream_id: sid.clone(),
                chunk: None,
                done: true,
                error: None,
            };
            if let Err(e) = app_clone.emit("helper-fetch-stream", &event) {
                eprintln!("[helper] Failed to emit stream done event: {}", e);
            }
        });

        Ok(HelperFetchResponse {
            status,
            headers: resp_headers,
            body: String::new(),
            stream_id: Some(stream_id),
        })
    } else {
        // Non-stream mode: read full body
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {}", e))?;

        Ok(HelperFetchResponse {
            status,
            headers: resp_headers,
            body,
            stream_id: None,
        })
    }
}

/// Simple v4 UUID generator (avoids pulling in the `uuid` crate).
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // Mix nanos with a counter for uniqueness within the same nanosecond
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let val = nanos ^ (count as u128);
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (val >> 96) as u32,
        (val >> 80) as u16 & 0xFFFF,
        (val >> 64) as u16 & 0x0FFF,
        ((val >> 48) as u16 & 0x3FFF) | 0x8000,
        val as u64 & 0xFFFF_FFFF_FFFF,
    )
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![read_agent_config, helper_fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
