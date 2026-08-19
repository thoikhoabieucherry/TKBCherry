import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    text = f.read()

idx = text.find('this.fixedRawCells.set(key, cell);')
if idx != -1:
    print("=== How fixed cells are detected in init() ===")
    print(text[idx-600:idx+400])
