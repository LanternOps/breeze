package tools

import (
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Grant-mode file access (diag_file_list / diag_file_read). Every command
// carries a server-signed authorization; without a valid one nothing is
// opened. The decision is made on the handle that is then read from:
//
//  1. the requested path must be an ordinary absolute path (no device or
//     namespace prefix, no UNC, no stream syntax, no trailing dot/space);
//  2. it must sit lexically inside an approved root (component boundary);
//  3. the target is opened, and the FINAL path of the opened handle
//     (GetFinalPathNameByHandle on Windows, /proc/self/fd on Linux, F_GETPATH
//     on macOS) must be the requested path itself, compared case-
//     insensitively only where the platform is. A junction, symlink, mount
//     redirection or 8.3 short name anywhere in the path makes the two differ
//     and the request is refused — so no link can move the read elsewhere,
//     including one swapped in between the check and the open, because the
//     answer describes the handle the data is read from;
//  4. the approved root is opened the same way and its final path must also
//     be the root as approved, and the target's final path must lie under the
//     root's final path with exact case, which keeps distinct case-sensitive
//     siblings apart on Windows directories that have case sensitivity on;
//  5. it must not be hard-denied, and it must not fall in any credential-
//     material class (browser secrets, credential stores, private keys,
//     session tokens): those are never readable through a grant;
//  6. a regular file with more than one hard link is refused, since its path
//     names only one of its locations; special files are refused;
//  7. the read or listing is served from that same handle, and the result is
//     sealed to the API's one-time key (diagaccess_seal.go).

const (
	diagMaxReadBytes = 1024 * 1024
	diagMaxListLimit = 5000
	// diagMaxDirScan bounds how many entries a listing will read and sort to
	// page through. A directory beyond it is listed up to the bound and
	// reported as scan-capped rather than making the agent sort an unbounded
	// set on every page.
	diagMaxDirScan = 50000
)

// diagHardDeniedPrefixes are virtual and device filesystems: they hold live
// process memory, environment and raw devices, not diagnostic logs, and are
// never grantable. Anchored prefixes (not fragments), so "C:\Users\x\dev" is
// unaffected.
var diagHardDeniedPrefixes = []string{"/proc", "/sys", "/dev"}

// validateDiagRequestPath rejects path forms the grant model does not accept.
// The API rejects the same forms before signing; this is the agent's own
// copy, because a signed token proves who asked, not that the path is sane.
func validateDiagRequestPath(p string) error {
	if p == "" || len(p) > 4096 {
		return diagErr(DiagErrPathForm, "path must be 1-4096 characters")
	}
	if !utf8.ValidString(p) {
		return diagErr(DiagErrPathForm, "path is not valid UTF-8")
	}
	if err := rejectControl("path", p); err != nil {
		return diagErr(DiagErrPathForm, "path contains a control character")
	}
	norm := strings.ReplaceAll(p, "\\", "/")
	for _, seg := range strings.Split(norm, "/") {
		if seg == ".." || seg == "." {
			return diagErr(DiagErrPathForm, "path may not contain . or .. segments")
		}
	}
	if strings.HasPrefix(norm, "//") {
		return diagErr(DiagErrPathForm, "UNC, device and namespace paths are not accepted")
	}
	if len(p) >= 2 && p[1] == ':' {
		c := p[0] | 0x20
		if c < 'a' || c > 'z' || len(p) < 3 || (p[2] != '\\' && p[2] != '/') {
			return diagErr(DiagErrPathForm, "Windows paths must be absolute (X:\\...)")
		}
		if strings.Contains(p[2:], ":") {
			return diagErr(DiagErrPathForm, "NTFS stream syntax is not accepted")
		}
		for _, seg := range strings.Split(norm[3:], "/") {
			if seg != "" && (strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ")) {
				return diagErr(DiagErrPathForm, "path components may not end in a dot or space")
			}
		}
		if runtime.GOOS != "windows" {
			return diagErr(DiagErrPathForm, "a Windows path was sent to a non-Windows device")
		}
		return nil
	}
	if !strings.HasPrefix(p, "/") {
		return diagErr(DiagErrPathForm, "path must be absolute")
	}
	if runtime.GOOS == "windows" {
		return diagErr(DiagErrPathForm, "Windows paths must be absolute (X:\\...)")
	}
	return nil
}

// diagCaseInsensitive reports whether path names on this platform compare
// without regard to case by default (NTFS; APFS/HFS+ default volumes).
func diagCaseInsensitive() bool {
	return runtime.GOOS == "windows" || runtime.GOOS == "darwin"
}

// diagSlash folds separators, collapses doubled slashes and drops a trailing
// slash (except for the root itself).
func diagSlash(p string) string {
	k := strings.ReplaceAll(p, "\\", "/")
	for strings.Contains(k, "//") {
		k = strings.ReplaceAll(k, "//", "/")
	}
	if len(k) > 1 && strings.HasSuffix(k, "/") && (len(k) != 3 || k[1] != ':') {
		k = strings.TrimSuffix(k, "/")
	}
	return k
}

func diagFold(p string) string {
	k := diagSlash(p)
	if diagCaseInsensitive() {
		k = strings.ToLower(k)
	}
	return k
}

// diagWithin reports whether target is root itself or below it (component
// boundary), and whether it is root or one of its direct children.
func diagWithin(rootKey, targetKey string) (within bool, directChild bool) {
	if targetKey == rootKey {
		return true, true
	}
	prefix := rootKey
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	if !strings.HasPrefix(targetKey, prefix) {
		return false, false
	}
	rest := targetKey[len(prefix):]
	return true, !strings.Contains(rest, "/")
}

func classifyOpenErr(err error, what string) *DiagError {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return diagErr(DiagErrNotFound, "%s does not exist", what)
	case errors.Is(err, fs.ErrPermission):
		return diagErr(DiagErrPermissionDenied, "the operating system denied access to %s", what)
	default:
		return diagErr(DiagErrIO, "could not open %s: %v", what, err)
	}
}

