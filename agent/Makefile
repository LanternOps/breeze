.PHONY: build build-agent build-desktop-helper build-backup build-all build-all-agent build-all-desktop-helper build-all-backup build-windows-user-helper build-winres build-windows-msi clean test install install-service uninstall-service dev-push dev-push-helper build-watchdog build-watchdog-linux build-watchdog-darwin build-watchdog-windows dev-push-watchdog dev-push-both

VERSION ?= 0.5.0
# Local-dev targets intentionally keep plain LDFLAGS (self-host by
# construction — no hostpolicy ldflags are ever injected here). Release
# builds go through agent/scripts/build-edition.sh instead, which adds the
# self-host/hosted-* edition rules on top of this same -X main.version= base.
LDFLAGS := -ldflags "-X main.version=$(VERSION)"

# CGO MUST stay off for every target.
#
# github.com/shoenig/go-m1cpu (pulled in indirectly by gopsutil/v3) calls into
# IOKit via cgo during package init to read Apple Silicon CPU registers. It does
# not recognise M4/M5 silicon and dereferences null, so the agent takes a SIGSEGV
# in runtime.doInit before a single line of our code runs — it never enrolls and
# launchd just sees exit status 2. With CGO off, go-m1cpu compiles to its pure-Go
# stub (returns zeros) and the only thing lost is a CPU-frequency metric.
#
# Do not "fix" this by removing the flag. If cgo is ever genuinely needed, migrate
# gopsutil/v3 -> v4 first: v4 dropped the go-m1cpu dependency entirely.
export CGO_ENABLED := 0

# Default build for current platform (agent + backup)
build: build-agent build-desktop-helper build-backup

build-agent:
	go build $(LDFLAGS) -o bin/nu-agent ./cmd/nu-agent

build-desktop-helper:
	go build $(LDFLAGS) -o bin/nu-desktop-helper ./cmd/nu-desktop-helper

build-backup:
	go build $(LDFLAGS) -o bin/nu-backup ./cmd/nu-backup

# Build for all platforms
build-all: build-all-agent build-all-desktop-helper build-all-backup

build-all-agent: build-linux build-darwin build-windows

build-all-desktop-helper:
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-desktop-helper-darwin-amd64 ./cmd/nu-desktop-helper
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/nu-desktop-helper-darwin-arm64 ./cmd/nu-desktop-helper

build-all-backup:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-backup-linux-amd64 ./cmd/nu-backup
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/nu-backup-linux-arm64 ./cmd/nu-backup
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-backup-darwin-amd64 ./cmd/nu-backup
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/nu-backup-darwin-arm64 ./cmd/nu-backup
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-backup-windows-amd64.exe ./cmd/nu-backup

build-linux:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-agent-linux-amd64 ./cmd/nu-agent
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/nu-agent-linux-arm64 ./cmd/nu-agent

build-darwin:
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-agent-darwin-amd64 ./cmd/nu-agent
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/nu-agent-darwin-arm64 ./cmd/nu-agent

build-windows: build-windows-user-helper
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-agent-windows-amd64.exe ./cmd/nu-agent

# build-windows-user-helper builds ./cmd/nu-user-helper as a GUI-subsystem
# PE binary so the scheduled task that launches the user-helper at user logon
# does not allocate a visible console window. Console-subsystem binaries (the
# default `go build` output on Windows) get an attached console from the kernel
# whenever the Task Scheduler spawns them in a user session, regardless of the
# task XML <Hidden> flag. -H windowsgui flips the PE subsystem byte from 3 to 2;
# the kernel then allocates no console at all.
#
# cmd/nu-user-helper is a thin wrapper over the same internal/agentapp code
# as cmd/nu-agent — same program, same subcommands, same agent.yaml. It
# exists as a separate cmd package solely so it can embed an asInvoker manifest
# (see build-winres) instead of the agent's requireAdministrator one: the
# sessionbroker spawns it into the logged-in user's non-elevated session, where
# a requireAdministrator manifest makes CreateProcessAsUser fail with
# ERROR_ELEVATION_REQUIRED (#949 regression).
build-windows-user-helper:
	GOOS=windows GOARCH=amd64 go build -ldflags "-X main.version=$(VERSION) -H windowsgui" -o bin/nu-user-helper-windows-amd64.exe ./cmd/nu-user-helper

