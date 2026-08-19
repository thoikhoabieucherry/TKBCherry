import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-constraints.js', 'r', encoding='utf-8', errors='ignore') as f:
    text = f.read()

idx = text.find('fixedLessonsBySlot')
if idx != -1:
    print(text[idx-50:idx+800])
