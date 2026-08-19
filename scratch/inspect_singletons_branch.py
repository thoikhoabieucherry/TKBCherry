import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    content = f.read()

start_needle = 'if(mode === "optimize_singletons")'
idx = content.find(start_needle)
if idx != -1:
    print(content[idx:idx+4000])
