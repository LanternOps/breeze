package tools

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

type diagFixture struct {
	Cases []struct {
		Path       string   `json:"path"`
		HardDenied bool     `json:"hardDenied"`
		Classes    []string `json:"classes"`
	} `json:"cases"`
}

func TestClassifyDiagnosticPathSharedFixture(t *testing.T) {
	orig := agentConfigDirFunc
	agentConfigDirFunc = func() string { return "" }
	t.Cleanup(func() { agentConfigDirFunc = orig })

	raw, err := os.ReadFile(filepath.Join("testdata", "diagnostic_path_classes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx diagFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 20 {
		t.Fatalf("fixture unexpectedly small: %d cases", len(fx.Cases))
	}
	for _, c := range fx.Cases {
		hard, classes := ClassifyDiagnosticPath(c.Path)
		if classes == nil {
			classes = []string{}
		}
		if hard != c.HardDenied || !reflect.DeepEqual(classes, c.Classes) {
			t.Errorf("%s: got hard=%v classes=%v, want hard=%v classes=%v", c.Path, hard, classes, c.HardDenied, c.Classes)
		}
	}
}

// Every path the pre-existing SR5-01 deny-list protects must fall in some
// approvable class or be hard-denied, otherwise grant mode would have to
// choose between serving it unannounced and refusing it for no stated reason.
func TestSensitiveReadPathsAreAllClassified(t *testing.T) {
	for _, p := range []string{
		"/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/ssl/private/k",
		"/private/etc/master.passwd", `C:\Windows\System32\config\SAM`, `C:\Windows\NTDS\ntds.dit`,
		"/Library/Keychains/login.keychain-db", `C:\ProgramData\Breeze\agent.yaml`,
		`C:\Users\a\AppData\Local\Google\Chrome\User Data\Default\Login Data`,
		"/home/a/.mozilla/firefox/x/key4.db", "/home/a/.ssh/id_rsa", "/home/a/.aws/credentials",
		"/home/a/.kube/config", "/home/a/.git-credentials", "/srv/app/.env",
	} {
		if !isSensitiveReadPath(p) {
			t.Fatalf("test premise: %s should be SR5-01 sensitive", p)
		}
		hard, classes := ClassifyDiagnosticPath(p)
		if !hard && len(classes) == 0 {
			t.Errorf("%s is SR5-01 sensitive but has no diagnostic class", p)
		}
	}
}

type diagSigner struct {
	pub     ed25519.PublicKey
	priv    ed25519.PrivateKey
	kid     string
	resultK *ecdh.PrivateKey
}

func newDiagSigner(t *testing.T) *diagSigner {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rk, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &diagSigner{pub: pub, priv: priv, kid: "deploy-test-key", resultK: rk}
}

func (s *diagSigner) resultPub() string {
	return base64.StdEncoding.EncodeToString(s.resultK.PublicKey().Bytes())
}

func (s *diagSigner) env(deviceID, orgID string) DiagGrantEnv {
	return DiagGrantEnv{
		DeviceID: deviceID,
		OrgID:    orgID,
		Verify: func(keyID string, payload, sig []byte) error {
			if keyID != s.kid {
				return errors.New("unknown key")
			}
			if !ed25519.Verify(s.pub, payload, sig) {
				return errors.New("bad signature")
			}
			return nil
		},
	}
}

var diagSeq int

// diagCmd is one signed diagnostic command: its id, payload, and the
// authorization embedded in the payload.
type diagCmd struct {
	id      string
	payload map[string]any
}

// build signs an authorization for op/path with the given roots and classes,
// then applies mut to the authorization before signing.
func (s *diagSigner) build(t *testing.T, op, path string, roots []DiagGrantRoot, classes []string, extra map[string]any, mut func(*DiagnosticAuthorization)) diagCmd {
	t.Helper()
	diagSeq++
	id := fmt.Sprintf("cmd-%d-%d", time.Now().UnixNano(), diagSeq)
	payload := map[string]any{"path": path, "resultPublicKey": s.resultPub()}
	if op == "read" {
		payload["offset"] = 0
		payload["maxBytes"] = 262144
		payload["encoding"] = "text"
	} else {
		payload["offset"] = 0
		payload["limit"] = 500
	}
	for k, v := range extra {
		payload[k] = v
	}
	args := diagArgs(id, payload)
	now := time.Now().UTC().Truncate(time.Second)
	a := &DiagnosticAuthorization{
		Version:          1,
		AuthorizationID:  "auth-" + id,
		CommandID:        id,
		GrantID:          "grant-1",
		DeviceID:         "dev-1",
		OrgID:            "org-1",
		Operation:        op,
		RequestPath:      args.Path,
		Offset:           args.Offset,
		MaxBytes:         args.MaxBytes,
		Limit:            args.Limit,
		Encoding:         args.Encoding,
		ResultPublicKey:  args.ResultPublicKey,
		Roots:            roots,
		SensitiveClasses: classes,
		ApprovedBy:       "user-approver",
		IssuedAt:         now.Format(time.RFC3339),
		ExpiresAt:        now.Add(2 * time.Minute).Format(time.RFC3339),
		KeyID:            s.kid,
	}
	if mut != nil {
		mut(a)
	}
	canonical, err := a.CanonicalBytes()
	if err != nil {
		t.Fatal(err)
	}
	a.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(s.priv, canonical))
	payload[DiagnosticAuthorizationPayloadKey] = authToPayload(a)
	return diagCmd{id: id, payload: payload}
}

