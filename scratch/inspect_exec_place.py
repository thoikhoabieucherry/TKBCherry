import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\phanmon.js', 'r', encoding='utf-8', errors='ignore') as f:
    text = f.read()

idx = text.find('worker = new Worker')
if idx != -1:
    print("=== Worker instantiation in phanmon.js ===")
    print(text[idx-200:idx+800])

idx2 = text.find('async function runOptimizeAction')
if idx2 == -1:
    idx2 = text.find('runOptimizeAction')
if idx2 != -1:
    print("\n=== runOptimizeAction ===")
    print(text[idx2-100:idx2+1200])
