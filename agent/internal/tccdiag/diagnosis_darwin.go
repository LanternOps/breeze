//go:build darwin && cgo

package tccdiag

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation -lsqlite3
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <sqlite3.h>
#include <stdlib.h>
#include <string.h>

// breeze_cfstring_dup copies a CFString to a malloc'd UTF-8 C string, or NULL.
static char *breeze_cfstring_dup(CFStringRef s) {
	if (s == NULL || CFGetTypeID(s) != CFStringGetTypeID()) {
		return NULL;
	}
	CFIndex max = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), kCFStringEncodingUTF8) + 1;
	char *buf = malloc((size_t)max);
	if (buf == NULL) {
		return NULL;
	}
	if (!CFStringGetCString(s, buf, max, kCFStringEncodingUTF8)) {
		free(buf);
		return NULL;
	}
	return buf;
}

// breeze_requirement_text renders a requirement as text, or NULL.
static char *breeze_requirement_text(SecRequirementRef req) {
	CFStringRef text = NULL;
	if (SecRequirementCopyString(req, kSecCSDefaultFlags, &text) != errSecSuccess || text == NULL) {
		return NULL;
	}
	char *out = breeze_cfstring_dup(text);
	CFRelease(text);
	return out;
}

typedef struct {
	OSStatus selfStatus;     // SecCodeCopySelf / SecCodeCopyStaticCode
	OSStatus infoStatus;     // SecCodeCopySigningInformation
	OSStatus drStatus;       // SecCodeCopyDesignatedRequirement
	OSStatus devIDStatus;    // SecCodeCheckValidity against the Developer ID requirement
	int hasFlags;
	uint32_t flags;
	char *identifier;
	char *teamID;
	char *designated;
	unsigned char cdhash[64];
	int cdhashLen;
} breeze_signing_t;

// The Developer ID Application shape: Apple's anchor, the Developer ID CA
// intermediate, and the Developer ID Application leaf marker.
static const char *breezeDeveloperIDRequirement =
	"anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] "
	"and certificate leaf[field.1.2.840.113635.100.6.1.13]";

static void breeze_self_signing(breeze_signing_t *out) {
	memset(out, 0, sizeof(*out));
	SecCodeRef code = NULL;
	out->selfStatus = SecCodeCopySelf(kSecCSDefaultFlags, &code);
	if (out->selfStatus != errSecSuccess) {
		return;
	}
	SecStaticCodeRef staticCode = NULL;
	out->selfStatus = SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &staticCode);
	if (out->selfStatus != errSecSuccess) {
		CFRelease(code);
		return;
	}

	CFDictionaryRef info = NULL;
	out->infoStatus = SecCodeCopySigningInformation(staticCode, kSecCSSigningInformation, &info);
	if (out->infoStatus == errSecSuccess && info != NULL) {
		out->identifier = breeze_cfstring_dup((CFStringRef)CFDictionaryGetValue(info, kSecCodeInfoIdentifier));
		out->teamID = breeze_cfstring_dup((CFStringRef)CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier));
		CFNumberRef flags = (CFNumberRef)CFDictionaryGetValue(info, kSecCodeInfoFlags);
		if (flags != NULL && CFGetTypeID(flags) == CFNumberGetTypeID()) {
			out->hasFlags = CFNumberGetValue(flags, kCFNumberSInt32Type, &out->flags) ? 1 : 0;
		}
		CFDataRef unique = (CFDataRef)CFDictionaryGetValue(info, kSecCodeInfoUnique);
		if (unique != NULL && CFGetTypeID(unique) == CFDataGetTypeID()) {
			CFIndex n = CFDataGetLength(unique);
			if (n > (CFIndex)sizeof(out->cdhash)) {
				n = (CFIndex)sizeof(out->cdhash);
			}
			CFDataGetBytes(unique, CFRangeMake(0, n), out->cdhash);
			out->cdhashLen = (int)n;
		}
	}
	if (info != NULL) {
		CFRelease(info);
	}

	SecRequirementRef dr = NULL;
	out->drStatus = SecCodeCopyDesignatedRequirement(staticCode, kSecCSDefaultFlags, &dr);
	if (out->drStatus == errSecSuccess && dr != NULL) {
		out->designated = breeze_requirement_text(dr);
	}
	if (dr != NULL) {
		CFRelease(dr);
	}

	CFStringRef devIDText = CFStringCreateWithCString(NULL, breezeDeveloperIDRequirement, kCFStringEncodingUTF8);
	SecRequirementRef devID = NULL;
	out->devIDStatus = SecRequirementCreateWithString(devIDText, kSecCSDefaultFlags, &devID);
	if (out->devIDStatus == errSecSuccess) {
		out->devIDStatus = SecCodeCheckValidity(code, kSecCSDefaultFlags, devID);
	}
	if (devID != NULL) {
		CFRelease(devID);
	}
	if (devIDText != NULL) {
		CFRelease(devIDText);
	}
	CFRelease(staticCode);
	CFRelease(code);
}

