package providers

import (
	"context"
	"io"
	"time"
)

// ContextDownloader is optionally implemented by providers whose Download can
// be cancelled mid-transfer. Every production provider implements it; callers
// that need a bounded download (verification, test restore — #6598) use it
// when present and fall back to the plain, uncancellable Download otherwise
// (test fakes). Cancelling ctx must abort an in-flight body transfer, not
// only the request setup: a peer that answers the headers and then stops
// sending the body is exactly the stall this exists to bound.
type ContextDownloader interface {
	DownloadContext(ctx context.Context, remotePath, localPath string) error
}

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
