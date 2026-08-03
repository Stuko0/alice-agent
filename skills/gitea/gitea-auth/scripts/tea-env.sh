#!/usr/bin/env bash
# Gitea environment detection helper for Alice Agent skills.
#
# Usage (via terminal tool):
#   source skills/github/gitea-auth/scripts/tea-env.sh
#
# After sourcing, these variables are set:
#   TEA_AUTH_METHOD  - "tea", "curl", or "none"
#   GITEA_TOKEN    - personal access token (set if method is "curl")
#   TEA_USER         - GitHub username
#   TEA_OWNER        - repo owner  (only if inside a git repo with a github remote)
#   TEA_REPO         - repo name   (only if inside a git repo with a github remote)
#   TEA_OWNER_REPO   - owner/repo  (only if inside a git repo with a github remote)

# --- Auth detection ---

TEA_AUTH_METHOD="none"
GITEA_TOKEN="${GITEA_TOKEN:-}"
TEA_USER=""

if command -v tea &>/dev/null && tea logins list &>/dev/null 2>&1; then
    TEA_AUTH_METHOD="tea"
    TEA_USER=$(tea api user --jq '.login' 2>/dev/null)
elif [ -n "$GITEA_TOKEN" ]; then
    TEA_AUTH_METHOD="curl"
elif _lydia_env="${LYDIA_HOME:-$HOME/.alice}/.env"; [ -f "$_lydia_env" ] && grep -q "^GITEA_TOKEN=" "$_lydia_env" 2>/dev/null; then
    GITEA_TOKEN=$(grep "^GITEA_TOKEN=" "$_lydia_env" | head -1 | cut -d= -f2 | tr -d '\n\r')
    if [ -n "$GITEA_TOKEN" ]; then
        TEA_AUTH_METHOD="curl"
    fi
elif [ -f "$HOME/.git-credentials" ] && grep -q "github.com" "$HOME/.git-credentials" 2>/dev/null; then
    GITEA_TOKEN=$(grep "github.com" "$HOME/.git-credentials" | head -1 | sed 's|https://[^:]*:\([^@]*\)@.*|\1|')
    if [ -n "$GITEA_TOKEN" ]; then
        TEA_AUTH_METHOD="curl"
    fi
fi

# Resolve username for curl method
if [ "$TEA_AUTH_METHOD" = "curl" ] && [ -z "$TEA_USER" ]; then
    TEA_USER=$(curl -s -H "Authorization: token $GITEA_TOKEN" \
        https://\${GITEA_HOST:-gitea.com}/api/v1/user 2>/dev/null \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('login',''))" 2>/dev/null)
fi

# --- Repo detection (if inside a git repo with a GitHub remote) ---

TEA_OWNER=""
TEA_REPO=""
TEA_OWNER_REPO=""

_remote_url=$(git remote get-url origin 2>/dev/null)
if [ -n "$_remote_url" ] && echo "$_remote_url" | grep -q "github.com"; then
    TEA_OWNER_REPO=$(echo "$_remote_url" | sed -E 's|.*${GITEA_HOST:-gitea\.com}[:/]||; s|\.git$||')
    TEA_OWNER=$(echo "$TEA_OWNER_REPO" | cut -d/ -f1)
    TEA_REPO=$(echo "$TEA_OWNER_REPO" | cut -d/ -f2)
fi
unset _remote_url

# --- Summary ---

echo "GitHub Auth: $TEA_AUTH_METHOD"
[ -n "$TEA_USER" ]       && echo "User: $TEA_USER"
[ -n "$TEA_OWNER_REPO" ] && echo "Repo: $TEA_OWNER_REPO"
[ "$TEA_AUTH_METHOD" = "none" ] && echo "⚠ Not authenticated — see gitea-auth skill"

export TEA_AUTH_METHOD GITEA_TOKEN TEA_USER TEA_OWNER TEA_REPO TEA_OWNER_REPO
