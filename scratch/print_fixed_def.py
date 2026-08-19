import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    text = f.read()

print(text[21000:22200])
