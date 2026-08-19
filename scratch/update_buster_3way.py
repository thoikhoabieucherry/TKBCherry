import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

sapxep_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html'

with codecs.open(sapxep_file, 'r', 'utf-8') as f:
    content = f.read()

old_tag = '<script src="tkb-fet-engine.js?v=20260818-fast-singleton-dir1-live"></script>'
new_tag = '<script src="tkb-fet-engine.js?v=20260818-3way-cycle-fast-v2"></script>'

if old_tag in content:
    content = content.replace(old_tag, new_tag)
    with codecs.open(sapxep_file, 'w', 'utf-8') as f:
        f.write(content)
    print("Updated cache-buster in sapxep.html!")
else:
    print("Old tag not found in sapxep.html")
