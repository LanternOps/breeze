package providers

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
)

// AzureProvider stores backups in Azure Blob Storage.
type AzureProvider struct {
	containerName string
	accountName   string
	accountKey    string
	client        *azblob.Client
	clientMu      sync.Mutex
}

// NewAzureProvider creates a new AzureProvider.
func NewAzureProvider(accountName, accountKey, containerName string) (*AzureProvider, error) {
	if accountName == "" {
		return nil, errors.New("azure account name is required")
	}
	if accountKey == "" {
		return nil, errors.New("azure account key is required")
	}
	if containerName == "" {
		return nil, errors.New("azure container name is required")
	}
	return &AzureProvider{
		containerName: containerName,
		accountName:   accountName,
		accountKey:    accountKey,
	}, nil
}

// Upload sends a local file to Azure Blob Storage.
func (a *AzureProvider) Upload(localPath, remotePath string) error {
	if localPath == "" {
		return errors.New("local source path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	client, err := a.getClient()
	if err != nil {
		return err
	}

	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	defer file.Close()

	slog.Info("uploading file to azure blob storage",
		"container", a.containerName,
		"blob", remotePath,
	)

	ctx := context.Background()
	if _, err := client.UploadFile(ctx, a.containerName, remotePath, file, nil); err != nil {
		return fmt.Errorf("failed to upload file to azure: %w", err)
	}
	return nil
}

// Download retrieves a file from Azure Blob Storage.
func (a *AzureProvider) Download(remotePath, localPath string) error {
	if remotePath == "" {
		return errors.New("remote path is required")
	}
	if localPath == "" {
		return errors.New("local destination path is required")
	}

	client, err := a.getClient()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	file, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("failed to create local destination file: %w", err)
	}

	slog.Info("downloading file from azure blob storage",
		"container", a.containerName,
		"blob", remotePath,
	)

	ctx := context.Background()
	if _, err := client.DownloadFile(ctx, a.containerName, remotePath, file, nil); err != nil {
		closeErr := file.Close()
		if closeErr != nil {
			slog.Warn("failed to close file after download error", "error", closeErr.Error())
		}
		return fmt.Errorf("failed to download file from azure: %w", err)
	}

	if err := file.Close(); err != nil {
		return fmt.Errorf("failed to close local destination file: %w", err)
	}
	return nil
}

// List enumerates blobs in the container with the given prefix.
func (a *AzureProvider) List(prefix string) ([]string, error) {
	client, err := a.getClient()
	if err != nil {
		return nil, err
	}

	ctx := context.Background()
	pager := client.NewListBlobsFlatPager(a.containerName, &azblob.ListBlobsFlatOptions{
		Prefix: &prefix,
	})

	keys := []string{}
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list azure blobs: %w", err)
		}
		for _, item := range page.Segment.BlobItems {
			if item.Name != nil {
				keys = append(keys, *item.Name)
			}
		}
	}
	return keys, nil
}

// Delete removes a blob from the container.
func (a *AzureProvider) Delete(remotePath string) error {
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	client, err := a.getClient()
	if err != nil {
		return err
	}

	slog.Info("deleting blob from azure blob storage",
		"container", a.containerName,
		"blob", remotePath,
	)

	ctx := context.Background()
	if _, err := client.DeleteBlob(ctx, a.containerName, remotePath, nil); err != nil {
		return fmt.Errorf("failed to delete azure blob: %w", err)
	}
	return nil
}

// UploadStream uploads data from a reader to Azure Blob Storage.
func (a *AzureProvider) UploadStream(reader io.Reader, remotePath string, _ int64) error {
	if reader == nil {
		return errors.New("reader is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	client, err := a.getClient()
	if err != nil {
		return err
	}

	slog.Info("streaming upload to azure blob storage",
		"container", a.containerName,
		"blob", remotePath,
	)

	ctx := context.Background()
	if _, err := client.UploadStream(ctx, a.containerName, remotePath, reader, nil); err != nil {
		return fmt.Errorf("failed to stream upload to azure: %w", err)
	}
	return nil
}

// GetObjectMetadata returns metadata for a blob.
func (a *AzureProvider) GetObjectMetadata(remotePath string) (*ObjectMetadata, error) {
	if remotePath == "" {
		return nil, errors.New("remote path is required")
	}

	client, err := a.getClient()
	if err != nil {
		return nil, err
	}

	ctx := context.Background()
	blobClient := client.ServiceClient().NewContainerClient(a.containerName).NewBlobClient(remotePath)
	props, err := blobClient.GetProperties(ctx, &blob.GetPropertiesOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to get azure blob properties: %w", err)
	}

	meta := &ObjectMetadata{}
	if props.ContentLength != nil {
		meta.Size = *props.ContentLength
	}
	if props.LastModified != nil {
		meta.LastModified = *props.LastModified
	}
	if props.AccessTier != nil {
		meta.StorageTier = string(*props.AccessTier)
	}
	if props.ContentMD5 != nil {
		meta.ContentHash = hex.EncodeToString(props.ContentMD5)
	}
	return meta, nil
}

func (a *AzureProvider) getClient() (*azblob.Client, error) {
	a.clientMu.Lock()
	defer a.clientMu.Unlock()

	if a.client != nil {
		return a.client, nil
	}

	cred, err := azblob.NewSharedKeyCredential(a.accountName, a.accountKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create azure shared key credential: %w", err)
	}

	serviceURL := fmt.Sprintf("https://%s.blob.core.windows.net/", a.accountName)
	client, err := azblob.NewClientWithSharedKeyCredential(serviceURL, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create azure blob client: %w", err)
	}

	a.client = client
	return a.client, nil
}
