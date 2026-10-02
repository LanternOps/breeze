package providers

import (
	"context"
	"errors"
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

// SourceSkipper is implemented by a provider that serves downloads from an
// ordered list of sources (FallbackProvider: a local vault copy first, then
// primary storage). DownloadSkipping reads from the sources after the first
// skip, so a caller whose checks refuse the copy the first source returned
// can read the same object from the next one.
type SourceSkipper interface {
	DownloadSkipping(ctx context.Context, remotePath, localPath string, skip int) error
	DownloadOnly(ctx context.Context, remotePath, localPath string, idx int) error
	SourceCount() int
}

// StaleUploadSweeper is optionally implemented by providers that write a
// temporary file beside an object during an upload (the local provider), so
// ones left by an interrupted helper can be removed later.
type StaleUploadSweeper interface {
	SweepStaleUploads(prefix string, olderThan time.Duration) (int, error)
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

// PlannedUpload is one upload a caller is about to make.
type PlannedUpload struct {
	LocalPath string
	Key       string
}

// UploadPlanner is optionally implemented by providers that authorize
// uploads in batches ahead of the uploads themselves (the brokered write
// provider): callers hand over the uploads they are about to make, in
// order. Purely an optimisation, like DownloadPlanner.
type UploadPlanner interface {
	PrepareUploads(entries []PlannedUpload)
}

// PrepareDownloads hands keys to provider when it implements DownloadPlanner
// and is a no-op otherwise.
func PrepareDownloads(provider BackupProvider, keys []string) {
	if planner, ok := provider.(DownloadPlanner); ok && len(keys) > 0 {
		planner.PrepareDownloads(keys)
	}
}

// ResumeMode is how a brokered writer may continue a journaled snapshot id
// (see SnapshotIDIssuer.ResumeSnapshot).
type ResumeMode int

const (
	// ResumeWrite: the writer now owns the journaled id and may upload
	// under it.
	ResumeWrite ResumeMode = iota + 1
	// ResumeReadOnlyCompletion: the journaled snapshot is already
	// published; the writer may only read its manifest and report it.
	ResumeReadOnlyCompletion
	// ResumeTakeover: like ResumeWrite, but the snapshot was being written
	// by an earlier job, which the control plane has fenced; its journaled
	// objects are reused only after checking what storage holds.
	ResumeTakeover
)

// ErrSnapshotNotResumable reports that the control plane refused to let this
// writer continue a journaled snapshot id; the caller starts afresh under
// the id it was issued.
var ErrSnapshotNotResumable = errors.New("storage session: journaled snapshot cannot be resumed")

// ErrPreviousWriterActive reports that an earlier writer of a snapshot id may
// still write it, and waiting for it did not end within the writer's bound.
var ErrPreviousWriterActive = errors.New("storage session: an earlier writer of this snapshot may still be active")

// SnapshotIDIssuer is implemented by brokered write providers, whose
// snapshot id is issued by the control plane rather than chosen by the
// helper. A run writing through one uses SnapshotID() and never mints its
// own; it may ask once, before any upload, to continue a journaled id
// instead.
type SnapshotIDIssuer interface {
	// SnapshotID is the snapshot id the writer currently owns.
	SnapshotID() string
	// ResumeSnapshot asks to continue journalID. ResumeWrite and
	// ResumeTakeover move the writer onto journalID; ResumeReadOnlyCompletion moves it onto the
	// already published journalID, read-only. An error wrapping
	// ErrSnapshotNotResumable means the writer keeps its issued id.
	ResumeSnapshot(ctx context.Context, journalID string) (ResumeMode, error)
}

// WriterFence is implemented by brokered writers. AwaitWriteAccess returns
// once no earlier writer of the snapshot can still write it — waiting, within
// a bound, for the control plane to fence it — and otherwise an error
// wrapping ErrPreviousWriterActive. Uploads themselves do not wait: they
// answer ErrPreviousWriterActive at once, so the caller can wait outside any
// per-file deadline.
type WriterFence interface {
	AwaitWriteAccess(ctx context.Context) error
}

// StoredObjectDigester is implemented by providers that can report the
// SHA-256 and length of an object as stored, by reading it back. A missing
// object is reported with an error wrapping ErrObjectNotFound.
type StoredObjectDigester interface {
	StoredObjectDigest(ctx context.Context, remotePath string) (UploadDigest, error)
}
