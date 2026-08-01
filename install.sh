#!/usr/bin/env bash
#
# install.sh — one-command setup for the Universal Invoice Management Platform.
#
#   ./install.sh
#
# Installs backend (npm) and extraction-service (pip) dependencies, seeds the .env
# files from their .env.example templates, creates the Postgres database if it does
# not exist, and pushes the Drizzle schema.
#
# Every step is idempotent — re-running is safe and is the intended way to pick up
# new dependencies or schema changes after a `git pull`.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
EXTRACTION_DIR="$ROOT_DIR/extraction-service"
VENV_DIR="$EXTRACTION_DIR/.venv"

MIN_NODE_MAJOR=20
MIN_PYTHON_MINOR=10 # => Python 3.10

SKIP_NODE=0
SKIP_PYTHON=0
SKIP_DB=0
USE_VENV=1

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

STEP_NO=0
WARNINGS=()
WARNING_COUNT=0

step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s[%d/%d] %s%s\n' "$BOLD$BLUE" "$STEP_NO" "$TOTAL_STEPS" "$1" "$RESET"; }
info() { printf '      %s\n' "$1"; }
run()  { printf '      %s$ %s%s\n' "$DIM" "$1" "$RESET"; }
ok()   { printf '      %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
skip() { printf '      %s·%s %s\n' "$DIM" "$RESET" "$1"; }
warn() { printf '      %s!%s %s\n' "$YELLOW" "$RESET" "$1"; WARNINGS+=("$1"); WARNING_COUNT=$((WARNING_COUNT + 1)); }
die()  { printf '\n%serror:%s %s\n\n' "$RED$BOLD" "$RESET" "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Sets up the whole platform for local development: backend dependencies,
extraction-service dependencies, .env files, the Postgres database, and the
Drizzle schema. Safe to re-run at any time.

Options:
  --skip-node      Skip the backend `npm ci` install
  --skip-python    Skip the extraction-service pip install
  --skip-db        Skip database creation and `drizzle-kit push`
  --no-venv        Install Python deps into the active interpreter instead of
                   creating extraction-service/.venv
  -h, --help       Show this help

Environment:
  DATABASE_URL     Overrides the value in backend/.env for the database step
EOF
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-node)   SKIP_NODE=1 ;;
    --skip-python) SKIP_PYTHON=1 ;;
    --skip-db)     SKIP_DB=1 ;;
    --no-venv)     USE_VENV=0 ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

TOTAL_STEPS=4

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------

check_prerequisites() {
  step "Checking prerequisites"

  if [ "$SKIP_NODE" -eq 0 ] || [ "$SKIP_DB" -eq 0 ]; then
    command -v node >/dev/null 2>&1 || die "node is not installed. Install Node.js ${MIN_NODE_MAJOR}+ and re-run."
    command -v npm  >/dev/null 2>&1 || die "npm is not installed. Install Node.js ${MIN_NODE_MAJOR}+ and re-run."

    local node_version node_major
    node_version="$(node --version)"
    node_major="${node_version#v}"
    node_major="${node_major%%.*}"
    if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
      die "node $node_version is too old — this project needs Node.js ${MIN_NODE_MAJOR}+."
    fi
    ok "node $node_version, npm $(npm --version)"
  fi

  if [ "$SKIP_PYTHON" -eq 0 ]; then
    command -v python3 >/dev/null 2>&1 || die "python3 is not installed. Install Python 3.${MIN_PYTHON_MINOR}+ and re-run."

    local py_minor
    py_minor="$(python3 -c 'import sys; print(sys.version_info[1])')"
    if [ "$(python3 -c 'import sys; print(sys.version_info[0])')" -lt 3 ] || [ "$py_minor" -lt "$MIN_PYTHON_MINOR" ]; then
      die "$(python3 --version) is too old — this project needs Python 3.${MIN_PYTHON_MINOR}+."
    fi
    ok "$(python3 --version)"
  fi

  if [ "$SKIP_DB" -eq 0 ]; then
    if command -v psql >/dev/null 2>&1; then
      ok "psql $(psql --version | awk '{print $3}')"
    else
      warn "psql not found — skipping database creation and schema push."
      info "Install the PostgreSQL client tools, then re-run: ./install.sh --skip-node --skip-python"
      SKIP_DB=1
    fi
  fi
}

# ---------------------------------------------------------------------------
# .env helper
# ---------------------------------------------------------------------------

ensure_env_file() {
  local example="$1" target="$2" label="$3"

  if [ ! -f "$example" ]; then
    warn "$label: $(basename "$example") is missing, cannot create .env"
    return
  fi

  if [ -f "$target" ]; then
    skip "$label: .env already exists, left untouched"
  else
    cp "$example" "$target"
    ok "$label: created .env from .env.example"
  fi
}

# ---------------------------------------------------------------------------
# 2. Backend
# ---------------------------------------------------------------------------

install_backend() {
  step "Installing backend (NestJS + Drizzle)"

  ensure_env_file "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env" "backend"

  if [ "$SKIP_NODE" -eq 1 ]; then
    skip "npm install skipped (--skip-node)"
    return
  fi

  if [ -f "$BACKEND_DIR/package-lock.json" ]; then
    run "npm ci --prefix backend"
    npm ci --prefix "$BACKEND_DIR"
  else
    run "npm install --prefix backend"
    npm install --prefix "$BACKEND_DIR"
  fi
  ok "backend dependencies installed"
}

# ---------------------------------------------------------------------------
# 3. Extraction service
# ---------------------------------------------------------------------------

