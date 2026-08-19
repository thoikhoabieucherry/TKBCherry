import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    text = f.read()

idx = text.find('if(mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= 1)')
if idx == -1:
    idx = text.find('bestMetrics.soBuoiDay1 <= 1')
print(text[idx-100:idx+800])
