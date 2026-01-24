package providers

import (
	"errors"
	"fmt"
)

// S3Provider is a stub for S3-compatible backup storage.
type S3Provider struct {
	Bucket          string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

// NewS3Provider creates a new S3Provider.
func NewS3Provider(bucket, region, accessKeyID, secretAccessKey, sessionToken string) *S3Provider {
	return &S3Provider{
		Bucket:          bucket,
		Region:          region,
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		SessionToken:    sessionToken,
	}
}

// Upload sends a local file to S3.
func (s *S3Provider) Upload(localPath, remotePath string) error {
	if s.Bucket == "" || s.Region == "" {
		return errors.New("s3 bucket and region are required")
	}
	// Pattern:
	// cfg := aws.NewConfig().WithRegion(s.Region)
	// sess := session.Must(session.NewSession(cfg))
	// uploader := s3manager.NewUploader(sess)
	// file, _ := os.Open(localPath)
	// _, err := uploader.Upload(&s3manager.UploadInput{
	// 	Bucket: aws.String(s.Bucket),
	// 	Key:    aws.String(remotePath),
	// 	Body:   file,
	// })
	return fmt.Errorf("s3 upload not implemented")
}

// Download retrieves a file from S3.
func (s *S3Provider) Download(remotePath, localPath string) error {
	if s.Bucket == "" || s.Region == "" {
		return errors.New("s3 bucket and region are required")
	}
	// Pattern:
	// cfg := aws.NewConfig().WithRegion(s.Region)
	// sess := session.Must(session.NewSession(cfg))
	// downloader := s3manager.NewDownloader(sess)
	// file, _ := os.Create(localPath)
	// _, err := downloader.Download(file, &s3.GetObjectInput{
	// 	Bucket: aws.String(s.Bucket),
	// 	Key:    aws.String(remotePath),
	// })
	return fmt.Errorf("s3 download not implemented")
}

// List lists objects in the bucket with the given prefix.
func (s *S3Provider) List(prefix string) ([]string, error) {
	if s.Bucket == "" || s.Region == "" {
		return nil, errors.New("s3 bucket and region are required")
	}
	// Pattern:
	// svc := s3.New(session.Must(session.NewSession(aws.NewConfig().WithRegion(s.Region))))
	// resp, _ := svc.ListObjectsV2(&s3.ListObjectsV2Input{Bucket: aws.String(s.Bucket), Prefix: aws.String(prefix)})
	return nil, fmt.Errorf("s3 list not implemented")
}

// Delete removes an object from the bucket.
func (s *S3Provider) Delete(remotePath string) error {
	if s.Bucket == "" || s.Region == "" {
		return errors.New("s3 bucket and region are required")
	}
	// Pattern:
	// svc := s3.New(session.Must(session.NewSession(aws.NewConfig().WithRegion(s.Region))))
	// _, err := svc.DeleteObject(&s3.DeleteObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(remotePath)})
	return fmt.Errorf("s3 delete not implemented")
}
