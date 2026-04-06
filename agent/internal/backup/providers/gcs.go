package providers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	gcs "cloud.google.com/go/storage"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
)

// GCSProvider stores backups in Google Cloud Storage.
type GCSProvider struct {
	bucketName      string
	credentialsJSON []byte
	client          *gcs.Client
	clientMu        sync.Mutex
}

// NewGCSProvider creates a new GCSProvider.
// If credentialsJSON is nil, Application Default Credentials (ADC) are used.
func NewGCSProvider(bucketName string, credentialsJSON []byte) (*GCSProvider, error) {
	if bucketName == "" {
		return nil, errors.New("gcs bucket name is required")
	}
	return &GCSProvider{
		bucketName:      bucketName,
		credentialsJSON: credentialsJSON,
	}, nil
}

// Upload sends a local file to Google Cloud Storage.
func (g *GCSProvider) Upload(localPath, remotePath string) error {
	return g.UploadContext(context.Background(), localPath, remotePath)
}

// UploadContext sends a local file to Google Cloud Storage with cancellation support.
func (g *GCSProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if localPath == "" {
		return errors.New("local source path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	client, err := g.getClient()
	if err != nil {
		return err
	}

	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	defer file.Close()

	slog.Info("uploading file to gcs",
		"bucket", g.bucketName,
		"object", remotePath,
	)

	writer := client.Bucket(g.bucketName).Object(remotePath).NewWriter(ctx)

	if _, err := io.Copy(writer, file); err != nil {
		_ = writer.Close()
		return fmt.Errorf("failed to upload file to gcs: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("failed to finalize gcs upload: %w", err)
	}
	return nil
}

// Download retrieves a file from Google Cloud Storage.
func (g *GCSProvider) Download(remotePath, localPath string) error {
	if remotePath == "" {
		return errors.New("remote path is required")
	}
	if localPath == "" {
		return errors.New("local destination path is required")
	}

	client, err := g.getClient()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	slog.Info("downloading file from gcs",
		"bucket", g.bucketName,
		"object", remotePath,
	)

	ctx := context.Background()
	reader, err := client.Bucket(g.bucketName).Object(remotePath).NewReader(ctx)
	if err != nil {
		return fmt.Errorf("failed to create gcs reader: %w", err)
	}
	defer reader.Close()

	file, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("failed to create local destination file: %w", err)
	}

	if _, err := io.Copy(file, reader); err != nil {
		_ = file.Close()
		return fmt.Errorf("failed to download file from gcs: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("failed to close local destination file: %w", err)
	}
	return nil
}

// List enumerates objects in the bucket with the given prefix.
func (g *GCSProvider) List(prefix string) ([]string, error) {
	client, err := g.getClient()
	if err != nil {
		return nil, err
	}

	ctx := context.Background()
	query := &gcs.Query{Prefix: prefix}
	it := client.Bucket(g.bucketName).Objects(ctx, query)

	keys := []string{}
	for {
		attrs, err := it.Next()
		if errors.Is(err, iterator.Done) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("failed to list gcs objects: %w", err)
		}
		keys = append(keys, attrs.Name)
	}
	return keys, nil
}

// Delete removes an object from the bucket.
func (g *GCSProvider) Delete(remotePath string) error {
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	client, err := g.getClient()
	if err != nil {
		return err
	}

	slog.Info("deleting object from gcs",
		"bucket", g.bucketName,
		"object", remotePath,
	)

	ctx := context.Background()
	if err := client.Bucket(g.bucketName).Object(remotePath).Delete(ctx); err != nil {
		return fmt.Errorf("failed to delete gcs object: %w", err)
	}
	return nil
}

// UploadStream uploads data from a reader to Google Cloud Storage.
func (g *GCSProvider) UploadStream(reader io.Reader, remotePath string, _ int64) error {
	if reader == nil {
		return errors.New("reader is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	client, err := g.getClient()
	if err != nil {
		return err
	}

	slog.Info("streaming upload to gcs",
		"bucket", g.bucketName,
		"object", remotePath,
	)

	ctx := context.Background()
	writer := client.Bucket(g.bucketName).Object(remotePath).NewWriter(ctx)

	if _, err := io.Copy(writer, reader); err != nil {
		_ = writer.Close()
		return fmt.Errorf("failed to stream upload to gcs: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("failed to finalize gcs stream upload: %w", err)
	}
	return nil
}

// GetObjectMetadata returns metadata for a GCS object.
func (g *GCSProvider) GetObjectMetadata(remotePath string) (*ObjectMetadata, error) {
	if remotePath == "" {
		return nil, errors.New("remote path is required")
	}

	client, err := g.getClient()
	if err != nil {
		return nil, err
	}

	ctx := context.Background()
	attrs, err := client.Bucket(g.bucketName).Object(remotePath).Attrs(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get gcs object attributes: %w", err)
	}

	meta := &ObjectMetadata{
		Size:         attrs.Size,
		LastModified: attrs.Updated,
		StorageTier:  attrs.StorageClass,
	}
	if len(attrs.MD5) > 0 {
		meta.ContentHash = fmt.Sprintf("%x", attrs.MD5)
	}
	return meta, nil
}

func (g *GCSProvider) getClient() (*gcs.Client, error) {
	g.clientMu.Lock()
	defer g.clientMu.Unlock()

	if g.client != nil {
		return g.client, nil
	}

	ctx := context.Background()
	var opts []option.ClientOption
	if len(g.credentialsJSON) > 0 {
		opts = append(opts, option.WithCredentialsJSON(g.credentialsJSON))
	}

	client, err := gcs.NewClient(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create gcs client: %w", err)
	}

	g.client = client
	return g.client, nil
}
