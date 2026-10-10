package tools

import "strings"

// Diagnostic read grants (administrator-approved, read-only file access).
//
// This file is the agent's copy of the sensitive-location classification the
// API applies when it decides whether a grant covers a path
// (apps/api/src/services/diagnosticAccess/classification.ts). The two
// implementations are held together by one fixture both test suites read:
// testdata/diagnostic_path_classes.json. Change one, change both, and extend
// the fixture.
//
// Classes are about CONTENT, not location: a broad grant over a user's
// AppData\Local tree must not incidentally reach the browser cookie jar or
// the DPAPI master keys inside it. Every class is credential material and is
// never readable through a grant: a location in any class is refused, and a
// listing leaves it out.

// Sensitive classes. The string values are part of the signed authorization
// wire format; they never change meaning. An authorization that names one is
// refused (VerifyDiagnosticAuthorization).
const (
	DiagClassCredentialStore = "credential_store"
	DiagClassBrowserSecrets  = "browser_secrets"
	DiagClassPrivateKeys     = "private_keys"
	DiagClassSessionTokens   = "session_tokens"
)

// diagKnownClasses is the closed set the authorization parser recognises; an
// unknown name is malformed, a known one is refused after verification.
var diagKnownClasses = map[string]bool{
	DiagClassCredentialStore: true,
	DiagClassBrowserSecrets:  true,
	DiagClassPrivateKeys:     true,
	DiagClassSessionTokens:   true,
}

// diagHardDeniedFragments are never readable through a grant, whatever it
// names: the agent's own configuration holds its bearer token and mTLS key,
// and handing those out would let the reader impersonate the device.
var diagHardDeniedFragments = []string{
	"/programdata/breeze",
	"/etc/breeze",
	"/library/application support/breeze",
	// Linux agent state and runtime sockets live outside /etc/breeze.
	"/var/lib/breeze",
	"/var/run/breeze",
	"/run/breeze",
}

// diagClassFragments are matched at a path-component boundary (see
// matchesPathFragment): the location itself and everything beneath it.
var diagClassFragments = map[string][]string{
	DiagClassCredentialStore: {
		"/windows/system32/config",
		"/windows/ntds",
		"/windows/system32/microsoft/protect",
		"/appdata/roaming/microsoft/credentials",
		"/appdata/local/microsoft/credentials",
		"/appdata/roaming/microsoft/protect",
		"/appdata/roaming/microsoft/vault",
		"/appdata/local/microsoft/vault",
		"/programdata/microsoft/crypto",
		"/etc/shadow",
		"/etc/gshadow",
		"/etc/sudoers",
		"/etc/sudoers.d",
		"/etc/master.passwd",
		"/etc/krb5.keytab",
		"/library/keychains",
		// macOS local directory: user records with password hashes.
		"/var/db/dslocal",
		// GNOME keyring / KWallet.
		"/.local/share/keyrings",
		"/.local/share/kwalletd",
		// Windows Hello (NGC) key and PIN containers.
		"/appdata/local/microsoft/ngc",
		// Setup answer files can carry the local administrator password.
		"/windows/panther",
		"/windows/system32/sysprep",
		// Group Policy preferences (Groups.xml cpassword): SYSVOL on a domain
		// controller and the client-side history cache.
		"/windows/sysvol",
		"/programdata/microsoft/group policy/history",
	},
	// macOS: ~/Library/Cookies and the Safari container's Library/Cookies.
	DiagClassBrowserSecrets: {
		"/library/cookies",
	},
	DiagClassPrivateKeys: {
		"/.ssh",
		"/.gnupg",
		"/etc/ssl/private",
		// Windows per-user key containers (CAPI RSA/DSS, CNG) and the personal
		// certificate store that points at them.
		"/appdata/roaming/microsoft/crypto",
		"/appdata/local/microsoft/crypto",
		"/appdata/roaming/microsoft/systemcertificates",
	},
	DiagClassSessionTokens: {
		"/.aws",
		"/.kube",
		"/.docker/config.json",
		"/.azure",
		"/.config/gcloud",
		// Browser and Electron-app web storage (Chromium, Edge, Teams, Slack, ...;
		// Firefox profile storage): sites keep session and refresh tokens here.
		"/local storage",
		"/session storage",
		"/indexeddb",
		"/service worker",
		"/storage/default",
		// Windows account token caches (WAM / AAD broker).
		"/appdata/local/microsoft/tokenbroker",
		"/appdata/local/microsoft/identitycache",
		"/appdata/local/packages/microsoft.aad.brokerplugin_cw5n1h2txyewy",
		// PowerShell command history (typed secrets, connection strings).
		"/appdata/roaming/microsoft/windows/powershell/psreadline",
	},
}

