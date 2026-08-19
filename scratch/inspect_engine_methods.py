import sys, re
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find method definitions in FetTimetableEngine
matches = re.findall(r'^\s*(async\s+)?([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{', content, re.MULTILINE)
print(f"Total methods in engine: {len(matches)}")

# Filter methods related to optimize, singleton, crusher, ruin, ejection, swap
relevant = [m[1] for m in matches if any(k in m[1].lower() for k in ['singleton', 'optimize', 'crush', 'swap', 'ruin', 'eject', 'chain', 'pair'])]
print("Relevant methods:", relevant)

# Search optimize() method implementation
opt_idx = content.find('async optimize(')
if opt_idx != -1:
    print("\n=== optimize() implementation snippet ===")
    print(content[opt_idx:opt_idx+3000])

