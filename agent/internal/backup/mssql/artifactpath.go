package mssql

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// This file checks backup file paths and names before they are staged or
// handed to SQL Server, and builds the RESTORE statements that read them.
// It carries no build tag so the checks and the statement text have real
// unit test coverage on every platform, same rationale as sqlcmd.go.

// isPrintableText reports whether s is valid UTF-8 with no control
// character (C0, DEL or C1) and no Unicode line or paragraph separator, so
// it reads as a single line wherever it is used.
func isPrintableText(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || r == ' ' || r == ' ' {
			return false
		}
	}
	return true
}

// ValidateBackupArtifactPath checks a backup file path before it is staged
// or used in a BACKUP or RESTORE statement. The Win32 file APIs refuse
// control characters in names, but NTFS itself, reached through the native
// API, and other file systems and object stores can hold them; no backup
// Breeze writes uses one, so a path holding one is refused rather than
// passed on.
func ValidateBackupArtifactPath(value string) error {
	if value == "" {
		return fmt.Errorf("backup file path is required")
	}
	if !isPrintableText(value) {
		return fmt.Errorf("backup file path contains a control character or is not valid UTF-8")
	}
	return nil
}

// ValidateBackupArtifactName checks the single file name a backup artifact
// is staged under.
func ValidateBackupArtifactName(value string) error {
	if err := ValidateBackupArtifactPath(value); err != nil {
		return err
	}
	if value == "." || value == ".." || strings.ContainsAny(value, `/\:`) {
		return fmt.Errorf("backup filename must be a single path component")
	}
	return nil
}

// backupFileVar is the T-SQL variable every RESTORE statement in this
// package reads its backup file path from.
const backupFileVar = "@backup_file"

// bindBackupFile checks backupFile and returns the T-SQL that binds it to
// backupFileVar (see bindNVarchar), so statements name the file as
// DISK=@backup_file and never carry the path text itself.
func bindBackupFile(backupFile string) (string, error) {
	if err := ValidateBackupArtifactPath(backupFile); err != nil {
		return "", err
	}
	return bindNVarchar(backupFileVar, backupFile)
}

// buildVerifyQuery builds the RESTORE VERIFYONLY statement for backupFile.
func buildVerifyQuery(backupFile string) (string, error) {
	binding, err := bindBackupFile(backupFile)
	if err != nil {
		return "", err
	}
	return binding + " RESTORE VERIFYONLY FROM DISK=" + backupFileVar, nil
}

// buildHeaderOnlyQuery builds the RESTORE HEADERONLY statement for
// backupFile.
func buildHeaderOnlyQuery(backupFile string) (string, error) {
	binding, err := bindBackupFile(backupFile)
	if err != nil {
		return "", err
	}
	return binding + " RESTORE HEADERONLY FROM DISK=" + backupFileVar, nil
}
