---
name: gitea-auth
description: "Gitea auth setup: HTTPS tokens, SSH keys, tea CLI login."
version: 1.1.0
author: Alice Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  alice:
    tags: [Gitea, Authentication, Git, tea-cli, SSH, Setup]
    related_skills: [gitea-pr-workflow, gitea-code-review, gitea-issues, gitea-repo-management]
---

# Gitea Authentication Setup

This skill sets up authentication so the agent can work with Gitea repositories, PRs, issues, and CI. It covers two paths:

- **`git` (always available)** — uses HTTPS personal access tokens or SSH keys
- **`tea` CLI (if installed)** — richer Gitea API access with a simpler auth flow

## Detection Flow

When a user asks you to work with Gitea, run this check first:

```bash
# Check what's available
git --version
tea --version 2>/dev/null || echo "tea not installed"

# Check if already authenticated
tea logins list 2>/dev/null || echo "tea not authenticated"
git config --global credential.helper 2>/dev/null || echo "no git credential helper"
```

**Decision tree:**
1. If `tea logins list` shows authenticated → you're good, use `tea` for everything
2. If `tea` is installed but not authenticated → use "tea auth" method below
3. If `tea` is not installed → use "git-only" method below (no sudo needed)

---

## Method 1: Git-Only Authentication (No tea, No sudo)

This works on any machine with `git` installed. No root access needed.

### Option A: HTTPS with Personal Access Token (Recommended)

This is the most portable method — works everywhere, no SSH config needed.

**Step 1: Create a personal access token**

Tell the user to go to: **https://\${GITEA_HOST:-gitea.com}/user/settings/applications**

- Click "Generate new token (classic)"
- Give it a name like "alice-agent"
- Select scopes:
  - `repo` (full repository access — read, write, push, PRs)
  - `workflow` (trigger and manage GitHub Actions)
  - `read:org` (if working with organization repos)
- Set expiration (90 days is a good default)
- Copy the token — it won't be shown again

**Step 2: Configure git to store the token**

```bash
# Set up the credential helper to cache credentials
# "store" saves to ~/.git-credentials in plaintext (simple, persistent)
git config --global credential.helper store

# Now do a test operation that triggers auth — git will prompt for credentials
# Username: <their-gitea-username>
# Password: <paste the personal access token, NOT their GitHub password>
git ls-remote https://\${GITEA_HOST:-gitea.com}/<their-username>/<any-repo>.git
```

After entering credentials once, they're saved and reused for all future operations.

**Alternative: cache helper (credentials expire from memory)**

```bash
# Cache in memory for 8 hours (28800 seconds) instead of saving to disk
git config --global credential.helper 'cache --timeout=28800'
```

**Alternative: set the token directly in the remote URL (per-repo)**

```bash
# Embed token in the remote URL (avoids credential prompts entirely)
git remote set-url origin https://<username>:<token>@github.com/<owner>/<repo>.git
```

**Step 3: Configure git identity**

```bash
# Required for commits — set name and email
git config --global user.name "Their Name"
git config --global user.email "their-email@example.com"
```

**Step 4: Verify**

```bash
# Test push access (this should work without any prompts now)
git ls-remote https://\${GITEA_HOST:-gitea.com}/<their-username>/<any-repo>.git

# Verify identity
git config --global user.name
git config --global user.email
```

### Option B: SSH Key Authentication

Good for users who prefer SSH or already have keys set up.

**Step 1: Check for existing SSH keys**

```bash
ls -la ~/.ssh/id_*.pub 2>/dev/null || echo "No SSH keys found"
```

**Step 2: Generate a key if needed**

```bash
# Generate an ed25519 key (modern, secure, fast)
ssh-keygen -t ed25519 -C "their-email@example.com" -f ~/.ssh/id_ed25519 -N ""

# Display the public key for them to add to GitHub
cat ~/.ssh/id_ed25519.pub
```

