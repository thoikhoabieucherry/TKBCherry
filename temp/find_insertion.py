import sys

sys.stdout.reconfigure(encoding='utf-8')

def find_insertion_point():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    print("Finding insertion point in optimize_gap2 section...")
    for i in range(5220, 5320):
        if "resKempe" in lines[i]:
            print(f"Line {i+1}: {lines[i].strip()}")
            for j in range(i, i+15):
                print(f"  Line {j+1}: {lines[j].strip()}")
            break

if __name__ == "__main__":
    find_insertion_point()
