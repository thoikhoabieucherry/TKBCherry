import sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js', 'r', encoding='utf-8') as f:
    content = f.read()

idx = content.find('tryAugmentingSingletonEjectionChain(')
print("tryAugmentingSingletonEjectionChain snippet:")
print(content[idx:idx+2500])