build-winres:
	@command -v go-winres >/dev/null 2>&1 || (echo "go-winres not found. Install with: go install github.com/tc-hib/go-winres@v0.3.3" && exit 1)
	# Embed VERSIONINFO + manifest + icon into every Windows binary we ship.
	#
	# Without an embedded FileVersion resource, MSI's FileTable default rule
	# ("preserve user-modified unversioned files") leaves an existing copy in
	# place on upgrade or reinstall whenever its on-disk hash differs from the
	# one captured at MSI build time. The install.log line we kept seeing was:
	#   File: C:\Program Files\Breeze\nu-agent.exe;
	#   Won't Overwrite; Won't patch; Existing file is unversioned but modified.
	# Embedding a FileVersion flips MSI into normal "newer wins" semantics.
	# See issue #944.
	#
	# Implementation note: we use go-winres `simply` (CLI args) rather than
	# `make` + JSON because (a) .ico files work via --icon in simply mode but
	# not in JSON-mode RT_GROUP_ICON entries, and (b) one Makefile line per
	# binary keeps the source of truth here in the build file instead of
	# scattered across resources/winres-*.json. The five binaries map to:
	#   nu-agent.exe            - admin manifest (matches existing UAC)
	#   nu-user-helper.exe      - per-user session, asInvoker (NOT admin: it
	#                                 is spawned with the user's filtered token,
	#                                 so an admin manifest => ELEVATION_REQUIRED)
	#   nu-watchdog.exe         - service, asInvoker
	#   nu-backup.exe           - launched by agent, asInvoker
	#   nu-desktop-helper.exe   - per-user session, asInvoker, GUI manifest
	cd resources && go-winres simply --arch amd64 --no-suffix \
		--icon icon.ico --admin \
		--file-version $(VERSION) --product-version $(VERSION) \
		--product-name "Breeze RMM Agent" \
		--file-description "Breeze RMM Agent" \
		--copyright "Copyright (c) Breeze RMM" \
		--original-filename "nu-agent.exe" \
		--out ../cmd/nu-agent/rsrc_windows_amd64.syso
	cd resources && go-winres simply --arch amd64 --no-suffix \
		--icon icon.ico \
		--file-version $(VERSION) --product-version $(VERSION) \
		--product-name "Breeze RMM User Helper" \
		--file-description "Breeze RMM User Helper" \
		--copyright "Copyright (c) Breeze RMM" \
		--original-filename "nu-user-helper.exe" \
		--out ../cmd/nu-user-helper/rsrc_windows_amd64.syso
	cd resources && go-winres simply --arch amd64 --no-suffix \
		--icon icon.ico \
		--file-version $(VERSION) --product-version $(VERSION) \
		--product-name "Breeze RMM Watchdog" \
		--file-description "Breeze RMM Watchdog" \
		--copyright "Copyright (c) Breeze RMM" \
		--original-filename "nu-watchdog.exe" \
		--out ../cmd/nu-watchdog/rsrc_windows_amd64.syso
	cd resources && go-winres simply --arch amd64 --no-suffix \
		--icon icon.ico \
		--file-version $(VERSION) --product-version $(VERSION) \
		--product-name "Breeze RMM Backup Helper" \
		--file-description "Breeze RMM Backup Helper" \
		--copyright "Copyright (c) Breeze RMM" \
		--original-filename "nu-backup.exe" \
		--out ../cmd/nu-backup/rsrc_windows_amd64.syso
	cd resources && go-winres simply --arch amd64 --no-suffix --manifest gui \
		--icon icon.ico \
		--file-version $(VERSION) --product-version $(VERSION) \
		--product-name "Breeze RMM Desktop Helper" \
		--file-description "Breeze RMM Desktop Helper" \
		--copyright "Copyright (c) Breeze RMM" \
		--original-filename "nu-desktop-helper.exe" \
		--out ../cmd/nu-desktop-helper/rsrc_windows_amd64.syso

build-windows-msi: build-winres build-windows
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File installer/build-msi.ps1 -Version $(VERSION) -AgentExePath "$(CURDIR)\\bin\\nu-agent-windows-amd64.exe" -OutputPath "$(CURDIR)\\..\\dist\\nu-agent.msi"
else
	@echo "build-windows-msi must be run on Windows with wix + PowerShell installed."
	@echo "Run: pwsh -File agent/installer/build-msi.ps1 -Version $(VERSION) -AgentExePath agent/bin/nu-agent-windows-amd64.exe -OutputPath dist/nu-agent.msi"
	@exit 1
endif

clean:
	rm -rf bin/

test:
	go test -v ./...

# Install locally (requires sudo on Linux/macOS)
install: build
ifeq ($(OS),Windows_NT)
	copy bin\nu-agent.exe "C:\Program Files\Breeze\nu-agent.exe"
else
	sudo mkdir -p /usr/local/bin
	sudo cp bin/nu-agent /usr/local/bin/nu-agent
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
ifeq ($(OS),Windows_NT)
	@echo "Unsupported OS for service uninstall."
else
	sudo bash scripts/install/uninstall.sh
endif

# Development run
run:
	go run ./cmd/nu-agent start

# Run user helper (for development)
run-user-helper:
	go run ./cmd/nu-user-helper user-helper

