from pathlib import Path


def test_windows_native_install_path_docs_match_installer() -> None:
    doc = Path("website/docs/user-guide/windows-native.md").read_text()
    install = Path("scripts/install.ps1").read_text()

    assert "%LOCALAPPDATA%\\alice\\alice-agent\\venv\\Scripts" in doc
    assert "Get-Command alice        # should print C:\\Users\\<you>\\AppData\\Local\\alice\\alice-agent\\venv\\Scripts\\alice.exe" in doc
    assert '$aliceBin = "$InstallDir\\venv\\Scripts"' in install
