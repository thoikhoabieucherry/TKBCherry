import sys, codecs, re
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# When soBuoiDay1 <= 1 in optimize_singletons, complete immediately!
old_break = """          if(bestMetrics.soBuoiDay1 === 0){
            portfolioDone = true;
            break;
          }"""

new_break = """          if(bestMetrics.soBuoiDay1 <= 1){
            portfolioDone = true;
            break;
          }"""

if old_break in content:
    content = content.replace(old_break, new_break)
    print("Updated early break to <= 1 singletons!")
else:
    print("Old break not found, checking...")

# Also in the check after fast repair:
old_check = 'if(mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= 0){'
new_check = 'if(mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= 1){'
content = content.replace(old_check, new_check)

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

print("Saved engine with instant exit when optimal singletons reached!")
