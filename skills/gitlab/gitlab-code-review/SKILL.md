---
name: gitlab-code-review
description: "Review MRs: diffs, inline comments via glab or REST."
version: 1.1.0
author: Alice Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  alice:
    tags: [GitLab, Code-Review, Pull-Requests, Git, Quality]
    related_skills: [gitlab-auth, gitlab-mr-workflow]
---

# GitHub Code Review

Perform code reviews on local changes before pushing, or review open MRs on GitLab. Most of this skill uses plain `git` — the `glab`/`curl` split only matters for MR-level interactions.

## Prerequisites

- Authenticated with GitLab (see `gitlab-auth` skill)
- Inside a git repository

### Setup (for MR interactions)

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

REMOTE_URL=$(git remote get-url origin)
OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's|.*${GITLAB_HOST:-gitlab\.com}[:/]||; s|\.git$||')
OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1)
REPO=$(echo "$OWNER_REPO" | cut -d/ -f2)
```

---

## 1. Reviewing Local Changes (Pre-Push)

This is pure `git` — works everywhere, no API needed.

### Get the Diff

```bash
# Staged changes (what would be committed)
git diff --staged

# All changes vs main (what an MR would contain)
git diff main...HEAD

# File names only
git diff main...HEAD --name-only

# Stat summary (insertions/deletions per file)
git diff main...HEAD --stat
```

### Review Strategy

1. **Get the big picture first:**

```bash
git diff main...HEAD --stat
git log main..HEAD --oneline
```

2. **Review file by file** — use `read_file` on changed files for full context, and the diff to see what changed:

```bash
git diff main...HEAD -- src/auth/login.py
```

3. **Check for common issues:**

```bash
# Debug statements, TODOs, console.logs left behind
git diff main...HEAD | grep -n "print(\|console\.log\|TODO\|FIXME\|HACK\|XXX\|debugger"

# Large files accidentally staged
git diff main...HEAD --stat | sort -t'|' -k2 -rn | head -10

# Secrets or credential patterns
git diff main...HEAD | grep -in "password\|secret\|api_key\|token.*=\|private_key"

# Merge conflict markers
git diff main...HEAD | grep -n "<<<<<<\|>>>>>>\|======="
```

4. **Present structured feedback** to the user.

### Review Output Format

When reviewing local changes, present findings in this structure:

```
## Code Review Summary

### Critical
- **src/auth.py:45** — SQL injection: user input passed directly to query.
  Suggestion: Use parameterized queries.

### Warnings
- **src/models/user.py:23** — Password stored in plaintext. Use bcrypt or argon2.
- **src/api/routes.py:112** — No rate limiting on login endpoint.

### Suggestions
- **src/utils/helpers.py:8** — Duplicates logic in `src/core/utils.py:34`. Consolidate.
- **tests/test_auth.py** — Missing edge case: expired token test.

### Looks Good
- Clean separation of concerns in the middleware layer
- Good test coverage for the happy path
```

---

## 2. Reviewing a Merge Request on GitHub

### View MR Details

**With glab:**

```bash
glab mr view 123
glab mr diff 123
glab mr diff 123 --name-only
```

**With git + curl:**

```bash
MR_NUMBER=123

# Get MR details
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/merge_requests/$MR_NUMBER \
  | python3 -c "
