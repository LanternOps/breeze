#!/bin/bash

set -e

echo "🌊 Setting up Breeze RMM development environment..."

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "❌ Node.js is required but not installed."; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "Installing pnpm..."; npm install -g pnpm; }
command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required but not installed."; exit 1; }
command -v go >/dev/null 2>&1 || { echo "⚠️  Go is optional but recommended for agent development."; }

# Install dependencies
echo "📦 Installing Node.js dependencies..."
pnpm install

# Copy environment file
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cp .env.example .env
fi

# Start Docker services
echo "🐳 Starting Docker services..."
docker-compose -f docker/docker-compose.yml up -d

# Wait for Postgres
echo "⏳ Waiting for PostgreSQL to be ready..."
sleep 5

# Push database schema
echo "🗄️  Pushing database schema..."
pnpm db:push

# Build Go agent (if Go is installed)
if command -v go &> /dev/null; then
    echo "🔧 Building Go agent..."
    cd agent && go mod tidy && make build && cd ..
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start development:"
echo "  pnpm dev          # Start web + API servers"
echo "  cd agent && make run  # Run the agent (separate terminal)"
echo ""
echo "Services:"
echo "  Web UI:     http://localhost:4321"
echo "  API:        http://localhost:3001"
echo "  PostgreSQL: localhost:5432"
echo "  Redis:      localhost:6379"
echo "  MinIO:      http://localhost:9001 (admin: minioadmin/minioadmin)"
echo ""
