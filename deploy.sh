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
step "0/7  Pre-flight checks"

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
step "1/7  Type-checking"
npm run typecheck
ok "No type errors"

# ── 2. Bump version ────────────────────────────────────────────────────────
step "2/7  Bumping version"
# npm version also creates a git commit + tag automatically
npm version "$BUMP" --no-git-tag-version   # update package.json only (we tag manually below)
NEW_VERSION=$(node -p "require('./package.json').version")
ok "Version bumped: ${CURRENT_VERSION} → ${NEW_VERSION}"

# ── 3. Build ───────────────────────────────────────────────────────────────
step "3/7  Building"
npm run build
ok "Built → dist/index.js  ($(du -sh dist/index.js 2>/dev/null | cut -f1))"

# ── 4. Dry-run preview ─────────────────────────────────────────────────────
step "4/7  Dry-run preview (files that will be published)"
npm publish --dry-run 2>&1 | grep -E '^\s+(dist|README|package)' || true
echo ""

# ── 5. Publish to npm ──────────────────────────────────────────────────────
step "5/7  Publishing to npm"
npm publish
ok "${PKG_NAME}@${NEW_VERSION} published"

# ── 6. Publish to the MCP Registry ─────────────────────────────────────────
step "6/7  Publishing to the MCP Registry"

# The registry listing is what syndicates this server into the MCP directories and the editor
# install pickers; npm alone reaches nobody looking for an MCP server. It was never part of this
# script, so between 2026-09-09 and 2026-09-11 server.json sat correct on disk while the registry
# held no betadrop entry at all. Automated here so a release cannot leave the two out of step.
#
# Order matters: the registry re-reads the npm package and checks its `mcpName` against the name
# in server.json, so this must run AFTER `npm publish` — and after npm has actually propagated.
REGISTRY_OK=0

if ! command -v mcp-publisher >/dev/null 2>&1; then
  warn "mcp-publisher is not installed — skipping the registry (npm is already published)."
  echo "    Install it:  brew install mcp-publisher"
  echo "    Then see the authentication note further down this script."
elif [ -n "${SKIP_REGISTRY:-}" ]; then
  warn "SKIP_REGISTRY is set — not touching the MCP Registry."