# Install user helper service files (requires sudo on Linux/macOS)
install-user-helper:
ifeq ($(shell uname -s),Darwin)
	sudo cp service/launchd/com.nodesunlimited.agent-user.plist /Library/LaunchAgents/
	sudo chown root:wheel /Library/LaunchAgents/com.nodesunlimited.agent-user.plist
	sudo chmod 644 /Library/LaunchAgents/com.nodesunlimited.agent-user.plist
	@echo "LaunchAgent installed. Users will get the helper at next login."
else ifeq ($(shell uname -s),Linux)
	sudo mkdir -p /usr/lib/systemd/user
	sudo cp service/systemd/nu-agent-user.service /usr/lib/systemd/user/
	sudo chmod 644 /usr/lib/systemd/user/nu-agent-user.service
	sudo cp service/xdg/nu-agent-user.desktop /etc/xdg/autostart/
	sudo chmod 644 /etc/xdg/autostart/nu-agent-user.desktop
	@echo "Systemd user unit + XDG autostart installed."
	@echo "Users: systemctl --user enable nu-agent-user"
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
	GOOS=$(TARGET_GOOS) GOARCH=$(TARGET_GOARCH) $(CGO_FLAG) go build -ldflags "-X main.version=$(DEV_VERSION)" -o bin/nu-agent-dev ./cmd/nu-agent
ifneq ($(CODESIGN_IDENTITY),)
ifeq ($(TARGET_GOOS),darwin)
	@echo "Codesigning with identity '$(CODESIGN_IDENTITY)'..."
	codesign --force --sign "$(CODESIGN_IDENTITY)" --options runtime --timestamp=none --entitlements dev-entitlements.plist bin/nu-agent-dev
endif
endif
	@echo "Uploading binary to API..."
	@curl -sf -X POST "$(API_URL)/api/v1/dev/push" \
		-H "$(AUTH_HEADER)" \
		-F "agentId=$(DEVICE)" \
		-F "version=$(DEV_VERSION)" \
		-F "binary=@bin/nu-agent-dev" | python3 -m json.tool
	@echo "Dev push complete — agent will restart with $(DEV_VERSION)"

# Watchdog targets
build-watchdog:
	go build $(LDFLAGS) -o bin/nu-watchdog ./cmd/nu-watchdog

build-watchdog-linux:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-watchdog-linux-amd64 ./cmd/nu-watchdog
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/nu-watchdog-linux-arm64 ./cmd/nu-watchdog

build-watchdog-darwin:
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-watchdog-darwin-amd64 ./cmd/nu-watchdog
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/nu-watchdog-darwin-arm64 ./cmd/nu-watchdog

build-watchdog-windows:
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/nu-watchdog-windows-amd64.exe ./cmd/nu-watchdog

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
	GOOS=$(TARGET_GOOS) GOARCH=$(TARGET_GOARCH) $(CGO_FLAG) go build -ldflags "-X main.version=$(DEV_VERSION)" -o bin/nu-watchdog-dev ./cmd/nu-watchdog
ifneq ($(CODESIGN_IDENTITY),)
ifeq ($(TARGET_GOOS),darwin)
	@echo "Codesigning with identity '$(CODESIGN_IDENTITY)'..."
	codesign --force --sign "$(CODESIGN_IDENTITY)" --options runtime --timestamp=none --entitlements dev-entitlements.plist bin/nu-watchdog-dev
endif
endif
	@echo "Uploading watchdog binary to API..."
	@curl -sf -X POST "$(API_URL)/api/v1/dev/push" \
		-H "$(AUTH_HEADER)" \
		-F "agentId=$(DEVICE)" \
		-F "version=$(DEV_VERSION)" \
		-F "component=watchdog" \
		-F "binary=@bin/nu-watchdog-dev" | python3 -m json.tool
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
	GOOS=$(TARGET_GOOS) GOARCH=$(TARGET_GOARCH) $(CGO_FLAG) go build -ldflags "-X main.version=$(DEV_VERSION)" -o bin/nu-desktop-helper-dev ./cmd/nu-desktop-helper
ifneq ($(CODESIGN_IDENTITY),)
	@echo "Codesigning with identity '$(CODESIGN_IDENTITY)'..."
	codesign --force --sign "$(CODESIGN_IDENTITY)" --options runtime --timestamp=none --entitlements dev-entitlements.plist bin/nu-desktop-helper-dev
endif
	@echo "Uploading desktop-helper binary to API..."
	@curl -sf -X POST "$(API_URL)/api/v1/dev/push" \
		-H "$(AUTH_HEADER)" \
		-F "agentId=$(DEVICE)" \
		-F "version=$(DEV_VERSION)" \
		-F "component=desktop-helper" \
		-F "binary=@bin/nu-desktop-helper-dev" | python3 -m json.tool
	@echo "Dev push desktop-helper complete — helper will be kickstarted with $(DEV_VERSION)"
