package providers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
)

// FallbackProvider wraps multiple BackupProviders. Uploads go to the primary
// (first) provider, downloads try each in order until one succeeds, and
// deletes propagate to all providers.
type FallbackProvider struct {
	providers []BackupProvider
}

// NewFallbackProvider creates a FallbackProvider from one or more providers.
// The first provider is treated as the primary.
func NewFallbackProvider(providers ...BackupProvider) *FallbackProvider {
	return &FallbackProvider{providers: providers}
}

// Upload sends the file to the FIRST (primary) provider only.
func (f *FallbackProvider) Upload(localPath, remotePath string) error {
	return f.UploadContext(context.Background(), localPath, remotePath)
}

// UploadContext sends the file to the FIRST (primary) provider only.
func (f *FallbackProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if len(f.providers) == 0 {
		return errors.New("fallback provider has no configured providers")
	}
	if uploader, ok := f.providers[0].(interface {
		UploadContext(context.Context, string, string) error
	}); ok {
		return uploader.UploadContext(ctx, localPath, remotePath)
	}
	return f.providers[0].Upload(localPath, remotePath)
}

// Download tries each provider in order until one succeeds.
func (f *FallbackProvider) Download(remotePath, localPath string) error {
	if len(f.providers) == 0 {
		return errors.New("fallback provider has no configured providers")
	}

	var lastErr error
	for i, p := range f.providers {
		err := p.Download(remotePath, localPath)
		if err == nil {
			if i > 0 {
				slog.Info("fallback download succeeded on secondary provider",
					"providerIndex", i, "remotePath", remotePath)
			}
			return nil
		}
		lastErr = err
		slog.Debug("fallback download failed, trying next provider",
			"providerIndex", i, "error", err.Error())
	}
	return fmt.Errorf("all %d providers failed to download %s: %w",
		len(f.providers), remotePath, lastErr)
}

// List returns results from the FIRST (primary) provider.
func (f *FallbackProvider) List(prefix string) ([]string, error) {
	if len(f.providers) == 0 {
		return nil, errors.New("fallback provider has no configured providers")
	}
	return f.providers[0].List(prefix)
}

// Delete removes the file from ALL providers. Errors are collected but
// do not stop deletion from remaining providers.
func (f *FallbackProvider) Delete(remotePath string) error {
	if len(f.providers) == 0 {
		return errors.New("fallback provider has no configured providers")
	}

	var errs []error
	for i, p := range f.providers {
		if err := p.Delete(remotePath); err != nil {
			slog.Warn("fallback delete failed on provider",
				"providerIndex", i, "error", err.Error())
			errs = append(errs, fmt.Errorf("provider %d: %w", i, err))
		}
	}
	return errors.Join(errs...)
}
