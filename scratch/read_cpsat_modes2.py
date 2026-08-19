import sys
from pathlib import Path

cpsat_modes_path = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\src\tkb_engine_v3\cpsat_modes.py")
with open(cpsat_modes_path, encoding="utf-8") as f:
    lines = f.readlines()
    print("".join(lines[70:180]))
