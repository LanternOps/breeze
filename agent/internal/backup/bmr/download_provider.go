package bmr

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type recoveryDownloadProvider struct {
	serverURL string
	token     string

	mu         sync.RWMutex
	descriptor *AuthenticatedDownloadDescriptor
}

func newRecoveryDownloadProvider(serverURL, token string, descriptor *AuthenticatedDownloadDescriptor) *recoveryDownloadProvider {
	return &recoveryDownloadProvider{
		serverURL:  serverURL,
		token:      token,
		descriptor: descriptor,
	}
}

func (p *recoveryDownloadProvider) Upload(localPath, remotePath string) error {
	return fmt.Errorf("bmr: upload is not supported for authenticated recovery downloads")
}

func (p *recoveryDownloadProvider) List(prefix string) ([]string, error) {
	return nil, fmt.Errorf("bmr: list is not supported for authenticated recovery downloads")
}

func (p *recoveryDownloadProvider) Delete(remotePath string) error {
	return fmt.Errorf("bmr: delete is not supported for authenticated recovery downloads")
}

func (p *recoveryDownloadProvider) Download(remotePath, localPath string) error {
	if strings.TrimSpace(remotePath) == "" {
		return fmt.Errorf("bmr: remote path is required")
	}
	if strings.TrimSpace(localPath) == "" {
		return fmt.Errorf("bmr: local destination path is required")
	}

	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("bmr: create destination directory: %w", err)
	}

	if err := p.downloadOnce(remotePath, localPath); err == nil {
		return nil
	} else if !p.shouldRefresh(err) {
		return err
	}

	bootstrap, authErr := authenticateRecoverySession(p.serverURL, p.token)
	if authErr != nil {
		return fmt.Errorf("%w; re-authenticate failed: %v", authErr, authErr)
	}
	if bootstrap.Download == nil {
		return fmt.Errorf("bmr: refreshed bootstrap missing download descriptor")
	}
	p.mu.Lock()
	p.descriptor = bootstrap.Download
	p.mu.Unlock()

	return p.downloadOnce(remotePath, localPath)
}

func (p *recoveryDownloadProvider) shouldRefresh(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "status 401") || strings.Contains(message, "status 403")
}

func (p *recoveryDownloadProvider) currentDescriptor() (*AuthenticatedDownloadDescriptor, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if p.descriptor == nil {
		return nil, fmt.Errorf("bmr: missing download descriptor")
	}
	if p.descriptor.URL == "" {
		return nil, fmt.Errorf("bmr: download descriptor url is required")
	}
	if p.descriptor.PathPrefix == "" {
		return nil, fmt.Errorf("bmr: download descriptor path prefix is required")
	}
	return p.descriptor, nil
}

func (p *recoveryDownloadProvider) downloadOnce(remotePath, localPath string) error {
	descriptor, err := p.currentDescriptor()
	if err != nil {
		return err
	}

	normalizedRemotePath := strings.TrimLeft(pathClean(remotePath), "/")
	normalizedPrefix := strings.Trim(descriptor.PathPrefix, "/")
	if normalizedRemotePath != normalizedPrefix && !strings.HasPrefix(normalizedRemotePath, normalizedPrefix+"/") {
		return fmt.Errorf("bmr: requested path %q is outside allowed prefix %q", remotePath, descriptor.PathPrefix)
	}

	requestURL, err := url.Parse(descriptor.URL)
	if err != nil {
		return fmt.Errorf("bmr: invalid download url: %w", err)
	}
	query := requestURL.Query()
	tokenParam := descriptor.TokenQueryParam
	if tokenParam == "" {
		tokenParam = "token"
	}
	pathParam := descriptor.PathQueryParam
	if pathParam == "" {
		pathParam = "path"
	}
	query.Set(tokenParam, p.token)
	query.Set(pathParam, normalizedRemotePath)
	requestURL.RawQuery = query.Encode()

	req, err := http.NewRequest(http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return fmt.Errorf("bmr: create download request: %w", err)
	}

	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("bmr: download request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err == nil {
			if message, ok := body["error"].(string); ok && message != "" {
				return fmt.Errorf("bmr: download failed with status %d: %s", resp.StatusCode, message)
			}
		}
		return fmt.Errorf("bmr: download failed with status %d", resp.StatusCode)
	}

	file, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("bmr: create local destination file: %w", err)
	}
	_, copyErr := io.Copy(file, resp.Body)
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("bmr: write downloaded file: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("bmr: close downloaded file: %w", closeErr)
	}
	return nil
}

func pathClean(path string) string {
	cleaned := filepath.ToSlash(filepath.Clean(path))
	if cleaned == "." {
		return ""
	}
	return cleaned
}
