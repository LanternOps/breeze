.PHONY: build build-agent build-desktop-helper build-backup build-all build-all-agent build-all-desktop-helper build-all-backup build-winres build-windows-msi clean test install install-service uninstall-service dev-push dev-push-helper build-watchdog build-watchdog-linux build-watchdog-darwin build-watchdog-windows dev-push-watchdog dev-push-both

VERSION ?= 0.5.0
LDFLAGS := -ldflags "-X main.version=$(VERSION)"

# Default build for current platform (agent + backup)
build: build-agent build-desktop-helper build-backup

build-agent:
	go build $(LDFLAGS) -o bin/breeze-agent ./cmd/breeze-agent

build-desktop-helper:
	go build $(LDFLAGS) -o bin/breeze-desktop-helper ./cmd/breeze-desktop-helper

build-backup:
	go build $(LDFLAGS) -o bin/breeze-backup ./cmd/breeze-backup

# Build for all platforms
build-all: build-all-agent build-all-desktop-helper build-all-backup

build-all-agent: build-linux build-darwin build-windows

build-all-desktop-helper:
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-desktop-helper-darwin-amd64 ./cmd/breeze-desktop-helper
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-desktop-helper-darwin-arm64 ./cmd/breeze-desktop-helper

build-all-backup:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-backup-linux-amd64 ./cmd/breeze-backup
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-backup-linux-arm64 ./cmd/breeze-backup
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-backup-darwin-amd64 ./cmd/breeze-backup
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-backup-darwin-arm64 ./cmd/breeze-backup
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-backup-windows-amd64.exe ./cmd/breeze-backup

build-linux:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-linux-amd64 ./cmd/breeze-agent
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-agent-linux-arm64 ./cmd/breeze-agent

build-darwin:
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-darwin-amd64 ./cmd/breeze-agent
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-agent-darwin-arm64 ./cmd/breeze-agent

build-windows:
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-windows-amd64.exe ./cmd/breeze-agent

build-winres:
	@command -v go-winres >/dev/null 2>&1 || (echo "go-winres not found. Install with: go install github.com/tc-hib/go-winres@latest" && exit 1)
	cd resources && go-winres make --in winres.json --out ../cmd/breeze-agent/rsrc_windows_amd64.syso

build-windows-msi: build-windows
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File installer/build-msi.ps1 -Version $(VERSION) -AgentExePath "$(CURDIR)\\bin\\breeze-agent-windows-amd64.exe" -OutputPath "$(CURDIR)\\..\\dist\\breeze-agent.msi"
else
	@echo "build-windows-msi must be run on Windows with wix + PowerShell installed."
	@echo "Run: pwsh -File agent/installer/build-msi.ps1 -Version $(VERSION) -AgentExePath agent/bin/breeze-agent-windows-amd64.exe -OutputPath dist/breeze-agent.msi"
	@exit 1
endif

clean:
	rm -rf bin/

test:
	go test -v ./...

# Install locally (requires sudo on Linux/macOS)
install: build
ifeq ($(OS),Windows_NT)
	copy bin\breeze-agent.exe "C:\Program Files\Breeze\breeze-agent.exe"
else
	sudo mkdir -p /usr/local/bin
	sudo cp bin/breeze-agent /usr/local/bin/breeze-agent
endif

# Install as system service (requires sudo)
install-service: build
ifeq ($(shell uname -s),Darwin)
	sudo bash scripts/install/install-darwin.sh
else ifeq ($(shell uname -s),Linux)
	sudo bash scripts/install/install-linux.sh
else
	@echo "Unsupported OS for service install. Use Windows Services manually."
endif

# Uninstall system service (requires sudo)
uninstall-service:
ifeq ($(shell uname -s),Darwin)
	sudo bash scripts/install/uninstall-darwin.sh
else ifeq ($(shell uname -s),Linux)
	sudo bash scripts/install/uninstall-linux.sh
else
	@echo "Unsupported OS for service uninstall."
endif

# Development run
run:
	go run ./cmd/breeze-agent start

# Run user helper (for development)
run-user-helper:
	go run ./cmd/breeze-agent user-helper

# Install user helper service files (requires sudo on Linux/macOS)
install-user-helper:
ifeq ($(shell uname -s),Darwin)
	sudo cp service/launchd/com.breeze.agent-user.plist /Library/LaunchAgents/
	sudo chown root:wheel /Library/LaunchAgents/com.breeze.agent-user.plist
	sudo chmod 644 /Library/LaunchAgents/com.breeze.agent-user.plist
	@echo "LaunchAgent installed. Users will get the helper at next login."