Tell the user to add the public key at: **https://\${GITEA_HOST:-gitea.com}/user/settings/keys**
- Click "New SSH key"
- Paste the public key content
- Give it a title like "alice-agent-<machine-name>"

**Step 3: Test the connection**

```bash
ssh -T git@\${GITEA_HOST:-gitea.com}
# Expected: "Hi <username>! You've successfully authenticated..."
```

**Step 4: Configure git to use SSH for GitHub**

```bash
# Rewrite HTTPS GitHub URLs to SSH automatically
git config --global url."git@\${GITEA_HOST:-gitea.com}:".insteadOf "https://\${GITEA_HOST:-gitea.com}/"
```

**Step 5: Configure git identity**

```bash
git config --global user.name "Their Name"
git config --global user.email "their-email@example.com"
```

---

## Method 2: tea CLI Authentication

If `tea` is installed, it handles both API access and git credentials in one step.

### Interactive Browser Login (Desktop)

```bash
tea login add
# Select: GitHub.com
# Select: HTTPS
# Authenticate via browser
```

### Token-Based Login (Headless / SSH Servers)

```bash
echo "<THEIR_TOKEN>" | tea login add --with-token

# Set up git credentials through tea
tea login add
```

### Verify

```bash
tea logins list
```

---

## Using the GitHub API Without tea

When `tea` is not available, you can still access the full GitHub API using `curl` with a personal access token. This is how the other GitHub skills implement their fallbacks.

### Setting the Token for API Calls

```bash
# Option 1: Export as env var (preferred — keeps it out of commands)
export GITEA_TOKEN="<token>"

# Then use in curl calls:
curl -s -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/user
```

### Extracting the Token from Git Credentials

If git credentials are already configured (via credential.helper store), the token can be extracted:

```bash
# Read from git credential store
grep "github.com" ~/.git-credentials 2>/dev/null | head -1 | sed 's|https://[^:]*:\([^@]*\)@.*|\1|'
```

### Helper: Detect Auth Method

Use this pattern at the start of any GitHub workflow:

```bash
# Try tea first, fall back to git + curl
if command -v tea &>/dev/null && tea logins list &>/dev/null; then
  echo "AUTH_METHOD=tea"
elif [ -n "$GITEA_TOKEN" ]; then
  echo "AUTH_METHOD=curl"
elif _lydia_env="${ALICE_HOME:-$HOME/.alice}/.env"; [ -f "$_lydia_env" ] && grep -q "^GITEA_TOKEN=" "$_lydia_env"; then
  export GITEA_TOKEN=$(grep "^GITEA_TOKEN=" "$_lydia_env" | head -1 | cut -d= -f2 | tr -d '\n\r')
  echo "AUTH_METHOD=curl"
elif grep -q "github.com" ~/.git-credentials 2>/dev/null; then
  export GITEA_TOKEN=$(grep "github.com" ~/.git-credentials | head -1 | sed 's|https://[^:]*:\([^@]*\)@.*|\1|')
  echo "AUTH_METHOD=curl"
else
  echo "AUTH_METHOD=none"
  echo "Need to set up authentication first"
fi
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `git push` asks for password | GitHub disabled password auth. Use a personal access token as the password, or switch to SSH |
| `remote: Permission to X denied` | Token may lack `repo` scope — regenerate with correct scopes |
| `fatal: Authentication failed` | Cached credentials may be stale — run `git credential reject` then re-authenticate |
| `ssh: connect to host github.com port 22: Connection refused` | Try SSH over HTTPS port: add `Host github.com` with `Port 443` and `Hostname ssh.github.com` to `~/.ssh/config` |
| Credentials not persisting | Check `git config --global credential.helper` — must be `store` or `cache` |
| Multiple GitHub accounts | Use SSH with different keys per host alias in `~/.ssh/config`, or per-repo credential URLs |
| `tea: command not found` + no sudo | Use git-only Method 1 above — no installation needed |
