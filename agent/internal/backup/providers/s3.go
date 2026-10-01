package providers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const multipartUploadThreshold = 100 * 1024 * 1024 // 100 MB

// S3Provider is a stub for S3-compatible backup storage.
type S3Provider struct {
	Bucket          string
	Region          string
	endpoint        string
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
	sseAlgorithm    string
	sseKMSKeyID     string
	client          *s3.Client
	clientMu        sync.Mutex
}

// NewS3Provider creates a new S3Provider.
func NewS3Provider(bucket, region, accessKeyID, secretAccessKey, sessionToken string) *S3Provider {
	return NewS3ProviderWithEndpoint(bucket, region, "", accessKeyID, secretAccessKey, sessionToken)
}

// BackupIdentity implements JournalIdentity. The endpoint is included
// because a custom endpoint means an S3-compatible-but-different backend
// (MinIO, Backblaze's S3 API, ...) even when bucket+region happen to match.
func (s *S3Provider) BackupIdentity() string {
	return fmt.Sprintf("s3|%s|%s|%s", s.endpoint, s.Region, s.Bucket)
}

// SetServerSideEncryption requires S3 server-side encryption on future uploads.
func (s *S3Provider) SetServerSideEncryption(algorithm, kmsKeyID string) {
	s.sseAlgorithm = algorithm
	s.sseKMSKeyID = kmsKeyID
}

// NewS3ProviderWithEndpoint creates a new S3Provider with an optional custom endpoint.
func NewS3ProviderWithEndpoint(bucket, region, endpoint, accessKeyID, secretAccessKey, sessionToken string) *S3Provider {
	return &S3Provider{
		Bucket:          bucket,
		Region:          region,
		endpoint:        endpoint,
		accessKeyID:     accessKeyID,
		secretAccessKey: secretAccessKey,
		sessionToken:    sessionToken,
	}
}

// Upload sends a local file to S3.
func (s *S3Provider) Upload(localPath, remotePath string) error {
	return s.UploadContext(context.Background(), localPath, remotePath)
}

// UploadContext sends a local file to S3 with cancellation support.
func (s *S3Provider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	_, err := s.upload(ctx, localPath, remotePath, false)
	return err
}

// UploadWithDigest implements DigestUploader: it uploads like UploadContext
// and returns the digest of the bytes the stored object holds. A file up to
// the multipart threshold goes up in one PutObject whose body hashes the
// pass the SDK finally sent (see rewindableDigestSource); a larger file is
// read once, sequentially, by the multipart uploader (see
// sequentialDigestReader), trading the concurrent ReadAt path for a digest of
// exactly what was stored.
func (s *S3Provider) UploadWithDigest(ctx context.Context, localPath, remotePath string) (UploadDigest, error) {
	return s.upload(ctx, localPath, remotePath, true)
}

// s3MultipartThreshold is multipartUploadThreshold, as a variable so tests
// can reach the multipart path with a small file.
var s3MultipartThreshold int64 = multipartUploadThreshold

func setS3MultipartThresholdForTest(n int64) (restore func()) {
	old := s3MultipartThreshold
	s3MultipartThreshold = n
	return func() { s3MultipartThreshold = old }
}

// s3SequentialMemoryBudget bounds the memory a sequential multipart upload
// buffers, up to the part size where one part alone needs more.
const s3SequentialMemoryBudget = 256 << 20

// s3SequentialPartPlan sizes a sequential multipart upload of size bytes (a
// file that may change while it is read — see UploadWithDigest). Without a
// seekable body the uploader cannot size parts itself, and it buffers parts
// in memory: (concurrency+1) pooled parts plus the first part, read
// separately and grown by doubling (up to two parts). The part size leaves
// headroom under the 10,000-part limit for a file that grows while it is
// read; concurrency shrinks as parts grow, to at least 1. The resulting
// bound (s3SequentialBufferedBytes) is s3SequentialMemoryBudget up to about
// 500 GiB, and four parts above that (about 490 MB at 1 TiB, 2.4 GB at
// 5 TiB). Database and VM exports, which cannot change during the backup,
// never take this path.
func s3SequentialPartPlan(size int64) (partSize int64, concurrency int) {
	const maxParts = 9000
	partSize = manager.MinUploadPartSize
	if size > 0 {
		if need := (size + maxParts - 1) / maxParts; need > partSize {
			partSize = need
		}
	}
	concurrency = int(s3SequentialMemoryBudget/partSize) - 3
	if concurrency > manager.DefaultUploadConcurrency {
		concurrency = manager.DefaultUploadConcurrency
	}
	if concurrency < 1 {
		concurrency = 1
	}
	return partSize, concurrency
}

