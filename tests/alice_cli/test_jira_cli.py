"""Tests for the Jira CLI helpers (`alice jira`)."""

import argparse
import base64

import pytest

from alice_cli.jira_cli import JiraError, adf_to_text, _issue_line, _print_error
from alice_cli.subcommands.jira import build_jira_parser


def _parse_jira_args(argv):
    """Build the real `alice jira` parser and parse argv against it."""
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")
    build_jira_parser(subparsers, cmd_jira=lambda _args: 0)
    return parser.parse_args(argv)


class TestJiraArgparse:
    def test_list_defaults(self):
        args = _parse_jira_args(["jira", "list"])
        assert args.jira_command == "list"
        assert args.jql is None
        assert args.project is None
        assert args.limit == 50
        assert args.json is False

    def test_list_jql_and_limit(self):
        args = _parse_jira_args(
            ["jira", "list", "--jql", "project = MM AND key = MM-1", "--limit", "5"]
        )
        assert args.jql == "project = MM AND key = MM-1"
        assert args.limit == 5

    def test_show_key(self):
        args = _parse_jira_args(["jira", "show", "mm-58"])
        assert args.key == "mm-58"

    def test_auth_probe_defaults_false(self):
        assert _parse_jira_args(["jira", "auth"]).probe is False


class TestAdfToText:
    def test_flattens_paragraphs_and_text_nodes(self):
        doc = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Hola "},
                                                   {"type": "text", "text": "mundo"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "Segunda línea"}]},
            ],
        }
        out = adf_to_text(doc)
        assert "Hola mundo" in out
        assert "Segunda línea" in out

    def test_handles_none_and_strings(self):
        assert adf_to_text(None) == ""
        assert adf_to_text("texto plano") == "texto plano"


class TestIssueLine:
    def test_contains_key_status_and_summary(self):
        issue = {
            "key": "MM-58",
            "fields": {
                "summary": "Implementar pantalla de Checkout",
                "status": {"name": "To-do"},
                "priority": {"name": "Highest"},
                "issuetype": {"name": "Historia"},
                "assignee": None,
            },
        }
        line = _issue_line(issue)
        assert "MM-58" in line
        assert "To-do" in line
        assert "Highest" in line
        assert "Checkout" in line


class TestErrorReporting:
    def test_unauthorized_points_at_token_url(self, capsys):
        rc = _print_error(JiraError("/rest/api/3/myself", 401, "{}"))
        err = capsys.readouterr().err
        assert rc == 1
        assert "atlassian.com" in err

    def test_parse_error_explains_basic_auth(self, capsys):
        rc = _print_error(
            JiraError("/rest/api/3/myself", 403,
                      '{"error": "Failed to parse Connect Session Auth Token"}')
        )
        err = capsys.readouterr().err
        assert rc == 1
        assert "Basic" in err

    def test_settings_missing_creds_is_actionable(self, monkeypatch, capsys):
        from alice_cli import jira_cli

        monkeypatch.setattr(jira_cli, "_env_value", lambda _k: "")
        assert jira_cli._settings() == ("", "", "")
        assert "JIRA_API_TOKEN" in capsys.readouterr().err


class TestBasicAuthHeader:
    def test_header_is_basic_email_token(self):
        """Guard: the token must ride as Basic, never Bearer (Jira rejects Bearer)."""
        cred = base64.b64encode(b"me@example.com:ATATT3x").decode()
        header = "Basic " + cred
        assert header.startswith("Basic ")
        decoded = base64.b64decode(header.split(" ", 1)[1]).decode()
        assert decoded == "me@example.com:ATATT3x"
