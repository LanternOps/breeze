//go:build darwin

package tcc

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("tcc")

// systemTCCDBPath is the system-level TCC database managed by macOS.
// Only processes with Full Disk Access (or root) can write to it.
const systemTCCDBPath = "/Library/Application Support/com.apple.TCC/TCC.db"

// agentBinaryPath is the installed location of the Breeze agent.
const agentBinaryPath = "/usr/local/bin/breeze-agent"

// tccService represents a macOS TCC service identifier.
type tccService struct {
	Name    string // Human-readable name for logging
	Service string // TCC service identifier (e.g. kTCCServiceScreenCapture)
}

// services lists the TCC permissions we need to grant.
var services = []tccService{
	{Name: "Screen Recording", Service: "kTCCServiceScreenCapture"},
	{Name: "Accessibility", Service: "kTCCServiceAccessibility"},
}

// GrantResult holds the outcome of a TCC grant attempt for a single service.
type GrantResult struct {
	Service string
	Name    string
	Granted bool
	Already bool  // true if permission was already present
	Err     error // non-nil if the grant failed
}

// EnsurePermissions checks whether the required TCC permissions are granted
// for the agent binary and inserts them into the system TCC database if not.
// This must be called as root (the main daemon has FDA).
//
// It returns a slice of results -- one per service -- and a summary error if
// any grants failed. Individual failures are logged but do not prevent
// attempts on remaining services.
func EnsurePermissions() ([]GrantResult, error) {
	// Verify we're running as root
	if os.Getuid() != 0 {
		return nil, fmt.Errorf("TCC grant requires root (current uid=%d)", os.Getuid())
	}

	// Verify sqlite3 is available on PATH
	if _, err := exec.LookPath("sqlite3"); err != nil {
		return nil, fmt.Errorf("sqlite3 not found — required for TCC auto-grant: %w", err)
	}

	// Verify the TCC database exists and is readable (i.e. we have FDA)
	if _, err := os.Stat(systemTCCDBPath); err != nil {
		return nil, fmt.Errorf("cannot access TCC database at %s: %w", systemTCCDBPath, err)
	}

	// Verify the agent binary exists
	if _, err := os.Stat(agentBinaryPath); err != nil {
		return nil, fmt.Errorf("agent binary not found at %s: %w", agentBinaryPath, err)
	}

	// Detect the TCC database schema to use the right INSERT statement
	columns, err := detectTCCSchema()
	if err != nil {
		return nil, fmt.Errorf("failed to detect TCC database schema: %w", err)
	}
	log.Info("detected TCC database schema", "columns", strings.Join(columns, ", "))

	var results []GrantResult
	var errCount int

	// Screen Recording (kTCCServiceScreenCapture) must be granted in BOTH the
	// system TCC database AND user-level TCC databases. On macOS 10.15+,
	// CGPreflightScreenCaptureAccess() checks the user-level DB. Other
	// permissions (Accessibility) only need the system DB.
	userDBPaths := getUserTCCDBPaths()

	for _, svc := range services {
		r := GrantResult{Service: svc.Service, Name: svc.Name}

		// Grant in system TCC database
		granted, checkErr := isAlreadyGranted(systemTCCDBPath, svc.Service)
		if checkErr != nil {
			log.Warn("failed to check existing TCC entry",
				"service", svc.Name, "error", checkErr.Error())
		}

		if granted {
			r.Granted = true
			r.Already = true
			log.Info("TCC permission already granted (system)", "service", svc.Name)
		} else {
			if grantErr := grantPermission(systemTCCDBPath, svc.Service, columns); grantErr != nil {
				r.Err = grantErr
				errCount++
				log.Warn("failed to grant TCC permission (system)",
					"service", svc.Name, "error", grantErr.Error())
			} else {
				r.Granted = true
				log.Info("TCC permission granted (system)", "service", svc.Name)
			}
		}

		// Screen Recording also needs user-level TCC grants
		if svc.Service == "kTCCServiceScreenCapture" && len(userDBPaths) > 0 {
			var userDBSucceeded bool
			for _, userDB := range userDBPaths {
				userGranted, userCheckErr := isAlreadyGranted(userDB, svc.Service)
				if userCheckErr != nil {
					log.Warn("failed to check user TCC entry",
						"db", userDB, "error", userCheckErr.Error())
				}
				if userGranted {
					log.Debug("Screen Recording already granted in user DB", "db", userDB)
					userDBSucceeded = true
					continue
				}
				// Detect schema for this user's DB (may differ from system DB)
				userCols, schemaErr := detectTCCSchemaForDB(userDB)
				if schemaErr != nil {
					log.Warn("failed to detect user TCC schema", "db", userDB, "error", schemaErr.Error())
					continue
				}
				if grantErr := grantPermission(userDB, svc.Service, userCols); grantErr != nil {
					log.Warn("failed to grant Screen Recording in user DB",
						"db", userDB, "error", grantErr.Error())
				} else {
					log.Info("Screen Recording granted in user DB", "db", userDB)
					userDBSucceeded = true
				}
			}
			if !userDBSucceeded {
				r.Err = fmt.Errorf("Screen Recording grant failed for all %d user TCC databases", len(userDBPaths))
				r.Granted = false
				errCount++
			}
		}

		results = append(results, r)
	}

	if errCount > 0 {
		return results, fmt.Errorf("%d of %d TCC grants failed", errCount, len(services))
	}
	return results, nil
}