// s3SequentialBufferedBytes is the most a sequential multipart upload of size
// bytes holds in memory (see s3SequentialPartPlan).
func s3SequentialBufferedBytes(size int64) int64 {
	part, concurrency := s3SequentialPartPlan(size)
	return int64(concurrency+3) * part
}

// immutableSourceKey marks an upload whose source cannot change while the
// backup runs.
type immutableSourceKey struct{}

// WithImmutableSource returns a context telling UploadWithDigest that the
// source file cannot change during the backup (a database backup file or VM
// export the helper itself just wrote). A large file is then hashed in one
// read and uploaded through the SDK's unbuffered ranged-read path; if its
// size or modification time changed by the end of the upload, the upload
// fails.
func WithImmutableSource(ctx context.Context) context.Context {
	return context.WithValue(ctx, immutableSourceKey{}, true)
}

// IsImmutableSource reports whether ctx carries WithImmutableSource.
func IsImmutableSource(ctx context.Context) bool {
	return immutableSource(ctx)
}

func immutableSource(ctx context.Context) bool {
	v, _ := ctx.Value(immutableSourceKey{}).(bool)
	return v
}

// largeDigestUploadHook reports which path a digested multipart upload took
// ("immutable" or "sequential"). Test seam.
var largeDigestUploadHook func(mode string)

func setLargeDigestUploadHookForTest(fn func(mode string)) (restore func()) {
	old := largeDigestUploadHook
	largeDigestUploadHook = fn
	return func() { largeDigestUploadHook = old }
}

func (s *S3Provider) upload(ctx context.Context, localPath, remotePath string, withDigest bool) (UploadDigest, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.Bucket == "" || s.Region == "" {
		return UploadDigest{}, errors.New("s3 bucket and region are required")
	}
	if localPath == "" {
		return UploadDigest{}, errors.New("local source path is required")
	}
	if remotePath == "" {
		return UploadDigest{}, errors.New("remote path is required")
	}

	client, err := s.getClient()
	if err != nil {
		return UploadDigest{}, err
	}

	file, err := os.Open(localPath)
	if err != nil {
		return UploadDigest{}, fmt.Errorf("failed to open source file: %w", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return UploadDigest{}, fmt.Errorf("failed to stat source file: %w", err)
	}

	input := &s3.PutObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(remotePath),
		Body:   uploadProgressSource(ctx, file),
	}
	switch s.sseAlgorithm {
	case "AES256":
		input.ServerSideEncryption = s3types.ServerSideEncryptionAes256
	case "aws:kms":
		input.ServerSideEncryption = s3types.ServerSideEncryptionAwsKms
		if s.sseKMSKeyID != "" {
			input.SSEKMSKeyId = aws.String(s.sseKMSKeyID)
		}
	}

	threshold := int64(multipartUploadThreshold)
	if withDigest {
		threshold = s3MultipartThreshold
	}
	if info.Size() > threshold {
		if !withDigest {
			// The feature/s3/manager uploader stays until the module moves to
			// transfermanager as a whole (the same call this path always made).
			uploader := manager.NewUploader(client)                //nolint:staticcheck // see above
			if _, err := uploader.Upload(ctx, input); err != nil { //nolint:staticcheck // see above
				return UploadDigest{}, fmt.Errorf("failed to upload file to s3 with multipart upload: %w", err)
			}
			return UploadDigest{}, nil
		}
		if immutableSource(ctx) {
			if largeDigestUploadHook != nil {
				largeDigestUploadHook("immutable")
			}
			return s.uploadImmutable(ctx, client, input, file, info, remotePath)
		}
		if largeDigestUploadHook != nil {
			largeDigestUploadHook("sequential")
		}
		body := newSequentialDigestReader(uploadProgressSource(ctx, file))
		input.Body = body
		partSize, concurrency := s3SequentialPartPlan(info.Size())
		uploader := manager.NewUploader(client, func(u *manager.Uploader) { //nolint:staticcheck // as above
			u.PartSize = partSize
			u.Concurrency = concurrency
		})
		if _, err := uploader.Upload(ctx, input); err != nil { //nolint:staticcheck // as above
			return UploadDigest{}, fmt.Errorf("failed to upload file to s3 with multipart upload: %w", err)
		}
		return body.digest(), nil
	}

	var digestSource *rewindableDigestSource
	if withDigest {
		digestSource = newRewindableDigestSource(uploadProgressSource(ctx, file))
		input.Body = digestSource
	}
	if _, err := client.PutObject(ctx, input); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to upload file to s3: %w", err)
	}
	if !withDigest {
		return UploadDigest{}, nil
	}
	d, ok := digestSource.digest()
	if !ok {
		return UploadDigest{}, fmt.Errorf("%w: the upload of %s was not read as one complete pass", ErrDigestUnavailable, remotePath)
	}
	return d, nil
}

