package bmr

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

var newHTTPClient = func() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

var runRecovery = RunRecoveryContext

func RunRecoveryWithToken(cfg RecoveryConfig) (*RecoveryResult, error) {
	return RunRecoveryWithTokenContext(context.Background(), cfg)
}

func RunRecoveryWithTokenContext(ctx context.Context, cfg RecoveryConfig) (*RecoveryResult, error) {
	if strings.TrimSpace(cfg.RecoveryToken) == "" {
		return nil, fmt.Errorf("bmr: recoveryToken is required")
	}
	if strings.TrimSpace(cfg.ServerURL) == "" {
		return nil, fmt.Errorf("bmr: serverUrl is required")
	}

	bootstrap, err := authenticateRecoverySessionContext(ctx, cfg.ServerURL, cfg.RecoveryToken)
	if err != nil {
		return nil, err
	}

	result := &RecoveryResult{Status: "failed"}
	completeAndReturn := func(runErr error) (*RecoveryResult, error) {
		if result.Error == "" && runErr != nil {
			result.Error = runErr.Error()
		}
		if completeErr := reportRecoveryCompletion(cfg.ServerURL, cfg.RecoveryToken, result); completeErr != nil {
			if runErr != nil {
				return result, fmt.Errorf("%w; failed to report completion: %v", runErr, completeErr)
			}
			return result, fmt.Errorf("failed to report BMR completion: %w", completeErr)
		}
		return result, runErr
	}

	authConfig := map[string]any{}
	if bootstrap.BackupConfig != nil {
		authConfig["provider"] = bootstrap.BackupConfig.Provider
		authConfig["providerConfig"] = bootstrap.BackupConfig.ProviderConfig
	}
	for key, value := range bootstrap.TargetConfig {
		authConfig[key] = value
	}

	var provider providers.BackupProvider
	if bootstrap.Download != nil {
		provider = newRecoveryDownloadProvider(ctx, cfg.ServerURL, cfg.RecoveryToken, bootstrap.Download)
	} else {
		provider, err = providerFromAuthenticatedConfig(authConfig)
		if err != nil {
			result.Error = fmt.Sprintf("failed to configure backup provider: %s", err.Error())
			return completeAndReturn(err)
		}
	}

	effectiveCfg := cfg
	if bootstrap.DeviceID != "" {
		effectiveCfg.DeviceID = bootstrap.DeviceID
	}
	if bootstrap.Snapshot != nil && bootstrap.Snapshot.SnapshotID != "" {
		effectiveCfg.SnapshotID = bootstrap.Snapshot.SnapshotID
	} else if bootstrap.SnapshotID != "" {
		effectiveCfg.SnapshotID = bootstrap.SnapshotID
	}
	if len(effectiveCfg.TargetPaths) == 0 {
		effectiveCfg.TargetPaths = targetPathsFromConfig(bootstrap.TargetConfig)
	}

	runResult, runErr := runRecovery(ctx, effectiveCfg, provider)
	if runResult != nil {
		result = runResult
	}
	return completeAndReturn(runErr)
}

func authenticateRecoverySession(serverURL, token string) (*BootstrapResponse, error) {
	return authenticateRecoverySessionContext(context.Background(), serverURL, token)
}

