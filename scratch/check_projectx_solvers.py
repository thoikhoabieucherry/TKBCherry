import sys
from pathlib import Path

anti_dir = Path(r"C:\Users\Love\Documents\Codex\ProjectX\TKBCherryAnti")
claude_dir = Path(r"C:\Users\Love\Documents\Codex\ProjectX\TKBCherryClaude")
current_dir = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")

print("=== CHECKING TKBCherryAnti solve_stdio.py ===")
anti_stdio = anti_dir / "solver_runtime" / "scripts" / "solve_stdio.py"
if anti_stdio.exists():
    with open(anti_stdio, encoding="utf-8") as f:
        content = f.read()
        print(f"TKBCherryAnti solve_stdio.py length: {len(content)}")
        # check imports and solve calls
        for line in content.splitlines():
            if "import" in line and ("solver" in line or "solve" in line or "tkb" in line):
                print("  ", line)
            if "solve_" in line or "unified" in line or "cpsat" in line:
                print("  call:", line)

print("\n=== CHECKING TKBCherryClaude solve_stdio.py ===")
claude_stdio = claude_dir / "solver_runtime" / "scripts" / "solve_stdio.py"
if claude_stdio.exists():
    with open(claude_stdio, encoding="utf-8") as f:
        content = f.read()
        print(f"TKBCherryClaude solve_stdio.py length: {len(content)}")
        for line in content.splitlines():
            if "import" in line and ("solver" in line or "solve" in line or "tkb" in line):
                print("  ", line)
            if "solve_" in line or "v3" in line or "cherry" in line:
                print("  call:", line)