// uploadImmutable hashes file in one sequential read, uploads it through the
// uploader's ranged-read path (parts are read concurrently straight from the
// file, nothing buffered), and fails if the file's size or modification time
// changed meanwhile — the digest would then not describe what was stored.
func (s *S3Provider) uploadImmutable(ctx context.Context, client *s3.Client, input *s3.PutObjectInput, file *os.File, before os.FileInfo, remotePath string) (UploadDigest, error) {
	sum := newCountingHash()
	if _, err := io.Copy(sum, &contextReader{ctx: ctx, reader: file}); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to read source file: %w", err)
	}
	d := sum.digest()
	if d.Size != before.Size() {
		return UploadDigest{}, fmt.Errorf("source file for %s changed while it was read", remotePath)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to rewind source file: %w", err)
	}
	input.Body = uploadProgressSource(ctx, file)
	uploader := manager.NewUploader(client)                //nolint:staticcheck // see UploadContext's multipart path
	if _, err := uploader.Upload(ctx, input); err != nil { //nolint:staticcheck // as above
		return UploadDigest{}, fmt.Errorf("failed to upload file to s3 with multipart upload: %w", err)
	}
	// Heuristic, not proof: the size+mtime check relies on the caller having
	// written and closed the file itself (only the MSSQL .bak and Hyper-V
	// export uploads mark their sources unchanging).
	after, err := file.Stat()
	if err != nil {
		return UploadDigest{}, fmt.Errorf("failed to stat source file after upload: %w", err)
	}
	if after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return UploadDigest{}, fmt.Errorf("source file for %s changed during the upload", remotePath)
	}
	return d, nil
}

// Download retrieves a file from S3.
func (s *S3Provider) Download(remotePath, localPath string) error {
	return s.DownloadContext(context.Background(), remotePath, localPath)
}

// DownloadContext retrieves a file from S3. Cancelling ctx aborts the request
// and any in-progress body read.
func (s *S3Provider) DownloadContext(ctx context.Context, remotePath, localPath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.Bucket == "" || s.Region == "" {
		return errors.New("s3 bucket and region are required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}
	if localPath == "" {
		return errors.New("local destination path is required")
	}

	client, err := s.getClient()
	if err != nil {
		return err
	}

	resp, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(remotePath),
	})
	if err != nil {
		var noSuchKey *s3types.NoSuchKey
		if errors.As(err, &noSuchKey) {
			return fmt.Errorf("%w: %s", ErrObjectNotFound, err)
		}
		return fmt.Errorf("failed to get s3 object: %w", err)
	}
	defer resp.Body.Close()

	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	file, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("failed to create local destination file: %w", err)
	}
	_, copyErr := io.Copy(DownloadProgressWriter(ctx, file), resp.Body)
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("failed to write s3 object to local file: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("failed to close local destination file: %w", closeErr)
	}

	return nil
}

