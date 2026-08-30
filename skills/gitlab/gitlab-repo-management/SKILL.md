---
name: gitlab-repo-management
description: "Clone/create/fork repos; manage remotes, releases."
version: 1.1.0
author: Alice Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  alice:
    tags: [GitLab, Repositories, Git, Releases, Secrets, Configuration]
    related_skills: [gitlab-auth, gitlab-mr-workflow, gitlab-issues]
---

# GitHub Repository Management

Create, clone, fork, configure, and manage GitHub repositories. Each section shows `glab` first, then the `git` + `curl` fallback.

## Prerequisites

- Authenticated with GitLab (see `gitlab-auth` skill)

### Setup

```bash
if command -v glab &>/dev/null && glab auth status &>/dev/null; then
  AUTH="glab"
else
  AUTH="git"
  if [ -z "$GITLAB_TOKEN" ]; then
    if _alice_env="${ALICE_HOME:-$HOME/.alice}/.env"; [ -f "$_alice_env" ] && grep -q "^GITLAB_TOKEN=" "$_alice_env"; then
      GITLAB_TOKEN=$(grep "^GITLAB_TOKEN=" "$_alice_env" | head -1 | cut -d= -f2 | tr -d '\n\r')
    elif grep -q "github.com" ~/.git-credentials 2>/dev/null; then
      GITLAB_TOKEN=$(grep "${GITLAB_HOST:-gitlab\.com}" ~/.git-credentials 2>/dev/null | head -1 | sed 's|https://[^:]*:\([^@]*\)@.*|\1|')
    fi
  fi
fi

# Get your GitHub username (needed for several operations)
if [ "$AUTH" = "glab" ]; then
  GL_USER=$(glab api user --jq '.login')
else
  GL_USER=$(curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" https://\${GITLAB_HOST:-gitlab.com}/api/v4/user | python3 -c "import sys,json; print(json.load(sys.stdin)['login'])")
fi
```

If you're inside a repo already:

```bash
REMOTE_URL=$(git remote get-url origin)
OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's|.*${GITLAB_HOST:-gitlab\.com}[:/]||; s|\.git$||')
OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1)
REPO=$(echo "$OWNER_REPO" | cut -d/ -f2)
```

---

## 1. Cloning Repositories

Cloning is pure `git` — works identically either way:

```bash
# Clone via HTTPS (works with credential helper or token-embedded URL)
git clone https://\${GITLAB_HOST:-gitlab.com}/owner/repo-name.git

# Clone into a specific directory
git clone https://\${GITLAB_HOST:-gitlab.com}/owner/repo-name.git ./my-local-dir

# Shallow clone (faster for large repos)
git clone --depth 1 https://\${GITLAB_HOST:-gitlab.com}/owner/repo-name.git

# Clone a specific branch
git clone --branch develop https://\${GITLAB_HOST:-gitlab.com}/owner/repo-name.git

# Clone via SSH (if SSH is configured)
git clone git@github.com:owner/repo-name.git
```

**With glab (shorthand):**

```bash
glab repo clone owner/repo-name
glab repo clone owner/repo-name -- --depth 1
```

## 2. Creating Repositories

**With glab:**

```bash
# Create a public repo and clone it
glab repo create my-new-project --public --clone

# Private, with description and license
glab repo create my-new-project --private --description "A useful tool" --license MIT --clone

# Under an organization
glab repo create my-org/my-new-project --public --clone

# From existing local directory
cd /path/to/existing/project
glab repo create my-project --source . --public --push
```

**With git + curl:**

```bash
# Create the remote repo via API
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/user/repos \
  -d '{
    "name": "my-new-project",
    "description": "A useful tool",
    "private": false,
    "auto_init": true,
    "license_template": "mit"
  }'

# Clone it
git clone https://\${GITLAB_HOST:-gitlab.com}/$GL_USER/my-new-project.git
cd my-new-project

# -- OR -- push an existing local directory to the new repo
cd /path/to/existing/project
git init
git add .
git commit -m "Initial commit"
git remote add origin https://\${GITLAB_HOST:-gitlab.com}/$GL_USER/my-new-project.git
git push -u origin main
```

To create under an organization:

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/orgs/my-org/repos \
  -d '{"name": "my-new-project", "private": false}'
```

### From a Template

**With glab:**

```bash
glab repo create my-new-app --template owner/template-repo --public --clone
```

**With curl:**

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/owner/template-repo/generate \
  -d '{"owner": "'"$GL_USER"'", "name": "my-new-app", "private": false}'
```

