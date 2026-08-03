---
name: gitea-issues
description: "Create, triage, label, assign Gitea issues via tea or REST."
version: 1.1.0
author: Alice Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  alice:
    tags: [Gitea, Issues, Project-Management, Bug-Tracking, Triage]
    related_skills: [gitea-auth, gitea-pr-workflow]
---

# Gitea Issues Management

Create, search, triage, and manage GitHub issues. Each section shows `tea` first, then the `curl` fallback.

## Prerequisites

- Authenticated with Gitea (see `gitea-auth` skill)
- Inside a git repo with a GitHub remote, or specify the repo explicitly

### Setup

```bash
if command -v tea &>/dev/null && tea logins list &>/dev/null; then
  AUTH="tea"
else
  AUTH="git"
  if [ -z "$GITEA_TOKEN" ]; then
    if _lydia_env="${ALICE_HOME:-$HOME/.alice}/.env"; [ -f "$_lydia_env" ] && grep -q "^GITEA_TOKEN=" "$_lydia_env"; then
      GITEA_TOKEN=$(grep "^GITEA_TOKEN=" "$_lydia_env" | head -1 | cut -d= -f2 | tr -d '\n\r')
    elif grep -q "github.com" ~/.git-credentials 2>/dev/null; then
      GITEA_TOKEN=$(grep "github.com" ~/.git-credentials 2>/dev/null | head -1 | sed 's|https://[^:]*:\([^@]*\)@.*|\1|')
    fi
  fi
fi

REMOTE_URL=$(git remote get-url origin)
OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's|.*${GITEA_HOST:-gitea\.com}[:/]||; s|\.git$||')
OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1)
REPO=$(echo "$OWNER_REPO" | cut -d/ -f2)
```

---

## 1. Viewing Issues

**With tea:**

```bash
tea issues list
tea issues list --state open --label "bug"
tea issues list --assignee @me
tea issues list --search "authentication error" --state all
tea issues view 42
```

**With curl:**

```bash
# List open issues
curl -s \
  -H "Authorization: token $GITEA_TOKEN" \
  "https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues?state=open&per_page=20" \
  | python3 -c "
import sys, json
for i in json.load(sys.stdin):
    if 'pull_request' not in i:  # GitHub API returns PRs in /issues too
        labels = ', '.join(l['name'] for l in i['labels'])
        print(f\"#{i['number']:5}  {i['state']:6}  {labels:30}  {i['title']}\")"

# Filter by label
curl -s \
  -H "Authorization: token $GITEA_TOKEN" \
  "https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues?state=open&labels=bug&per_page=20" \
  | python3 -c "
import sys, json
for i in json.load(sys.stdin):
    if 'pull_request' not in i:
        print(f\"#{i['number']}  {i['title']}\")"

# View a specific issue
curl -s \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues/42 \
  | python3 -c "
import sys, json
i = json.load(sys.stdin)
labels = ', '.join(l['name'] for l in i['labels'])
assignees = ', '.join(a['login'] for a in i['assignees'])
print(f\"#{i['number']}: {i['title']}\")
print(f\"State: {i['state']}  Labels: {labels}  Assignees: {assignees}\")
print(f\"Author: {i['user']['login']}  Created: {i['created_at']}\")
print(f\"\n{i['body']}\")"

# Search issues
curl -s \
  -H "Authorization: token $GITEA_TOKEN" \
  "https://\${GITEA_HOST:-gitea.com}/api/v1/search/issues?q=authentication+error+repo:$OWNER/$REPO" \
  | python3 -c "
import sys, json
for i in json.load(sys.stdin)['items']:
    print(f\"#{i['number']}  {i['state']:6}  {i['title']}\")"
```

## 2. Creating Issues

**With tea:**

```bash
tea issues create \
  --title "Login redirect ignores ?next= parameter" \
  --body "## Description
After logging in, users always land on /dashboard.

## Steps to Reproduce
1. Navigate to /settings while logged out
2. Get redirected to /login?next=/settings
3. Log in
4. Actual: redirected to /dashboard (should go to /settings)

## Expected Behavior
Respect the ?next= query parameter." \
  --label "bug,backend" \
  --assignee "username"
```

**With curl:**

```bash
curl -s -X POST \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues \
  -d '{
    "title": "Login redirect ignores ?next= parameter",
    "body": "## Description\nAfter logging in, users always land on /dashboard.\n\n## Steps to Reproduce\n1. Navigate to /settings while logged out\n2. Get redirected to /login?next=/settings\n3. Log in\n4. Actual: redirected to /dashboard\n\n## Expected Behavior\nRespect the ?next= query parameter.",
    "labels": ["bug", "backend"],
    "assignees": ["username"]
  }'
```

### Bug Report Template

