"""Tests for git provider detection — used by the desktop statusbar to
swap its icon and PR-creation target based on the origin remote URL."""

from alice_cli.web_git import detect_git_provider, _pr_target_url


class TestDetectGitProvider:
    """Provider detection from a remote URL. We test ssh://, https://, git@,
    scp-style (git@host:owner/repo) and http://user@host forms. Each provider
    is identified by host fragment."""

    def test_none_for_empty_or_none(self):
        assert detect_git_provider("") == "none"
        assert detect_git_provider(None) == "none"

    def test_github_https(self):
        assert detect_git_provider("https://github.com/foo/bar.git") == "github"

    def test_github_ssh_scp_style(self):
        # scp-style: no scheme, just user@host:path
        assert detect_git_provider("git@github.com:foo/bar.git") == "github"

    def test_github_ssh_uri(self):
        assert detect_git_provider("ssh://git@github.com/foo/bar.git") == "github"

    def test_github_enterprise(self):
        # host containing "github" matches (covers enterprise / GitHub AE)
        assert detect_git_provider("https://github.acme.corp/team/repo") == "github"

    def test_gitlab_https(self):
        assert detect_git_provider("https://gitlab.com/foo/bar.git") == "gitlab"

    def test_gitlab_self_hosted(self):
        assert detect_git_provider("https://gitlab.acme.corp/group/repo.git") == "gitlab"

    def test_bitbucket_https(self):
        assert detect_git_provider("https://bitbucket.org/foo/bar.git") == "bitbucket"

    def test_bitbucket_ssh(self):
        assert detect_git_provider("git@bitbucket.org:foo/bar.git") == "bitbucket"

    def test_azure_devops(self):
        assert detect_git_provider("https://dev.azure.com/myorg/myproj/_git/myrepo") == "azure-devops"

    def test_azure_devops_legacy_visualstudio(self):
        assert detect_git_provider("https://myorg.visualstudio.com/_git/myrepo") == "azure-devops"

    def test_gitea_public(self):
        assert detect_git_provider("https://gitea.com/foo/bar.git") == "gitea"

    def test_unknown_host_is_other(self):
        # Custom self-hosted gitea / gogs / sourcehut / etc.
        assert detect_git_provider("https://git.example.com/foo/bar.git") == "other"
        assert detect_git_provider("git@git.example.com:foo/bar.git") == "other"

    def test_https_with_userinfo(self):
        # https://user:token@host/owner/repo
        assert detect_git_provider("https://user:token@github.com/foo/bar.git") == "github"

    def test_https_with_port(self):
        assert detect_git_provider("https://gitlab.example.com:8443/foo/bar.git") == "gitlab"

    def test_host_is_case_insensitive(self):
        assert detect_git_provider("https://GitHub.com/foo/bar") == "github"
        assert detect_git_provider("https://GITLAB.com/foo/bar") == "gitlab"


class TestPrTargetUrl:
    """The deep-link URL the desktop statusbar hands to ``openExternal`` to
    land the user on the right PR/MR creation page for the current branch."""

    def test_github_compare(self):
        url = _pr_target_url("https://github.com/foo/bar.git", "github", "feature/x")
        assert url == "https://github.com/foo/bar/compare/feature/x"

    def test_gitlab_compare(self):
        url = _pr_target_url("git@gitlab.com:foo/bar.git", "gitlab", "feature/y")
        assert url == "https://gitlab.com/foo/bar/compare/feature/y"

    def test_bitbucket_compare(self):
        url = _pr_target_url("https://bitbucket.org/foo/bar.git", "bitbucket", "fix")
        assert url == "https://bitbucket.org/foo/bar/compare/fix"

    def test_azure_devops_shape(self):
        url = _pr_target_url(
            "https://dev.azure.com/myorg/myproj/_git/myrepo", "azure-devops", "main"
        )
        assert url == (
            "https://dev.azure.com/myorg/myproj/_git/myrepo"
            "/pullrequestcreate?sourceRef=main"
        )

    def test_returns_none_when_no_remote(self):
        assert _pr_target_url(None, "github", "main") is None

    def test_returns_none_when_no_branch(self):
        assert _pr_target_url("https://github.com/foo/bar", "github", None) is None

    def test_strips_dot_git_suffix(self):
        url = _pr_target_url("https://github.com/foo/bar.git", "github", "main")
        assert url is not None
        assert "/bar/compare" in url and "bar.git" not in url
