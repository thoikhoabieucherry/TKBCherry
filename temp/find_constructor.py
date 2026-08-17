import sys

sys.stdout.reconfigure(encoding='utf-8')

def find_constructor():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    for i, line in enumerate(lines[:500]):
        if "constructor(" in line:
            print(f"Line {i+1}: {line}")
            for j in range(i, min(len(lines), i + 60)):
                print(f"{j+1:4d}: {lines[j]}", end="")
            break

if __name__ == "__main__":
    find_constructor()