// detectTCCSchema queries the TCC database to discover which columns exist
// in the `access` table. This handles schema changes across macOS versions.
func detectTCCSchema() ([]string, error) {
	return detectTCCSchemaForDB(systemTCCDBPath)
}

func detectTCCSchemaForDB(dbPath string) ([]string, error) {
	out, err := runSQLite(dbPath, "PRAGMA table_info(access);")
	if err != nil {
		return nil, fmt.Errorf("PRAGMA table_info failed: %w", err)
	}

	var columns []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		// PRAGMA table_info returns: cid|name|type|notnull|dflt_value|pk
		parts := strings.Split(line, "|")
		if len(parts) >= 2 {
			columns = append(columns, parts[1])
		}
	}

	if len(columns) == 0 {
		return nil, fmt.Errorf("no columns found in access table")
	}

	return columns, nil
}

// isAlreadyGranted checks if a TCC entry already exists and is allowed
// (auth_value=2) for the agent binary. Does not filter on
// indirect_object_identifier because older macOS TCC schemas may lack that
// column. Instead we check if any matching row has auth_value=2.
func isAlreadyGranted(dbPath, service string) (bool, error) {
	query := fmt.Sprintf(
		"SELECT auth_value FROM access WHERE service=%s AND client=%s AND client_type=1;",
		sqlStr(service), sqlStr(agentBinaryPath),
	)
	out, err := runSQLite(dbPath, query)
	if err != nil {
		return false, err
	}
	// Check if any returned row has auth_value=2 ("allowed")
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == "2" {
			return true, nil
		}
	}
	return false, nil
}

// grantPermission inserts or replaces a TCC entry for the given service.
// It adapts the SQL to the detected schema columns.
func grantPermission(dbPath, service string, columns []string) error {
	colSet := make(map[string]bool, len(columns))
	for _, c := range columns {
		colSet[c] = true
	}

	// Verify required columns exist
	required := []string{"service", "client", "client_type", "auth_value", "auth_reason", "auth_version"}
	for _, r := range required {
		if !colSet[r] {
			return fmt.Errorf("TCC database missing required column %q", r)
		}
	}

	// Build column/value lists starting with the required core columns
	insertCols := []string{"service", "client", "client_type", "auth_value", "auth_reason", "auth_version"}
	insertVals := []string{
		sqlStr(service),         // service
		sqlStr(agentBinaryPath), // client
		"1",                     // client_type: 1 = absolute path
		"2",                     // auth_value: 2 = allowed
		"4",                     // auth_reason: 4 = system policy
		"1",                     // auth_version
	}

	// Handle optional columns -- provide safe defaults so the INSERT
	// doesn't violate NOT NULL constraints on newer macOS versions.
	now := time.Now().Unix()
	optionalDefaults := map[string]string{
		"csreq":                           "NULL",
		"policy_id":                       "NULL",
		"indirect_object_identifier_type": "0",
		"indirect_object_identifier":      "'UNUSED'",
		"indirect_object_code_identity":   "NULL",
		"flags":                           "0",
		"last_modified":                   fmt.Sprintf("%d", now),
		"pid":                             "0",
		"pid_version":                     "0",
		"boot_uuid":                       "''",
		"last_reminded":                   "0",
	}

	// Build a set of already-included columns to avoid duplicates
	insertSet := make(map[string]bool, len(insertCols))
	for _, c := range insertCols {
		insertSet[c] = true
	}

	// Iterate in column order (as reported by PRAGMA) to match table layout
	for _, col := range columns {
		if val, ok := optionalDefaults[col]; ok && !insertSet[col] {
			insertCols = append(insertCols, col)
			insertVals = append(insertVals, val)
		}
	}

	stmt := fmt.Sprintf(
		"INSERT OR REPLACE INTO access (%s) VALUES (%s);",
		strings.Join(insertCols, ", "),
		strings.Join(insertVals, ", "),
	)

	if _, err := runSQLite(dbPath, stmt); err != nil {
		return fmt.Errorf("INSERT failed for %s: %w", service, err)
	}

	// Verify the insert worked
	granted, verifyErr := isAlreadyGranted(dbPath, service)
	if verifyErr != nil {
		return fmt.Errorf("verification query failed after INSERT: %w", verifyErr)
	}
	if !granted {
		return fmt.Errorf("INSERT appeared to succeed but verification found no matching row")
	}

	return nil
}