import sys, json
mr = json.load(sys.stdin)
print(f\"Title: {mr['title']}\")
print(f\"Author: {mr['user']['login']}\")
print(f\"Branch: {mr['head']['ref']} -> {mr['base']['ref']}\")
print(f\"State: {mr['state']}\")
print(f\"Body:\n{mr['body']}\")"

# List changed files
curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/merge_requests/$MR_NUMBER/files \
  | python3 -c "
import sys, json
for f in json.load(sys.stdin):
    print(f\"{f['status']:10} +{f['additions']:-4} -{f['deletions']:-4}  {f['filename']}\")"
```

### Check Out MR Locally for Full Review

This works with plain `git` — no `glab` needed:

```bash
# Fetch the MR branch and check it out
git fetch origin merge-requests/123/head:mr-123
git checkout mr-123

# Now you can use read_file, search_files, run tests, etc.

# View diff against the base branch
git diff main...mr-123
```

**With glab (shortcut):**

```bash
glab mr checkout 123
```

### Leave Comments on an MR

**General MR comment — with glab:**

```bash
glab mr comment 123 --body "Overall looks good, a few suggestions below."
```

**General MR comment — with curl:**

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/issues/$MR_NUMBER/comments \
  -d '{"body": "Overall looks good, a few suggestions below."}'
```

### Leave Inline Review Comments

**Single inline comment — with glab (via API):**

```bash
HEAD_SHA=$(glab mr view 123 --json headRefOid --jq '.headRefOid')

glab api repos/$OWNER/$REPO/merge_requests/123/comments \
  --method POST \
  -f body="This could be simplified with a list comprehension." \
  -f path="src/auth/login.py" \
  -f commit_id="$HEAD_SHA" \
  -f line=45 \
  -f side="RIGHT"
```

**Single inline comment — with curl:**

```bash
# Get the head commit SHA
HEAD_SHA=$(curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/merge_requests/$MR_NUMBER \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['head']['sha'])")

curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/merge_requests/$MR_NUMBER/comments \
  -d "{
    \"body\": \"This could be simplified with a list comprehension.\",
    \"path\": \"src/auth/login.py\",
    \"commit_id\": \"$HEAD_SHA\",
    \"line\": 45,
    \"side\": \"RIGHT\"
  }"
```

### Submit a Formal Review (Approve / Request Changes)

**With glab:**

```bash
glab mr review 123 --approve --body "LGTM!"
glab mr review 123 --request-changes --body "See inline comments."
glab mr review 123 --comment --body "Some suggestions, nothing blocking."
```

**With curl — multi-comment review submitted atomically:**

```bash
HEAD_SHA=$(curl -s \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/merge_requests/$MR_NUMBER \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['head']['sha'])")

curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$OWNER/$REPO/merge_requests/$MR_NUMBER/reviews \
  -d "{
    \"commit_id\": \"$HEAD_SHA\",
    \"event\": \"COMMENT\",
    \"body\": \"Code review from Alice Agent\",
    \"comments\": [
      {\"path\": \"src/auth.py\", \"line\": 45, \"body\": \"Use parameterized queries to prevent SQL injection.\"},
      {\"path\": \"src/models/user.py\", \"line\": 23, \"body\": \"Hash passwords with bcrypt before storing.\"},
      {\"path\": \"tests/test_auth.py\", \"line\": 1, \"body\": \"Add test for expired token edge case.\"}
    ]
  }"
```

Event values: `"APPROVE"`, `"REQUEST_CHANGES"`, `"COMMENT"`

The `line` field refers to the line number in the *new* version of the file. For deleted lines, use `"side": "LEFT"`.

---

## 3. Review Checklist

When performing a code review (local or MR), systematically check:

### Correctness
- Does the code do what it claims?
- Edge cases handled (empty inputs, nulls, large data, concurrent access)?
- Error paths handled gracefully?

### Security
- No hardcoded secrets, credentials, or API keys
- Input validation on user-facing inputs
- No SQL injection, XSS, or path traversal
- Auth/authz checks where needed

### Code Quality
- Clear naming (variables, functions, classes)
- No unnecessary complexity or premature abstraction
- DRY — no duplicated logic that should be extracted
- Functions are focused (single responsibility)

### Testing
- New code paths tested?
- Happy path and error cases covered?
- Tests readable and maintainable?

### Performance
- No N+1 queries or unnecessary loops
- Appropriate caching where beneficial
- No blocking operations in async code paths

### Documentation
- Public APIs documented
- Non-obvious logic has comments explaining "why"
- README updated if behavior changed

---

## 4. Pre-Push Review Workflow

When the user asks you to "review the code" or "check before pushing":

1. `git diff main...HEAD --stat` — see scope of changes
2. `git diff main...HEAD` — read the full diff
3. For each changed file, use `read_file` if you need more context
4. Apply the checklist above
5. Present findings in the structured format (Critical / Warnings / Suggestions / Looks Good)
6. If critical issues found, offer to fix them before the user pushes

---

## 5. MR Review Workflow (End-to-End)

When the user asks you to "review MR #N", "look at this MR", or gives you an MR URL, follow this recipe:

### Step 1: Set up environment

```bash
source "${ALICE_HOME:-$HOME/.alice}/skills/gitlab/gitlab-auth/scripts/gitlab-env.sh"
# Or run the inline setup block from the top of this skill
```

### Step 2: Gather MR context

Get the MR metadata, description, and list of changed files to understand scope before diving into code.

**With glab:**
```bash
glab mr view 123
glab mr diff 123 --name-only
glab mr ci 123
```

**With curl:**
```bash
MR_NUMBER=123

# MR details (title, author, description, branch)
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$GL_OWNER/$GL_REPO/merge_requests/$MR_NUMBER

# Changed files with line counts
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$GL_OWNER/$GL_REPO/merge_requests/$MR_NUMBER/files
```

### Step 3: Check out the MR locally

This gives you full access to `read_file`, `search_files`, and the ability to run tests.

```bash
git fetch origin merge-requests/$MR_NUMBER/head:mr-$MR_NUMBER
git checkout mr-$MR_NUMBER$MR_NUMBER
```

### Step 4: Read the diff and understand changes

```bash
# Full diff against the base branch
git diff main...HEAD

# Or file-by-file for large PRs
git diff main...HEAD --name-only
# Then for each file:
git diff main...HEAD -- path/to/file.py
```

For each changed file, use `read_file` to see full context around the changes — diffs alone can miss issues visible only with surrounding code.

### Step 5: Run automated checks locally (if applicable)

```bash
# Run tests if there's a test suite
python -m pytest 2>&1 | tail -20
# or: npm test, cargo test, go test ./..., etc.

# Run linter if configured
ruff check . 2>&1 | head -30
# or: eslint, clippy, etc.
```

### Step 6: Apply the review checklist (Section 3)

Go through each category: Correctness, Security, Code Quality, Testing, Performance, Documentation.

### Step 7: Post the review to GitHub

Collect your findings and submit them as a formal review with inline comments.

**With glab:**
```bash
# If no issues — approve
glab mr review $MR_NUMBER --approve --body "Reviewed by Alice Agent. Code looks clean — good test coverage, no security concerns."

# If issues found — request changes with inline comments
glab mr review $MR_NUMBER --request-changes --body "Found a few issues — see inline comments."
```

**With curl — atomic review with multiple inline comments:**
```bash
HEAD_SHA=$(curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$GL_OWNER/$GL_REPO/merge_requests/$MR_NUMBER \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['head']['sha'])")

# Build the review JSON — event is APPROVE, REQUEST_CHANGES, or COMMENT
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$GL_OWNER/$GL_REPO/merge_requests/$MR_NUMBER/reviews \
  -d "{
    \"commit_id\": \"$HEAD_SHA\",
    \"event\": \"REQUEST_CHANGES\",
    \"body\": \"## Alice Agent Review\n\nFound 2 issues, 1 suggestion. See inline comments.\",
    \"comments\": [
      {\"path\": \"src/auth.py\", \"line\": 45, \"body\": \"🔴 **Critical:** User input passed directly to SQL query — use parameterized queries.\"},
      {\"path\": \"src/models.py\", \"line\": 23, \"body\": \"⚠️ **Warning:** Password stored without hashing.\"},
      {\"path\": \"src/utils.py\", \"line\": 8, \"body\": \"💡 **Suggestion:** This duplicates logic in core/utils.py:34.\"}
    ]
  }"
```

### Step 8: Also post a summary comment

In addition to inline comments, leave a top-level summary so the MR author gets the full picture at a glance. Use the review output format from `references/review-output-template.md`.

**With glab:**
```bash
glab mr comment $MR_NUMBER --body "$(cat <<'EOF'
## Code Review Summary

**Verdict: Changes Requested** (2 issues, 1 suggestion)

### 🔴 Critical
- **src/auth.py:45** — SQL injection vulnerability

### ⚠️ Warnings
- **src/models.py:23** — Plaintext password storage

### 💡 Suggestions
- **src/utils.py:8** — Duplicated logic, consider consolidating

### ✅ Looks Good
- Clean API design
- Good error handling in the middleware layer

---
*Reviewed by Alice Agent*
EOF
)"
```

### Step 9: Clean up

```bash
git checkout main
git branch -D mr-$MR_NUMBER
```

### Decision: Approve vs Request Changes vs Comment

- **Approve** — no critical or warning-level issues, only minor suggestions or all clear
- **Request Changes** — any critical or warning-level issue that should be fixed before merge
- **Comment** — observations and suggestions, but nothing blocking (use when you're unsure or the MR is a draft)
