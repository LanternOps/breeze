// Package tccdiag explains a macOS TCC denial the desktop helper observes
// (#10300).
//
// #5953 Host B: the TCC rows for /usr/local/bin/breeze-desktop-helper hold
// auth_value=2 (allowed) for Screen Recording and Accessibility, yet the
// helper's own preflight reports denied and macOS raises no consent dialog.
// tccd honours a row only when the requesting code satisfies the code
// requirement stored in the row's csreq, so the row reads "allowed" while
// this binary is refused whenever
//
//   - the binary on disk is not the build the grant was made to (an ad-hoc or
//     unsigned copy, a locally built helper), or
//   - the row was written by the retired TCC self-heal in agents <= 0.105.2
//     (auth_reason=4, csreq NULL), see #3380.
//
// Diagnose turns that into one verdict plus the evidence behind it: the
// running code's signing identity and designated requirement, and for each
// denied service the row for this binary's path, its stored requirement and
// whether this code satisfies it.
//
// Read-only by construction: this package never writes to TCC, never opens a
// capturer or ScreenCaptureKit (#8058), never prompts, and never shells out
// (to sqlite3 or codesign): a subprocess is its own TCC client (#3380). The
// platform layer (diagnosis_darwin.go) reads the signature through
// Security.framework and the database through the system SQLite library,
// in-process, behind the CodeInspector and RowReader interfaces so this file
// is tested on every OS with fakes.
package tccdiag

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// Verdict is the one-word cause of a denial.
type Verdict string

const (
	// VerdictRequirementMismatch: an allowed row exists for this path, but
	// the running code does not satisfy its stored requirement (the helper
	// on disk is not the build the grant was made to).
	VerdictRequirementMismatch Verdict = "requirement_mismatch"
	// VerdictLegacyRowNoCsreq: an allowed row exists with no stored
	// requirement, the shape the retired self-heal wrote (auth_reason=4).
	VerdictLegacyRowNoCsreq Verdict = "legacy_row_no_csreq"
	// VerdictNotGranted: no row for this path, or a row that is not allowed.
	VerdictNotGranted Verdict = "not_granted"
	// VerdictUnexplained: an allowed row whose requirement this code
	// satisfies, yet the check denied. The cause is outside the TCC row
	// (for example the responsible process); the row is not it.
	VerdictUnexplained Verdict = "unexplained"
	// VerdictUnobservable: the row could not be read (no Full Disk Access)
	// or its requirement could not be evaluated.
	VerdictUnobservable Verdict = "unobservable"
)

// verdictRank orders verdicts for the overall verdict: a definite cause
// outranks "the row looks fine", which outranks "could not see".
var verdictRank = map[Verdict]int{
	VerdictRequirementMismatch: 0,
	VerdictLegacyRowNoCsreq:    1,
	VerdictNotGranted:          2,
	VerdictUnexplained:         3,
	VerdictUnobservable:        4,
}

// Service is a TCC service name as stored in the access table.
type Service string

const (
	ServiceScreenCapture Service = "kTCCServiceScreenCapture"
	ServiceAccessibility Service = "kTCCServiceAccessibility"
)

// logKey is the service's short name in log attributes.
func (s Service) logKey() string {
	switch s {
	case ServiceScreenCapture:
		return "screenCapture"
	case ServiceAccessibility:
		return "accessibility"
	}
	return strings.TrimPrefix(string(s), "kTCCService")
}

// tccAuthAllowed is the access table's auth_value for an allowed client
// (0 denied, 1 unknown, 2 allowed, 3 limited).
const tccAuthAllowed = 2

// SigningKind classifies the running code's signature.
type SigningKind string

const (
	// SigningDeveloperID: signed with a Developer ID Application
	// certificate, the shape of every official release helper.
	SigningDeveloperID SigningKind = "developer_id"
	// SigningOther: signed with a certificate identity that is not
	// Developer ID (for example an Apple Development certificate).
	SigningOther SigningKind = "signed_other"
	// SigningAdhoc: ad-hoc signed (codesign -s -, or the linker signature
	// every arm64 binary carries).
	SigningAdhoc SigningKind = "adhoc"
	// SigningUnsigned: no signature at all.
	SigningUnsigned SigningKind = "unsigned"
	// SigningUnknown: the signature could not be read.
	SigningUnknown SigningKind = "unknown"
)

// Signing is the running code's identity.
type Signing struct {
	Kind       SigningKind `json:"kind"`
	Identifier string      `json:"identifier,omitempty"`
	TeamID     string      `json:"teamId,omitempty"`
	CDHash     string      `json:"cdhash,omitempty"`
	// DesignatedRequirement is the code's designated requirement as text,
	// the same form a row's stored csreq decodes to.
	DesignatedRequirement string `json:"designatedRequirement,omitempty"`
	Error                 string `json:"error,omitempty"`
}

// Row is one access-table row.
type Row struct {
	Service    Service
	Client     string
	AuthValue  int
	AuthReason int
	// Csreq is the stored code requirement blob; nil when the column is NULL.
	Csreq []byte
	// LastModified is the row's last_modified, Unix seconds.
	LastModified int64
}

