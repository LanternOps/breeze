package helper

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// WebView2 runtime check before launching Breeze Assist (#10183).
//
// Assist is a Tauri app that renders in the WebView2 Evergreen runtime. On a
// runtime older than its wry build needs, it exits before its own logging is
// up, the watcher burns its retries, and the device silently has no Assist. So
// on Windows the agent reads the installed runtime version before every launch
// and refuses below the installed build's minimum, reporting
// webview2_outdated; prompts then take the native fallback (OD-10: no
// automatic runtime install).

// webview2GateApplies: only Windows Assist renders in WebView2. A var so tests
// exercise the gate on every host (the sweepLegacyAutoStart precedent).
var webview2GateApplies = runtime.GOOS == "windows"

// errWebView2Outdated: ensureRunningSession refused the launch. The gate logs
// the refusal once per episode itself, so callers must not log it again.
var errWebView2Outdated = errors.New("breeze assist not started: WebView2 runtime too old")

// fallbackMinWebView2 is the minimum used when the installed Assist carries no
// usable requirements sidecar (older builds, or a sidecar left by a different
// version after a rollback; P12).
//
// Source: wry 0.57 (webview2-com-sys 0.39.1, WebView2 SDK 1.0.3650.58) casts
// to ICoreWebView2_4 with `?` while attaching the webview's handlers
// (src/webview2/mod.rs, attach_handlers), so webview creation fails on any
// runtime without that interface. ICoreWebView2_4 shipped in WebView2 SDK
// 1.0.902.49, whose minimum runtime is 92.0.902.49. The inbox runtime of
// Windows 11 21H2 (90.0.818.66, #10183) lacks it. Every other interface wry
// needs newer than that is cast with `if let Ok`, i.e. optional.
//
// The SDK's own "full API compatibility" runtime (143.x for 1.0.3650.58) is
// deliberately not used: it would refuse Assist on devices that run it today.
// Raise this when a wry/Tauri bump adds a newer hard requirement; the
// requirements sidecar in apps/helper/src-tauri carries the same value.
const fallbackMinWebView2 = "92.0.902.49"

// assistRequirementsFile is the sidecar Assist ships next to its executable.
const assistRequirementsFile = "assist-requirements.json"

// maxAssistRequirementsBytes bounds the sidecar read; the real file is ~80 bytes.
const maxAssistRequirementsBytes = 4096

// webview2Version is a WebView2 runtime version, major.minor.build.patch.
type webview2Version [4]uint32

// parseWebView2Version parses a four-part numeric runtime version. "0.0.0.0"
// is what EdgeUpdate leaves behind after an uninstall, so it reads as absent.
func parseWebView2Version(s string) (webview2Version, bool) {
	var v webview2Version
	parts := strings.Split(strings.TrimSpace(s), ".")
	if len(parts) != len(v) {
		return webview2Version{}, false
	}
	for i, p := range parts {
		// ParseUint accepts neither signs nor empty strings.
		if p == "" || p[0] == '+' {
			return webview2Version{}, false
		}
		n, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return webview2Version{}, false
		}
		v[i] = uint32(n)
	}
	if v == (webview2Version{}) {
		return webview2Version{}, false
	}
	return v, true
}

func (v webview2Version) less(o webview2Version) bool {
	for i := range v {
		if v[i] != o[i] {
			return v[i] < o[i]
		}
	}
	return false
}

func (v webview2Version) String() string {
	return strconv.FormatUint(uint64(v[0]), 10) + "." + strconv.FormatUint(uint64(v[1]), 10) + "." +
		strconv.FormatUint(uint64(v[2]), 10) + "." + strconv.FormatUint(uint64(v[3]), 10)
}

// assistRequirements is the sidecar's content.
type assistRequirements struct {
	AssistVersion      string `json:"assistVersion"`
	MinWebView2Version string `json:"minWebView2Version"`
}

var fallbackAssistRequirements = assistRequirements{MinWebView2Version: fallbackMinWebView2}