static void breeze_signing_free(breeze_signing_t *s) {
	free(s->identifier);
	free(s->teamID);
	free(s->designated);
}

// breeze_check_csreq decodes a stored csreq blob and checks the running code
// against it. *text receives the requirement text (caller frees), or NULL.
// Returns the status of the first call that failed: errSecSuccess means the
// code satisfies the requirement. *stage is 1 when decoding failed, 2 when
// the validity check did.
static OSStatus breeze_check_csreq(const void *blob, int len, char **text, int *stage) {
	*text = NULL;
	*stage = 1;
	CFDataRef data = CFDataCreate(NULL, (const UInt8 *)blob, (CFIndex)len);
	if (data == NULL) {
		return errSecAllocate;
	}
	SecRequirementRef req = NULL;
	OSStatus st = SecRequirementCreateWithData(data, kSecCSDefaultFlags, &req);
	CFRelease(data);
	if (st != errSecSuccess) {
		return st;
	}
	*text = breeze_requirement_text(req);
	*stage = 2;
	SecCodeRef code = NULL;
	st = SecCodeCopySelf(kSecCSDefaultFlags, &code);
	if (st == errSecSuccess) {
		st = SecCodeCheckValidity(code, kSecCSDefaultFlags, req);
		CFRelease(code);
	}
	CFRelease(req);
	return st;
}

static int breeze_sqlite_open_ro(const char *path, sqlite3 **db) {
	int rc = sqlite3_open_v2(path, db, SQLITE_OPEN_READONLY, NULL);
	if (rc == SQLITE_OK) {
		sqlite3_busy_timeout(*db, 1000);
	}
	return rc;
}

static int breeze_sqlite_bind_text(sqlite3_stmt *st, int idx, const char *s) {
	return sqlite3_bind_text(st, idx, s, -1, SQLITE_TRANSIENT);
}
*/
import "C"

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Supported reports whether this build can diagnose (darwin with cgo).
const Supported = true

// SystemTCCDatabase is the system TCC database: Screen Recording and
// Accessibility grants live here.
const SystemTCCDatabase = "/Library/Application Support/com.apple.TCC/TCC.db"

// Run diagnoses a denial of services for the running process.
func Run(services []Service) Diagnosis {
	exe, _ := os.Executable()
	var userDB string
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		userDB = filepath.Join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db")
	}
	version, _ := unix.Sysctl("kern.osproductversion")
	build, _ := unix.Sysctl("kern.osversion")
	return Diagnose(Env{
		Code:           securityInspector{},
		Rows:           sqliteRowReader{},
		ExecutablePath: exe,
		Clients:        clientCandidates(exe),
		SystemDB:       SystemTCCDatabase,
		UserDB:         userDB,
		MacOSVersion:   version,
		MacOSBuild:     build,
	}, services)
}

// clientCandidates are the access-table client values for a path-keyed
// binary: the path as reported, then the symlink-resolved path.
func clientCandidates(exe string) []string {
	if exe == "" {
		return nil
	}
	out := []string{exe}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil && resolved != exe {
		out = append(out, resolved)
	}
	return out
}

// securityInspector reads the running code through Security.framework.
type securityInspector struct{}

var (
	selfSigningOnce sync.Once
	selfSigning     Signing
)

// Signing is computed once per process: the running code cannot change.
func (securityInspector) Signing() Signing {
	selfSigningOnce.Do(func() { selfSigning = readSelfSigning() })
	return selfSigning
}

func readSelfSigning() Signing {
	var raw C.breeze_signing_t
	C.breeze_self_signing(&raw)
	defer C.breeze_signing_free(&raw)

	if raw.selfStatus != 0 {
		return Signing{Kind: SigningUnknown, Error: fmt.Sprintf("SecCodeCopySelf: OSStatus %d", int32(raw.selfStatus))}
	}
	s := Signing{
		Identifier:            goString(raw.identifier),
		TeamID:                goString(raw.teamID),
		DesignatedRequirement: goString(raw.designated),
	}
	if raw.cdhashLen > 0 {
		s.CDHash = hex.EncodeToString(C.GoBytes(unsafe.Pointer(&raw.cdhash[0]), raw.cdhashLen))
	}
	var problems []string
	if raw.infoStatus != 0 {
		problems = append(problems, fmt.Sprintf("SecCodeCopySigningInformation: OSStatus %d", int32(raw.infoStatus)))
	}
	if raw.drStatus != 0 && raw.drStatus != errSecCSUnsigned {
		problems = append(problems, fmt.Sprintf("SecCodeCopyDesignatedRequirement: OSStatus %d", int32(raw.drStatus)))
	}
	s.Kind = classifySigning(signingFacts{
		infoOK:        raw.infoStatus == 0,
		drUnsigned:    raw.drStatus == errSecCSUnsigned,
		hasIdentifier: s.Identifier != "",
		hasFlags:      raw.hasFlags != 0,
		adhoc:         raw.hasFlags != 0 && raw.flags&kSecCodeSigAdhoc != 0,
		devIDStatus:   int32(raw.devIDStatus),
	})
	if s.Kind == SigningUnknown && raw.devIDStatus != 0 && raw.devIDStatus != errSecCSReqFailed && raw.devIDStatus != errSecCSUnsigned {
		problems = append(problems, fmt.Sprintf("SecCodeCheckValidity(Developer ID): OSStatus %d", int32(raw.devIDStatus)))
	}
	s.Error = strings.Join(problems, "; ")
	return s
}

