import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

old_fast_hook = """          // [FAST-PATH TARGETED SINGLETON REPAIR] (ANTIGRAVITY DIRECTION 1)
          const fastM = this.tryFastSingletonRepair(bestMetrics, initialMetrics, notifyLiveProgress);
          if(fastM && this.compareMetrics(fastM, bestMetrics, mode) < 0){
            bestMetrics = { ...fastM };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }
          if(bestMetrics.soBuoiDay1 === 0){
            portfolioDone = true;
            break;
          }"""

new_fast_hook = """          // [FAST-PATH TARGETED SINGLETON REPAIR] (ANTIGRAVITY DIRECTION 1)
          const fastM = this.tryFastSingletonRepair(bestMetrics, initialMetrics, notifyLiveProgress);
          if(fastM && this.compareMetrics(fastM, bestMetrics, mode) < 0){
            bestMetrics = { ...fastM };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }
          if(bestMetrics.soBuoiDay1 <= 1){
            portfolioDone = true;
            break;
          }"""

if old_fast_hook in content:
    content = content.replace(old_fast_hook, new_fast_hook)
    print("Successfully patched fast hook with instant exit on soBuoiDay1 <= 1!")
else:
    print("Fast hook string not matched, trying normalized...")
    # normalized replace
    import re
    content = re.sub(r'if\(bestMetrics\.soBuoiDay1\s*===\s*0\)\{\s+portfolioDone = true;\s+break;\s+\}', 'if(bestMetrics.soBuoiDay1 <= 1){\\n            portfolioDone = true;\\n            break;\\n          }', content)
    print("Patched with regex!")

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

# Update cache buster in sapxep.html
sapxep_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html'
with codecs.open(sapxep_file, 'r', 'utf-8') as f:
    s_content = f.read()

import re
s_content = re.sub(r'tkb-fet-engine\.js\?v=[^\"]+', 'tkb-fet-engine.js?v=20260818-instant-convergence-v6', s_content)
with codecs.open(sapxep_file, 'w', 'utf-8') as f:
    f.write(s_content)

print("Updated sapxep.html to v=20260818-instant-convergence-v6!")
