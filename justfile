# Build the tobor binary
build:
    go build ./cmd/tobor

# Run all tests
test:
    go test ./...

# Install the binary
install:
    go install ./cmd/tobor

# Build with Nix
nix-build:
    nix build

# Format code
fmt:
    go fmt ./...

# Vet code
vet:
    go vet ./...

# Clean build artifacts
clean:
    go clean
