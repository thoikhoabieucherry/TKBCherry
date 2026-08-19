import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# 1. Patch Tabu Map
old_tabu = """        this.jrnPlace(actId, slot);

        const oldSlot = act.fixedSlot >= 0 ? act.fixedSlot : this.actPlacement[actId];
        if(oldSlot >= 0){
          this.tabuMap.set(`${actId}|${oldSlot}`, this.currentStep + this.activities.length);
        }"""

new_tabu = """        const oldSlot = this.actPlacement[actId];
        this.jrnPlace(actId, slot);

        if(oldSlot >= 0){
          this.tabuMap.set(`${actId}|${oldSlot}`, this.currentStep + this.activities.length);
        }"""

if old_tabu in content:
    content = content.replace(old_tabu, new_tabu)
    print("1. Successfully patched Tabu map oldSlot!")
else:
    print("1. Tabu map target not found")

# 2. Patch candM in 3-way cycle
old_candm = """                      this.jrnPlace(act1.id, s2);
                      this.jrnPlace(act2.id, s3);
                      this.jrnPlace(act3.id, s1);

                      const isBetter = (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&"""

new_candm = """                      this.jrnPlace(act1.id, s2);
                      this.jrnPlace(act2.id, s3);
                      this.jrnPlace(act3.id, s1);

                      const candM = this.evaluateMetrics();
                      const isBetter = (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&"""

if old_candm in content:
    content = content.replace(old_candm, new_candm)
    print("2. Successfully patched candM in augmenting 3-cycle!")
else:
    print("2. candM target not found")

# 3. Hook tryFastSingletonRepair into optimize()
old_hook = """        // 1. Primary Downhill Optimization Passes
        if(mode === "optimize_singletons"){
          // Nuoc chu luc hoc tu cong cu tham chieu (bo MD 17/08): chay DAU TIEN.
          const relabelM = this.trySingletonRelabelCycles(bestMetrics, initialMetrics, notifyLiveProgress);"""

new_hook = """        // 1. Primary Downhill Optimization Passes
        if(mode === "optimize_singletons"){
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

          // Nuoc chu luc hoc tu cong cu tham chieu (bo MD 17/08): chay DAU TIEN.
          const relabelM = this.trySingletonRelabelCycles(bestMetrics, initialMetrics, notifyLiveProgress);"""

if old_hook in content:
    content = content.replace(old_hook, new_hook)
    print("3. Successfully hooked tryFastSingletonRepair into optimize() loop!")
else:
    print("3. Hook target not found")

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

engine_root = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js'
with codecs.open(engine_root, 'w', 'utf-8') as f:
    f.write(content)

print("Saved both engine files successfully!")

# 4. Check worker throttle
worker_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-worker.js'
with codecs.open(worker_file, 'r', 'utf-8') as f:
    w_content = f.read()

old_w = """    const res = await runOptimize((prog) => {
      self.postMessage({
        type: "progress",
        mode,
        percent: prog.percent,
        currentMetric: prog.currentMetric,
        initialMetric: prog.initialMetric,
        stage: prog.stage || null,
        cycle: prog.cycle,
        metrics: prog.metrics,
        checkpoint: {
          snapshot: currentEngine.getSnapshotTKB(),
          metrics: prog.metrics
        }
      });
    }, data, workerOptions, (eng) => { currentEngine = eng; });"""

new_w = """    let lastSnapshotAt = 0;
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

      self.postMessage({
        type: "progress",
        mode,
        percent: prog.percent,
        currentMetric: prog.currentMetric,
        initialMetric: prog.initialMetric,
        stage: prog.stage || null,
        cycle: prog.cycle,
        metrics: prog.metrics,
        checkpoint: {
          snapshot: (lastSnapshotTkb || (currentEngine ? currentEngine.getSnapshotTKB() : null)),
          metrics: prog.metrics
        }
      });
    }, data, workerOptions, (eng) => { currentEngine = eng; });"""

if old_w in w_content:
    w_content = w_content.replace(old_w, new_w)
    with codecs.open(worker_file, 'w', 'utf-8') as f:
        f.write(w_content)
    worker_root = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-worker.js'
    with codecs.open(worker_root, 'w', 'utf-8') as f:
        f.write(w_content)
    print("4. Successfully patched worker files with snapshot throttling!")
else:
    print("4. Worker target not found or already patched")
