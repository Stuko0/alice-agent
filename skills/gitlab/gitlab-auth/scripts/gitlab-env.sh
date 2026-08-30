#!/usr/bin/env bash
# GitHub environment detection helper for Alice Agent skills.
#
# Usage (via terminal tool):
#   source skills/gitlab/gitlab-auth/scripts/gitlab-env.sh
#
# After sourcing, these variables are set:
#   GL_AUTH_METHOD  - "glab", "curl", or "none"
#   GITLAB_TOKEN    - personal access token (set if method is "curl")
#   GL_USER         - GitHub username
#   GL_OWNER        - repo owner  (only if inside a git repo with a github remote)
#   GL_REPO         - repo name   (only if inside a git repo with a github remote)
#   GL_OWNER_REPO   - owner/repo  (only if inside a git repo with a github remote)

# --- Auth detection ---

GL_AUTH_METHOD="none"
GITLAB_TOKEN="${GITLAB_TOKEN:-}"
GL_USER=""

if command -v glab &>/dev/null && glab auth status &>/dev/null 2>&1; then
    GL_AUTH_METHOD="glab"
    GL_USER=$(glab api user --jq '.login' 2>/dev/null)
elif [ -n "$GITLAB_TOKEN" ]; then
    GL_AUTH_METHOD="curl"
elif _alice_env="${ALICE_HOME:-$HOME/.alice}/.env"; [ -f "$_alice_env" ] && grep -q "^GITLAB_TOKEN=" "$_alice_env" 2>/dev/null; then
    GITLAB_TOKEN=$(grep "^GITLAB_TOKEN=" "$_alice_env" | head -1 | cut -d= -f2 | tr -d '\n\r')
    if [ -n "$GITLAB_TOKEN" ]; then
        GL_AUTH_METHOD="curl"
    fi
elif [ -f "$HOME/.git-credentials" ] && grep -q "github.com" "$HOME/.git-credentials" 2>/dev/null; then
    GITLAB_TOKEN=$(grep "${GITLAB_HOST:-gitlab\.com}" "$HOME/.git-credentials" | head -1 | sed 's|https://[^:]*:\([^@]*\)@.*|\1|')
    if [ -n "$GITLAB_TOKEN" ]; then
        GL_AUTH_METHOD="curl"
    fi
fi

# Resolve username for curl method
if [ "$GL_AUTH_METHOD" = "curl" ] && [ -z "$GL_USER" ]; then
    GL_USER=$(curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
        https://\${GITLAB_HOST:-gitlab.com}/api/v4/user 2>/dev/null \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('login',''))" 2>/dev/null)
fi

# --- Repo detection (if inside a git repo with a GitHub remote) ---

GL_OWNER=""
GL_REPO=""
GL_OWNER_REPO=""

_remote_url=$(git remote get-url origin 2>/dev/null)
if [ -n "$_remote_url" ] && echo "$_remote_url" | grep -q "github.com"; then
    GL_OWNER_REPO=$(echo "$_remote_url" | sed -E 's|.*${GITLAB_HOST:-gitlab\.com}[:/]||; s|\.git$||')
    GL_OWNER=$(echo "$GL_OWNER_REPO" | cut -d/ -f1)
    GL_REPO=$(echo "$GL_OWNER_REPO" | cut -d/ -f2)
fi
unset _remote_url

# --- Summary ---

echo "GitHub Auth: $GL_AUTH_METHOD"
[ -n "$GL_USER" ]       && echo "User: $GL_USER"
[ -n "$GL_OWNER_REPO" ] && echo "Repo: $GL_OWNER_REPO"
[ "$GL_AUTH_METHOD" = "none" ] && echo "⚠ Not authenticated — see gitlab-auth skill"

export GL_AUTH_METHOD GITLAB_TOKEN GL_USER GL_OWNER GL_REPO GL_OWNER_REPO
