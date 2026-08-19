import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    lines = f.readlines()

for i, l in enumerate(lines):
    if 'stageDeadlineMs' in l:
        print(f"Line {i+1}: {l}")

