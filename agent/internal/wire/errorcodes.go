package wire

// CommandErrorCode is the typed reason carried on a failed command result's
// `errorCode` field (#4026).
//
// The API used to decide how to present an agent failure (404 vs 409 vs 422 vs
// 500) by pattern-matching the English `error` string. That breaks silently
// whenever an agent release rewords a message or adds a new refusal. A code
// travels alongside the prose instead: the prose stays for humans and for
// servers that predate the code, the code is what the server branches on.
//
// MIRRORS apps/api/src/routes/agents/schemas.ts `AGENT_COMMAND_ERROR_CODES`.
// Pinned in both directions — TestCommandErrorCodesMatchServerSchema here and
// schemas.commandResult.test.ts on the server — so a one-sided edit fails CI.
//
// Values are wire-stable: never rename one. Retire a code by ceasing to emit
// it, and only drop it from both lists once no supported agent sends it.
// The server accepts any short string here and treats an unknown code as
// absent (prose fallback), so an agent that ships a new code before the server
// learns it degrades to today's behaviour rather than having its result
// rejected.
type CommandErrorCode string

const (
	// ErrCodePathNotFound: the path (or trash item) the command names does not
	// exist.
	ErrCodePathNotFound CommandErrorCode = "path_not_found"
	// ErrCodePathExists: the destination is already occupied and the command
	// will not overwrite it (trash restore onto an existing path).
	ErrCodePathExists CommandErrorCode = "path_exists"
	// ErrCodeFileTooLarge: the file exceeds the agent's read cap.
	ErrCodeFileTooLarge CommandErrorCode = "file_too_large"
	// ErrCodePayloadTooLarge: a write payload exceeds the agent's write cap.
	ErrCodePayloadTooLarge CommandErrorCode = "payload_too_large"
	// ErrCodePathIsDirectory: a file operation was aimed at a directory.
	ErrCodePathIsDirectory CommandErrorCode = "path_is_directory"
	// ErrCodeSensitivePathDenied: the credential-store deny-list refused the
	// path (directly, via a symlink, or because a directory contains one).
	ErrCodeSensitivePathDenied CommandErrorCode = "sensitive_path_denied"
	// ErrCodeSystemPathDenied: the path is a protected system location.
	ErrCodeSystemPathDenied CommandErrorCode = "system_path_denied"
	// ErrCodeTopLevelDeleteDenied: a recursive delete of a top-level path.
	ErrCodeTopLevelDeleteDenied CommandErrorCode = "top_level_delete_denied"
	// ErrCodeContentsUnverifiable: a destructive directory operation was
	// refused because its contents could not be checked against the deny-list.
	ErrCodeContentsUnverifiable CommandErrorCode = "contents_unverifiable"
	// ErrCodeDirectoryTooLarge: the directory is too large for the agent to
	// verify before clearing it.
	ErrCodeDirectoryTooLarge CommandErrorCode = "directory_too_large"
	// ErrCodeCopyIntoSelf: a directory copy whose destination is inside its
	// source.
	ErrCodeCopyIntoSelf CommandErrorCode = "copy_into_self"
	// ErrCodeTrashMetadataTooLarge: a trash item's metadata exceeds its cap.
	ErrCodeTrashMetadataTooLarge CommandErrorCode = "trash_metadata_too_large"
	// ErrCodeUnsupportedEncoding: the requested content encoding is not one
	// the agent supports.
	ErrCodeUnsupportedEncoding CommandErrorCode = "unsupported_encoding"
	// ErrCodeInvalidArgument: a required payload field is missing.
	ErrCodeInvalidArgument CommandErrorCode = "invalid_argument"
	// ErrCodeScanInProgress: a filesystem_analysis scan is already running on
	// this agent; the new one was refused rather than started alongside it
	// (#8509). Transient — retry once the running scan finishes.
	ErrCodeScanInProgress CommandErrorCode = "scan_in_progress"
)

// AllCommandErrorCodes lists every code above. It is what the cross-language
// pin compares; TestAllCommandErrorCodesListsEveryConstant keeps it complete.
var AllCommandErrorCodes = []CommandErrorCode{
	ErrCodePathNotFound,
	ErrCodePathExists,
	ErrCodeFileTooLarge,
	ErrCodePayloadTooLarge,
	ErrCodePathIsDirectory,
	ErrCodeSensitivePathDenied,
	ErrCodeSystemPathDenied,
	ErrCodeTopLevelDeleteDenied,
	ErrCodeContentsUnverifiable,
	ErrCodeDirectoryTooLarge,
	ErrCodeCopyIntoSelf,
	ErrCodeTrashMetadataTooLarge,
	ErrCodeUnsupportedEncoding,
	ErrCodeInvalidArgument,
	ErrCodeScanInProgress,
}
