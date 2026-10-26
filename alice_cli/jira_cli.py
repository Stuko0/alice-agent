"""``alice jira ...`` CLI subcommands.

Thin, dependency-free (stdlib urllib) wrappers over the Jira Cloud REST API so
the agent can inspect tickets without a gateway or MCP server.

Credentials are read from ``.env`` (never printed):

    JIRA_BASE_URL=https://<site>.atlassian.net
    JIRA_API_TOKEN=ATATT...
    JIRA_USER_EMAIL=<account email>

Jira Cloud API tokens are used with **Basic** auth
(``base64(email:token)``) — ``Bearer`` fails with
``403 Failed to parse Connect Session Auth Token``.

Typical workflow::

    $ alice jira auth --probe
    $ alice jira list                       # pending MM issues by priority
    $ alice jira list --jql 'key = MM-58'
    $ alice jira show MM-58
"""
from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

_AUTH_HEADER = "Authorization"  # kept as a name so the value stays out of literals

_DEFAULT_JQL = (
    "project = MM AND resolution = Unresolved ORDER BY priority DESC, key ASC"
)
_LIST_FIELDS = (
    "summary,status,priority,issuetype,assignee,reporter,updated,created,labels"
)
_SHOW_FIELDS = (
    "summary,status,priority,issuetype,assignee,reporter,description,"
    "created,updated,labels,comment,issuelinks,subtasks"
)


class JiraError(Exception):
    def __init__(self, method: str, status: int, body: str):
        super().__init__(f"{method}: HTTP {status}")
        self.method = method
        self.status = status
        self.body = body


def _env_value(key: str) -> str:
    try:
        from alice_cli.config import get_env_value

        val = get_env_value(key)
        if val:
            return val.strip()
    except Exception:
        pass
    return (os.environ.get(key) or "").strip()


def _settings() -> tuple[str, str, str]:
    """Return (base_url, token, email) — the token is never printed."""
    base = _env_value("JIRA_BASE_URL").rstrip("/")
    token = _env_value("JIRA_API_TOKEN")
    email = _env_value("JIRA_USER_EMAIL")
    missing = [
        k
        for k, v in (
            ("JIRA_BASE_URL", base),
            ("JIRA_API_TOKEN", token),
            ("JIRA_USER_EMAIL", email),
        )
        if not v
    ]
    if missing:
        print(
            "Faltan credenciales Jira: "
            + ", ".join(missing)
            + f". Agréguelas en `alice config env-path`.",
            file=sys.stderr,
        )
        return "", "", ""
    return base, token, email


def _api(
    path: str,
    *,
    base: str,
    token: str,
    email: str,
    payload: dict | None = None,
    timeout: int = 30,
) -> dict:
    """GET/POST a Jira Cloud endpoint with Basic auth. Returns JSON (or raises JiraError)."""
    cred = base64.b64encode(f"{email}:{token}".encode()).decode()
    headers = {_AUTH_HEADER: "Basic " + cred, "Accept": "application/json"}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers=headers,
                                 method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:400]
        raise JiraError(path, exc.code, body) from None
    except Exception as exc:  # network errors
        raise JiraError(path, 0, str(exc)) from None


def _print_error(err: JiraError) -> int:
    print(f"Jira {err.method} falló: HTTP {err.status}", file=sys.stderr)
    if err.status == 401:
        print(
            "  Credenciales inválidas: verifique JIRA_API_TOKEN y "
            "JIRA_USER_EMAIL (https://id.atlassian.com/manage-profile/security/api-tokens).",
            file=sys.stderr,
        )
    elif err.status == 403:
        print(
            "  403 con 'Failed to parse Connect Session Auth Token' = Bearer "
            "usado por error; este token exige Basic (email + token).",
            file=sys.stderr,
        )
        print(f"  detalle: {err.body[:160]}", file=sys.stderr)
    elif err.status in {404, 410}:
        print(
            "  ¿JIRA_BASE_URL mal escrito o endpoint no disponible? "
            "Pruebe /rest/api/3/search/jql en vez de /rest/api/3/search.",
            file=sys.stderr,
        )
    else:
        print(f"  detalle: {err.body[:200]}", file=sys.stderr)
    return 1