func authToPayload(a *DiagnosticAuthorization) map[string]any {
	raw, _ := json.Marshal(a)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return m
}

func (s *diagSigner) run(c diagCmd, op string, env DiagGrantEnv) CommandResult {
	if op == "read" {
		return DiagnosticReadFile(c.id, c.payload, env)
	}
	return DiagnosticListFiles(c.id, c.payload, env)
}

func diagCode(r CommandResult) string {
	if r.Status == "completed" {
		return "OK"
	}
	code, _, _ := strings.Cut(r.Error, ":")
	return code
}

// open decrypts a successful sealed result into out.
func (s *diagSigner) open(t *testing.T, r CommandResult, out any) {
	t.Helper()
	var sealed DiagSealedResult
	if err := json.Unmarshal([]byte(r.Stdout), &sealed); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(r.Stdout, "line1") {
		t.Fatal("result stdout carries plaintext content")
	}
	plain, err := openDiagResult(s.resultK, &sealed)
	if err != nil {
		t.Fatalf("could not open sealed result: %v", err)
	}
	if err := json.Unmarshal(plain, out); err != nil {
		t.Fatal(err)
	}
}

// realTempDir resolves the platform temp dir (macOS /var -> /private/var) so
// the tree has no link in its path; grant mode refuses linked paths.
func realTempDir(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// diagTree builds: <root>/Logs/app.log, <root>/Logs/deep/inner.log,
// <root>/Chrome/Cookies and an outside directory with secret.txt.
func diagTree(t *testing.T) (root, outside string) {
	t.Helper()
	base := realTempDir(t)
	root = filepath.Join(base, "AppData", "Local", "Battle.net")
	outside = filepath.Join(base, "outside")
	for _, d := range []string{filepath.Join(root, "Logs", "deep"), filepath.Join(root, "Chrome"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p, s string) {
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(root, "Logs", "app.log"), "line1\nline2\nline3\n")
	write(filepath.Join(root, "Logs", "deep", "inner.log"), "inner\n")
	write(filepath.Join(root, "Chrome", "Cookies"), "cookie-db")
	write(filepath.Join(outside, "secret.txt"), "top secret")
	return root, outside
}

func skipIfNoGrantPlatform(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("grant mode is refused on this platform")
	}
}

func rec(p string) []DiagGrantRoot  { return []DiagGrantRoot{{Path: p, Recursive: true}} }
func flat(p string) []DiagGrantRoot { return []DiagGrantRoot{{Path: p, Recursive: false}} }

func TestDiagnosticReadAuthorizedPaginatedAndSealed(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	logPath := filepath.Join(root, "Logs", "app.log")

	r := s.run(s.build(t, "read", logPath, rec(root), nil, map[string]any{"maxBytes": 6}, nil), "read", env)
	if diagCode(r) != "OK" {
		t.Fatalf("read failed: %s", r.Error)
	}
	var resp DiagnosticReadResponse
	s.open(t, r, &resp)
	if resp.Content != "line1\n" || resp.NextOffset != 6 || resp.EOF || resp.Size != 18 {
		t.Fatalf("unexpected first page: %+v", resp)
	}
	if resp.GrantID != "grant-1" || resp.ResolvedPath == "" {
		t.Fatalf("missing grant/resolved metadata: %+v", resp)
	}

	r = s.run(s.build(t, "read", logPath, rec(root), nil, map[string]any{"offset": 12, "maxBytes": 100}, nil), "read", env)
	s.open(t, r, &resp)
	if resp.Content != "line3\n" || !resp.EOF {
		t.Fatalf("unexpected last page: %+v", resp)
	}

	// Sealed to someone else's key: the stored result is useless to them.
	var sealed DiagSealedResult
	_ = json.Unmarshal([]byte(r.Stdout), &sealed)
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := openDiagResult(other, &sealed); err == nil {
		t.Fatal("sealed result opened with the wrong key")
	}
}

func TestDiagnosticRecursiveVsFlat(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	logs := filepath.Join(root, "Logs")
	deep := filepath.Join(logs, "deep", "inner.log")

	if got := diagCode(s.run(s.build(t, "read", deep, flat(logs), nil, nil, nil), "read", env)); got != DiagErrOutOfScope {
		t.Fatalf("flat grant reached a grandchild: %s", got)
	}
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(logs, "app.log"), flat(logs), nil, nil, nil), "read", env)); got != "OK" {
		t.Fatalf("flat grant refused a direct child file: %s", got)
	}
	if got := diagCode(s.run(s.build(t, "list", logs, flat(logs), nil, nil, nil), "list", env)); got != "OK" {
		t.Fatalf("flat grant refused listing its own root: %s", got)
	}
	if got := diagCode(s.run(s.build(t, "list", filepath.Join(logs, "deep"), flat(logs), nil, nil, nil), "list", env)); got != DiagErrOutOfScope {
		t.Fatalf("flat grant listed a subdirectory: %s", got)
	}
	if got := diagCode(s.run(s.build(t, "read", deep, rec(root), nil, nil, nil), "read", env)); got != "OK" {
		t.Fatalf("recursive grant refused a descendant: %s", got)
	}
}