// runSQLite executes a SQL statement against a TCC database using
// the sqlite3 command-line tool. This avoids adding a CGO sqlite dependency.
func runSQLite(dbPath, statement string) (string, error) {
	cmd := exec.Command("sqlite3", "-cmd", ".timeout 5000", dbPath, statement)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("sqlite3: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// getUserTCCDBPaths returns TCC database paths for all local user accounts.
// Screen Recording grants must be in the user-level TCC database on macOS 10.15+.
// Uses Lstat and symlink checks to prevent following symlinks to attacker-chosen files.
func getUserTCCDBPaths() []string {
	entries, err := os.ReadDir("/Users")
	if err != nil {
		log.Warn("cannot list /Users for user TCC databases", "error", err.Error())
		return nil
	}
	var paths []string
	for _, e := range entries {
		// Use e.Type().IsDir() to avoid following symlinks on /Users entries
		if !e.Type().IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == "Shared" {
			continue
		}
		dbPath := filepath.Join("/Users", e.Name(), "Library/Application Support/com.apple.TCC/TCC.db")
		userHome := filepath.Join("/Users", e.Name())

		// Use Lstat to avoid following symlinks
		fi, err := os.Lstat(dbPath)
		if err != nil {
			if !os.IsNotExist(err) {
				log.Warn("cannot access user TCC database", "user", e.Name(), "error", err.Error())
			}
			continue
		}
		// Reject symlinks — a local user could point this at an arbitrary file
		if fi.Mode()&os.ModeSymlink != 0 {
			log.Warn("skipping symlinked TCC database", "user", e.Name(), "path", dbPath)
			continue
		}
		// Verify the resolved path stays within the user's home directory
		resolved, err := filepath.EvalSymlinks(filepath.Dir(dbPath))
		if err != nil {
			log.Warn("cannot resolve TCC database directory", "user", e.Name(), "error", err.Error())
			continue
		}
		if !strings.HasPrefix(resolved, userHome) {
			log.Warn("TCC database path resolves outside user home, skipping",
				"user", e.Name(), "resolved", resolved)
			continue
		}

		paths = append(paths, dbPath)
	}
	return paths
}

// CheckFDA queries the system TCC database (as root) to determine whether the
// agent binary has been granted Full Disk Access (kTCCServiceSystemPolicyAllFiles).
// This is used as a daemon-side fallback when the user helper's os.Open probe
// returns false — which happens on macOS 12 where even FDA-granted user-context
// processes cannot open the system TCC database.
//
// Returns true only if the agent binary has an explicit auth_value=2 entry.
// Returns false (without error) if the database is unreadable or the entry is
// missing, so callers can safely treat the result as a best-effort check.
func CheckFDA() bool {
	if os.Getuid() != 0 {
		log.Debug("CheckFDA skipped — not running as root")
		return false
	}
	if _, err := os.Stat(systemTCCDBPath); err != nil {
		log.Debug("CheckFDA: cannot stat TCC database", "error", err.Error())
		return false
	}
	granted, err := isAlreadyGranted(systemTCCDBPath, "kTCCServiceSystemPolicyAllFiles")
	if err != nil {
		log.Warn("CheckFDA: query failed", "error", err.Error())
		return false
	}
	return granted
}

// sqlStr wraps a string value for SQL, escaping single quotes.
func sqlStr(s string) string {
	escaped := strings.ReplaceAll(s, "'", "''")
	return "'" + escaped + "'"
}
