import sys

sys.stdout.reconfigure(encoding='utf-8')

def find_engine_constructor():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    for i, line in enumerate(lines[90:400]):
        if "constructor(" in line:
            actual_line = 90 + i
            print(f"Line {actual_line+1}: {line}")
            for j in range(actual_line, min(len(lines), actual_line + 80)):
                print(f"{j+1:4d}: {lines[j]}", end="")
            break

if __name__ == "__main__":
    find_engine_constructor()
