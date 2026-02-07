package providers

import (
	"errors"
	"fmt"
)

// S3Provider is a stub for S3-compatible backup storage.
type S3Provider struct {
	Bucket          string
	Region          string
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
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
	return fmt.Errorf("s3 upload not implemented")
}

// Download retrieves a file from S3.
func (s *S3Provider) Download(remotePath, localPath string) error {
	if s.Bucket == "" || s.Region == "" {
		return errors.New("s3 bucket and region are required")
	}
	return fmt.Errorf("s3 download not implemented")
}

// List lists objects in the bucket with the given prefix.
func (s *S3Provider) List(prefix string) ([]string, error) {
	if s.Bucket == "" || s.Region == "" {
		return nil, errors.New("s3 bucket and region are required")
	}
	return nil, fmt.Errorf("s3 list not implemented")
}

// Delete removes an object from the bucket.
func (s *S3Provider) Delete(remotePath string) error {
	if s.Bucket == "" || s.Region == "" {
		return errors.New("s3 bucket and region are required")
	}
	return fmt.Errorf("s3 delete not implemented")
}