// openFinal opens p and returns the handle and its final path, refusing when
// the final path is not p itself (a link, junction, mount redirection or
// short name was traversed).
func openFinal(p, what string) (*os.File, string, error) {
	f, err := os.OpenFile(filepath.Clean(p), os.O_RDONLY|diagOpenFlags, 0)
	if err != nil {
		return nil, "", classifyOpenErr(err, what)
	}
	final, err := finalPathOfFile(f)
	if err != nil {
		_ = f.Close()
		if errors.Is(err, errDiagUnsupported) {
			return nil, "", diagErr(DiagErrNotSupported, "this platform cannot verify where an opened path leads")
		}
		return nil, "", diagErr(DiagErrIO, "could not determine where %s leads: %v", what, err)
	}
	if diagFold(final) != diagFold(p) {
		_ = f.Close()
		return nil, "", diagErr(DiagErrLinkRefused,
			"%s resolves to %s through a link, junction or alternate name; request the resolved location directly", what, final)
	}
	return f, final, nil
}

// diagScopeMatch is the approved root that covers a request.
type diagScopeMatch struct {
	root   DiagGrantRoot
	direct bool
}

// lexicalScope finds the approved root that lexically covers requestPath.
// The most specific (longest) root wins, so a recursive grant on a parent
// is not shadowed by a non-recursive grant on a child.
func lexicalScope(a *DiagnosticAuthorization, requestPath string) (diagScopeMatch, bool) {
	target := diagFold(requestPath)
	var best diagScopeMatch
	bestLen := -1
	for _, root := range a.Roots {
		if validateDiagRequestPath(root.Path) != nil {
			continue
		}
		rk := diagFold(root.Path)
		within, direct := diagWithin(rk, target)
		if !within {
			continue
		}
		if !root.Recursive && !direct {
			continue
		}
		if len(rk) > bestLen || (len(rk) == bestLen && root.Recursive) {
			best = diagScopeMatch{root: root, direct: direct}
			bestLen = len(rk)
		}
	}
	return best, bestLen >= 0
}

func isDiagHardDeniedPrefix(p string) bool {
	k := diagSlash(p)
	for _, pre := range diagHardDeniedPrefixes {
		if k == pre || strings.HasPrefix(k, pre+"/") {
			return true
		}
	}
	return false
}

