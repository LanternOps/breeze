package workloads

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	maxListBytes  = 32 << 20
	maxSmallBytes = 1 << 20
	// engineTimeout bounds each HTTP request; the collector additionally gives
	// every driver a 30 s context for the whole Detect or Collect call.
	engineTimeout = 25 * time.Second

	labelComposeProject    = "com.docker.compose.project"
	labelComposeService    = "com.docker.compose.service"
	labelComposeWorkingDir = "com.docker.compose.project.working_dir"
)

var errTooLarge = errors.New("workloads: response too large")

// engineDriver speaks the Docker Engine API over a local socket or pipe. Podman
// serves the same endpoints, so one implementation backs both runtimes; the
// runtime field decides which flavor this driver reports.
type engineDriver struct {
	runtime Runtime
	client  *http.Client // nil when the runtime has no endpoint on this OS

	// Pre-connect gates. Connecting to a socket-activated engine starts it, so
	// Detect decides "present" and "running" without a connection first.
	socketPath string                         // unix socket to stat; "" on Windows
	liveness   func(context.Context) liveness // nil means always connect
	stat       func(string) (fs.FileInfo, error)
	resolve    func(string) (string, error)
}

type engineOption func(*engineDriver)

// withSocketPath makes Detect stat the socket before anything else: a missing
// socket is "absent" and a socket that is a symlink to Podman's is not Docker.
func withSocketPath(p string) engineOption { return func(d *engineDriver) { d.socketPath = p } }

// withLiveness adds the "is the daemon already running" check that must pass
// before any connection is made.
func withLiveness(f func(context.Context) liveness) engineOption {
	return func(d *engineDriver) { d.liveness = f }
}

func newEngineDriver(rt Runtime, dial DialFunc, opts ...engineOption) *engineDriver {
	d := &engineDriver{runtime: rt, stat: os.Stat, resolve: filepath.EvalSymlinks}
	if dial != nil {
		d.client = newReadOnlyClient(dial, engineTimeout)
	}
	for _, o := range opts {
		o(d)
	}
	return d
}

// preflight answers what can be known without opening a connection. It returns
// ok=true when the detection is final.
func (d *engineDriver) preflight(ctx context.Context) (Detection, bool) {
	if d.socketPath != "" {
		if _, err := d.stat(d.socketPath); err != nil {
			switch {
			case errors.Is(err, fs.ErrNotExist):
				return Detection{State: DetectionAbsent}, true
			case errors.Is(err, fs.ErrPermission):
				return Detection{State: DetectionPresent, Reason: ReasonPermissionDenied}, true
			default:
				return Detection{State: DetectionUnknown, Reason: ReasonUnreachable}, true
			}
		}
		if d.runtime == RuntimeDocker {
			// podman-docker symlinks /var/run/docker.sock to Podman's socket; that
			// engine is reported once, as podman.
			if target, err := d.resolve(d.socketPath); err == nil && strings.HasPrefix(filepath.Base(target), "podman") {
				return Detection{State: DetectionAbsent}, true
			}
		}
	}
	if d.liveness != nil {
		switch d.liveness(ctx) {
		case livenessAbsent:
			return Detection{State: DetectionAbsent}, true
		case livenessStopped:
			return Detection{State: DetectionPresent, Reason: ReasonNotRunning}, true
		}
	}
	return Detection{}, false
}

func (d *engineDriver) Runtime() Runtime { return d.runtime }

// engineVersion is the subset of GET /version the driver reads.
type engineVersion struct {
	Version    string `json:"Version"`
	APIVersion string `json:"ApiVersion"`
	Components []struct {
		Name string `json:"Name"`
	} `json:"Components"`
}

func (v engineVersion) known() bool { return v.Version != "" || len(v.Components) > 0 }

// isPodman is true when the engine behind the socket identifies as Podman, for
// example when /var/run/docker.sock is a symlink to Podman's socket.
func (v engineVersion) isPodman() bool {
	for _, c := range v.Components {
		if strings.HasPrefix(strings.ToLower(c.Name), "podman") {
			return true
		}
	}
	return false
}