// diagClassBasenames are credential material wherever they live.
var diagClassBasenames = map[string]string{
	"login data":              DiagClassBrowserSecrets,
	"login data for account":  DiagClassBrowserSecrets,
	"cookies":                 DiagClassBrowserSecrets,
	"local state":             DiagClassBrowserSecrets,
	"web data":                DiagClassBrowserSecrets,
	"key4.db":                 DiagClassBrowserSecrets,
	"logins.json":             DiagClassBrowserSecrets,
	"signons.sqlite":          DiagClassBrowserSecrets,
	"cookies.sqlite":          DiagClassBrowserSecrets,
	"webcachev01.dat":         DiagClassBrowserSecrets,
	"webappsstore.sqlite":     DiagClassSessionTokens,
	".git-credentials":        DiagClassSessionTokens,
	".env":                    DiagClassSessionTokens,
	".netrc":                  DiagClassSessionTokens,
	".bash_history":           DiagClassSessionTokens,
	".zsh_history":            DiagClassSessionTokens,
	".sh_history":             DiagClassSessionTokens,
	".psql_history":           DiagClassSessionTokens,
	".mysql_history":          DiagClassSessionTokens,
	"consolehost_history.txt": DiagClassSessionTokens,
	"unattend.xml":            DiagClassCredentialStore,
	"autounattend.xml":        DiagClassCredentialStore,
	"sysprep.inf":             DiagClassCredentialStore,
	// Group Policy preference file carrying cpassword, wherever it was copied.
	"groups.xml": DiagClassCredentialStore,
}

// diagClassBasenamePrefixes are credential material by name prefix (SSH host
// keys, Kerberos ticket caches).
var diagClassBasenamePrefixes = map[string]string{
	"ssh_host_": DiagClassPrivateKeys,
	"krb5cc_":   DiagClassSessionTokens,
}

// diagClassExtensions mark private-key containers by file extension.
var diagClassExtensions = map[string]string{
	".pem":           DiagClassPrivateKeys,
	".key":           DiagClassPrivateKeys,
	".pfx":           DiagClassPrivateKeys,
	".p12":           DiagClassPrivateKeys,
	".ppk":           DiagClassPrivateKeys,
	".keychain":      DiagClassCredentialStore,
	".keychain-db":   DiagClassCredentialStore,
	".binarycookies": DiagClassBrowserSecrets,
}

// normalizeDiagPath folds separators and case the way the API does. The input
// must already be absolute; a Windows drive prefix ("c:") is dropped so a
// fragment like "/windows/system32/config" matches "C:\Windows\System32\config".
func normalizeDiagPath(p string) string {
	norm := strings.ToLower(strings.ReplaceAll(p, "\\", "/"))
	if len(norm) >= 2 && norm[1] == ':' {
		norm = norm[2:]
	}
	for strings.Contains(norm, "//") {
		norm = strings.ReplaceAll(norm, "//", "/")
	}
	if len(norm) > 1 {
		norm = strings.TrimSuffix(norm, "/")
	}
	if norm == "" {
		norm = "/"
	}
	return norm
}

// ClassifyDiagnosticPath returns whether p is never grantable, and the
// sensitive classes it falls in (sorted, de-duplicated).
func ClassifyDiagnosticPath(p string) (hardDenied bool, classes []string) {
	norm := normalizeDiagPath(p)
	for _, frag := range diagHardDeniedFragments {
		if matchesPathFragment(norm, frag) {
			return true, nil
		}
	}
	if configDir := agentConfigDirFunc(); configDir != "" {
		if matchesPathFragment(norm, normalizeDiagPath(configDir)) {
			return true, nil
		}
	}

	found := map[string]bool{}
	for class, frags := range diagClassFragments {
		for _, frag := range frags {
			if matchesPathFragment(norm, frag) {
				found[class] = true
			}
		}
	}
	base := norm
	if i := strings.LastIndex(norm, "/"); i >= 0 {
		base = norm[i+1:]
	}
	// SQLite/ESE sidecars (Cookies-journal, Login Data-wal, ...) hold the
	// same pages as the database they belong to.
	if class, ok := diagClassBasenames[diagStripSidecar(base)]; ok {
		found[class] = true
	}
	for prefix, class := range diagClassBasenamePrefixes {
		if strings.HasPrefix(base, prefix) {
			found[class] = true
		}
	}
	for ext, class := range diagClassExtensions {
		if strings.HasSuffix(base, ext) && len(base) > len(ext) {
			found[class] = true
		}
	}
	for _, class := range []string{DiagClassBrowserSecrets, DiagClassCredentialStore, DiagClassPrivateKeys, DiagClassSessionTokens} {
		if found[class] {
			classes = append(classes, class)
		}
	}
	return false, classes
}

// diagStripSidecar maps "cookies-journal" / "login data-wal" / "x-shm" to the
// database name it belongs to; any other name is returned unchanged.
func diagStripSidecar(base string) string {
	for _, suffix := range []string{"-journal", "-wal", "-shm"} {
		if strings.HasSuffix(base, suffix) && len(base) > len(suffix) {
			return strings.TrimSuffix(base, suffix)
		}
	}
	return base
}