// CheckRequirement decodes csreq and checks the running code against it. A
// requirement failure and an unsigned binary both mean "not satisfied"; any
// other status is an evaluation error.
func (securityInspector) CheckRequirement(csreq []byte) (string, bool, error) {
	if len(csreq) == 0 {
		return "", false, errors.New("empty csreq")
	}
	var text *C.char
	var stage C.int
	blob := C.CBytes(csreq)
	defer C.free(blob)
	status := int32(C.breeze_check_csreq(blob, C.int(len(csreq)), &text, &stage))
	req := goString(text)
	C.free(unsafe.Pointer(text))
	satisfied, err := interpretRequirementStatus(status, int(stage))
	return req, satisfied, err
}

// sqliteRowReader reads TCC.db through the system SQLite library, read-only
// and in-process (never the sqlite3 tool, #3380).
type sqliteRowReader struct{}

func (sqliteRowReader) ReadRows(path string, clients []string, services []Service) ([]Row, error) {
	if len(clients) == 0 || len(services) == 0 {
		return nil, nil
	}
	// Open the file first for a clean errno: TCC refuses with EPERM, which
	// SQLite reports only as "unable to open database file".
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return nil, ErrNotReadable
		}
		return nil, err
	}
	_ = f.Close()

	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	var db *C.sqlite3
	if rc := C.breeze_sqlite_open_ro(cPath, &db); rc != C.SQLITE_OK {
		err := sqliteError("open", db, rc)
		C.sqlite3_close(db)
		return nil, err
	}
	defer C.sqlite3_close(db)

	query := buildRowQuery(len(clients), len(services))
	cQuery := C.CString(query)
	defer C.free(unsafe.Pointer(cQuery))
	var stmt *C.sqlite3_stmt
	if rc := C.sqlite3_prepare_v2(db, cQuery, -1, &stmt, nil); rc != C.SQLITE_OK {
		return nil, sqliteError("prepare", db, rc)
	}
	defer C.sqlite3_finalize(stmt)

	idx := C.int(1)
	bind := func(v string) error {
		cv := C.CString(v)
		defer C.free(unsafe.Pointer(cv))
		if rc := C.breeze_sqlite_bind_text(stmt, idx, cv); rc != C.SQLITE_OK {
			return sqliteError("bind", db, rc)
		}
		idx++
		return nil
	}
	for _, c := range clients {
		if err := bind(c); err != nil {
			return nil, err
		}
	}
	for _, s := range services {
		if err := bind(string(s)); err != nil {
			return nil, err
		}
	}

	var rows []Row
	for {
		rc := C.sqlite3_step(stmt)
		if rc == C.SQLITE_DONE {
			return rows, nil
		}
		if rc != C.SQLITE_ROW {
			return nil, sqliteError("step", db, rc)
		}
		r := Row{
			Service:      Service(columnText(stmt, 0)),
			Client:       columnText(stmt, 1),
			AuthValue:    int(C.sqlite3_column_int64(stmt, 2)),
			AuthReason:   int(C.sqlite3_column_int64(stmt, 3)),
			LastModified: int64(C.sqlite3_column_int64(stmt, 5)),
		}
		if C.sqlite3_column_type(stmt, 4) != C.SQLITE_NULL {
			// column_blob before column_bytes, per the SQLite docs.
			p := C.sqlite3_column_blob(stmt, 4)
			n := C.sqlite3_column_bytes(stmt, 4)
			if p != nil && n > 0 {
				r.Csreq = C.GoBytes(p, n)
			}
		}
		rows = append(rows, r)
	}
}

func columnText(stmt *C.sqlite3_stmt, col C.int) string {
	p := C.sqlite3_column_text(stmt, col)
	if p == nil {
		return ""
	}
	return C.GoString((*C.char)(unsafe.Pointer(p)))
}

func sqliteError(op string, db *C.sqlite3, rc C.int) error {
	msg := C.GoString(C.sqlite3_errstr(rc))
	if db != nil {
		msg = C.GoString(C.sqlite3_errmsg(db))
	}
	return fmt.Errorf("sqlite %s: %s (rc %d)", op, msg, int(rc))
}

func goString(p *C.char) string {
	if p == nil {
		return ""
	}
	return C.GoString(p)
}