func TestDiagnosticOutOfScopeAndPrefixSibling(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, outside := diagTree(t)
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(outside, "secret.txt"), rec(root), nil, nil, nil), "read", env)); got != DiagErrOutOfScope {
		t.Fatalf("read outside the grant: %s", got)
	}
	sib := root + "2"
	if err := os.MkdirAll(sib, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sib, "x.log"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(sib, "x.log"), rec(root), nil, nil, nil), "read", env)); got != DiagErrOutOfScope {
		t.Fatalf("prefix sibling treated as in scope: %s", got)
	}
}

func TestDiagnosticLinkEscapesRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privilege on Windows; junction coverage lives in the Windows test")
	}
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, outside := diagTree(t)
	logs := filepath.Join(root, "Logs")
	// A directory link inside the approved tree pointing outside it.
	link := filepath.Join(logs, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(link, "secret.txt"), rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused {
		t.Fatalf("symlinked directory escape: %s", got)
	}
	// A file link pointing outside.
	fileLink := filepath.Join(logs, "secret-link.txt")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), fileLink); err != nil {
		t.Fatal(err)
	}
	if got := diagCode(s.run(s.build(t, "read", fileLink, rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused {
		t.Fatalf("symlinked file escape: %s", got)
	}
	// A link that stays INSIDE the tree is still refused: the final path must
	// be the requested path.
	inner := filepath.Join(logs, "inner-link.log")
	if err := os.Symlink(filepath.Join(logs, "app.log"), inner); err != nil {
		t.Fatal(err)
	}
	if got := diagCode(s.run(s.build(t, "read", inner, rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused {
		t.Fatalf("in-tree link served: %s", got)
	}
	// The approved root itself replaced by a link after approval.
	moved := root + "-moved"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(root, "secret.txt"), rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused {
		t.Fatalf("root swapped for a link: %s", got)
	}
	// Listing reports links as links and does not follow them.
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(moved, root); err != nil {
		t.Fatal(err)
	}
	r := s.run(s.build(t, "list", logs, rec(root), nil, nil, nil), "list", env)
	if diagCode(r) != "OK" {
		t.Fatalf("list failed: %s", r.Error)
	}
	var lr DiagnosticListResponse
	s.open(t, r, &lr)
	found := false
	for _, e := range lr.Entries {
		if e.Name == "escape" {
			found = true
			if e.Type != "link" {
				t.Fatalf("link entry reported as %q", e.Type)
			}
		}
	}
	if !found {
		t.Fatal("link entry missing from listing")
	}
}

func TestDiagnosticTraversalSpellingsRefused(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, outside := diagTree(t)
	escape := root + string(filepath.Separator) + ".." + string(filepath.Separator) + ".." + string(filepath.Separator) + ".." + string(filepath.Separator) + "outside" + string(filepath.Separator) + "secret.txt"
	_ = outside
	if got := diagCode(s.run(s.build(t, "read", escape, rec(root), nil, nil, nil), "read", env)); got != DiagErrPathForm {
		t.Fatalf("traversal spelling: %s", got)
	}
}

func TestDiagnosticHardLinkRefused(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, outside := diagTree(t)
	hl := filepath.Join(root, "Logs", "hard.log")
	if err := os.Link(filepath.Join(outside, "secret.txt"), hl); err != nil {
		t.Skipf("hard links unavailable here: %v", err)
	}
	if got := diagCode(s.run(s.build(t, "read", hl, rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused {
		t.Fatalf("hard link served: %s", got)
	}
}

func TestDiagnosticSensitiveClassMustBeExplicit(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	cookies := filepath.Join(root, "Chrome", "Cookies")
	if got := diagCode(s.run(s.build(t, "read", cookies, rec(root), nil, nil, nil), "read", env)); got != DiagErrSensitive {
		t.Fatalf("broad grant reached the cookie jar: %s", got)
	}
	if got := diagCode(s.run(s.build(t, "read", cookies, rec(root), []string{DiagClassBrowserSecrets}, nil, nil), "read", env)); got != "OK" {
		t.Fatalf("explicit browser_secrets grant refused: %s", got)
	}
}

func TestDiagnosticTokenFailures(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	logPath := filepath.Join(root, "Logs", "app.log")
	good := func(mut func(*DiagnosticAuthorization)) diagCmd {
		return s.build(t, "read", logPath, rec(root), nil, nil, mut)
	}
	check := func(name string, c diagCmd, e DiagGrantEnv, want string) {
		t.Helper()
		if got := diagCode(s.run(c, "read", e)); got != want {
			t.Errorf("%s: got %s want %s", name, got, want)
		}
	}

	// Forged: signed by a key the device does not pin.
	other := newDiagSigner(t)
	other.resultK = s.resultK
	check("forged", other.build(t, "read", logPath, rec(root), nil, nil, nil), env, DiagErrSignature)
	// Tampered after signing: widen the roots.
	c := good(nil)
	c.payload[DiagnosticAuthorizationPayloadKey].(map[string]any)["roots"] = []any{map[string]any{"path": "/", "recursive": true}}
	check("tampered roots", c, env, DiagErrSignature)
	// Tampered sensitive classes.
	c = good(nil)
	c.payload[DiagnosticAuthorizationPayloadKey].(map[string]any)["sensitiveClasses"] = []any{"browser_secrets"}
	check("tampered classes", c, env, DiagErrSignature)
	// Invented signature.
	c = good(nil)
	c.payload[DiagnosticAuthorizationPayloadKey].(map[string]any)["signature"] = base64.StdEncoding.EncodeToString(make([]byte, 64))
	check("invented", c, env, DiagErrSignature)
	// Missing authorization altogether.
	c = good(nil)
	delete(c.payload, DiagnosticAuthorizationPayloadKey)
	check("missing", c, env, DiagErrMalformed)
	// Wrong device / org.
	check("wrong device", good(nil), s.env("dev-2", "org-1"), DiagErrDevice)
	check("wrong org", good(nil), s.env("dev-1", "org-2"), DiagErrDevice)
	check("agent with no local org id", good(nil), s.env("dev-1", ""), DiagErrDevice)
	// Expired.
	check("expired", good(func(a *DiagnosticAuthorization) {
		past := time.Now().UTC().Add(-30 * time.Minute).Truncate(time.Second)
		a.IssuedAt = past.Format(time.RFC3339)
		a.ExpiresAt = past.Add(2 * time.Minute).Format(time.RFC3339)
	}), env, DiagErrExpired)
	// Boundary: one second past expiry is refused (no skew on expiry).
	check("expired by one second", good(func(a *DiagnosticAuthorization) {
		exp := time.Now().UTC().Add(-1 * time.Second).Truncate(time.Second)
		a.IssuedAt = exp.Add(-2 * time.Minute).Format(time.RFC3339)
		a.ExpiresAt = exp.Format(time.RFC3339)
	}), env, DiagErrExpired)
	// Over-long lifetime.
	check("over-long", good(func(a *DiagnosticAuthorization) {
		a.ExpiresAt = time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second).Format(time.RFC3339)
	}), env, DiagErrMalformed)
	// Token moved to another command id.
	c = good(nil)
	c.id = "some-other-command"
	check("command transplant", c, env, DiagErrCommandMismatch)
	// Path, page and encoding changed after signing.
	c = good(nil)
	c.payload["path"] = filepath.Join(root, "Logs", "deep", "inner.log")
	check("path swap", c, env, DiagErrPathMismatch)
	c = good(nil)
	c.payload["offset"] = 6
	check("offset swap", c, env, DiagErrArgsMismatch)
	c = good(nil)
	c.payload["encoding"] = "base64"
	check("encoding swap", c, env, DiagErrArgsMismatch)
	c = good(nil)
	other2, _ := ecdh.X25519().GenerateKey(rand.Reader)
	c.payload["resultPublicKey"] = base64.StdEncoding.EncodeToString(other2.PublicKey().Bytes())
	check("result key swap", c, env, DiagErrArgsMismatch)
	// A list authorization on a read command.
	check("operation swap", s.build(t, "list", logPath, rec(root), nil, map[string]any{"maxBytes": 262144, "encoding": "text"}, nil), env, DiagErrOperation)
	// Replay.
	once := good(nil)
	check("first use", once, env, "OK")
	check("replay", once, env, DiagErrReplay)
	// No pinned key.
	check("no pinned key", good(nil), DiagGrantEnv{DeviceID: "dev-1", OrgID: "org-1"}, DiagErrSignature)
	// Unknown sensitive class smuggled in (fails parsing before signature).
	c = good(nil)
	c.payload[DiagnosticAuthorizationPayloadKey].(map[string]any)["sensitiveClasses"] = []any{"everything"}
	check("unknown class", c, env, DiagErrMalformed)
}

func TestDiagnosticPathFormsRejected(t *testing.T) {
	for _, p := range []string{
		"relative/path", "/a/../b", "/a/./b", "//server/share/x", `\\?\C:\x`, `\\.\PhysicalDrive0`,
		"/a/b\x00c", "/a/b\nc", "",
	} {
		if err := validateDiagRequestPath(p); err == nil {
			t.Errorf("accepted %q", p)
		}
	}
	if runtime.GOOS == "windows" {
		for _, p := range []string{`C:\x\file.txt::$DATA`, `C:\x\dir.\f`, `C:\x\dir \f`, `C:relative`, "/unix/on/windows"} {
			if err := validateDiagRequestPath(p); err == nil {
				t.Errorf("accepted %q", p)
			}
		}
	} else if err := validateDiagRequestPath(`C:\Users\x`); err == nil {
		t.Error("accepted a Windows path on a non-Windows device")
	}
	for _, p := range []string{"/proc/self/environ", "/dev/sda", "/sys/kernel"} {
		if !isDiagHardDeniedPrefix(p) {
			t.Errorf("%s not hard-denied", p)
		}
	}
	if isDiagHardDeniedPrefix("/home/a/dev/x") || isDiagHardDeniedPrefix("/devices") {
		t.Error("hard-deny prefix matched a non-prefix")
	}
}

func TestDiagnosticListPagination(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	dir := filepath.Join(root, "Logs")
	for i := 0; i < 7; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%02d.log", i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var names []string
	var offset int64
	for page := 0; page < 10; page++ {
		r := s.run(s.build(t, "list", dir, rec(root), nil, map[string]any{"offset": offset, "limit": 4}, nil), "list", env)
		if diagCode(r) != "OK" {
			t.Fatalf("list: %s", r.Error)
		}
		var lr DiagnosticListResponse
		s.open(t, r, &lr)
		for _, e := range lr.Entries {
			names = append(names, e.Name)
		}
		if !lr.Truncated {
			break
		}
		offset = lr.NextOffset
	}
	if len(names) != 9 || names[0] != "app.log" || names[len(names)-1] != "f06.log" {
		t.Fatalf("pages did not cover the directory in order: %v", names)
	}
}

func TestDiagnosticHardDeniedEvenIfNamed(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	base := realTempDir(t)
	cfg := filepath.Join(base, "agentcfg")
	if err := os.MkdirAll(cfg, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg, "secrets.yaml"), []byte("token"), 0o600); err != nil {
		t.Fatal(err)
	}
	orig := agentConfigDirFunc
	agentConfigDirFunc = func() string { return cfg }
	t.Cleanup(func() { agentConfigDirFunc = orig })
	all := []string{DiagClassBrowserSecrets, DiagClassCredentialStore, DiagClassPrivateKeys, DiagClassSessionTokens}
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(cfg, "secrets.yaml"), rec(base), all, nil, nil), "read", env)); got != DiagErrHardDenied {
		t.Fatalf("agent config served under a grant: %s", got)
	}
}

func TestDiagnosticListWithholdsUnapprovedSensitiveChildren(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	chrome := filepath.Join(root, "Chrome")
	r := s.run(s.build(t, "list", chrome, rec(root), nil, nil, nil), "list", env)
	if diagCode(r) != "OK" {
		t.Fatalf("list failed: %s", r.Error)
	}
	var lr DiagnosticListResponse
	s.open(t, r, &lr)
	for _, e := range lr.Entries {
		if strings.EqualFold(e.Name, "Cookies") {
			t.Fatal("unapproved cookie store listed")
		}
	}
	if lr.HiddenSensitive != 1 {
		t.Fatalf("hiddenSensitive = %d, want 1", lr.HiddenSensitive)
	}
	// Named explicitly, it is listed.
	r = s.run(s.build(t, "list", chrome, rec(root), []string{DiagClassBrowserSecrets}, nil, nil), "list", env)
	var lr2 DiagnosticListResponse
	s.open(t, r, &lr2)
	if len(lr2.Entries) != 1 || lr2.HiddenSensitive != 0 {
		t.Fatalf("approved listing: %d entries, %d hidden", len(lr2.Entries), lr2.HiddenSensitive)
	}
}
