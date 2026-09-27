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

// DownloadPlanner is optionally implemented by providers that authorize
// object access in batches ahead of the downloads themselves (the brokered
// storage-session provider). Callers hand over the ordered keys they are
// about to download once the manifest is parsed; the provider may then
// resolve a bounded window of upcoming keys per round trip instead of one
// key per Download. Keys are passed verbatim. Purely an optimisation: a
// provider that never receives a plan still serves every Download.
type DownloadPlanner interface {
	PrepareDownloads(keys []string)
}

// PrepareDownloads hands keys to provider when it implements DownloadPlanner
// and is a no-op otherwise.
func PrepareDownloads(provider BackupProvider, keys []string) {
	if planner, ok := provider.(DownloadPlanner); ok && len(keys) > 0 {
		planner.PrepareDownloads(keys)
	}
}
