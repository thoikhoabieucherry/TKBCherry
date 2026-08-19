import sys, re
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with open(engine_file, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Patch Tabu Map
# Find this.jrnPlace(actId, slot); followed by const oldSlot
tabu_pattern = r'(this\.jrnUnplace\(confId\);\s+this\.swappedInBranch\.add\(confId\);\s+\}\s+)(this\.jrnPlace\(actId,\s*slot\);\s+const oldSlot\s*=\s*act\.fixedSlot\s*>=\s*0\s*\?\s*act\.fixedSlot\s*:\s*this\.actPlacement\[actId\];)'
tabu_match = re.search(tabu_pattern, content)
if tabu_match:
    replacement = r'\1const oldSlot = this.actPlacement[actId];\n        this.jrnPlace(actId, slot);'
    content = re.sub(tabu_pattern, replacement, content, count=1)
    print("1. Successfully patched Tabu map with regex!")
else:
    print("1. Tabu pattern not matched")

# 2. Patch candM in 3-way cycle
candm_pattern = r'(this\.jrnPlace\(act1\.id,\s*s2\);\s+this\.jrnPlace\(act2\.id,\s*s3\);\s+this\.jrnPlace\(act3\.id,\s*s1\);)(\s+const isBetter\s*=\s*\(candM\.soBuoiTrong2)'
candm_match = re.search(candm_pattern, content)
if candm_match:
    content = re.sub(candm_pattern, r'\1\n                      const candM = this.evaluateMetrics();\2', content, count=1)
    print("2. Successfully patched candM with regex!")
else:
    print("2. candM pattern not matched")

# 3. Hook tryFastSingletonRepair
hook_pattern = r'(// 1\. Primary Downhill Optimization Passes\s+if\(mode === "optimize_singletons"\)\{)(\s+// Nuoc chu luc)'
hook_match = re.search(hook_pattern, content)
if hook_match:
    fast_hook = r'''\1
          // [FAST-PATH TARGETED SINGLETON REPAIR] (ANTIGRAVITY DIRECTION 1)
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
          }
\2'''
    content = re.sub(hook_pattern, fast_hook, content, count=1)
    print("3. Successfully hooked tryFastSingletonRepair with regex!")
else:
    print("3. Hook pattern not matched")

with open(engine_file, 'w', encoding='utf-8') as f:
    f.write(content)

engine_root = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js'
with open(engine_root, 'w', encoding='utf-8') as f:
    f.write(content)

# 4. Worker throttle
worker_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-worker.js'
with open(worker_file, 'r', encoding='utf-8') as f:
    w_content = f.read()

worker_pattern = r'const res = await runOptimize\(\(prog\) => \{\s+self\.postMessage\(\{'
worker_match = re.search(worker_pattern, w_content)
if worker_match:
    w_replacement = '''let lastSnapshotAt = 0;
    let lastSnapshotTkb = null;
    const SNAPSHOT_INTERVAL_MS = 250;

    const res = await runOptimize((prog) => {
      const now = Date.now();
      if(!lastSnapshotTkb || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || prog.percent >= 100){
        try{
          lastSnapshotTkb = currentEngine ? currentEngine.getSnapshotTKB() : null;
          lastSnapshotAt = now;
        }catch(_){}
      }

      self.postMessage({'''
    w_content = re.sub(worker_pattern, w_replacement, w_content, count=1)
    w_content = w_content.replace('snapshot: currentEngine.getSnapshotTKB()', 'snapshot: (lastSnapshotTkb || (currentEngine ? currentEngine.getSnapshotTKB() : null))')
    
    with open(worker_file, 'w', encoding='utf-8') as f:
        f.write(w_content)
    with open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-worker.js', 'w', encoding='utf-8') as f:
        f.write(w_content)
    print("4. Successfully patched worker with regex!")
else:
    print("4. Worker pattern not matched")

print("All files patched and synchronized successfully!")
