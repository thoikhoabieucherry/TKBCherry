import sys, codecs, re
sys.stdout.reconfigure(encoding='utf-8')

sapxep_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html'

with codecs.open(sapxep_file, 'r', 'utf-8') as f:
    content = f.read()

content = re.sub(r'tkb-fet-engine\.js\?v=[^\"]+', 'tkb-fet-engine.js?v=20260818-turbo-2.5m-evals-v4', content)

with codecs.open(sapxep_file, 'w', 'utf-8') as f:
    f.write(content)

print("Updated sapxep.html with Turbo cache buster!")
