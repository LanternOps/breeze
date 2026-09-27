//go:build windows

package config

// On Windows, helper_auth_token still ships inside agent.yaml
// (secretKeyAllowedInAgentYAML) rather than in a separate file: there is no
// Windows equivalent yet of the Unix "breeze" group that
// helpertoken_unix.go uses to scope the file to console/GUI users without
// granting BUILTIN\Users. Splitting it out on Windows needs either a
// dynamically-resolved per-console-session ACL or completing the IPC-based
// delivery the Tauri Helper already prefers when available (see
// apps/helper/src-tauri/src/lib.rs) — tracked as follow-up work, not done
// here. These are no-ops so the cross-platform call sites in config.go don't
// need a build-tag switch of their own.

func helperTokenFilePathFor(string) string { return "" }

func writeHelperTokenFileFor(string, string) error { return nil }

func readHelperTokenFileFor(string) (string, error) { return "", nil }

func reapplyHelperTokenFilePermissionsFor(string) {}
