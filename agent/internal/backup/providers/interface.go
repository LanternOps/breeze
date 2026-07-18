package providers

// BackupProvider defines the interface for backup storage providers.
type BackupProvider interface {
	Upload(localPath, remotePath string) error
	Download(remotePath, localPath string) error
	List(prefix string) ([]string, error)
	Delete(remotePath string) error
}

// JournalIdentity is optionally implemented by BackupProviders to supply
// stable identity material for the agent's checkpoint journal (see the
// backup package's journal.go): a string that uniquely identifies the
// storage destination (bucket/container/path, plus enough config — e.g. an
// S3-compatible endpoint — to distinguish two same-kind destinations)
// WITHOUT including credentials. It exists purely to key journal files per
// destination, so a journal from one destination is never mistaken for
// another's after a reconfiguration (e.g. pointing the same provider kind
// at a different bucket).
//
// Providers that don't implement it (test fakes) fall back to a generic
// per-Go-type identity in the backup package — resume simply won't trigger
// across a fake-provider reconfiguration in a test, which is harmless.
type JournalIdentity interface {
	BackupIdentity() string
}
