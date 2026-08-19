import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    text = f.read()

idx = text.find('loadExistingSchedule(')
idx_loop = text.find('this.classes.forEach(lop => {', idx)
if idx_loop != -1:
    print(text[idx_loop:idx_loop+2500])
