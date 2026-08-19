import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-constraints.js', 'r', encoding='utf-8') as f:
    text = f.read()

idx = text.find('teacherFixedLessonSlotIndex')
while idx != -1:
    print('--- match ---')
    print(text[idx-50:idx+400])
    idx = text.find('teacherFixedLessonSlotIndex', idx + 1)
