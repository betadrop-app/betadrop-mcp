#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — publish @betadrop/mcp to npm
#
# Usage:
#   ./deploy.sh          # defaults to "minor" bump (0.1.0 → 0.2.0)
#   ./deploy.sh patch    # bug-fix bump  (0.1.0 → 0.1.1)
#   ./deploy.sh minor    # feature bump  (0.1.0 → 0.2.0)
#   ./deploy.sh major    # breaking bump (0.1.0 → 1.0.0)
#   ./deploy.sh 1.3.0    # exact version (must be higher than current)
# ---------------------------------------------------------------------------

set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
info() { echo -e "${CYAN}→${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
fail() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }
step() { echo -e "\n${BOLD}$*${RESET}"; }

# ── Move to the MCP package root ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUMP="${1:-minor}"

# ── 0. Pre-flight checks ───────────────────────────────────────────────────
step "0/6  Pre-flight checks"

# Node + npm present
command -v node >/dev/null 2>&1 || fail "Node.js is not installed."
command -v npm  >/dev/null 2>&1 || fail "npm is not installed."
ok "Node $(node -v)  npm $(npm -v)"

# Must be logged in to npm
NPM_USER=$(npm whoami 2>/dev/null) || fail "Not logged in to npm. Run: npm login"
ok "npm user: ${NPM_USER}"

# git must be clean (no uncommitted changes)
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "Working tree has uncommitted changes. Commit or stash them first."
fi
ok "Git working tree is clean"

# Confirm the package name in package.json
PKG_NAME=$(node -p "require('./package.json').name")
CURRENT_VERSION=$(node -p "require('./package.json').version")
info "Package : ${BOLD}${PKG_NAME}${RESET}"
info "Current : ${BOLD}v${CURRENT_VERSION}${RESET}"
info "Bump    : ${BOLD}${BUMP}${RESET}"

echo ""
read -r -p "$(echo -e "${YELLOW}Proceed with publishing?${RESET} [y/N] ")" CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 0; }

# ── 1. Typecheck ───────────────────────────────────────────────────────────
step "1/6  Type-checking"
npm run typecheck
ok "No type errors"

# ── 2. Bump version ────────────────────────────────────────────────────────
step "2/6  Bumping version"
# npm version also creates a git commit + tag automatically
npm version "$BUMP" --no-git-tag-version   # update package.json only (we tag manually below)
NEW_VERSION=$(node -p "require('./package.json').version")
ok "Version bumped: ${CURRENT_VERSION} → ${NEW_VERSION}"

# ── 3. Build ───────────────────────────────────────────────────────────────
step "3/6  Building"
npm run build
ok "Built → dist/index.js  ($(du -sh dist/index.js 2>/dev/null | cut -f1))"

# ── 4. Dry-run preview ─────────────────────────────────────────────────────
step "4/6  Dry-run preview (files that will be published)"
npm publish --dry-run 2>&1 | grep -E '^\s+(dist|README|package)' || true
echo ""

# ── 5. Publish to npm ──────────────────────────────────────────────────────
step "5/6  Publishing to npm"
npm publish
ok "${PKG_NAME}@${NEW_VERSION} published"

# ── 6. Commit, tag, push ───────────────────────────────────────────────────
step "6/6  Git commit + tag + push"

git add package.json package-lock.json
git commit -m "chore(release): ${PKG_NAME}@${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin HEAD
git push origin "v${NEW_VERSION}"
ok "Pushed commit and tag v${NEW_VERSION} to origin"

# ── Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Released ${PKG_NAME}@${NEW_VERSION}${RESET}"
echo -e "  npm   : https://www.npmjs.com/package/${PKG_NAME}"
echo -e "  tag   : v${NEW_VERSION}"
echo -e "  install: npm install -g ${PKG_NAME}@${NEW_VERSION}"