// Detect answers "is this runtime here" with GET /_ping and GET /version only.
//
//	socket missing                       -> absent
//	socket present, daemon not running   -> present, Reason not_running (no connection made)
//	socket present, access denied        -> present, Reason permission_denied
//	socket present, daemon not answering -> present, Reason unavailable
//	timeout or an unexpected error       -> unknown (previous state is kept server-side)
func (d *engineDriver) Detect(ctx context.Context) Detection {
	if d.client == nil {
		return Detection{State: DetectionAbsent}
	}
	if det, final := d.preflight(ctx); final {
		return det
	}
	status, _, err := d.get(ctx, "/_ping", maxSmallBytes)
	if err != nil {
		return detectionFromError(err)
	}
	if det, failed := detectionFromStatus(status); failed {
		return det
	}
	var v engineVersion
	vs, vb, verr := d.get(ctx, "/version", maxSmallBytes)
	switch {
	case verr != nil:
		slog.Debug("workloads: engine version probe failed", "runtime", d.runtime, "error", verr.Error())
	case vs != http.StatusOK:
		slog.Debug("workloads: engine version probe failed", "runtime", d.runtime, "status", vs)
	default:
		if err := json.Unmarshal(vb, &v); err != nil {
			slog.Debug("workloads: engine version not decodable", "runtime", d.runtime, "error", err.Error())
		}
	}
	if v.known() && v.isPodman() != (d.runtime == RuntimePodman) {
		return Detection{State: DetectionAbsent}
	}
	return Detection{State: DetectionPresent, Version: clip(v.Version, 64), apiVersion: clip(v.APIVersion, 16)}
}

func detectionFromError(err error) Detection {
	var netErr net.Error
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return Detection{State: DetectionAbsent}
	case errors.Is(err, fs.ErrPermission):
		return Detection{State: DetectionPresent, Reason: ReasonPermissionDenied}
	case errors.Is(err, syscall.ECONNREFUSED):
		return Detection{State: DetectionPresent, Reason: ReasonUnavailable}
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()):
		return Detection{State: DetectionUnknown, Reason: ReasonTimeout}
	default:
		return Detection{State: DetectionUnknown, Reason: ReasonUnreachable}
	}
}

func detectionFromStatus(status int) (Detection, bool) {
	switch status {
	case http.StatusOK:
		return Detection{}, false
	case http.StatusUnauthorized, http.StatusForbidden:
		return Detection{State: DetectionPresent, Reason: ReasonPermissionDenied}, true
	default:
		return Detection{State: DetectionPresent, Reason: ReasonUnavailable}, true
	}
}

// apiContainer is the allowlist for GET /containers/json: id, first name,
// state, image reference, image id, creation time and the three compose
// labels. Environment, command, mounts, ports, networks, host config and every
// other label are not declared here, so they are never decoded.
type apiContainer struct {
	ID      string        `json:"Id"`
	Names   []string      `json:"Names"`
	Image   string        `json:"Image"`
	ImageID string        `json:"ImageID"`
	Created int64         `json:"Created"`
	State   string        `json:"State"`
	Labels  composeLabels `json:"Labels"`
}

// composeLabels keeps the three compose labels and drops the rest at decode time.
type composeLabels struct {
	Project, Service, WorkingDir string
}

func (l *composeLabels) UnmarshalJSON(b []byte) error {
	var all map[string]string
	if err := json.Unmarshal(b, &all); err != nil {
		return nil // an unexpected label shape just means no compose metadata
	}
	l.Project = all[labelComposeProject]
	l.Service = all[labelComposeService]
	l.WorkingDir = all[labelComposeWorkingDir]
	return nil
}

// apiImage is the allowlist for GET /images/json.
type apiImage struct {
	ID          string        `json:"Id"`
	RepoTags    []string      `json:"RepoTags"`
	RepoDigests []string      `json:"RepoDigests"`
	Manifests   []apiManifest `json:"Manifests"`
}

// imageIdentityQuery asks Docker (Engine API 1.54+, Docker 29.3+) for each
// image's provenance. The engine computes it locally from the containerd
// content labels it set on pull and push; no registry is contacted.
const imageIdentityQuery = "manifests=1&identity=1"

// apiManifest keeps only the provenance part of a manifest summary.
type apiManifest struct {
	Kind      string        `json:"Kind"`
	ImageData *apiImageData `json:"ImageData"`
}

type apiImageData struct {
	Identity *apiIdentity `json:"Identity"`
}

// apiIdentity keeps the repositories the image was pulled from or pushed to.
// Build refs and signature details are not decoded.
type apiIdentity struct {
	Pull []apiPullIdentity `json:"Pull"`
}

type apiPullIdentity struct {
	Repository string `json:"Repository"`
}

