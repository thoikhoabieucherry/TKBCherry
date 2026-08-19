import sys, re
sys.stdout.reconfigure(encoding='utf-8')

for p in [r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-worker.js', r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-worker.js']:
    with open(p, 'r', encoding='utf-8') as f:
        text = f.read()

    old_block = """      const res = await runOptimize((prog) => {
        let snapshotTkb = null;
        if (!constructionPhase) {
          try { snapshotTkb = currentEngine.getSnapshotTKB(); } catch(_) {}
        }
        self.postMessage({"""

    new_block = """      let lastSnapshotAt = 0;
      let lastSnapshotTkb = null;
      const SNAPSHOT_INTERVAL_MS = 250;

      const res = await runOptimize((prog) => {
        let snapshotTkb = null;
        if (!constructionPhase) {
          const now = Date.now();
          if (!lastSnapshotTkb || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || prog.percent >= 100) {
            try { 
              lastSnapshotTkb = currentEngine.getSnapshotTKB(); 
              lastSnapshotAt = now;
            } catch(_) {}
          }
          snapshotTkb = lastSnapshotTkb;
        }
        self.postMessage({"""

    if old_block in text:
        text = text.replace(old_block, new_block)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f"Patched throttle in {p}")
    else:
        print(f"Old block not found in {p}")
