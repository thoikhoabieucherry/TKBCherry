import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    content = f.read()

idx = content.find('async optimize(')
end = content.find('async optimizeGap2WithBorrow(')
if end == -1:
    end = idx + 25000

with open('optimize_body.js', 'w', encoding='utf-8') as out:
    out.write(content[idx:end])

print(f"Written optimize_body.js ({end-idx} chars)")