// pulledFrom reports whether the engine recorded repository (normalized) as a
// place this image was pulled from or pushed to.
func (img apiImage) pulledFrom(repository string) bool {
	if repository == "" {
		return false
	}
	for _, m := range img.Manifests {
		if m.Kind != "image" || m.ImageData == nil || m.ImageData.Identity == nil {
			continue
		}
		for _, p := range m.ImageData.Identity.Pull {
			if NormalizeImage(p.Repository).Repository == repository {
				return true
			}
		}
	}
	return false
}

// apiVersionAtLeast compares an engine API version ("1.54") numerically. An
// empty or malformed version is never "at least" anything.
func apiVersionAtLeast(v string, major, minor int) bool {
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return false
	}
	gotMajor, err1 := strconv.Atoi(parts[0])
	gotMinor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || gotMajor < 0 || gotMinor < 0 {
		return false
	}
	if gotMajor != major {
		return gotMajor > major
	}
	return gotMinor >= minor
}

// Collect lists containers and images with two GET requests. It never calls
// inspect, so restart policy stays null and no environment is ever returned.
func (d *engineDriver) Collect(ctx context.Context, det Detection) Result {
	switch det.Reason {
	case ReasonNotRunning:
		return Result{Collection: CollectionUnavailable, Error: "daemon not running"}
	case ReasonPermissionDenied:
		return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}
	case ReasonUnavailable:
		return Result{Collection: CollectionUnavailable, Error: "daemon_unreachable"}
	}
	if d.client == nil {
		return Result{Collection: CollectionUnavailable, Error: "daemon_unreachable"}
	}
	status, body, err := d.get(ctx, "/containers/json?all=1", maxListBytes)
	if res, failed := failureResult(status, err); failed {
		// The report carries only a code; the cause stays in the local log.
		slog.Warn("workloads: container list failed", "runtime", d.runtime, "code", res.Error, "status", status, "error", errString(err))
		return res
	}
	var containers []apiContainer
	if err := json.Unmarshal(body, &containers); err != nil {
		slog.Warn("workloads: container list not decodable", "runtime", d.runtime, "error", err.Error())
		return Result{Collection: CollectionError, Error: "decode_failed"}
	}

	// Without the image list, containers still report but lose digest and tag
	// recovery, so the snapshot is marked incomplete rather than failed.
	complete, code := true, ""
	images := map[string]apiImage{}
	// Only Docker answers the identity query; Podman's compat API has no such
	// option. Older Docker engines would ignore it, so ask only where it works.
	identity := d.runtime == RuntimeDocker && apiVersionAtLeast(det.apiVersion, 1, 54)
	imagesPath := "/images/json"
	if identity {
		imagesPath += "?" + imageIdentityQuery
	}
	istatus, ibody, ierr := d.get(ctx, imagesPath, maxListBytes)
	var list []apiImage
	if ierr == nil && istatus == http.StatusOK {
		ierr = json.Unmarshal(ibody, &list)
	}
	if ierr != nil || istatus != http.StatusOK {
		slog.Warn("workloads: image list failed", "runtime", d.runtime, "status", istatus, "error", errString(ierr))
		complete, code = false, "images_list_failed"
	}
	for _, img := range list {
		images[normalizeImageID(img.ID)] = img
	}

	ws := buildContainerWorkloads(containers, images, identity)
	observed := len(ws)
	ws, truncated := orderAndCap(ws)
	if truncated {
		complete = false
		if code == "" {
			code = "truncated"
		}
	}
	return Result{Collection: CollectionOK, Complete: complete, Workloads: ws, ObservedCount: observed, Error: code}
}

func failureResult(status int, err error) (Result, bool) {
	if err != nil {
		if errors.Is(err, errTooLarge) {
			return Result{Collection: CollectionError, Error: "response_too_large"}, true
		}
		switch det := detectionFromError(err); {
		case det.Reason == ReasonPermissionDenied:
			return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}, true
		case det.State == DetectionAbsent || det.Reason == ReasonUnavailable:
			return Result{Collection: CollectionUnavailable, Error: "daemon_unreachable"}, true
		case det.Reason == ReasonTimeout:
			return Result{Collection: CollectionUnavailable, Error: ReasonTimeout}, true
		default:
			return Result{Collection: CollectionError, Error: "request_failed"}, true
		}
	}
	switch status {
	case http.StatusOK:
		return Result{}, false
	case http.StatusUnauthorized, http.StatusForbidden:
		return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}, true
	default:
		return Result{Collection: CollectionError, Error: "http_" + strconv.Itoa(status)}, true
	}
}

