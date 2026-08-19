import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    text = f.read()

idx = text.find('// CHIẾN LƯỢC B: PULL-IN')
if idx != -1:
    print("=== CURRENT STRATEGY B IN ENGINE ===")
    print(text[idx:idx+2500])
