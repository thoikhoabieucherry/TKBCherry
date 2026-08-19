import sys, codecs, re
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# Make optimize() exit cleanly on first completion without spurious loop restarts
clean_loop_pattern = r'while\(!portfolioDone\)\{\s+portfolioDone = true;\s+for\(round = 0; round < MAX_ROUNDS; round\)\{.*?(?=\n      // Quyết định restart)'

# Let's inspect the while loop in optimize()
idx = content.find('while(!portfolioDone){')
end_idx = content.find('this.applyToDataTKB();', idx)

print("while loop found:", idx != -1)
print(content[idx:idx+800])
