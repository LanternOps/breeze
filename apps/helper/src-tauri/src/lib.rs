use futures_util::StreamExt;
use reqwest::{header::HeaderMap, Client, Identity, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, Emitter, Manager, TitleBarStyle};
use tauri_plugin_shell::open;
use tokio::sync::Mutex;

/// Tracks whether a chat session is currently active (set from frontend).
static CHAT_ACTIVE: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Agent config types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AgentConfig {
    pub api_url: String,
    pub agent_id: String,
    pub has_mtls: bool,
    pub os_username: String,
    pub helper_version: String,
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
        PathBuf::from(program_data)
            .join("Breeze")
            .join("agent.yaml")
    }
    #[cfg(target_os = "linux")]
    {
        PathBuf::from("/etc/breeze/agent.yaml")
    }
}

/// Log a message to the Breeze helper log file.
/// In SYSTEM service context, stderr is not connected to anything visible,
/// so we append to a log file in the Breeze data directory instead.
fn log_helper_error(msg: &str) {
    eprintln!("{}", msg); // still try stderr for non-service contexts
    let log_path = agent_config_path().with_file_name("helper.log");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

fn helper_token_from_config(
    yaml: &serde_yaml::Value,
    secrets: Option<&serde_yaml::Value>,
) -> Option<String> {
    secrets
        .and_then(|s| s.get("helper_auth_token"))
        .and_then(|v| v.as_str())
        .or_else(|| yaml.get("helper_auth_token").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Parse the agent YAML config from disk.
fn load_agent_config_full() -> Result<AgentConfigFull, String> {
    let path = agent_config_path();

    let contents = std::fs::read_to_string(&path).map_err(|e| {
        log_helper_error(&format!("agent config not found at {}: {}", path.display(), e));
        "Breeze Assist requires the Breeze agent. Ensure the Breeze agent is installed and running on this device.".to_string()
    })?;

    let yaml: serde_yaml::Value = serde_yaml::from_str(&contents).map_err(|e| {
        log_helper_error(&format!(
            "failed to parse agent config at {}: {}",
            path.display(),
            e
        ));
        "Agent configuration is corrupt. Reinstall the Breeze agent or contact your administrator."
            .to_string()
    })?;

    let api_url = yaml
        .get("server_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            log_helper_error("missing required field 'server_url' in agent config");
            "Agent configuration is incomplete. The agent may still be enrolling \u{2014} wait a moment and retry.".to_string()
        })?
        .to_string();

    // Read secrets from secrets.yaml for mTLS material only. The helper uses
    // a helper-scoped token from agent.yaml and must never fall back to the
    // full agent bearer token.
    let secrets_path = path.with_file_name("secrets.yaml");
    let secrets: Option<serde_yaml::Value> = std::fs::read_to_string(&secrets_path)
        .ok()
        .and_then(|s| serde_yaml::from_str(&s).ok());

    let token = helper_token_from_config(&yaml, secrets.as_ref()).ok_or_else(|| {
        log_helper_error("missing helper_auth_token in agent config");
        "The Breeze agent is still setting up. Wait a moment and retry, or contact your administrator.".to_string()
    })?;

    let agent_id = yaml
        .get("agent_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            log_helper_error("missing required field 'agent_id' in agent config");
            "Agent configuration is incomplete. The agent may still be enrolling \u{2014} wait a moment and retry.".to_string()
        })?
        .to_string();

    let mtls_cert_pem = secrets
        .as_ref()
        .and_then(|s| s.get("mtls_cert_pem"))
        .and_then(|v| v.as_str())
        .or_else(|| yaml.get("mtls_cert_pem").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    let mtls_key_pem = secrets
        .as_ref()
        .and_then(|s| s.get("mtls_key_pem"))
        .and_then(|v| v.as_str())
        .or_else(|| yaml.get("mtls_key_pem").and_then(|v| v.as_str()))
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
// Helper config (written by Go agent, read by Tauri)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HelperConfig {
    #[serde(default = "default_true")]
    show_open_portal: bool,
    #[serde(default = "default_true")]
    show_device_info: bool,
    #[serde(default = "default_true")]
    show_request_support: bool,
    #[serde(default)]
    portal_url: Option<String>,
    #[serde(default)]
    device_name: Option<String>,
    #[serde(default)]
    device_status: Option<String>,
    #[serde(default)]
    last_checkin: Option<String>,
}

fn default_true() -> bool {
    true
}

impl Default for HelperConfig {
    fn default() -> Self {
        Self {
            show_open_portal: true,
            show_device_info: true,
            show_request_support: true,
            portal_url: None,
            device_name: None,
            device_status: None,
            last_checkin: None,
        }
    }
}

fn helper_config_path() -> PathBuf {
    agent_config_path().with_file_name("helper_config.yaml")
}

fn load_helper_config() -> HelperConfig {
    let path = helper_config_path();
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_yaml::from_str(&contents).unwrap_or_default(),
        Err(_) => HelperConfig::default(),
    }
}

fn load_agent_server_url() -> Result<String, String> {
    let path = agent_config_path();
    let contents = std::fs::read_to_string(&path).map_err(|e| {
        log_helper_error(&format!(
            "agent config not found at {}: {}",
            path.display(),
            e
        ));
        "Breeze agent configuration is unavailable.".to_string()
    })?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&contents).map_err(|e| {
        log_helper_error(&format!(
            "failed to parse agent config at {}: {}",
            path.display(),
            e
        ));
        "Agent configuration is corrupt.".to_string()
    })?;
    yaml.get("server_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            log_helper_error("missing required field 'server_url' in agent config");
            "Agent configuration is incomplete.".to_string()
        })
}