else
  # server.json carries the version in two places and neither is derived from package.json.
  info "Pinning server.json to v${NEW_VERSION}"
  node -e '
    const fs = require("fs");
    const v = process.argv[1];
    const j = JSON.parse(fs.readFileSync("server.json", "utf8"));
    j.version = v;
    for (const pkg of j.packages || []) pkg.version = v;
    fs.writeFileSync("server.json", JSON.stringify(j, null, 2) + "\n");
  ' "$NEW_VERSION"

  # npm publish returns before the version is readable from the public registry mirror. Publishing
  # into that gap fails validation for a package that is, in fact, fine.
  info "Waiting for npm to serve ${PKG_NAME}@${NEW_VERSION}…"
  NPM_READY=0
  for _ in $(seq 1 20); do
    if npm view "${PKG_NAME}@${NEW_VERSION}" version >/dev/null 2>&1; then NPM_READY=1; break; fi
    sleep 3
  done
  [ "$NPM_READY" -eq 1 ] && ok "npm is serving v${NEW_VERSION}" || warn "npm has not served v${NEW_VERSION} after 60s; trying the registry anyway."

  mcp-publisher validate || fail "server.json is invalid — fix it before the registry sees it."

  # Log in HERE, immediately before publishing, rather than relying on a session the caller set up
  # earlier: the registry's JWT lives 5 minutes (exp - iat = 300), which is shorter than a release
  # takes. `gh`'s token already carries read:org, which is what the org namespace needs, so this
  # mints a fresh grant with no new credential. Absolute path on purpose — see the note above.
  GH_BIN=""
  for candidate in "$HOME/.local/bin/gh" "$(command -v gh 2>/dev/null || true)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { GH_BIN="$candidate"; break; }
  done

  if [ -n "$GH_BIN" ] && GH_TOKEN_VALUE="$("$GH_BIN" auth token 2>/dev/null)" && [ -n "$GH_TOKEN_VALUE" ]; then
    if mcp-publisher login github --token "$GH_TOKEN_VALUE" >/dev/null 2>&1; then
      ok "Registry login refreshed via ${GH_BIN}"
    else
      warn "mcp-publisher login failed with gh's token; publishing with whatever session exists."
    fi
  else
    warn "gh not found or not logged in — publishing with whatever registry session exists."
    echo "    If this fails, see the authentication note above."
  fi

  # AUTHENTICATION — read this before "just running the login again".
  #
  # The registry grants the io.github.betadrop-app/* namespace only to an *Owner* of the org, and
  # it decides that by calling GET /user/memberships/orgs with the token and looking for
  # role=admin, state=active (internal/api/handlers/v0/auth/github_at.go). kaushalrola is an
  # active Owner, so the role is not the problem.
  #
  # `mcp-publisher login github` — the interactive device flow — does NOT produce a token that
  # can see that. It was tried twice on 2026-09-11 and both times the registry minted a JWT
  # carrying only `io.github.kaushalrola/*`, so `publish` answered 403 with a message about
  # making org membership public. That advice is a red herring: membership is already public
  # (GET /users/kaushalrola/orgs returns betadrop-app unauthenticated) and the handler does not
  # consult public membership at all. The registry authenticates as a GitHub *App*
  # (client_id Iv23liUydBbI7Z2Q9bOZ), whose user-to-server token does not carry org membership
  # here.
  #
  # The fix is to hand the publisher a token that ALREADY carries read:org rather than minting one
  # through the device flow. `gh`'s own token does (gist, read:org, repo, workflow), so no new
  # credential has to be created:
  #
  #   mcp-publisher login github --token "$(~/.local/bin/gh auth token)" && mcp-publisher publish
  #
  # Use the ABSOLUTE path: gh lives at ~/.local/bin/gh, which is not on the interactive shell's
  # PATH. A bare $(gh auth token) expands to empty, mcp-publisher falls through to the device
  # flow, and it looks like an unrelated failure.
  #
  # A Personal Access Token works equally well and is what the registry's own docs prescribe
  # (docs/modelcontextprotocol-io/authentication.mdx): classic PAT with the `read:org` scope, or a
  # fine-grained PAT with Organization permissions -> Members -> Read-only — the latter is bound
  # to ONE resource owner, so create it against betadrop-app, not the personal account.
  #
  # A token without that permission is not rejected — it silently publishes to the personal
  # namespace instead, which is why this script checks the result rather than trusting exit 0.
  #
  # Registry JWTs last 5 minutes, so log in immediately before publishing, not hours ahead.
  if ! mcp-publisher publish 2>&1 | tee /tmp/mcp-publish.log; then
    if grep -qi "auth\|login\|token\|unauthor" /tmp/mcp-publish.log; then
      warn "Not authorised for the io.github.betadrop-app namespace."
      echo "    The device flow does NOT grant it - pass a token with read:org (see note above):"
      echo "      mcp-publisher login github --token \"\$(~/.local/bin/gh auth token)\""
      echo "      cd $(pwd) && mcp-publisher publish"
    fi
  else
    REGISTRY_OK=1
    ok "Listed as io.github.betadrop-app/betadrop-mcp @ ${NEW_VERSION}"
  fi

  if [ "$REGISTRY_OK" -eq 0 ]; then
    warn "npm has v${NEW_VERSION} but the MCP Registry does NOT. Directory listings will show the"
    echo "    previous version until you re-run: cd $(pwd) && mcp-publisher publish"
  fi
fi

# ── 7. Commit, tag, push ───────────────────────────────────────────────────
step "7/7  Git commit + tag + push"

git add package.json package-lock.json server.json
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

if [ "${REGISTRY_OK:-0}" -eq 0 ] && [ -z "${SKIP_REGISTRY:-}" ]; then
  echo ""
  warn "Released to npm, but NOT to the MCP Registry — see the step above. Exiting non-zero so"
  echo "    this does not read as a clean release."
  exit 1
fi
echo -e "  registry: https://registry.modelcontextprotocol.io/v0/servers?search=betadrop"
