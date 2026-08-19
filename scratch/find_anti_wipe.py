import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\phanmon.js', 'r', encoding='utf-8', errors='ignore') as f:
    text = f.read()

idx = text.find('const __countLessonCells = (tkbObj) => {')
if idx != -1:
    print(text[idx:idx+2500])
