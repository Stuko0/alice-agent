SHELL := /bin/bash

VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT     ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS := -s -w \
	-X main.version=$(VERSION) \
	-X main.commit=$(COMMIT) \
	-X main.buildDate=$(BUILD_DATE)

.PHONY: build test vet fmt check integration install clean

build:
	go build -trimpath -ldflags '$(LDFLAGS)' -o bin/alice ./cmd/alice

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

check: fmt vet test

# Opt-in: spawns the real Python gateway and speaks the wire protocol to it.
integration:
	ALICE_GO_INTEGRATION=1 go test ./internal/protocol -run Gateway -v -timeout 180s

# Installs the host as `alice`. The binary delegates unknown commands to
# Python, so this is safe to put ahead of the Python console script in PATH.
PREFIX ?= $(HOME)/.local
install: build
	install -d $(PREFIX)/bin
	install -m 0755 bin/alice $(PREFIX)/bin/alice

clean:
	rm -rf bin