def adf_to_text(node) -> str:
    """Flatten an Atlassian Document Format body into plain text."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_to_text(n) for n in node)
    if not isinstance(node, dict):
        return str(node)
    parts = [adf_to_text(node.get("text", ""))]
    for key in ("content", "marks"):
        child = node.get(key)
        if isinstance(child, list):
            parts.append(adf_to_text(child))
        elif isinstance(child, dict):
            parts.append(adf_to_text(child))
    if node.get("type") in {"paragraph", "heading", "bulletList", "listItem", "blockquote", "rule"}:
        parts.append("\n")
    return "".join(parts)


def _issue_line(issue: dict) -> str:
    f = issue.get("fields") or {}
    status = ((f.get("status") or {}).get("name") or "?")[:14]
    priority = (f.get("priority") or {}).get("name") or "-"
    itype = (f.get("issuetype") or {}).get("name") or "?"
    assignee = ((f.get("assignee") or {}).get("displayName") or "-")[:18]
    summary = (f.get("summary") or "").replace("\n", " ")
    return (
        f"{issue.get('key', '?'):8} {itype[:6]:6} {status:14} {priority[:7]:7} "
        f"{assignee:18} {summary[:72]}"
    )


def jira_auth_command(args) -> int:
    """Verify the configured Jira credentials (identity only — values never printed)."""
    base, token, email = _settings()
    if not token:
        return 1
    try:
        me = _api("/rest/api/3/myself", base=base, token=token, email=email)
    except JiraError as err:
        return _print_error(err)
    print(f"ok   cuenta={me.get('displayName')} <{me.get('emailAddress')}> "
          f"accountId={str(me.get('accountId'))[:12]}…")
    if getattr(args, "probe", False):
        status = 0
        try:
            _api("/rest/api/3/project/search?maxResults=1",
                 base=base, token=token, email=email)
            print("probe  /rest/api/3/project/search: OK")
        except JiraError as err:
            print(f"probe  /rest/api/3/project/search: HTTP {err.status}")
            status = 1
        # probe del endpoint de búsqueda usado por `alice jira list`
        # (el JQL debe restringir: el endpoint nuevo rechaza consultas sin límite)
        try:
            _api("/rest/api/3/search/jql?" + urllib.parse.urlencode(
                {"jql": "project = MM ORDER BY created DESC", "fields": "summary",
                 "maxResults": "1"}),
                base=base, token=token, email=email)
            print("probe  /rest/api/3/search/jql: OK")
        except JiraError as err:
            print(f"probe  /rest/api/3/search/jql: HTTP {err.status}")
            status = 1
        return status
    return 0


def _search(base: str, token: str, email: str, jql: str, limit: int, fields: str) -> dict:
    """GET the modern search endpoint, falling back to legacy POST /search."""
    params = urllib.parse.urlencode(
        {"jql": jql, "fields": fields, "maxResults": str(limit)}
    )
    try:
        return _api(f"/rest/api/3/search/jql?{params}",
                    base=base, token=token, email=email)
    except JiraError as err:
        if err.status not in {404, 410, 400}:
            raise
    return _api("/rest/api/3/search",
                base=base, token=token, email=email,
                payload={"jql": jql, "fields": fields.split(","), "maxResults": limit})


def jira_list_command(args) -> int:
    """List issues (default: unresolved MM issues ordered by priority)."""
    base, token, email = _settings()
    if not token:
        return 1
    jql = getattr(args, "jql", None) or _DEFAULT_JQL
    if getattr(args, "project", None):
        jql = (
            f"project = {args.project} AND resolution = Unresolved "
            "ORDER BY priority DESC, key ASC"
        )
    limit = int(getattr(args, "limit", 50) or 50)
    try:
        data = _search(base, token, email, jql, limit, _LIST_FIELDS)
    except JiraError as err:
        return _print_error(err)

    issues = data.get("issues", [])
    if getattr(args, "json", False):
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0
    for issue in issues:
        print(_issue_line(issue))
    total = data.get("total")
    shown = len(issues)
    suffix = f" (total sin límite: {total})" if isinstance(total, int) and total > shown else ""
    print(f"\n{shown} issue(s){suffix}", file=sys.stderr)
    print(f"JQL: {jql}", file=sys.stderr)
    return 0


def jira_show_command(args) -> int:
    """Show one issue in detail."""
    base, token, email = _settings()
    if not token:
        return 1
    key = (args.key or "").strip().upper()
    try:
        data = _api(
            f"/rest/api/3/issue/{urllib.parse.quote(key)}"
            f"?fields={_SHOW_FIELDS}",
            base=base, token=token, email=email,
        )
    except JiraError as err:
        return _print_error(err)

    if getattr(args, "json", False):
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0

    f = data.get("fields") or {}
    status = (f.get("status") or {}).get("name", "?")
    priority = (f.get("priority") or {}).get("name", "-")
    itype = (f.get("issuetype") or {}).get("name", "?")
    assignee = ((f.get("assignee") or {}).get("displayName") or "-")
    reporter = ((f.get("reporter") or {}).get("displayName") or "-")
    print(f"{data.get('key')}  [{itype}]  {status}  prioridad={priority}")
    print(f"título:      {f.get('summary', '')}")
    print(f"asignado a:  {assignee}")
    print(f"reportado:   {reporter}")
    print(f"creado:      {f.get('created', '')[:16]}   actualizado: {f.get('updated', '')[:16]}")
    labels = f.get("labels") or []
    if labels:
        print(f"etiquetas:   {', '.join(labels)}")
    desc = adf_to_text(f.get("description")).strip()
    if desc:
        print("\ndescripción:")
        print(desc[:2000])
    comments = ((f.get("comment") or {}).get("comments")) or []
    if comments:
        print(f"\ncomentarios ({len(comments)}):")
        for c in comments[-5:]:
            who = ((c.get("author") or {}).get("displayName") or "?")
            body = adf_to_text(c.get("body")).strip().replace("\n", " ")
            print(f"  - {who}: {body[:300]}")
    subs = f.get("subtasks") or []
    if subs:
        print("\nsubtareas:")
        for s in subs:
            sf = s.get("fields") or {}
            print(f"  {s.get('key')}  {(sf.get('status') or {}).get('name', '?'):12} "
                  f"{(sf.get('summary') or '')[:70]}")
    links = f.get("issuelinks") or []
    if links:
        print("\nenlaces:")
        for l in links:
            other = l.get("outwardIssue") or l.get("inwardIssue") or {}
            rel = l.get("type", {}).get("name", "")
            print(f"  {rel}: {other.get('key')} "
                  f"{(((other.get('fields') or {}).get('summary')) or '')[:60]}")
    return 0