// List lists objects in the bucket with the given prefix.
func (s *S3Provider) List(prefix string) ([]string, error) {
	if s.Bucket == "" || s.Region == "" {
		return nil, errors.New("s3 bucket and region are required")
	}

	client, err := s.getClient()
	if err != nil {
		return nil, err
	}

	ctx := context.Background()
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.Bucket),
		Prefix: aws.String(prefix),
	})

	keys := []string{}
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list s3 objects: %w", err)
		}
		for _, object := range page.Contents {
			if object.Key != nil {
				keys = append(keys, *object.Key)
			}
		}
	}

	return keys, nil
}

// Delete removes an object from the bucket.
func (s *S3Provider) Delete(remotePath string) error {
	if s.Bucket == "" || s.Region == "" {
		return errors.New("s3 bucket and region are required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	client, err := s.getClient()
	if err != nil {
		return err
	}

	if _, err := client.DeleteObject(context.Background(), &s3.DeleteObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(remotePath),
	}); err != nil {
		return fmt.Errorf("failed to delete s3 object: %w", err)
	}
	return nil
}

func (s *S3Provider) getClient() (*s3.Client, error) {
	s.clientMu.Lock()
	defer s.clientMu.Unlock()

	if s.client != nil {
		return s.client, nil
	}

	// Defensive transport timeouts: without these, the AWS SDK's HTTP client
	// has no dial/TLS/header deadline and a stalled network peer wedges the
	// request forever. The mid-body stall (a peer that accepts the request
	// but never finishes reading/writing the body) is NOT covered here — that
	// case is handled by the caller's context: the per-file upload deadline in
	// snapshot.go, and the per-file download deadline in verify.go (#6598).
	httpClient := awshttp.NewBuildableClient().
		WithDialerOptions(func(d *net.Dialer) { d.Timeout = 30 * time.Second }).
		WithTransportOptions(func(tr *http.Transport) {
			tr.TLSHandshakeTimeout = 30 * time.Second
			tr.ResponseHeaderTimeout = 2 * time.Minute
			tr.ExpectContinueTimeout = 10 * time.Second
		})

	options := []func(*awscfg.LoadOptions) error{
		awscfg.WithRegion(s.Region),
		awscfg.WithHTTPClient(httpClient),
		// #6350: the SDK default (WhenSupported) makes every HTTPS PutObject
		// carry a CRC32 trailer via `aws-chunked` transfer encoding, and when
		// the body length is known with no explicit ChunkLength the SDK emits
		// the WHOLE body as ONE chunk. MinIO caps a chunk at 16 MiB
		// (maxChunkSize in cmd/streaming-signature-v4.go) and rejects anything
		// larger with HTTP 400 "chunk too big" — so over HTTPS every file
		// between 16 MiB and multipartUploadThreshold silently failed to
		// upload. (The same trap returns above ~160 GiB, where the multipart
		// manager's computed part size grows past 16 MiB again.)
		//
		// WhenRequired keeps checksums for operations that mandate them and
		// drops the chunked trailer otherwise. Content integrity is unaffected
		// in practice: the transport is TLS + SigV4-signed, and the agent
		// writes a per-file SHA-256 into the manifest that VerifyIntegrity
		// re-checks against the downloaded object.
		awscfg.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
	}
	if s.endpoint != "" {
		options = append(options, awscfg.WithEndpointResolverWithOptions(
			aws.EndpointResolverWithOptionsFunc(func(service, region string, _ ...interface{}) (aws.Endpoint, error) {
				if service != s3.ServiceID {
					return aws.Endpoint{}, &aws.EndpointNotFoundError{}
				}
				return aws.Endpoint{
					URL:               s.endpoint,
					SigningRegion:     region,
					HostnameImmutable: true,
				}, nil
			}),
		))
	}
	if s.accessKeyID != "" && s.secretAccessKey != "" {
		options = append(options, awscfg.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(s.accessKeyID, s.secretAccessKey, s.sessionToken),
		))
	}

	cfg, err := awscfg.LoadDefaultConfig(context.Background(), options...)
	if err != nil {
		return nil, fmt.Errorf("failed to load aws config: %w", err)
	}

	s.client = s3.NewFromConfig(cfg)
	return s.client, nil
}