// ServiceDiagnosis is what one service's row says.
type ServiceDiagnosis struct {
	Service Service `json:"service"`
	// Observed: a database answered for this service.
	Observed bool `json:"observed"`
	// Database is "system" or "user": which TCC.db answered.
	Database   string `json:"database,omitempty"`
	Client     string `json:"client,omitempty"`
	RowFound   bool   `json:"rowFound"`
	AuthValue  int    `json:"authValue"`
	AuthReason int    `json:"authReason"`
	// LastModified is the row's last_modified, Unix seconds.
	LastModified int64 `json:"lastModified,omitempty"`
	CsreqNull    bool  `json:"csreqNull"`
	// StoredRequirement is the row's csreq decoded to requirement text.
	StoredRequirement string `json:"storedRequirement,omitempty"`
	// RequirementSatisfied: whether the running code satisfies the stored
	// requirement; nil when there is none or it could not be evaluated.
	RequirementSatisfied *bool   `json:"requirementSatisfied,omitempty"`
	Error                string  `json:"error,omitempty"`
	Verdict              Verdict `json:"verdict"`
}

// Diagnosis is the whole explanation of a denial.
type Diagnosis struct {
	Verdict        Verdict            `json:"verdict"`
	MacOSVersion   string             `json:"macOSVersion,omitempty"`
	MacOSBuild     string             `json:"macOSBuild,omitempty"`
	ExecutablePath string             `json:"executablePath,omitempty"`
	Signing        Signing            `json:"signing"`
	Services       []ServiceDiagnosis `json:"services"`
}

// CodeInspector reads the running process's code signature (Security.framework
// on macOS).
type CodeInspector interface {
	// Signing describes the running code.
	Signing() Signing
	// CheckRequirement decodes a stored csreq blob to its requirement text
	// and reports whether the running code satisfies it. An error means the
	// requirement could not be evaluated, not that it failed.
	CheckRequirement(csreq []byte) (requirement string, satisfied bool, err error)
}

// RowReader reads TCC access rows, read-only.
type RowReader interface {
	// ReadRows returns the rows of the database at path whose client is one
	// of clients and whose service is one of services. An error means the
	// database could not be read (ErrNotReadable when the OS refused it).
	ReadRows(path string, clients []string, services []Service) ([]Row, error)
}

// ErrNotReadable is returned when the OS refuses to open a TCC database: the
// process does not hold Full Disk Access.
var ErrNotReadable = errors.New("TCC database not readable by this process (no Full Disk Access)")

// Env is what Diagnose reads from.
type Env struct {
	Code CodeInspector
	Rows RowReader
	// ExecutablePath is the running binary's path, as reported.
	ExecutablePath string
	// Clients are the access-table client values that identify this binary,
	// most specific first (the path it runs from, then the symlink-resolved
	// path when that differs).
	Clients []string
	// SystemDB and UserDB are the TCC database paths. UserDB may be empty.
	SystemDB, UserDB         string
	MacOSVersion, MacOSBuild string
}

// DeniedServices lists the services a denial covers, given what this
// process's own checks reported.
func DeniedServices(screenCaptureDenied, accessibilityDenied bool) []Service {
	var out []Service
	if screenCaptureDenied {
		out = append(out, ServiceScreenCapture)
	}
	if accessibilityDenied {
		out = append(out, ServiceAccessibility)
	}
	return out
}

// Diagnose explains a denial of services. The system database is
// authoritative for Screen Recording and Accessibility; the user database is
// read only when the system one cannot be, and a service it has no row for
// stays unobservable (absence there proves nothing).
func Diagnose(env Env, services []Service) Diagnosis {
	d := Diagnosis{
		MacOSVersion:   env.MacOSVersion,
		MacOSBuild:     env.MacOSBuild,
		ExecutablePath: env.ExecutablePath,
		Signing:        env.Code.Signing(),
	}

	systemRows, systemErr := env.Rows.ReadRows(env.SystemDB, env.Clients, services)
	var userRows []Row
	var userErr error
	if systemErr != nil {
		if env.UserDB == "" {
			userErr = errors.New("no user TCC database path")
		} else {
			userRows, userErr = env.Rows.ReadRows(env.UserDB, env.Clients, services)
		}
	}

	for _, svc := range services {
		var s ServiceDiagnosis
		switch {
		case systemErr == nil:
			s = diagnoseRow(env, svc, "system", findRow(systemRows, svc, env.Clients))
		case userErr == nil && findRow(userRows, svc, env.Clients) != nil:
			s = diagnoseRow(env, svc, "user", findRow(userRows, svc, env.Clients))
		default:
			s = ServiceDiagnosis{Service: svc, Error: unobservableReason(systemErr, userErr)}
		}
		s.Verdict = deriveServiceVerdict(s)
		d.Services = append(d.Services, s)
	}
	d.Verdict = overallVerdict(d.Services)
	return d
}

