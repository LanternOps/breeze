package patching

import "fmt"

// hresultInfo holds a human-readable name and description for a WUA HRESULT code.
type hresultInfo struct {
	Name    string
	Message string
}

// knownHResults maps common Windows Update Agent HRESULT codes to descriptions.
var knownHResults = map[int]hresultInfo{
	// WUA errors
	0x8024000B: {"WU_E_CALL_CANCELLED", "operation was cancelled"},
	0x8024000E: {"WU_E_OPERATIONINPROGRESS", "another conflicting operation was in progress"},
	0x80240016: {"WU_E_INSTALL_NOT_ALLOWED", "operation tried to install while another install was in progress or reboot pending"},
	0x80240004: {"WU_E_NOT_INITIALIZED", "Windows Update Agent is not initialized"},
	0x80240005: {"WU_E_RANGEOVERLAP", "update handler requested a byte range overlapping a previously requested range"},
	0x80240007: {"WU_E_INVALIDINDEX", "the index to a collection was invalid"},
	0x80240008: {"WU_E_ITEMNOTFOUND", "the key for the item queried could not be found"},
	0x80240010: {"WU_E_TOO_DEEP_RELATION", "update relationships too deep to evaluate"},
	0x80240017: {"WU_E_NOT_APPLICABLE", "operation is not applicable to the current state"},
	0x80240024: {"WU_E_NO_SERVICE", "Windows Update service could not be contacted"},
	0x80240028: {"WU_E_UNINSTALL_NOT_ALLOWED", "uninstall is not allowed for this update"},
	0x8024002C: {"WU_E_BIN_SOURCE_ABSENT", "a delta-compressed update could not be installed because it required the source"},
	0x8024002E: {"WU_E_WU_DISABLED", "non-managed server access is not allowed"},
	0x80240044: {"WU_E_PER_MACHINE_UPDATE_ACCESS_DENIED", "only administrators can perform this operation on per-machine updates"},
	0x80242014: {"WU_E_UH_POSTREBOOTSTILLPENDING", "the post-reboot operation for the update is still in progress"},

	// General COM / Win32 errors encountered during WUA operations
	0x80070005: {"E_ACCESSDENIED", "access denied — agent may need to run as SYSTEM or administrator"},
	0x8007000E: {"E_OUTOFMEMORY", "not enough memory to complete the operation"},
	0x80070057: {"E_INVALIDARG", "one or more arguments are not valid"},
	0x80072EE2: {"WININET_E_TIMEOUT", "the operation timed out"},
	0x80072EFD: {"WININET_E_CONNECTION_RESET", "the connection with the server was reset"},
	0x80072EFE: {"WININET_E_CANNOT_CONNECT", "could not connect to the update server"},
	0x80072F8F: {"WININET_E_DECODING_FAILED", "a security error occurred (certificate problem)"},

	// Download-specific
	0x80246008: {"WU_E_DM_FAILTOCONNECTTOBITS", "a download manager operation could not be completed because the download manager was unable to connect the Background Intelligent Transfer Service (BITS)"},
}

// FormatHResult returns a human-readable description of a WUA HRESULT code.
// For known codes: "0x8024000E: WU_E_OPERATIONINPROGRESS: another conflicting operation was in progress"
// For unknown codes: "0x80070005: unknown HRESULT"
func FormatHResult(hr int) string {
	if info, ok := knownHResults[hr]; ok {
		return fmt.Sprintf("0x%08X: %s: %s", uint32(hr), info.Name, info.Message)
	}
	return fmt.Sprintf("0x%08X: unknown HRESULT", uint32(hr))
}

// IsOperationInProgress returns true if the HRESULT indicates a WUA concurrent operation conflict.
func IsOperationInProgress(hr int) bool {
	return hr == 0x8024000E || hr == 0x80240016
}

// IsAccessDenied returns true if the HRESULT indicates an access denied error.
func IsAccessDenied(hr int) bool {
	return hr == 0x80070005 || hr == 0x80240044
}

// IsNetworkError returns true if the HRESULT indicates a network connectivity issue.
func IsNetworkError(hr int) bool {
	switch hr {
	case 0x80072EE2, 0x80072EFD, 0x80072EFE, 0x80072F8F:
		return true
	}
	return false
}