func (d *engineDriver) get(ctx context.Context, pathAndQuery string, limit int64) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://engine"+pathAndQuery, nil)
	if err != nil {
		return 0, nil, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if int64(len(body)) > limit {
		return resp.StatusCode, nil, errTooLarge
	}
	return resp.StatusCode, body, nil
}

func normalizeImageID(id string) string {
	id = strings.TrimSpace(id)
	if len(id) == 64 && !strings.HasPrefix(id, "sha256:") && IsImageID(id) {
		return "sha256:" + id
	}
	return id
}

// identity is true when the image list carries each image's provenance.
func buildContainerWorkloads(containers []apiContainer, images map[string]apiImage, identity bool) []Workload {
	seen := make(map[string]bool, len(containers))
	out := make([]Workload, 0, len(containers))
	for _, c := range containers {
		if c.ID == "" || seen[c.ID] {
			continue
		}
		seen[c.ID] = true
		out = append(out, mapContainer(c, images, identity))
	}
	return out
}

func mapContainer(c apiContainer, images map[string]apiImage, identity bool) Workload {
	imageID := normalizeImageID(c.ImageID)
	img := images[imageID]
	ref := strings.TrimSpace(c.Image)
	if IsImageID(ref) {
		// The engine reports a bare id when the tag has moved to another image;
		// recover a name from the image's own tags when it still has one.
		ref = ""
		if len(img.RepoTags) > 0 {
			tags := append([]string(nil), img.RepoTags...)
			sort.Strings(tags)
			ref = tags[0]
		}
	}
	parsed := NormalizeImage(ref)
	digest := PickRepoDigest(parsed.Repository, img.RepoDigests)
	// Docker's containerd image store lists "name@<image id>" in RepoDigests
	// for every named image, local builds and loaded images included (#8993).
	// The classic store never does: there a repo digest is a manifest digest
	// and the image id is the config digest. So a repo digest equal to the
	// image id says nothing about a registry; where the engine reports
	// provenance, keep the digest only if the image was pulled from (or pushed
	// to) this repository, else report none and the server calls it local
	// without asking any registry. Engines without provenance (Docker < 29.3)
	// keep the old behavior.
	if identity && digest != "" && digest == imageID && !img.pulledFrom(parsed.Repository) {
		digest = ""
	}
	if digest == "" && parsed.Pinned && digestPattern.MatchString(parsed.Digest) {
		digest = parsed.Digest
	}

	name := ""
	if len(c.Names) > 0 {
		name = strings.TrimPrefix(c.Names[0], "/")
	}
	if name == "" {
		name = clip(c.ID, 12)
	}
	w := Workload{
		WorkloadID:        c.ID,
		Kind:              KindContainer,
		Name:              name,
		State:             mapContainerState(c.State),
		RawState:          strp(c.State),
		ImageRef:          strp(ref),
		ImageRepository:   strp(parsed.Repository),
		ImageTag:          strp(parsed.Tag),
		ImageDigest:       strp(digest),
		ImageID:           strp(imageID),
		ComposeProject:    strp(c.Labels.Project),
		ComposeService:    strp(c.Labels.Service),
		ComposeWorkingDir: strp(c.Labels.WorkingDir),
	}
	if c.Created > 0 {
		w.RuntimeCreatedAt = strp(time.Unix(c.Created, 0).UTC().Format(time.RFC3339))
	}
	// StartedAt stays null: the list response only carries a relative "Up 3
	// hours" string, which is neither exact nor stable between collections.
	w.Bound()
	return w
}

func mapContainerState(raw string) string {
	switch strings.ToLower(raw) {
	case "running":
		return StateRunning
	case "paused":
		return StatePaused
	case "restarting":
		return StateRestarting
	case "exited", "created", "dead", "stopped", "configured", "initialized":
		return StateStopped
	default:
		return StateOther
	}
}

// orderAndCap sorts running workloads first, then newest first, then by id, and
// keeps at most MaxWorkloadsPerRuntime. The second result reports truncation.
func orderAndCap(ws []Workload) ([]Workload, bool) {
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	sort.SliceStable(ws, func(i, j int) bool {
		a, b := ws[i], ws[j]
		if ar, br := a.State == StateRunning, b.State == StateRunning; ar != br {
			return ar
		}
		if ac, bc := deref(a.RuntimeCreatedAt), deref(b.RuntimeCreatedAt); ac != bc {
			return ac > bc
		}
		return a.WorkloadID < b.WorkloadID
	})
	if len(ws) > MaxWorkloadsPerRuntime {
		return ws[:MaxWorkloadsPerRuntime:MaxWorkloadsPerRuntime], true
	}
	return ws, false
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