install_extraction() {
  step "Installing extraction service (FastAPI)"

  ensure_env_file "$EXTRACTION_DIR/.env.example" "$EXTRACTION_DIR/.env" "extraction-service"

  if [ "$SKIP_PYTHON" -eq 1 ]; then
    skip "pip install skipped (--skip-python)"
    return
  fi

  local python_bin="python3"

  if [ "$USE_VENV" -eq 1 ]; then
    if [ -x "$VENV_DIR/bin/python" ]; then
      skip "virtualenv already present at extraction-service/.venv"
    else
      run "python3 -m venv extraction-service/.venv"
      python3 -m venv "$VENV_DIR" \
        || die "failed to create a virtualenv. Install the python3-venv package, or re-run with --no-venv."
      ok "created virtualenv at extraction-service/.venv"
    fi
    python_bin="$VENV_DIR/bin/python"
  else
    info "installing into $(command -v python3) (--no-venv)"
  fi

  run "pip install -r extraction-service/requirements.txt"
  "$python_bin" -m pip install --quiet --upgrade pip
  "$python_bin" -m pip install --quiet -r "$EXTRACTION_DIR/requirements.txt"
  ok "extraction-service dependencies installed"

  if ! grep -qE '^ANTHROPIC_API_KEY=sk-ant-[A-Za-z0-9]' "$EXTRACTION_DIR/.env" 2>/dev/null; then
    warn "no real ANTHROPIC_API_KEY in extraction-service/.env — set one, or run mock_server.py instead."
  fi
}

# ---------------------------------------------------------------------------
# 4. Database
# ---------------------------------------------------------------------------

read_database_url() {
  # An exported DATABASE_URL wins, matching runtime behaviour: dotenv does not
  # override variables that are already present in the environment.
  if [ -n "${DATABASE_URL:-}" ]; then
    printf '%s' "$DATABASE_URL"
    return
  fi
  if [ -f "$BACKEND_DIR/.env" ]; then
    sed -nE 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/p' \
      "$BACKEND_DIR/.env" | tail -1
  fi
}

setup_database() {
  step "Setting up the database"

  if [ "$SKIP_DB" -eq 1 ]; then
    skip "database setup skipped"
    return
  fi

  local db_url db_name admin_url
  db_url="$(read_database_url)"
  [ -n "$db_url" ] || die "no DATABASE_URL found in backend/.env or the environment."

  # postgresql://user:pass@host:5432/invoice_platform?foo=bar -> invoice_platform
  db_name="$(printf '%s' "$db_url" | sed -E 's#\?.*$##; s#^.*/##')"
  # ...and the same URL pointed at the always-present `postgres` maintenance DB.
  admin_url="$(printf '%s' "$db_url" | sed -E 's#\?.*$##; s#/[^/]*$#/postgres#')"

  [ -n "$db_name" ] || die "could not parse a database name out of DATABASE_URL."

  if ! psql "$admin_url" -tAc 'SELECT 1' >/dev/null 2>&1; then
    warn "could not connect to Postgres at $(printf '%s' "$admin_url" | sed -E 's#//[^@]*@#//***@#')"
    info "Start Postgres and re-run: ./install.sh --skip-node --skip-python"
    return
  fi
  ok "connected to Postgres"

  if [ -n "$(psql "$admin_url" -tAc "SELECT 1 FROM pg_database WHERE datname = '${db_name//\'/\'\'}'")" ]; then
    skip "database \"$db_name\" already exists"
  else
    run "createdb $db_name"
    psql "$admin_url" -q -c "CREATE DATABASE \"$db_name\"" || die "failed to create database \"$db_name\"."
    ok "created database \"$db_name\""
  fi

  if [ "$SKIP_NODE" -eq 0 ] || [ -d "$BACKEND_DIR/node_modules" ]; then
    run "npx drizzle-kit push --force"
    (cd "$BACKEND_DIR" && DATABASE_URL="$db_url" npx --no-install drizzle-kit push --force) \
      || die "drizzle-kit push failed — see the output above."
    ok "schema pushed to \"$db_name\""
  else
    warn "backend/node_modules is missing — skipping the schema push."
    info "Run it later with: cd backend && npx drizzle-kit push --force"
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

summary() {
  local uvicorn="python3 -m uvicorn"
  [ "$USE_VENV" -eq 1 ] && uvicorn=".venv/bin/python -m uvicorn"

  printf '\n%sInstall complete.%s\n' "$BOLD$GREEN" "$RESET"

  if [ "$WARNING_COUNT" -gt 0 ]; then
    printf '\n%sFinish these before the stack will run:%s\n' "$BOLD$YELLOW" "$RESET"
    local w
    for w in "${WARNINGS[@]}"; do printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$w"; done
  fi

  cat <<EOF

${BOLD}Start the stack${RESET} (two terminals):

  ${DIM}# 1. Extraction service${RESET}
  cd extraction-service && $uvicorn main:app --port 8001
  ${DIM}# ...or, without an Anthropic API key, the mock:${RESET}
  cd extraction-service && $uvicorn mock_server:app --port 8001

  ${DIM}# 2. Backend API${RESET}
  cd backend && npm start

API:  http://localhost:3000
Docs: http://localhost:3000/api/docs
EOF
}

# ---------------------------------------------------------------------------

printf '%sUniversal Invoice Management Platform — installer%s\n' "$BOLD" "$RESET"
printf '%s%s%s\n' "$DIM" "$ROOT_DIR" "$RESET"

check_prerequisites
install_backend
install_extraction
setup_database
summary
