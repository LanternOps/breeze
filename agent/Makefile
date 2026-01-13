.PHONY: build build-all clean test install

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

# Development run
run:
	go run ./cmd/breeze-agent run

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
