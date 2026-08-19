import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    content = f.read()

opt_idx = content.find('async optimize(')
end_opt = content.find('async optimizeGap2WithBorrow(')
if end_opt == -1:
    end_opt = opt_idx + 8000

print(content[opt_idx:end_opt])
