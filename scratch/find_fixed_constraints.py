import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-constraints.js', 'r', encoding='utf-8', errors='ignore') as f:
    text = f.read()

idx = text.find('fixedLessons')
if idx != -1:
    print(text[idx-100:idx+800])

idx2 = text.find('toggleFixed')
if idx2 != -1:
    print("\n=== toggleFixed ===")
    print(text[idx2-100:idx2+800])