// loadAssistRequirements reads the sidecar in installDir. It returns
// fallbackAssistRequirements when the file is missing, unreadable, oversized
// or malformed, or when its assistVersion does not match installedVersion (an
// update rollback restores only the executable, so a newer build's sidecar may
// sit next to an older executable; P12). An unknown installedVersion never
// matches.
func loadAssistRequirements(installDir, installedVersion string) assistRequirements {
	req, _ := readAssistRequirements(installDir, installedVersion)
	return req
}

// readAssistRequirements is loadAssistRequirements that also says why a
// sidecar that exists was not used ("" when it was used or is absent).
func readAssistRequirements(installDir, installedVersion string) (assistRequirements, string) {
	f, err := os.Open(filepath.Join(installDir, assistRequirementsFile))
	if errors.Is(err, os.ErrNotExist) {
		return fallbackAssistRequirements, ""
	}
	if err != nil {
		return fallbackAssistRequirements, "unreadable: " + err.Error()
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxAssistRequirementsBytes+1))
	if err != nil {
		return fallbackAssistRequirements, "unreadable: " + err.Error()
	}
	if len(data) > maxAssistRequirementsBytes {
		return fallbackAssistRequirements, "oversized"
	}
	var req assistRequirements
	if err := json.Unmarshal(data, &req); err != nil {
		return fallbackAssistRequirements, "malformed: " + err.Error()
	}
	if _, ok := parseWebView2Version(req.MinWebView2Version); !ok {
		return fallbackAssistRequirements, "invalid minWebView2Version " + strconv.Quote(req.MinWebView2Version)
	}
	if strings.TrimSpace(req.AssistVersion) == "" || !helperVersionsMatch(installedVersion, req.AssistVersion) {
		// Expected right after an update rollback (P12).
		return fallbackAssistRequirements, "for assist " + strconv.Quote(req.AssistVersion) +
			", installed " + strconv.Quote(installedVersion)
	}
	return req, ""
}

// webview2GateLocked reports whether Assist may launch in state's session.
// A refusal sets state.launchIssue and logs one WARN per (found, minimum)
// pair, so a device that stays refused does not log every heartbeat. A runtime
// version the registry does not show allows the launch: absence is not proof
// of an old runtime, and refusing would turn a registry quirk into a lost
// Assist. Must be called with m.mu held.
func (m *Manager) webview2GateLocked(state *sessionState) bool {
	if !webview2GateApplies || m.readWebView2Func == nil {
		state.launchIssue = ""
		return true
	}
	raw, ok := m.readWebView2Func(state.key)
	found, parsed := parseWebView2Version(raw)
	if !ok || !parsed {
		if !state.webview2UnknownLogged {
			log.Warn("WebView2 runtime version not found; launching breeze assist without the runtime check",
				"session", state.key, "registered", ok, "value", raw)
			state.webview2UnknownLogged = true
		}
		state.launchIssue = ""
		state.webview2Refusal = ""
		return true
	}
	state.webview2UnknownLogged = false
	req, rejected := readAssistRequirements(filepath.Dir(m.binaryPath), m.installedVersionLocked())
	if rejected != m.sidecarRejectLogged {
		if rejected != "" {
			log.Warn("ignoring breeze assist's requirements sidecar; using the agent's WebView2 minimum",
				"reason", rejected, "minimum", fallbackMinWebView2)
		}
		m.sidecarRejectLogged = rejected
	}
	min, _ := parseWebView2Version(req.MinWebView2Version) // validated by readAssistRequirements
	if !found.less(min) {
		if state.launchIssue != "" {
			log.Info("WebView2 runtime now meets breeze assist's minimum; launching",
				"session", state.key, "found", found.String(), "minimum", min.String())
		}
		state.launchIssue = ""
		state.webview2Refusal = ""
		return true
	}
	source := "sidecar"
	if req == fallbackAssistRequirements {
		source = "fallback"
	}
	if key := found.String() + ">" + min.String(); state.webview2Refusal != key {
		log.Warn("breeze assist not started: the WebView2 runtime is older than this build requires",
			"session", state.key, "found", found.String(), "minimum", min.String(), "minimumSource", source)
		state.webview2Refusal = key
	}
	state.launchIssue = InstallIssueWebView2Outdated
	return false
}
