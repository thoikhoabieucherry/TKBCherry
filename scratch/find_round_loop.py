import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    content = f.read()

idx = 0
while True:
    idx = content.find('for(let round = 0; round < MAX_ROUNDS; round++)', idx)
    if idx == -1:
        break
    print(f"=== Found round loop at {idx} ===")
    print(content[idx:idx+3500])
    idx += 100
