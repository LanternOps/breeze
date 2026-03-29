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

	"github.com/Backblaze/blazer/b2"
)

// B2Provider stores backups in Backblaze B2 Cloud Storage.
type B2Provider struct {
	keyID      string
	appKey     string
	bucketName string
	client     *b2.Client
	bucket     *b2.Bucket
	clientMu   sync.Mutex
}

// NewB2Provider creates a new B2Provider.
func NewB2Provider(keyID, appKey, bucketName string) (*B2Provider, error) {
	if keyID == "" {
		return nil, errors.New("b2 key ID is required")
	}
	if appKey == "" {
		return nil, errors.New("b2 application key is required")
	}
	if bucketName == "" {
		return nil, errors.New("b2 bucket name is required")
	}
	return &B2Provider{
		keyID:      keyID,
		appKey:     appKey,
		bucketName: bucketName,
	}, nil
}

// Upload sends a local file to Backblaze B2.
func (p *B2Provider) Upload(localPath, remotePath string) error {
	if localPath == "" {
		return errors.New("local source path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	bucket, err := p.getBucket()
	if err != nil {
		return err
	}

	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	defer file.Close()

	slog.Info("uploading file to b2",
		"bucket", p.bucketName,
		"object", remotePath,
	)

	ctx := context.Background()
	obj := bucket.Object(remotePath)
	writer := obj.NewWriter(ctx)

	if _, err := io.Copy(writer, file); err != nil {
		_ = writer.Close()
		return fmt.Errorf("failed to upload file to b2: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("failed to finalize b2 upload: %w", err)
	}
	return nil
}

// Download retrieves a file from Backblaze B2.
func (p *B2Provider) Download(remotePath, localPath string) error {
	if remotePath == "" {
		return errors.New("remote path is required")
	}
	if localPath == "" {
		return errors.New("local destination path is required")
	}

	bucket, err := p.getBucket()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	slog.Info("downloading file from b2",
		"bucket", p.bucketName,
		"object", remotePath,
	)

	ctx := context.Background()
	reader := bucket.Object(remotePath).NewReader(ctx)

	file, err := os.Create(localPath)
	if err != nil {
		_ = reader.Close()
		return fmt.Errorf("failed to create local destination file: %w", err)
	}

	if _, err := io.Copy(file, reader); err != nil {
		_ = file.Close()
		_ = reader.Close()
		return fmt.Errorf("failed to download file from b2: %w", err)
	}

	closeErr := file.Close()
	readerErr := reader.Close()
	if closeErr != nil {
		return fmt.Errorf("failed to close local destination file: %w", closeErr)
	}
	if readerErr != nil {
		return fmt.Errorf("failed to close b2 reader: %w", readerErr)
	}
	return nil
}

// List enumerates objects in the bucket with the given prefix.
func (p *B2Provider) List(prefix string) ([]string, error) {
	bucket, err := p.getBucket()
	if err != nil {
		return nil, err
	}

	ctx := context.Background()
	iter := bucket.List(ctx, b2.ListPrefix(prefix))

	keys := []string{}
	for iter.Next() {
		obj := iter.Object()
		keys = append(keys, obj.Name())
	}
	if err := iter.Err(); err != nil {
		return nil, fmt.Errorf("failed to list b2 objects: %w", err)
	}
	return keys, nil
}

// Delete removes an object from the bucket.
func (p *B2Provider) Delete(remotePath string) error {
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	bucket, err := p.getBucket()
	if err != nil {
		return err
	}

	slog.Info("deleting object from b2",
		"bucket", p.bucketName,
		"object", remotePath,
	)

	ctx := context.Background()
	if err := bucket.Object(remotePath).Delete(ctx); err != nil {
		return fmt.Errorf("failed to delete b2 object: %w", err)
	}
	return nil
}

func (p *B2Provider) getBucket() (*b2.Bucket, error) {
	p.clientMu.Lock()
	defer p.clientMu.Unlock()

	if p.bucket != nil {
		return p.bucket, nil
	}

	ctx := context.Background()
	client, err := b2.NewClient(ctx, p.keyID, p.appKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create b2 client: %w", err)
	}
	p.client = client

	buckets, err := client.ListBuckets(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list b2 buckets: %w", err)
	}

	for _, bkt := range buckets {
		if bkt.Name() == p.bucketName {
			p.bucket = bkt
			return p.bucket, nil
		}
	}
	return nil, fmt.Errorf("b2 bucket %q not found", p.bucketName)
}