// openDiagTarget performs steps 1-6 and returns the open handle, its final
// path and its info. The caller owns the handle.
func openDiagTarget(a *DiagnosticAuthorization, requestPath, operation string) (*os.File, string, os.FileInfo, error) {
	if err := validateDiagRequestPath(requestPath); err != nil {
		return nil, "", nil, err
	}
	if isDiagHardDeniedPrefix(requestPath) {
		return nil, "", nil, diagErr(DiagErrHardDenied, "virtual and device filesystems are never readable through a grant")
	}
	// Refuse outright what the grant can never cover, before touching it.
	if hard, _ := ClassifyDiagnosticPath(requestPath); hard {
		return nil, "", nil, diagErr(DiagErrHardDenied, "the agent's own configuration is never readable through a grant")
	}
	match, ok := lexicalScope(a, requestPath)
	if !ok {
		return nil, "", nil, diagErr(DiagErrOutOfScope, "%s is outside the approved locations", requestPath)
	}

	// The root must still be the directory that was approved: not replaced by
	// a junction or link since approval. Its handle is only held for the
	// comparison; the target's own final path is what proves containment.
	rootFile, rootFinal, err := openFinal(match.root.Path, "the approved location")
	if err != nil {
		return nil, "", nil, err
	}
	rootMount, err := mountIdentityOfFile(rootFile)
	_ = rootFile.Close()
	if err != nil {
		if errors.Is(err, errDiagUnsupported) {
			return nil, "", nil, diagErr(DiagErrNotSupported, "this platform cannot verify which mount a path is on")
		}
		return nil, "", nil, diagErr(DiagErrIO, "could not identify the approved location's mount: %v", err)
	}

	f, final, err := openFinal(requestPath, "the requested path")
	if err != nil {
		return nil, "", nil, err
	}
	fail := func(e error) (*os.File, string, os.FileInfo, error) {
		_ = f.Close()
		return nil, "", nil, e
	}
	// A bind mount (or a volume mounted into a folder) keeps the path
	// spelling of its mountpoint, so final-path equality cannot see it. The
	// target must sit on the same mount as the approved root.
	if targetMount, err := mountIdentityOfFile(f); err != nil {
		return fail(diagErr(DiagErrIO, "could not identify the requested path's mount: %v", err))
	} else if targetMount != rootMount {
		return fail(diagErr(DiagErrLinkRefused, "%s is on a different mount than the approved location; request that mount's path directly", final))
	}
	info, err := f.Stat()
	if err != nil {
		return fail(diagErr(DiagErrIO, "could not stat the opened file: %v", err))
	}

	// Exact-case containment on the two final paths.
	within, direct := diagWithin(diagSlash(rootFinal), diagSlash(final))
	if !within {
		return fail(diagErr(DiagErrOutOfScope, "the path resolves outside the approved location (resolved to %s)", final))
	}
	if !match.root.Recursive {
		// Non-recursive: the location itself, and files directly inside it.
		isRoot := diagSlash(final) == diagSlash(rootFinal)
		if !isRoot && (!direct || info.IsDir()) {
			return fail(diagErr(DiagErrOutOfScope, "the approval for %s is not recursive; only it and the files directly inside it are covered", match.root.Path))
		}
	}
	if operation == "list" && !info.IsDir() {
		return fail(diagErr(DiagErrNotADirectory, "%s is not a directory; use read", final))
	}
	if operation == "read" {
		if info.IsDir() {
			return fail(diagErr(DiagErrNotAFile, "%s is a directory; use list", final))
		}
		if !info.Mode().IsRegular() {
			return fail(diagErr(DiagErrNotAFile, "%s is not a regular file", final))
		}
	}

	for _, candidate := range []string{requestPath, final} {
		if isDiagHardDeniedPrefix(candidate) {
			return fail(diagErr(DiagErrHardDenied, "virtual and device filesystems are never readable through a grant"))
		}
		hard, classes := ClassifyDiagnosticPath(candidate)
		if hard {
			return fail(diagErr(DiagErrHardDenied, "the agent's own configuration is never readable through a grant"))
		}
		if len(classes) > 0 {
			return fail(diagErr(DiagErrCredentialMaterial,
				"%s holds credential material (%s) and is never readable through a grant", final, strings.Join(classes, ", ")))
		}
	}
	// Safety net: anything the existing sensitive-path deny-list protects is
	// refused too, so a drift between the two lists can only ever refuse more.
	if isSensitiveReadPath(final) || isSensitiveReadPath(requestPath) {
		return fail(diagErr(DiagErrCredentialMaterial, "%s is a protected location and is never readable through a grant", final))
	}

	if info.Mode().IsRegular() {
		n, err := linkCountOfFile(f, info)
		if err != nil {
			return fail(diagErr(DiagErrIO, "could not read the file's link count: %v", err))
		}
		if n > 1 {
			return fail(diagErr(DiagErrLinkRefused, "the file has %d hard links; its other locations cannot be checked", n))
		}
	}
	return f, final, info, nil
}

// diagResultError turns any error into a CommandResult with a coded message.
func diagResultError(err error, start time.Time) CommandResult {
	var de *DiagError
	if !errors.As(err, &de) {
		de = diagErr(DiagErrIO, "%v", err)
	}
	return NewErrorResult(de, time.Since(start).Milliseconds())
}

