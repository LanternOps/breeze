package providers

// BackupProvider defines the interface for backup storage providers.
type BackupProvider interface {
	Upload(localPath, remotePath string) error
	Download(remotePath, localPath string) error
	List(prefix string) ([]string, error)
	Delete(remotePath string) error
}
