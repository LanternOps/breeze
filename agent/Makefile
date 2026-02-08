.PHONY: build build-all clean test install install-service uninstall-service

VERSION ?= 0.1.0
LDFLAGS := -ldflags "-X main.version=$(VERSION)"

# Default build for current platform
build:
	go build $(LDFLAGS) -o bin/breeze-agent ./cmd/breeze-agent

# Build for all platforms
build-all: build-linux build-darwin build-windows

build-linux:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-linux-amd64 ./cmd/breeze-agent
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-agent-linux-arm64 ./cmd/breeze-agent

build-darwin:
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-darwin-amd64 ./cmd/breeze-agent
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-agent-darwin-arm64 ./cmd/breeze-agent

build-windows:
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-windows-amd64.exe ./cmd/breeze-agent

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
	go run ./cmd/breeze-agent run

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
