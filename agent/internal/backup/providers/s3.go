package providers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const multipartUploadThreshold = 100 * 1024 * 1024 // 100 MB

// S3Provider is a stub for S3-compatible backup storage.
type S3Provider struct {
	Bucket          string
	Region          string
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
	client          *s3.Client
	clientMu        sync.Mutex
}

// NewS3Provider creates a new S3Provider.
func NewS3Provider(bucket, region, accessKeyID, secretAccessKey, sessionToken string) *S3Provider {
	return &S3Provider{
		Bucket:          bucket,
		Region:          region,
		accessKeyID:     accessKeyID,
		secretAccessKey: secretAccessKey,
		sessionToken:    sessionToken,
	}
}

// Upload sends a local file to S3.
func (s *S3Provider) Upload(localPath, remotePath string) error {
	if s.Bucket == "" || s.Region == "" {
		return errors.New("s3 bucket and region are required")
	}
	if localPath == "" {
		return errors.New("local source path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	client, err := s.getClient()
	if err != nil {
		return err
	}

	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat source file: %w", err)
	}

	ctx := context.Background()
	input := &s3.PutObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(remotePath),
		Body:   file,
	}
	if info.Size() > multipartUploadThreshold {
		uploader := manager.NewUploader(client)
		if _, err := uploader.Upload(ctx, input); err != nil {
			return fmt.Errorf("failed to upload file to s3 with multipart upload: %w", err)
		}
		return nil
	}

	if _, err := client.PutObject(ctx, input); err != nil {
		return fmt.Errorf("failed to upload file to s3: %w", err)
	}
	return nil
}

// Download retrieves a file from S3.
func (s *S3Provider) Download(remotePath, localPath string) error {
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

	ctx := context.Background()
	resp, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(remotePath),
	})
	if err != nil {
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
	_, copyErr := io.Copy(file, resp.Body)
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

	options := []func(*awscfg.LoadOptions) error{
		awscfg.WithRegion(s.Region),
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