else ifeq ($(shell uname -s),Linux)
	sudo mkdir -p /usr/lib/systemd/user
	sudo cp service/systemd/breeze-agent-user.service /usr/lib/systemd/user/
	sudo chmod 644 /usr/lib/systemd/user/breeze-agent-user.service
	sudo cp service/xdg/breeze-agent-user.desktop /etc/xdg/autostart/
	sudo chmod 644 /etc/xdg/autostart/breeze-agent-user.desktop
	@echo "Systemd user unit + XDG autostart installed."
	@echo "Users: systemctl --user enable breeze-agent-user"
else
	@echo "Windows: run scripts/install/install-windows.ps1 as Administrator"
endif

# Run IPC + session broker tests
test-ipc:
	go test -v -count=1 ./internal/ipc/... ./internal/sessionbroker/... ./internal/userhelper/...

# Update dependencies
deps:
	go mod tidy
	go mod download

# Format code
fmt:
	go fmt ./...

# Lint
lint:
	golangci-lint run

# Dev push: build + upload to API + trigger agent update
# Usage: make dev-push [DEVICE=<deviceId>] [API_URL=...] [AUTH_TOKEN=...]
# Reads defaults from ../.env.dev if present. AUTH_TOKEN accepts JWT or API key (brz_...).
#
# Optional macOS code signing for TCC permission persistence:
#   Set CODESIGN_IDENTITY (or BREEZE_CODESIGN_IDENTITY in .env.dev) to a
#   self-signed cert in your login keychain. The dev-push targets will sign
#   the built binary with that identity before uploading. As long as the same
#   identity is used across builds, macOS will treat all dev pushes as the
#   "same app" and TCC grants persist across iterations.
#
#   Setup:
#     1. Keychain Access > Certificate Assistant > Create a Certificate
#        Name: BreezeDevSigning, Identity Type: Self Signed Root, Type: Code Signing
#     2. Export the certificate (.cer, public key only) and install on the
#        target Mac in System keychain, set Code Signing trust to Always Trust
#     3. CODESIGN_IDENTITY=BreezeDevSigning make dev-push-helper DEVICE=...
#
-include ../.env.dev
DEVICE ?= $(BREEZE_DEV_DEVICE)
AUTH_TOKEN ?= $(BREEZE_API_KEY)
API_URL ?= $(or $(BREEZE_API_URL),http://localhost:3001)
CODESIGN_IDENTITY ?= $(BREEZE_CODESIGN_IDENTITY)
# Optional override to skip the device GET query (which requires JWT auth and
# rejects API keys). Format: <goos>/<goarch>, e.g. darwin/arm64
PLATFORM ?= $(BREEZE_DEV_PLATFORM)
dev-push:
ifndef DEVICE
	$(error DEVICE is required. Set BREEZE_DEV_DEVICE in ../.env.dev or pass DEVICE=<id>)
endif
ifndef AUTH_TOKEN
	$(error AUTH_TOKEN is required. Set BREEZE_API_KEY in ../.env.dev or pass AUTH_TOKEN=<key>)
endif
	$(eval DEV_VERSION := dev-$(shell date +%s))
	$(eval AUTH_HEADER := $(if $(filter brz_%,$(AUTH_TOKEN)),X-API-Key: $(AUTH_TOKEN),Authorization: Bearer $(AUTH_TOKEN)))
	@if [ -z "$(PLATFORM)" ]; then echo "Querying device platform..."; else echo "Using PLATFORM=$(PLATFORM)"; fi
	$(eval PLATFORM := $(if $(PLATFORM),$(PLATFORM),$(shell curl -sf "$(API_URL)/api/v1/devices/$(DEVICE)" -H "$(AUTH_HEADER)" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); os_map={'windows':'windows','macos':'darwin','linux':'linux'}; print(os_map.get(d.get('osType','linux'),'linux')+'/'+d.get('architecture','amd64'))" 2>/dev/null || echo "")))
ifeq ($(PLATFORM),)
	$(error Failed to query device platform from API. Set PLATFORM=darwin/arm64 (or similar) to override.)
endif
	$(eval TARGET_GOOS := $(word 1,$(subst /, ,$(PLATFORM))))
	$(eval TARGET_GOARCH := $(word 2,$(subst /, ,$(PLATFORM))))
	$(eval BUILD_GOOS := $(shell go env GOOS))
	$(eval BUILD_GOARCH := $(shell go env GOARCH))
	$(eval CGO_FLAG := $(if $(and $(filter $(BUILD_GOOS),$(TARGET_GOOS)),$(filter $(BUILD_GOARCH),$(TARGET_GOARCH))),,CGO_ENABLED=0))
	@echo "Building for $(TARGET_GOOS)/$(TARGET_GOARCH) version=$(DEV_VERSION) (cgo=$(if $(CGO_FLAG),off,on))..."
	GOOS=$(TARGET_GOOS) GOARCH=$(TARGET_GOARCH) $(CGO_FLAG) go build -ldflags "-X main.version=$(DEV_VERSION)" -o bin/breeze-agent-dev ./cmd/breeze-agent
ifneq ($(CODESIGN_IDENTITY),)
ifeq ($(TARGET_GOOS),darwin)
	@echo "Codesigning with identity '$(CODESIGN_IDENTITY)'..."
	codesign --force --sign "$(CODESIGN_IDENTITY)" --options runtime --timestamp=none --entitlements dev-entitlements.plist bin/breeze-agent-dev
endif
endif
	@echo "Uploading binary to API..."
	@curl -sf -X POST "$(API_URL)/api/v1/dev/push" \
		-H "$(AUTH_HEADER)" \
		-F "agentId=$(DEVICE)" \
		-F "version=$(DEV_VERSION)" \
		-F "binary=@bin/breeze-agent-dev" | python3 -m json.tool
	@echo "Dev push complete — agent will restart with $(DEV_VERSION)"

# Watchdog targets
build-watchdog:
	go build $(LDFLAGS) -o bin/breeze-watchdog ./cmd/breeze-watchdog

build-watchdog-linux:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-watchdog-linux-amd64 ./cmd/breeze-watchdog
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-watchdog-linux-arm64 ./cmd/breeze-watchdog

build-watchdog-darwin:
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-watchdog-darwin-amd64 ./cmd/breeze-watchdog
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-watchdog-darwin-arm64 ./cmd/breeze-watchdog

build-watchdog-windows:
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-watchdog-windows-amd64.exe ./cmd/breeze-watchdog

# Dev push watchdog: build + upload watchdog binary to API + trigger watchdog update
# Usage: make dev-push-watchdog [DEVICE=<deviceId>] [API_URL=...] [AUTH_TOKEN=...]
dev-push-watchdog:
ifndef DEVICE
	$(error DEVICE is required. Set BREEZE_DEV_DEVICE in ../.env.dev or pass DEVICE=<id>)
endif
ifndef AUTH_TOKEN
	$(error AUTH_TOKEN is required. Set BREEZE_API_KEY in ../.env.dev or pass AUTH_TOKEN=<key>)
endif
	$(eval DEV_VERSION := dev-$(shell date +%s))
	$(eval AUTH_HEADER := $(if $(filter brz_%,$(AUTH_TOKEN)),X-API-Key: $(AUTH_TOKEN),Authorization: Bearer $(AUTH_TOKEN)))
	@if [ -z "$(PLATFORM)" ]; then echo "Querying device platform..."; else echo "Using PLATFORM=$(PLATFORM)"; fi
	$(eval PLATFORM := $(if $(PLATFORM),$(PLATFORM),$(shell curl -sf "$(API_URL)/api/v1/devices/$(DEVICE)" -H "$(AUTH_HEADER)" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); os_map={'windows':'windows','macos':'darwin','linux':'linux'}; print(os_map.get(d.get('osType','linux'),'linux')+'/'+d.get('architecture','amd64'))" 2>/dev/null || echo "")))
ifeq ($(PLATFORM),)
	$(error Failed to query device platform from API. Set PLATFORM=darwin/arm64 (or similar) to override.)
endif
	$(eval TARGET_GOOS := $(word 1,$(subst /, ,$(PLATFORM))))
	$(eval TARGET_GOARCH := $(word 2,$(subst /, ,$(PLATFORM))))
	$(eval BUILD_GOOS := $(shell go env GOOS))
	$(eval BUILD_GOARCH := $(shell go env GOARCH))
	$(eval CGO_FLAG := $(if $(and $(filter $(BUILD_GOOS),$(TARGET_GOOS)),$(filter $(BUILD_GOARCH),$(TARGET_GOARCH))),,CGO_ENABLED=0))
	@echo "Building watchdog for $(TARGET_GOOS)/$(TARGET_GOARCH) version=$(DEV_VERSION) (cgo=$(if $(CGO_FLAG),off,on))..."
	GOOS=$(TARGET_GOOS) GOARCH=$(TARGET_GOARCH) $(CGO_FLAG) go build -ldflags "-X main.version=$(DEV_VERSION)" -o bin/breeze-watchdog-dev ./cmd/breeze-watchdog
ifneq ($(CODESIGN_IDENTITY),)
ifeq ($(TARGET_GOOS),darwin)
	@echo "Codesigning with identity '$(CODESIGN_IDENTITY)'..."
	codesign --force --sign "$(CODESIGN_IDENTITY)" --options runtime --timestamp=none --entitlements dev-entitlements.plist bin/breeze-watchdog-dev
endif
endif
	@echo "Uploading watchdog binary to API..."
	@curl -sf -X POST "$(API_URL)/api/v1/dev/push" \
		-H "$(AUTH_HEADER)" \
		-F "agentId=$(DEVICE)" \
		-F "version=$(DEV_VERSION)" \
		-F "component=watchdog" \
		-F "binary=@bin/breeze-watchdog-dev" | python3 -m json.tool
	@echo "Dev push watchdog complete — watchdog will restart with $(DEV_VERSION)"

# Dev push both agent and watchdog in sequence
dev-push-both: dev-push dev-push-watchdog

# Dev push desktop helper: build + upload desktop-helper binary to API + trigger helper replacement
# Usage: make dev-push-helper [DEVICE=<deviceId>] [API_URL=...] [AUTH_TOKEN=...]
# macOS-only (desktop-helper binary only exists as a separate process on darwin).
dev-push-helper:
ifndef DEVICE
	$(error DEVICE is required. Set BREEZE_DEV_DEVICE in ../.env.dev or pass DEVICE=<id>)
endif
ifndef AUTH_TOKEN
	$(error AUTH_TOKEN is required. Set BREEZE_API_KEY in ../.env.dev or pass AUTH_TOKEN=<key>)
endif
	$(eval DEV_VERSION := dev-$(shell date +%s))
	$(eval AUTH_HEADER := $(if $(filter brz_%,$(AUTH_TOKEN)),X-API-Key: $(AUTH_TOKEN),Authorization: Bearer $(AUTH_TOKEN)))
	@if [ -z "$(PLATFORM)" ]; then echo "Querying device platform..."; else echo "Using PLATFORM=$(PLATFORM)"; fi
	$(eval PLATFORM := $(if $(PLATFORM),$(PLATFORM),$(shell curl -sf "$(API_URL)/api/v1/devices/$(DEVICE)" -H "$(AUTH_HEADER)" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); os_map={'windows':'windows','macos':'darwin','linux':'linux'}; print(os_map.get(d.get('osType','linux'),'linux')+'/'+d.get('architecture','amd64'))" 2>/dev/null || echo "")))
ifeq ($(PLATFORM),)
	$(error Failed to query device platform from API. Set PLATFORM=darwin/arm64 (or similar) to override.)
endif
	$(eval TARGET_GOOS := $(word 1,$(subst /, ,$(PLATFORM))))
	$(eval TARGET_GOARCH := $(word 2,$(subst /, ,$(PLATFORM))))
	@if [ "$(TARGET_GOOS)" != "darwin" ]; then echo "ERROR: dev-push-helper only supports darwin targets; got $(TARGET_GOOS)" >&2; exit 1; fi
	$(eval BUILD_GOOS := $(shell go env GOOS))
	$(eval BUILD_GOARCH := $(shell go env GOARCH))
	$(eval CGO_FLAG := $(if $(and $(filter $(BUILD_GOOS),$(TARGET_GOOS)),$(filter $(BUILD_GOARCH),$(TARGET_GOARCH))),,CGO_ENABLED=0))
	@echo "Building desktop-helper for $(TARGET_GOOS)/$(TARGET_GOARCH) version=$(DEV_VERSION) (cgo=$(if $(CGO_FLAG),off,on))..."
	GOOS=$(TARGET_GOOS) GOARCH=$(TARGET_GOARCH) $(CGO_FLAG) go build -ldflags "-X main.version=$(DEV_VERSION)" -o bin/breeze-desktop-helper-dev ./cmd/breeze-desktop-helper
ifneq ($(CODESIGN_IDENTITY),)
	@echo "Codesigning with identity '$(CODESIGN_IDENTITY)'..."
	codesign --force --sign "$(CODESIGN_IDENTITY)" --options runtime --timestamp=none --entitlements dev-entitlements.plist bin/breeze-desktop-helper-dev
endif
	@echo "Uploading desktop-helper binary to API..."
	@curl -sf -X POST "$(API_URL)/api/v1/dev/push" \
		-H "$(AUTH_HEADER)" \
		-F "agentId=$(DEVICE)" \
		-F "version=$(DEV_VERSION)" \
		-F "component=desktop-helper" \
		-F "binary=@bin/breeze-desktop-helper-dev" | python3 -m json.tool
	@echo "Dev push desktop-helper complete — helper will be kickstarted with $(DEV_VERSION)"