func authenticateRecoverySessionContext(ctx context.Context, serverURL, token string) (*BootstrapResponse, error) {
	payload, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		return nil, fmt.Errorf("bmr: marshal authenticate request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, buildBMRURL(serverURL, "/api/v1/backup/bmr/recover/authenticate"), bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("bmr: create authenticate request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := newHTTPClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("bmr: authenticate request failed: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("bmr: read authenticate response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errorBody map[string]any
		if err := json.Unmarshal(data, &errorBody); err == nil {
			if message, ok := errorBody["error"].(string); ok && message != "" {
				return nil, fmt.Errorf("bmr: authenticate failed: %s", message)
			}
		}
		return nil, fmt.Errorf("bmr: authenticate failed with status %d", resp.StatusCode)
	}
	body, err := decodeBootstrapResponse(data)
	if err != nil {
		return nil, err
	}
	return body, nil
}

func reportRecoveryCompletion(serverURL, token string, result *RecoveryResult) error {
	payload, err := json.Marshal(map[string]any{
		"token":  token,
		"result": result,
	})
	if err != nil {
		return fmt.Errorf("bmr: marshal completion request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, buildBMRURL(serverURL, "/api/v1/backup/bmr/recover/complete"), bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("bmr: create completion request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := newHTTPClient().Do(req)
	if err != nil {
		return fmt.Errorf("bmr: completion request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err == nil {
			if message, ok := body["error"].(string); ok && message != "" {
				return fmt.Errorf("bmr: completion failed: %s", message)
			}
		}
		return fmt.Errorf("bmr: completion failed with status %d", resp.StatusCode)
	}
	return nil
}

func buildBMRURL(serverURL, suffix string) string {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return strings.TrimRight(serverURL, "/") + suffix
	}
	parsed.Path = path.Join(parsed.Path, suffix)
	parsed.RawPath = ""
	return parsed.String()
}

func providerFromAuthenticatedConfig(targetConfig map[string]any) (providers.BackupProvider, error) {
	if len(targetConfig) == 0 {
		return nil, fmt.Errorf("missing authenticated target config")
	}

	provider := firstString(targetConfig["provider"], targetConfig["providerType"], targetConfig["backupProvider"], targetConfig["type"], targetConfig["storageProvider"])
	details := targetConfig
	if nested, ok := targetConfig["providerConfig"].(map[string]any); ok {
		details = nested
	}
	if provider == "" {
		switch {
		case details["path"] != nil || details["basePath"] != nil:
			provider = "local"
		case details["bucket"] != nil || details["bucketName"] != nil:
			provider = "s3"
		case details["container"] != nil || details["containerName"] != nil:
			provider = "azure_blob"
		case details["credentialsJson"] != nil || details["credentials"] != nil:
			provider = "google_cloud"
		case details["appKey"] != nil || details["applicationKey"] != nil || details["keyId"] != nil || details["keyID"] != nil:
			provider = "backblaze"
		}
	}

	switch provider {
	case "local":
		basePath := firstString(details["path"], details["basePath"])
		if basePath == "" {
			return nil, fmt.Errorf("local provider path is required")
		}
		return providers.NewLocalProvider(basePath), nil
	case "s3":
		bucket := firstString(details["bucket"], details["bucketName"])
		region := firstString(details["region"])
		accessKey := firstString(details["accessKey"], details["accessKeyId"])
		secretKey := firstString(details["secretKey"], details["secretAccessKey"])
		sessionToken := firstString(details["sessionToken"])
		endpoint := firstString(details["endpoint"])
		if bucket == "" || region == "" {
			return nil, fmt.Errorf("s3 bucket and region are required")
		}
		return providers.NewS3ProviderWithEndpoint(bucket, region, endpoint, accessKey, secretKey, sessionToken), nil
	case "azure_blob", "azure":
		accountName := firstString(details["accountName"], details["account"])
		accountKey := firstString(details["accountKey"], details["key"])
		container := firstString(details["container"], details["containerName"])
		return providers.NewAzureProvider(accountName, accountKey, container)
	case "google_cloud", "gcs":
		bucket := firstString(details["bucket"], details["bucketName"])
		credentialsJSON, err := bytesFromConfig(details["credentialsJson"], details["credentials"])
		if err != nil {
			return nil, err
		}
		return providers.NewGCSProvider(bucket, credentialsJSON)
	case "backblaze", "b2":
		keyID := firstString(details["keyId"], details["keyID"])
		appKey := firstString(details["applicationKey"], details["appKey"])
		bucket := firstString(details["bucket"], details["bucketName"])
		return providers.NewB2Provider(keyID, appKey, bucket)
	default:
		return nil, fmt.Errorf("unsupported backup provider %q", provider)
	}
}

func targetPathsFromConfig(targetConfig map[string]any) map[string]string {
	extract := func(raw any) map[string]string {
		record, ok := raw.(map[string]any)
		if !ok {
			return nil
		}
		paths := make(map[string]string, len(record))
		for key, value := range record {
			if target, ok := value.(string); ok && target != "" {
				paths[key] = target
			}
		}
		if len(paths) == 0 {
			return nil
		}
		return paths
	}

	if raw, ok := targetConfig["targetPaths"]; ok && raw != nil {
		if paths := extract(raw); len(paths) > 0 {
			return paths
		}
	}
	if raw, ok := targetConfig["providerConfig"]; ok && raw != nil {
		if nested, ok := raw.(map[string]any); ok {
			if paths := extract(nested["targetPaths"]); len(paths) > 0 {
				return paths
			}
		}
	}
	return nil
}

func firstString(values ...any) string {
	for _, value := range values {
		if str, ok := value.(string); ok && strings.TrimSpace(str) != "" {
			return str
		}
	}
	return ""
}

func bytesFromConfig(values ...any) ([]byte, error) {
	for _, value := range values {
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) == "" {
				continue
			}
			trimmed := strings.TrimSpace(typed)
			if json.Valid([]byte(trimmed)) {
				return []byte(trimmed), nil
			}
			decoded, err := base64.StdEncoding.DecodeString(trimmed)
			if err != nil {
				return nil, fmt.Errorf("invalid encoded credentials payload")
			}
			return decoded, nil
		case map[string]any:
			data, err := json.Marshal(typed)
			if err != nil {
				return nil, fmt.Errorf("invalid encoded credentials payload: %w", err)
			}
			return data, nil
		}
	}
	return nil, nil
}
