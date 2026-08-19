import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    lines = f.readlines()

for i in range(8050, min(len(lines), 8085)):
    print(f"{i+1}: {lines[i]}", end="")
