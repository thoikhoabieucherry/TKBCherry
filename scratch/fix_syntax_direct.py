import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    lines = f.readlines()

new_lines = []
skip = False
for i, l in enumerate(lines):
    if '!(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){ && restartCount < maxRestarts &&' in l:
        new_lines.append('         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){\n')
        skip = True
    elif skip and ('!(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){' in l):
        skip = False
    elif not skip:
        new_lines.append(l)

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.writelines(new_lines)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.writelines(new_lines)

print("Directly replaced broken lines around 8067!")
