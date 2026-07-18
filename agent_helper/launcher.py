"""PyInstaller entry point; keep package-relative imports out of the launcher."""

from agent_helper.relocation import maybe_relaunch_from_install_dir
from agent_helper.__main__ import main


if __name__ == "__main__":
    if maybe_relaunch_from_install_dir():
        raise SystemExit(main())
