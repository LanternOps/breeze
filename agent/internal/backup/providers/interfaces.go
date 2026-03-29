package providers

import (
	"io"
	"time"
)

// StreamUploader is optionally implemented by providers that support streaming uploads.
type StreamUploader interface {
	UploadStream(reader io.Reader, remotePath string, size int64) error
}

// Encryptor is optionally implemented by providers that support client-side encryption.
type Encryptor interface {
	UploadEncrypted(localPath, remotePath string, key []byte) error
	DownloadDecrypted(remotePath, localPath string, key []byte) error
}

// ImmutableStorage is optionally implemented by providers that support object locks.
type ImmutableStorage interface {
	SetObjectLock(remotePath string, retainUntil time.Time) error
}

// TierableStorage is optionally implemented by providers that support storage tiers.
type TierableStorage interface {
	SetStorageTier(remotePath string, tier string) error
}

// ObjectMetadata describes metadata about a stored object.
type ObjectMetadata struct {
	Size         int64
	LastModified time.Time
	StorageTier  string
	ContentHash  string
}

// MetadataReader is optionally implemented by providers that can read object metadata.
type MetadataReader interface {
	GetObjectMetadata(remotePath string) (*ObjectMetadata, error)
}