// diagResolvedMarker separates the resolved target from the message on a
// failure that happened after the target was opened and contained, so the API
// can audit where the attempt actually landed (apps/api diagnosticAccess/errors.ts).
const diagResolvedMarker = " | resolved: "

func diagResultErrorAt(de *DiagError, final string, start time.Time) CommandResult {
	de.Msg = de.Msg + diagResolvedMarker + final
	return diagResultError(de, start)
}

func diagSealedResult(a *DiagnosticAuthorization, body any, start time.Time) CommandResult {
	sealed, err := sealDiagResult(a.ResultPublicKey, a.AuthorizationID, body)
	if err != nil {
		return diagResultError(err, start)
	}
	return NewSuccessResult(sealed, time.Since(start).Milliseconds())
}

// DiagnosticReadResponse is a bounded read of one file (sealed on the wire).
type DiagnosticReadResponse struct {
	Path            string `json:"path"`
	ResolvedPath    string `json:"resolvedPath"`
	GrantID         string `json:"grantId"`
	AuthorizationID string `json:"authorizationId"`
	Size            int64  `json:"size"`
	Offset          int64  `json:"offset"`
	BytesRead       int    `json:"bytesRead"`
	NextOffset      int64  `json:"nextOffset"`
	EOF             bool   `json:"eof"`
	Encoding        string `json:"encoding"`
	Content         string `json:"content"`
	Modified        string `json:"modified"`
}

// DiagnosticListResponse is one page of a directory listing (sealed on the wire).
type DiagnosticListResponse struct {
	Path            string      `json:"path"`
	ResolvedPath    string      `json:"resolvedPath"`
	GrantID         string      `json:"grantId"`
	AuthorizationID string      `json:"authorizationId"`
	Entries         []FileEntry `json:"entries"`
	Offset          int64       `json:"offset"`
	Limit           int64       `json:"limit"`
	NextOffset      int64       `json:"nextOffset"`
	Truncated       bool        `json:"truncated"`
	ScanCapped      bool        `json:"scanCapped"`
	// HiddenSensitive counts children withheld because they hold credential
	// material or are otherwise never readable through a grant.
	HiddenSensitive int `json:"hiddenSensitive"`
}

func diagArgs(commandID string, payload map[string]any) DiagCommandArgs {
	return DiagCommandArgs{
		CommandID:       commandID,
		Path:            GetPayloadString(payload, "path", ""),
		Offset:          int64(GetPayloadInt(payload, "offset", 0)),
		MaxBytes:        int64(GetPayloadInt(payload, "maxBytes", 0)),
		Limit:           int64(GetPayloadInt(payload, "limit", 0)),
		Encoding:        GetPayloadString(payload, "encoding", ""),
		ResultPublicKey: GetPayloadString(payload, "resultPublicKey", ""),
	}
}

func verifyDiagCommand(commandID string, payload map[string]any, env DiagGrantEnv, operation string) (*DiagnosticAuthorization, DiagCommandArgs, error) {
	args := diagArgs(commandID, payload)
	a, present, err := ParseDiagnosticAuthorization(payload)
	if err != nil {
		return nil, args, err
	}
	if !present {
		return nil, args, diagErr(DiagErrMalformed, "a diagnostic read requires a signed authorization")
	}
	if err := VerifyDiagnosticAuthorization(a, env, operation, args); err != nil {
		return nil, args, err
	}
	return a, args, nil
}

// DiagnosticReadFile serves diag_file_read.
func DiagnosticReadFile(commandID string, payload map[string]any, env DiagGrantEnv) CommandResult {
	start := time.Now()
	a, args, err := verifyDiagCommand(commandID, payload, env, "read")
	if err != nil {
		return diagResultError(err, start)
	}
	if args.Encoding != "text" && args.Encoding != "base64" {
		return diagResultError(diagErr(DiagErrMalformed, "unsupported encoding %q", args.Encoding), start)
	}
	if args.Offset < 0 || args.MaxBytes < 1 || args.MaxBytes > diagMaxReadBytes {
		return diagResultError(diagErr(DiagErrMalformed, "offset must be >= 0 and maxBytes 1-%d", diagMaxReadBytes), start)
	}

	f, final, info, err := openDiagTarget(a, args.Path, "read")
	if err != nil {
		return diagResultError(err, start)
	}
	defer func() { _ = f.Close() }()

	buf := make([]byte, args.MaxBytes)
	n, rerr := f.ReadAt(buf, args.Offset)
	if rerr != nil && !errors.Is(rerr, io.EOF) {
		if errors.Is(rerr, fs.ErrPermission) {
			return diagResultErrorAt(diagErr(DiagErrPermissionDenied, "the operating system denied reading the file"), final, start)
		}
		return diagResultErrorAt(diagErr(DiagErrIO, "read failed: %v", rerr), final, start)
	}
	buf = buf[:n]
	size := info.Size()
	if st, err := f.Stat(); err == nil {
		size = st.Size() // a growing log: its size as of now
	}
	next := args.Offset + int64(n)
	content := string(buf)
	if args.Encoding == "base64" {
		content = base64.StdEncoding.EncodeToString(buf)
	}
	return diagSealedResult(a, DiagnosticReadResponse{
		Path:            args.Path,
		ResolvedPath:    final,
		GrantID:         a.GrantID,
		AuthorizationID: a.AuthorizationID,
		Size:            size,
		Offset:          args.Offset,
		BytesRead:       n,
		NextOffset:      next,
		EOF:             next >= size,
		Encoding:        args.Encoding,
		Content:         content,
		Modified:        info.ModTime().Format(time.RFC3339),
	}, start)
}