## 3. Forking Repositories

**With glab:**

```bash
glab repo fork owner/repo-name --clone
```

**With git + curl:**

```bash
# Create the fork via API
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/owner/repo-name/forks

# Wait a moment for GitHub to create it, then clone
sleep 3
git clone https://\${GITLAB_HOST:-gitlab.com}/$GL_USER/repo-name.git
cd repo-name

# Add the original repo as "upstream" remote
git remote add upstream https://\${GITLAB_HOST:-gitlab.com}/owner/repo-name.git
```

### Keeping a Fork in Sync

```bash
# Pure git — works everywhere
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

**With glab (shortcut):**

```bash
glab repo sync $GL_USER/repo-name
```

## 4. Repository Information

**With glab:**

```bash
glab repo view owner/repo-name
glab repo list --limit 20
glab search repos "machine learning" --language python --sort stars
```

**With curl:**

```bash
# View repo details
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO \
  | python3 -c "
import sys, json
r = json.load(sys.stdin)
print(f\"Name: {r['full_name']}\")
print(f\"Description: {r['description']}\")
print(f\"Stars: {r['stargazers_count']}  Forks: {r['forks_count']}\")
print(f\"Default branch: {r['default_branch']}\")
print(f\"Language: {r['language']}\")"

# List your repos
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://\${GITLAB_HOST:-gitlab.com}/api/v4/user/repos?per_page=20&sort=updated" \
  | python3 -c "
import sys, json
for r in json.load(sys.stdin):
    vis = 'private' if r['private'] else 'public'
    print(f\"  {r['full_name']:40}  {vis:8}  {r.get('language', ''):10}  ★{r['stargazers_count']}\")"

# Search repos
curl -s \
  "https://\${GITLAB_HOST:-gitlab.com}/api/v4/search/repositories?q=machine+learning+language:python&sort=stars&per_page=10" \
  | python3 -c "
import sys, json
for r in json.load(sys.stdin)['items']:
    print(f\"  {r['full_name']:40}  ★{r['stargazers_count']:6}  {r['description'][:60] if r['description'] else ''}\")"
```

## 5. Repository Settings

**With glab:**

```bash
glab repo edit --description "Updated description" --visibility public
glab repo edit --enable-wiki=false --enable-issues=true
glab repo edit --default-branch main
glab repo edit --add-topic "machine-learning,python"
glab repo edit --enable-auto-merge
```

**With curl:**

```bash
curl -s -X PATCH \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO \
  -d '{
    "description": "Updated description",
    "has_wiki": false,
    "has_issues": true,
    "allow_auto_merge": true
  }'

# Update topics
curl -s -X PUT \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Accept: application/vnd.github.mercy-preview+json" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/topics \
  -d '{"names": ["machine-learning", "python", "automation"]}'
```

## 6. Branch Protection

```bash
# View current protection
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/branches/main/protection

# Set up branch protection
curl -s -X PUT \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/branches/main/protection \
  -d '{
    "required_status_checks": {
      "strict": true,
      "contexts": ["ci/test", "ci/lint"]
    },
    "enforce_admins": false,
    "required_pull_request_reviews": {
      "required_approving_review_count": 1
    },
    "restrictions": null
  }'
```

## 7. Secrets Management (GitLab CI)

**With glab:**

```bash
glab secret set API_KEY --body "your-secret-value"
glab secret set SSH_KEY < ~/.ssh/id_rsa
glab secret list
glab secret delete API_KEY
```

**With curl:**

Secrets require encryption with the repo's public key — more involved via API:

```bash
# Get the repo's public key for encrypting secrets
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/secrets/public-key

# Encrypt and set (requires Python with PyNaCl)
python3 -c "
from base64 import b64encode
from nacl import encoding, public
import json, sys

# Get the public key
key_id = '<key_id_from_above>'
public_key = '<base64_key_from_above>'

# Encrypt
sealed = public.SealedBox(
    public.PublicKey(public_key.encode('utf-8'), encoding.Base64Encoder)
).encrypt('your-secret-value'.encode('utf-8'))
print(json.dumps({
    'encrypted_value': b64encode(sealed).decode('utf-8'),
    'key_id': key_id
}))"

# Then PUT the encrypted secret
curl -s -X PUT \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/secrets/API_KEY \
  -d '<output from python script above>'

# List secrets (names only, values hidden)
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/secrets \
  | python3 -c "
import sys, json
for s in json.load(sys.stdin)['secrets']:
    print(f\"  {s['name']:30}  updated: {s['updated_at']}\")"
```

Note: For secrets, `glab secret set` is dramatically simpler. If setting secrets is needed and `glab` isn't available, recommend installing it for just that operation.

## 8. Releases

**With glab:**

```bash
glab release create v1.0.0 --title "v1.0.0" --generate-notes
glab release create v2.0.0-rc1 --draft --prerelease --generate-notes
glab release create v1.0.0 ./dist/binary --title "v1.0.0" --notes "Release notes"
glab release list
glab release download v1.0.0 --dir ./downloads
```

**With curl:**

```bash
# Create a release
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/releases \
  -d '{
    "tag_name": "v1.0.0",
    "name": "v1.0.0",
    "body": "## Changelog\n- Feature A\n- Bug fix B",
    "draft": false,
    "prerelease": false,
    "generate_release_notes": true
  }'

# List releases
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/releases \
  | python3 -c "
import sys, json
for r in json.load(sys.stdin):
    tag = r.get('tag_name', 'no tag')
    print(f\"  {tag:15}  {r['name']:30}  {'draft' if r['draft'] else 'published'}\")"

# Upload a release asset (binary file)
RELEASE_ID=<id_from_create_response>
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  "https://uploads.github.com/projects/$OWNER/$REPO/releases/$RELEASE_ID/assets?name=binary-amd64" \
  --data-binary @./dist/binary-amd64
```

## 9. GitLab CI Workflows

**With glab:**

```bash
glab workflow list
glab ci list --limit 10
glab ci view <RUN_ID>
glab ci view <RUN_ID> --log-failed
glab run rerun <RUN_ID>
glab run rerun <RUN_ID> --failed
glab workflow run ci.yml --ref main
glab workflow run deploy.yml -f environment=staging
```

**With curl:**

```bash
# List workflows
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/workflows \
  | python3 -c "
import sys, json
for w in json.load(sys.stdin)['workflows']:
    print(f\"  {w['id']:10}  {w['name']:30}  {w['state']}\")"

# List recent runs
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/runs?per_page=10" \
  | python3 -c "
import sys, json
for r in json.load(sys.stdin)['workflow_runs']:
    print(f\"  Run {r['id']}  {r['name']:30}  {r['conclusion'] or r['status']}\")"

# Download failed run logs
RUN_ID=<run_id>
curl -s -L \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/runs/$RUN_ID/logs \
  -o /tmp/ci-logs.zip
cd /tmp && unzip -o ci-logs.zip -d ci-logs

# Re-run a failed workflow
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/runs/$RUN_ID/rerun

# Re-run only failed jobs
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/runs/$RUN_ID/rerun-failed-jobs

# Trigger a workflow manually (workflow_dispatch)
WORKFLOW_ID=<workflow_id_or_filename>
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/actions/workflows/$WORKFLOW_ID/dispatches \
  -d '{"ref": "main", "inputs": {"environment": "staging"}}'
```

## 10. Gists

**With glab:**

```bash
glab gist create script.py --public --desc "Useful script"
glab gist list
```

**With curl:**

```bash
# Create a gist
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/gists \
  -d '{
    "description": "Useful script",
    "public": true,
    "files": {
      "script.py": {"content": "print(\"hello\")"}
    }
  }'

# List your gists
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/gists \
  | python3 -c "
import sys, json
for g in json.load(sys.stdin):
    files = ', '.join(g['files'].keys())
    print(f\"  {g['id']}  {g['description'] or '(no desc)':40}  {files}\")"
```

## Quick Reference Table

| Action | glab | git + curl |
|--------|-----|-----------|
| Clone | `glab repo clone o/r` | `git clone https://\${GITLAB_HOST:-gitlab.com}/o/r.git` |
| Create repo | `glab repo create name --public` | `curl POST /user/repos` |
| Fork | `glab repo fork o/r --clone` | `curl POST /projects/o/r/forks` + `git clone` |
| Repo info | `glab repo view o/r` | `curl GET /projects/o/r` |
| Edit settings | `glab repo edit --...` | `curl PATCH /projects/o/r` |
| Create release | `glab release create v1.0` | `curl POST /projects/o/r/releases` |
| List workflows | `glab workflow list` | `curl GET /projects/o/r/actions/workflows` |
| Rerun CI | `glab run rerun ID` | `curl POST /projects/o/r/actions/runs/ID/rerun` |
| Set secret | `glab secret set KEY` | `curl PUT /projects/o/r/actions/secrets/KEY` (+ encryption) |