```
## Bug Description
<What's happening>

## Steps to Reproduce
1. <step>
2. <step>

## Expected Behavior
<What should happen>

## Actual Behavior
<What actually happens>

## Environment
- OS: <os>
- Version: <version>
```

### Feature Request Template

```
## Feature Description
<What you want>

## Motivation
<Why this would be useful>

## Proposed Solution
<How it could work>

## Alternatives Considered
<Other approaches>
```

## 3. Managing Issues

### Add/Remove Labels

**With tea:**

```bash
tea issues edit 42 --add-label "priority:high,bug"
tea issues edit 42 --remove-label "needs-triage"
```

**With curl:**

```bash
# Add labels
curl -s -X POST \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues/42/labels \
  -d '{"labels": ["priority:high", "bug"]}'

# Remove a label
curl -s -X DELETE \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues/42/labels/needs-triage

# List available labels in the repo
curl -s \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/labels \
  | python3 -c "
import sys, json
for l in json.load(sys.stdin):
    print(f\"  {l['name']:30}  {l.get('description', '')}\")"
```

### Assignment

**With tea:**

```bash
tea issues edit 42 --add-assignee username
tea issues edit 42 --add-assignee @me
```

**With curl:**

```bash
curl -s -X POST \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues/42/assignees \
  -d '{"assignees": ["username"]}'
```

### Commenting

**With tea:**

```bash
tea issues comment 42 --body "Investigated — root cause is in auth middleware. Working on a fix."
```

**With curl:**

```bash
curl -s -X POST \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues/42/comments \
  -d '{"body": "Investigated — root cause is in auth middleware. Working on a fix."}'
```

### Closing and Reopening

**With tea:**

```bash
tea issues close 42
tea issues close 42 --reason "not planned"
tea issues reopen 42
```

**With curl:**

```bash
# Close
curl -s -X PATCH \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues/42 \
  -d '{"state": "closed", "state_reason": "completed"}'

# Reopen
curl -s -X PATCH \
  -H "Authorization: token $GITEA_TOKEN" \
  https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues/42 \
  -d '{"state": "open"}'
```

### Linking Issues to PRs

Issues are automatically closed when a PR merges with the right keywords in the body:

```
Closes #42
Fixes #42
Resolves #42
```

To create a branch from an issue:

**With tea:**

```bash
tea issues checkout 42 --checkout
```

**With git (manual equivalent):**

```bash
git checkout main && git pull origin main
git checkout -b fix/issue-42-login-redirect
```

## 4. Issue Triage Workflow

When asked to triage issues:

1. **List untriaged issues:**

```bash
# With tea
tea issues list --label "needs-triage" --state open

# With curl
curl -s \
  -H "Authorization: token $GITEA_TOKEN" \
  "https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues?labels=needs-triage&state=open" \
  | python3 -c "
import sys, json
for i in json.load(sys.stdin):
    if 'pull_request' not in i:
        print(f\"#{i['number']}  {i['title']}\")"
```

2. **Read and categorize** each issue (view details, understand the bug/feature)

3. **Apply labels and priority** (see Managing Issues above)

4. **Assign** if the owner is clear

5. **Comment with triage notes** if needed

## 5. Bulk Operations

For batch operations, combine API calls with shell scripting:

**With tea:**

```bash
# Close all issues with a specific label
tea issues list --label "wontfix" --json number --jq '.[].number' | \
  xargs -I {} tea issues close {} --reason "not planned"
```

**With curl:**

```bash
# List issue numbers with a label, then close each
curl -s \
  -H "Authorization: token $GITEA_TOKEN" \
  "https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues?labels=wontfix&state=open" \
  | python3 -c "import sys,json; [print(i['number']) for i in json.load(sys.stdin)]" \
  | while read num; do
    curl -s -X PATCH \
      -H "Authorization: token $GITEA_TOKEN" \
      https://\${GITEA_HOST:-gitea.com}/api/v1/repos/$OWNER/$REPO/issues/$num \
      -d '{"state": "closed", "state_reason": "not_planned"}'
    echo "Closed #$num"
  done
```

## Quick Reference Table

| Action | tea | curl endpoint |
|--------|-----|--------------|
| List issues | `tea issues list` | `GET /repos/{o}/{r}/issues` |
| View issue | `tea issues view N` | `GET /repos/{o}/{r}/issues/N` |
| Create issue | `tea issues create ...` | `POST /repos/{o}/{r}/issues` |
| Add labels | `tea issues edit N --add-label ...` | `POST /repos/{o}/{r}/issues/N/labels` |
| Assign | `tea issues edit N --add-assignee ...` | `POST /repos/{o}/{r}/issues/N/assignees` |
| Comment | `tea issues comment N --body ...` | `POST /repos/{o}/{r}/issues/N/comments` |
| Close | `tea issues close N` | `PATCH /repos/{o}/{r}/issues/N` |
| Search | `tea issues list --search "..."` | `GET /search/issues?q=...` |
