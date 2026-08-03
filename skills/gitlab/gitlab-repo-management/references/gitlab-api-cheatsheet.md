# GitHub REST API Cheatsheet

Base URL: `https://\${GITLAB_HOST:-gitlab.com}/api/v4`

All requests need: `-H "PRIVATE-TOKEN: $GITLAB_TOKEN"`

Use the `gitlab-env.sh` helper to set `$GITLAB_TOKEN`, `$GL_OWNER`, `$GL_REPO` automatically:
```bash
source "${ALICE_HOME:-$HOME/.alice}/skills/gitlab/gitlab-auth/scripts/gitlab-env.sh"
```

## Repositories

| Action | Method | Endpoint |
|--------|--------|----------|
| Get repo info | GET | `/projects/{owner}/{repo}` |
| Create repo (user) | POST | `/user/repos` |
| Create repo (org) | POST | `/orgs/{org}/repos` |
| Update repo | PATCH | `/projects/{owner}/{repo}` |
| Delete repo | DELETE | `/projects/{owner}/{repo}` |
| List your repos | GET | `/user/repos?per_page=30&sort=updated` |
| List org repos | GET | `/orgs/{org}/repos` |
| Fork repo | POST | `/projects/{owner}/{repo}/forks` |
| Create from template | POST | `/projects/{owner}/{template}/generate` |
| Get topics | GET | `/projects/{owner}/{repo}/topics` |
| Set topics | PUT | `/projects/{owner}/{repo}/topics` |

## Merge Requests

| Action | Method | Endpoint |
|--------|--------|----------|
| List PRs | GET | `/projects/{owner}/{repo}/merge_requests?state=open` |
| Create MR | POST | `/projects/{owner}/{repo}/merge_requests` |
| Get MR | GET | `/projects/{owner}/{repo}/merge_requests/{number}` |
| Update MR | PATCH | `/projects/{owner}/{repo}/merge_requests/{number}` |
| List MR files | GET | `/projects/{owner}/{repo}/merge_requests/{number}/files` |
| Merge MR | PUT | `/projects/{owner}/{repo}/merge_requests/{number}/merge` |
| Request reviewers | POST | `/projects/{owner}/{repo}/merge_requests/{number}/requested_reviewers` |
| Create review | POST | `/projects/{owner}/{repo}/merge_requests/{number}/reviews` |
| Inline comment | POST | `/projects/{owner}/{repo}/merge_requests/{number}/comments` |

### MR Merge Body

```json
{"merge_method": "squash", "commit_title": "feat: description (#N)"}
```

Merge methods: `"merge"`, `"squash"`, `"rebase"`

### MR Review Events

`"APPROVE"`, `"REQUEST_CHANGES"`, `"COMMENT"`

## Issues

| Action | Method | Endpoint |
|--------|--------|----------|
| List issues | GET | `/projects/{owner}/{repo}/issues?state=open` |
| Create issue | POST | `/projects/{owner}/{repo}/issues` |
| Get issue | GET | `/projects/{owner}/{repo}/issues/{number}` |
| Update issue | PATCH | `/projects/{owner}/{repo}/issues/{number}` |
| Add comment | POST | `/projects/{owner}/{repo}/issues/{number}/comments` |
| Add labels | POST | `/projects/{owner}/{repo}/issues/{number}/labels` |
| Remove label | DELETE | `/projects/{owner}/{repo}/issues/{number}/labels/{name}` |
| Add assignees | POST | `/projects/{owner}/{repo}/issues/{number}/assignees` |
| List labels | GET | `/projects/{owner}/{repo}/labels` |
| Search issues | GET | `/search/issues?q={query}+repo:{owner}/{repo}` |

Note: The Issues API also returns PRs. Filter with `"pull_request" not in item` when parsing.

## CI / GitLab CI

| Action | Method | Endpoint |
|--------|--------|----------|
| List workflows | GET | `/projects/{owner}/{repo}/actions/workflows` |
| List runs | GET | `/projects/{owner}/{repo}/actions/runs?per_page=10` |
| List runs (branch) | GET | `/projects/{owner}/{repo}/actions/runs?branch={branch}` |
| Get run | GET | `/projects/{owner}/{repo}/actions/runs/{run_id}` |
| Download logs | GET | `/projects/{owner}/{repo}/actions/runs/{run_id}/logs` |
| Re-run | POST | `/projects/{owner}/{repo}/actions/runs/{run_id}/rerun` |
| Re-run failed | POST | `/projects/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs` |
| Trigger dispatch | POST | `/projects/{owner}/{repo}/actions/workflows/{id}/dispatches` |
| Commit status | GET | `/projects/{owner}/{repo}/repository/commits/{sha}/status` |
| Check runs | GET | `/projects/{owner}/{repo}/repository/commits/{sha}/check-runs` |

## Releases

| Action | Method | Endpoint |
|--------|--------|----------|
| List releases | GET | `/projects/{owner}/{repo}/releases` |
| Create release | POST | `/projects/{owner}/{repo}/releases` |
| Get release | GET | `/projects/{owner}/{repo}/releases/{id}` |
| Delete release | DELETE | `/projects/{owner}/{repo}/releases/{id}` |
| Upload asset | POST | `https://uploads.github.com/projects/{owner}/{repo}/releases/{id}/assets?name={filename}` |

## Secrets

| Action | Method | Endpoint |
|--------|--------|----------|
| List secrets | GET | `/projects/{owner}/{repo}/actions/secrets` |
| Get public key | GET | `/projects/{owner}/{repo}/actions/secrets/public-key` |
| Set secret | PUT | `/projects/{owner}/{repo}/actions/secrets/{name}` |
| Delete secret | DELETE | `/projects/{owner}/{repo}/actions/secrets/{name}` |

## Branch Protection

| Action | Method | Endpoint |
|--------|--------|----------|
| Get protection | GET | `/projects/{owner}/{repo}/branches/{branch}/protection` |
| Set protection | PUT | `/projects/{owner}/{repo}/branches/{branch}/protection` |
| Delete protection | DELETE | `/projects/{owner}/{repo}/branches/{branch}/protection` |

## User / Auth

| Action | Method | Endpoint |
|--------|--------|----------|
| Get current user | GET | `/user` |
| List user repos | GET | `/user/repos` |
| List user gists | GET | `/gists` |
| Create gist | POST | `/gists` |
| Search repos | GET | `/search/repositories?q={query}` |

## Pagination

Most list endpoints support:
- `?per_page=100` (max 100)
- `?page=2` for next page
- Check `Link` header for `rel="next"` URL

## Rate Limits

- Authenticated: 5,000 requests/hour
- Check remaining: `curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" https://\${GITLAB_HOST:-gitlab.com}/api/v4/rate_limit`

## Common curl Patterns

```bash
# GET
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$GL_OWNER/$GL_REPO

# POST with JSON body
curl -s -X POST \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$GL_OWNER/$GL_REPO/issues \
  -d '{"title": "...", "body": "..."}'

# PATCH (update)
curl -s -X PATCH \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$GL_OWNER/$GL_REPO/issues/42 \
  -d '{"state": "closed"}'

# DELETE
curl -s -X DELETE \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://\${GITLAB_HOST:-gitlab.com}/api/v4/projects/$GL_OWNER/$GL_REPO/issues/42/labels/bug

# Parse JSON response with python3
curl -s ... | python3 -c "import sys,json; data=json.load(sys.stdin); print(data['field'])"
```