// DiagnosticListFiles serves diag_file_list.
func DiagnosticListFiles(commandID string, payload map[string]any, env DiagGrantEnv) CommandResult {
	start := time.Now()
	a, args, err := verifyDiagCommand(commandID, payload, env, "list")
	if err != nil {
		return diagResultError(err, start)
	}
	if args.Offset < 0 || args.Limit < 1 || args.Limit > diagMaxListLimit {
		return diagResultError(diagErr(DiagErrMalformed, "offset must be >= 0 and limit 1-%d", diagMaxListLimit), start)
	}

	f, final, _, err := openDiagTarget(a, args.Path, "list")
	if err != nil {
		return diagResultError(err, start)
	}
	defer func() { _ = f.Close() }()

	entries, rerr := f.ReadDir(diagMaxDirScan + 1)
	if rerr != nil && !errors.Is(rerr, io.EOF) {
		if errors.Is(rerr, fs.ErrPermission) {
			return diagResultErrorAt(diagErr(DiagErrPermissionDenied, "the operating system denied listing the directory"), final, start)
		}
		return diagResultErrorAt(diagErr(DiagErrIO, "listing failed: %v", rerr), final, start)
	}
	scanCapped := false
	if len(entries) > diagMaxDirScan {
		entries = entries[:diagMaxDirScan]
		scanCapped = true
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	// Children that hold credential material (or that are never readable) are
	// left out of the listing entirely: even their names, sizes and times are
	// not part of a diagnostic grant. Filtered before paging so offsets stay
	// stable.
	hidden := 0
	visible := entries[:0]
	for _, entry := range entries {
		child := filepath.Join(final, entry.Name())
		hard, classes := ClassifyDiagnosticPath(child)
		if hard || len(classes) > 0 || isDiagHardDeniedPrefix(child) || isSensitiveReadPath(child) {
			hidden++
			continue
		}
		visible = append(visible, entry)
	}
	entries = visible

	out := []FileEntry{}
	if args.Offset < int64(len(entries)) {
		end := args.Offset + args.Limit
		if end > int64(len(entries)) {
			end = int64(len(entries))
		}
		for _, entry := range entries[args.Offset:end] {
			// Lstat semantics: a link or junction is reported, never followed.
			info, err := entry.Info()
			entryPath := filepath.Join(final, entry.Name())
			fe := FileEntry{Name: entry.Name(), Path: entryPath, Type: "file"}
			if err == nil {
				switch {
				case info.Mode()&fs.ModeSymlink != 0 || isReparsePoint(info):
					fe.Type = "link"
				case info.IsDir():
					fe.Type = "directory"
				case !info.Mode().IsRegular():
					fe.Type = "special"
				}
				fe.Size = info.Size()
				fe.Modified = info.ModTime().Format(time.RFC3339)
				fe.Permissions = info.Mode().String()
			} else {
				fe.Type = "unknown"
			}
			out = append(out, fe)
		}
	}
	next := args.Offset + int64(len(out))
	return diagSealedResult(a, DiagnosticListResponse{
		Path:            args.Path,
		ResolvedPath:    final,
		GrantID:         a.GrantID,
		AuthorizationID: a.AuthorizationID,
		Entries:         out,
		Offset:          args.Offset,
		Limit:           args.Limit,
		NextOffset:      next,
		Truncated:       next < int64(len(entries)),
		ScanCapped:      scanCapped,
		HiddenSensitive: hidden,
	}, start)
}