func unobservableReason(systemErr, userErr error) string {
	reason := "system TCC database: " + systemErr.Error()
	if userErr != nil {
		return reason + "; user TCC database: " + userErr.Error()
	}
	return reason + "; user TCC database: no row for this binary"
}

// findRow returns the row for svc whose client comes earliest in clients.
func findRow(rows []Row, svc Service, clients []string) *Row {
	var best *Row
	bestIdx := len(clients)
	for i := range rows {
		if rows[i].Service != svc {
			continue
		}
		for idx, c := range clients {
			if rows[i].Client == c && idx < bestIdx {
				best, bestIdx = &rows[i], idx
			}
		}
	}
	return best
}

func diagnoseRow(env Env, svc Service, database string, row *Row) ServiceDiagnosis {
	s := ServiceDiagnosis{Service: svc, Observed: true, Database: database}
	if row == nil {
		return s
	}
	s.RowFound = true
	s.Client = row.Client
	s.AuthValue = row.AuthValue
	s.AuthReason = row.AuthReason
	s.LastModified = row.LastModified
	s.CsreqNull = len(row.Csreq) == 0
	// Evaluate only what can change the verdict: a row that is not allowed
	// is not_granted whatever its requirement says.
	if s.CsreqNull || row.AuthValue != tccAuthAllowed {
		return s
	}
	req, satisfied, err := env.Code.CheckRequirement(row.Csreq)
	s.StoredRequirement = req
	if err != nil {
		s.Error = "evaluate stored requirement: " + err.Error()
		return s
	}
	s.RequirementSatisfied = &satisfied
	return s
}

// deriveServiceVerdict names the cause one service's evidence points to.
func deriveServiceVerdict(s ServiceDiagnosis) Verdict {
	switch {
	case !s.Observed:
		return VerdictUnobservable
	case !s.RowFound, s.AuthValue != tccAuthAllowed:
		return VerdictNotGranted
	case s.CsreqNull:
		return VerdictLegacyRowNoCsreq
	case s.RequirementSatisfied == nil:
		return VerdictUnobservable
	case !*s.RequirementSatisfied:
		return VerdictRequirementMismatch
	default:
		return VerdictUnexplained
	}
}

// overallVerdict is the most definite of the services' verdicts.
func overallVerdict(services []ServiceDiagnosis) Verdict {
	best := VerdictUnobservable
	for _, s := range services {
		if r, ok := verdictRank[s.Verdict]; ok && r < verdictRank[best] {
			best = s.Verdict
		}
	}
	return best
}

// LogAttrs renders the diagnosis as slog key/value pairs for one log line: a
// flat tccVerdict for grepping, and the evidence under a tccDiagnosis group
// (the log shipper flattens groups to dotted field names).
func (d Diagnosis) LogAttrs() []any {
	signing := []any{slog.String("kind", string(d.Signing.Kind))}
	signing = appendNonEmpty(signing,
		"identifier", d.Signing.Identifier,
		"teamId", d.Signing.TeamID,
		"cdhash", d.Signing.CDHash,
		"designatedRequirement", d.Signing.DesignatedRequirement,
		"error", d.Signing.Error,
	)

	group := []any{}
	group = appendNonEmpty(group,
		"macOSVersion", d.MacOSVersion,
		"macOSBuild", d.MacOSBuild,
		"executablePath", d.ExecutablePath,
	)
	group = append(group, slog.Group("signing", signing...))
	for _, s := range d.Services {
		group = append(group, slog.Group(s.Service.logKey(), s.logAttrs()...))
	}
	return []any{
		"tccVerdict", string(d.Verdict),
		slog.Group("tccDiagnosis", group...),
	}
}

func (s ServiceDiagnosis) logAttrs() []any {
	out := []any{slog.String("verdict", string(s.Verdict))}
	if !s.Observed {
		return append(out, slog.String("error", s.Error))
	}
	out = append(out,
		slog.String("database", s.Database),
		slog.Bool("rowFound", s.RowFound),
	)
	if !s.RowFound {
		return out
	}
	satisfied := "unknown"
	if s.RequirementSatisfied != nil {
		satisfied = fmt.Sprintf("%t", *s.RequirementSatisfied)
	}
	out = append(out,
		slog.String("client", s.Client),
		slog.Int("authValue", s.AuthValue),
		slog.Int("authReason", s.AuthReason),
		slog.Bool("csreqNull", s.CsreqNull),
		slog.String("requirementSatisfied", satisfied),
	)
	if s.LastModified > 0 {
		out = append(out, slog.String("lastModified", time.Unix(s.LastModified, 0).UTC().Format(time.RFC3339)))
	}
	return appendNonEmpty(out,
		"storedRequirement", s.StoredRequirement,
		"error", s.Error,
	)
}

// appendNonEmpty appends each key/value pair whose value is non-empty.
func appendNonEmpty(out []any, kv ...string) []any {
	for i := 0; i+1 < len(kv); i += 2 {
		if kv[i+1] != "" {
			out = append(out, slog.String(kv[i], kv[i+1]))
		}
	}
	return out
}
