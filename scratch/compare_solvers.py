import filecmp
from pathlib import Path

def compare_dirs(dir1, dir2):
    dcmp = filecmp.dircmp(dir1, dir2)
    print(f"Comparing {dir1} vs {dir2}")
    print("Files only in 1:", dcmp.left_only)
    print("Files only in 2:", dcmp.right_only)
    print("Differing files:", dcmp.diff_files)
    for sub in dcmp.common_dirs:
        compare_dirs(Path(dir1) / sub, Path(dir2) / sub)

print("=== CHECKING CHERRY (tkb_engine_v3) vs TKBCherryClaude ===")
dir_cherry = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\src\tkb_engine_v3")
dir_claude = Path(r"C:\Users\Love\Documents\Codex\ProjectX\TKBCherryClaude\solver_runtime\src\tkb_engine_v3")
if dir_cherry.exists() and dir_claude.exists():
    compare_dirs(dir_cherry, dir_claude)
else:
    print("One of the directories does not exist:", dir_cherry.exists(), dir_claude.exists())

print("\n=== CHECKING FLASH (unified_cpsat_solver.py) vs TKBCherryAnti ===")
file_flash = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\src\tkb_optimizer_ref\unified_cpsat_solver.py")
file_anti = Path(r"C:\Users\Love\Documents\Codex\ProjectX\TKBCherryAnti\solver_runtime\src\tkb_optimizer_ref\unified_cpsat_solver.py")
if file_flash.exists() and file_anti.exists():
    diff = filecmp.cmp(file_flash, file_anti, shallow=False)
    print(f"unified_cpsat_solver.py identical to TKBCherryAnti? {diff}")
else:
    print("One of the flash files does not exist:", file_flash.exists(), file_anti.exists())