// ---------------------------------------------------------------------------
// Helper status file (read by Go agent for idle detection before updates)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct HelperStatus {
    version: String,
    chat_active: bool,
    last_activity: String, // ISO 8601
    pid: u32,
}

fn helper_status_path() -> PathBuf {
    agent_config_path().with_file_name("helper_status.yaml")
}

fn write_status_file(chat_active: bool) {
    let status = HelperStatus {
        version: env!("CARGO_PKG_VERSION").to_string(),
        chat_active,
        last_activity: chrono::Utc::now().to_rfc3339(),
        pid: std::process::id(),
    };
    let path = helper_status_path();
    if let Ok(yaml) = serde_yaml::to_string(&status) {
        // Atomic write: temp file + rename
        let tmp_path = path.with_extension("yaml.tmp");
        if std::fs::write(&tmp_path, &yaml).is_ok() {
            let _ = std::fs::rename(&tmp_path, &path);
        }
    }
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
        *guard = Some(HttpClientState {
            client,
            config: cfg,
        });
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

/// Minimize the main window.
#[tauri::command]
fn minimize_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.minimize() {
            eprintln!("[helper] Failed to minimize window: {}", e);
        }
    }
}

/// Update the helper status file when chat activity changes.
/// Called from the frontend when a chat session starts/ends or on message activity.
#[tauri::command]
fn update_chat_active(active: bool) {
    CHAT_ACTIVE.store(active, Ordering::Relaxed);
    write_status_file(active);
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
    let state = guard
        .as_ref()
        .ok_or_else(|| "HTTP state not initialized".to_string())?;

    Ok(AgentConfig {
        api_url: state.config.api_url.clone(),
        agent_id: state.config.agent_id.clone(),
        has_mtls: state.config.mtls_cert_pem.is_some() && state.config.mtls_key_pem.is_some(),
        os_username: get_os_username(),
        helper_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
fn get_os_username() -> String {
    // When running as SYSTEM (spawned by agent service), whoami returns "SYSTEM".
    // Fall back to the USERNAME environment variable which is set to the
    // logged-in user's name even for SYSTEM processes in user sessions.
    let name = whoami::username();
    if name.eq_ignore_ascii_case("system") || name.ends_with('$') {
        if let Ok(env_user) = std::env::var("USERNAME") {
            if !env_user.is_empty()
                && !env_user.eq_ignore_ascii_case("system")
                && !env_user.ends_with('$')
            {
                return env_user;
            }
        }
    }
    name
}

#[tauri::command]
fn get_helper_config() -> HelperConfig {
    load_helper_config()
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

fn request_url_allowed(api_url: &str, request_url: &str) -> Result<(), String> {
    let base = reqwest::Url::parse(api_url)
        .map_err(|e| format!("Configured API URL is invalid: {}", e))?;
    let requested =
        reqwest::Url::parse(request_url).map_err(|e| format!("Request URL is invalid: {}", e))?;

    if base.scheme() != "https" && base.scheme() != "http" {
        return Err("Configured API URL must use http or https".to_string());
    }

    if requested.username() != "" || requested.password().is_some() {
        return Err("Request URL must not contain credentials".to_string());
    }

    let same_origin = base.scheme() == requested.scheme()
        && base.host_str() == requested.host_str()
        && base.port_or_known_default() == requested.port_or_known_default();
    if !same_origin {
        return Err(format!(
            "Request URL must target the configured API origin ({})",
            base.origin().ascii_serialization()
        ));
    }

    let base_path = base.path();
    if base_path != "/" {
        let request_path = requested.path();
        if path_has_dot_segment(request_path) {
            return Err("Request URL path must not contain dot segments".to_string());
        }
        let in_base_path = if base_path.ends_with('/') {
            request_path.starts_with(base_path)
        } else {
            request_path == base_path || request_path.starts_with(&format!("{}/", base_path))
        };
        if !in_base_path {
            return Err(format!(
                "Request URL path must stay under the configured API base path ({})",
                base_path
            ));
        }
    }

    Ok(())
}

fn path_has_dot_segment(path: &str) -> bool {
    path.split('/').any(|segment| {
        let segment = segment.to_ascii_lowercase();
        matches!(
            segment.as_str(),
            "." | ".." | "%2e" | ".%2e" | "%2e." | "%2e%2e"
        )
    })
}

fn host_is_breeze_portal(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "breezermm.com"
        || host.ends_with(".breezermm.com")
        || host == "2breeze.app"
        || host.ends_with(".2breeze.app")
}

fn same_https_origin(left: &reqwest::Url, right: &reqwest::Url) -> bool {
    left.scheme() == "https"
        && right.scheme() == "https"
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn validate_portal_open_url(portal_url: &str, api_url: Option<&str>) -> Result<String, String> {
    let requested =
        reqwest::Url::parse(portal_url).map_err(|e| format!("Portal URL is invalid: {}", e))?;

    if requested.scheme() != "https" {
        return Err("Portal URL must use https".to_string());
    }
    if requested.username() != "" || requested.password().is_some() {
        return Err("Portal URL must not contain credentials".to_string());
    }

    let host = requested
        .host_str()
        .ok_or_else(|| "Portal URL must include a host".to_string())?;

    if host_is_breeze_portal(host) {
        return Ok(requested.to_string());
    }

    if let Some(api_url) = api_url {
        if let Ok(api) = reqwest::Url::parse(api_url) {
            if api.username() == ""
                && api.password().is_none()
                && same_https_origin(&requested, &api)
            {
                return Ok(requested.to_string());
            }
        }
    }

    Err("Portal URL must target an approved Breeze portal origin".to_string())
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
        let state = guard
            .as_ref()
            .ok_or_else(|| "HTTP state not initialized".to_string())?;
        (
            state.client.clone(),
            state.config.token.clone(),
            state.config.api_url.clone(),
        )
    };

    // Validate that the request URL targets the configured API server.
    // This prevents SSRF and token leakage to arbitrary hosts.
    request_url_allowed(&api_url, &request.url)?;

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

    let response = req_builder.send().await.map_err(|e| {
        log_helper_error(&format!("HTTP request to {} failed: {}", request.url, e));
        "Cannot connect to the Breeze server. Check your network connection.".to_string()
    })?;

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

        // Spawn a background task to read the body and emit events.
        // Small delay to ensure the frontend listener is registered before
        // we start emitting events (avoids race with IPC round-trip).
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
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
// Tray menu builder
// ---------------------------------------------------------------------------

fn build_tray_menu(
    app: &AppHandle,
    config: &HelperConfig,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let mut builder = MenuBuilder::new(app);

    if config.show_request_support {
        let item = MenuItemBuilder::with_id("request_support", "Request Support").build(app)?;
        builder = builder.item(&item);
    }

    if config.show_open_portal {
        let item = MenuItemBuilder::with_id("open_portal", "Open Breeze Portal").build(app)?;
        builder = builder.item(&item);
    }

    if config.show_device_info {
        let item = MenuItemBuilder::with_id("device_info", "Device Info").build(app)?;
        builder = builder.item(&item);
    }

    builder = builder.separator();

    let exit_item = MenuItemBuilder::with_id("exit", "Exit").build(app)?;
    builder = builder.item(&exit_item);

    builder.build()
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            read_agent_config,
            helper_fetch,
            hide_window,
            minimize_window,
            get_os_username,
            get_helper_config,
            update_chat_active,
        ])
        .setup(|app| {
            // Create main window manually (not from config) so we can set
            // a custom WebView2 data directory when running as SYSTEM.
            // The agent service spawns this process with a SYSTEM token
            // (session ID overridden to the user's session), causing WebView2's
            // default data path to resolve to the SYSTEM profile directory
            // (systemprofile\AppData\Local) which may not exist or be accessible
            // when running in a user session rather than Session 0.
            let wb = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Breeze Helper")
            .inner_size(380.0, 600.0)
            .resizable(true)
            .center();

            // macOS: native traffic light buttons with overlay titlebar, hidden native title
            #[cfg(target_os = "macos")]
            let wb = wb
                .decorations(true)
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true);

            // Windows/Linux: frameless with custom HTML buttons
            #[cfg(not(target_os = "macos"))]
            let mut wb = wb.decorations(false);

            #[cfg(target_os = "windows")]
            {
                let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
                if local.to_lowercase().contains("systemprofile") || local.is_empty() {
                    let pd =
                        std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
                    let data_dir = PathBuf::from(pd).join("Breeze").join("helper-webview");
                    if let Err(e) = std::fs::create_dir_all(&data_dir) {
                        let msg = format!(
                            "[helper] Failed to create WebView2 data dir {}: {}",
                            data_dir.display(),
                            e
                        );
                        log_helper_error(&msg);
                        return Err(msg.into());
                    }
                    log_helper_error(&format!(
                        "[helper] SYSTEM context detected, WebView2 data dir: {}",
                        data_dir.display()
                    ));
                    wb = wb.data_directory(data_dir);
                }
            }

            let window = wb.build().map_err(|e| {
                let msg = format!("[helper] Failed to create main window: {}", e);
                log_helper_error(&msg);
                e
            })?;

            // Intercept window close to hide instead of destroy.
            // Preserves React state and allows re-showing from tray.
            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(e) = close_window.hide() {
                        eprintln!("[helper] Failed to hide window on close: {}", e);
                    }
                }
            });

            let handle = app.handle().clone();

            // Load initial config and build tray context menu
            let config = load_helper_config();
            if let Some(tray) = app.tray_by_id("main") {
                // Set tray tooltip with version
                let _ = tray.set_tooltip(Some(&format!(
                    "Breeze Helper v{}",
                    env!("CARGO_PKG_VERSION")
                )));

                // Build and set the context menu (shown on right-click)
                match build_tray_menu(&handle, &config) {
                    Ok(menu) => {
                        if let Err(e) = tray.set_menu(Some(menu)) {
                            eprintln!("[helper] Failed to set tray menu: {}", e);
                        }
                    }
                    Err(e) => eprintln!("[helper] Failed to build tray menu: {}", e),
                }

                // Handle left-click only: show chat window
                // Matching all Click variants (including right-click) would steal
                // focus from the context menu on Windows, causing it to close instantly.
                let click_handle = handle.clone();
                tray.on_tray_icon_event(move |_tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(&click_handle);
                    }
                });
            }

            // Write initial status file (not chatting)
            write_status_file(false);

            // Handle menu item clicks
            let menu_handle = handle.clone();
            app.on_menu_event(move |app_handle, event| match event.id().as_ref() {
                "request_support" => {
                    show_window(&menu_handle);
                }
                "open_portal" => {
                    let config = load_helper_config();
                    let agent_api_url = load_agent_server_url().ok();
                    let url = config
                        .portal_url
                        .filter(|u| !u.is_empty())
                        .or_else(|| agent_api_url.clone());
                    if let Some(url) = url {
                        match validate_portal_open_url(&url, agent_api_url.as_deref()) {
                            Ok(safe_url) => {
                                let _ = tauri_plugin_shell::ShellExt::shell(app_handle)
                                    .open(&safe_url, None::<open::Program>);
                            }
                            Err(e) => {
                                log_helper_error(&format!(
                                    "[helper] Refusing to open unsafe portal URL: {}",
                                    e
                                ));
                            }
                        }
                    }
                }
                "device_info" => {
                    if let Err(e) = menu_handle.emit("show-device-info", ()) {
                        eprintln!("[helper] Failed to emit show-device-info: {}", e);
                    }
                    show_window(&menu_handle);
                }
                "exit" => {
                    app_handle.exit(0);
                }
                _ => {}
            });

            // Periodic config reload — rebuild tray menu every 60s on config change
            let reload_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut last_config =
                    serde_yaml::to_string(&load_helper_config()).unwrap_or_default();
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let new_config = load_helper_config();
                    let new_yaml = serde_yaml::to_string(&new_config).unwrap_or_default();
                    if new_yaml != last_config {
                        eprintln!("[helper] Config changed, rebuilding tray menu");
                        if let Some(tray) = reload_handle.tray_by_id("main") {
                            match build_tray_menu(&reload_handle, &new_config) {
                                Ok(menu) => {
                                    if let Err(e) = tray.set_menu(Some(menu)) {
                                        eprintln!("[helper] Failed to update tray menu: {}", e);
                                    }
                                }
                                Err(e) => eprintln!("[helper] Failed to rebuild tray menu: {}", e),
                            }
                        }
                        last_config = new_yaml;
                    }

                    // Refresh status file timestamp (shows helper is alive even when idle)
                    write_status_file(CHAT_ACTIVE.load(Ordering::Relaxed));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_agent_config_omits_bearer_token() {
        let config = AgentConfig {
            api_url: "https://api.example.test".to_string(),
            agent_id: "agent-1".to_string(),
            has_mtls: true,
            os_username: "alice".to_string(),
            helper_version: "test".to_string(),
        };

        let value = serde_json::to_value(config).expect("serialize agent config");
        assert!(value.get("token").is_none());
        assert_eq!(value["api_url"], "https://api.example.test");
        assert_eq!(value["agent_id"], "agent-1");
    }

    #[test]
    fn helper_token_does_not_fallback_to_full_agent_token() {
        let yaml: serde_yaml::Value = serde_yaml::from_str(
            r#"
server_url: https://api.example.test
agent_id: agent-1
auth_token: brz_full_agent
"#,
        )
        .expect("parse yaml");

        assert_eq!(helper_token_from_config(&yaml, None), None);
    }

    #[test]
    fn helper_token_prefers_helper_scoped_secret() {
        let yaml: serde_yaml::Value = serde_yaml::from_str(
            r#"
server_url: https://api.example.test
agent_id: agent-1
helper_auth_token: brz_helper_agent_yaml
"#,
        )
        .expect("parse yaml");
        let secrets: serde_yaml::Value = serde_yaml::from_str(
            r#"
auth_token: brz_full_agent
helper_auth_token: brz_helper_secret
"#,
        )
        .expect("parse secrets");

        assert_eq!(
            helper_token_from_config(&yaml, Some(&secrets)).as_deref(),
            Some("brz_helper_secret")
        );
    }

    #[test]
    fn request_url_allows_same_origin_and_base_path() {
        assert!(request_url_allowed(
            "https://api.example.test/rmm",
            "https://api.example.test/rmm/api/v1/helper/chat"
        )
        .is_ok());

        assert!(request_url_allowed(
            "https://api.example.test:8443/",
            "https://api.example.test:8443/api/v1/helper/chat"
        )
        .is_ok());

        assert!(request_url_allowed(
            "http://localhost:3001/",
            "http://localhost:3001/api/v1/helper/chat"
        )
        .is_ok());

        assert!(request_url_allowed(
            "https://API.example.test/",
            "https://api.EXAMPLE.test/api/v1/helper/chat"
        )
        .is_ok());
    }

    #[test]
    fn request_url_rejects_sibling_domains_and_scheme_mismatch() {
        assert!(request_url_allowed(
            "https://api.example.test",
            "https://api.example.test.evil.invalid/api/v1/helper/chat"
        )
        .is_err());

        assert!(request_url_allowed(
            "https://api.example.test",
            "http://api.example.test/api/v1/helper/chat"
        )
        .is_err());

        assert!(request_url_allowed(
            "https://api.example.test:8443",
            "https://api.example.test/api/v1/helper/chat"
        )
        .is_err());
    }

    #[test]
    fn request_url_rejects_userinfo_and_base_path_escape() {
        assert!(request_url_allowed(
            "https://api.example.test",
            "https://user:pass@api.example.test/api/v1/helper/chat"
        )
        .is_err());

        assert!(request_url_allowed(
            "https://api.example.test/rmm",
            "https://api.example.test/rmmx/api/v1/helper/chat"
        )
        .is_err());

        assert!(request_url_allowed(
            "https://api.example.test/rmm/",
            "https://api.example.test/rmmx/api/v1/helper/chat"
        )
        .is_err());

        assert!(request_url_allowed(
            "https://api.example.test/rmm",
            "https://api.example.test/rmm/%2e%2e/api/v1/helper/chat"
        )
        .is_err());
    }

    #[test]
    fn request_url_rejects_unsupported_base_scheme() {
        assert!(request_url_allowed(
            "file:///tmp/breeze.sock",
            "file:///tmp/breeze.sock/api/v1/helper/chat"
        )
        .is_err());
    }

    #[test]
    fn portal_url_allows_breeze_and_same_https_api_origin() {
        assert_eq!(
            validate_portal_open_url("https://app.breezermm.com/devices", None).as_deref(),
            Ok("https://app.breezermm.com/devices")
        );

        assert_eq!(
            validate_portal_open_url(
                "https://console.example.test/devices",
                Some("https://console.example.test/api")
            )
            .as_deref(),
            Ok("https://console.example.test/devices")
        );

        assert!(validate_portal_open_url("https://tenant.2breeze.app", None).is_ok());
    }

    #[test]
    fn portal_url_rejects_unapproved_schemes_hosts_and_userinfo() {
        assert!(validate_portal_open_url("http://app.breezermm.com", None).is_err());
        assert!(validate_portal_open_url("javascript:alert(1)", None).is_err());
        assert!(validate_portal_open_url("https://breezermm.com.evil.test", None).is_err());
        assert!(validate_portal_open_url("https://user:pass@app.breezermm.com", None).is_err());
        assert!(validate_portal_open_url(
            "https://evil.example.test",
            Some("https://console.example.test")
        )
        .is_err());
        assert!(validate_portal_open_url(
            "https://console.example.test",
            Some("http://console.example.test")
        )
        .is_err());
    }
}
