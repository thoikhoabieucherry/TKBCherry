import difflib
from pathlib import Path

def print_diff(p1, p2, title):
    print(f"=== DIFF: {title} ===")
    with open(p1, encoding='utf-8') as f1, open(p2, encoding='utf-8') as f2:
        lines1 = f1.readlines()
        lines2 = f2.readlines()
    diff = list(difflib.unified_diff(lines1, lines2, fromfile=str(p1), tofile=str(p2)))
    if not diff:
        print("Identical!")
    else:
        for line in diff[:60]:
            print(line, end="")
        if len(diff) > 60:
            print(f"\n... [{len(diff)-60} more diff lines]")

p_flash1 = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\src\tkb_optimizer_ref\unified_cpsat_solver.py")
p_flash2 = Path(r"C:\Users\Love\Documents\Codex\ProjectX\TKBCherryAnti\solver_runtime\src\tkb_optimizer_ref\unified_cpsat_solver.py")
print_diff(p_flash1, p_flash2, "Flash / unified_cpsat_solver.py")

p_cherry_entry1 = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\src\tkb_engine_v3\entry.py")
p_cherry_entry2 = Path(r"C:\Users\Love\Documents\Codex\ProjectX\TKBCherryClaude\solver_runtime\src\tkb_engine_v3\entry.py")
print_diff(p_cherry_entry1, p_cherry_entry2, "Cherry / entry.py")
