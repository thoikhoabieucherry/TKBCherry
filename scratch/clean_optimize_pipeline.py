import sys, codecs, re
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# 1. Clean up round loop break conditions (don't send percent 100 inside round loop)
old_breaks = """        if(mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= 1){
          if(progressCallback){
            progressCallback({
              percent: 100,
              currentMetric: bestMetrics.soBuoiDay1,
              initialMetric: Math.max(1, getMetricVal(initialMetrics)),
              metrics: bestMetrics
            });
          }
          break;
        }

        if(getMetricVal(bestMetrics) === 0){
          if(progressCallback){
            progressCallback({
              percent: 100,
              currentMetric: getMetricVal(bestMetrics),
              initialMetric: Math.max(1, getMetricVal(initialMetrics)),
              metrics: bestMetrics
            });
          }
          break;
        }"""

new_breaks = """        if((mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= 1) || getMetricVal(bestMetrics) === 0){
          portfolioDone = true;
          break;
        }"""

if old_breaks in content:
    content = content.replace(old_breaks, new_breaks)
    print("1. Replaced spurious percent:100 inside round loop!")
else:
    print("1. Old breaks not matched directly, trying regex...")
    pattern = r'if\(mode === "optimize_singletons" && bestMetrics\.soBuoiDay1 <= 1\)\{.*?break;\s+\}\s+if\(getMetricVal\(bestMetrics\) === 0\)\{.*?break;\s+\}'
    content = re.sub(pattern, new_breaks, content, flags=re.DOTALL)
    print("1. Patched with regex!")

# 2. Fix restart condition so complete modes terminate immediately
old_restart_block = """      // Quyết định restart: global best còn chỉ tiêu > 0, còn ngân sách thời
      // gian, chưa bị Dừng. Lượt LẺ đi lại TỪ GỐC với pha RNG mới (đa dạng hóa
      // — mỗi pha mở được các ca kẹt khác nhau), lượt CHẴN đi tiếp từ global
      // best (thâm canh). Kết quả cuối luôn là global best qua mọi lượt.
      const globalVal = this.__globalBestM ? getMetricVal(this.__globalBestM) : getMetricVal(bestMetrics);
      if(canRestart && globalVal > restartTargetVal && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){"""

new_restart_block = """      // Quyết định restart: kết thúc tức thì khi đã đạt mục tiêu hoặc hội tụ
      const globalVal = this.__globalBestM ? getMetricVal(this.__globalBestM) : getMetricVal(bestMetrics);
      const isTargetAchieved = (mode === "optimize_singletons" && globalVal <= 1) || (globalVal === 0);

      if(!isTargetAchieved && canRestart && globalVal > restartTargetVal && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){"""

if old_restart_block in content:
    content = content.replace(old_restart_block, new_restart_block)
    print("2. Successfully patched clean restart condition!")
else:
    print("2. Old restart block not matched directly, trying regex...")
    pattern2 = r'// Quyết định restart:.*?const globalVal = this\.__globalBestM \? getMetricVal\(this\.__globalBestM\) : getMetricVal\(bestMetrics\);\s+if\(canRestart && globalVal > restartTargetVal'
    content = re.sub(pattern2, new_restart_block, content, flags=re.DOTALL)
    print("2. Patched with regex!")

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

# Update cache buster in sapxep.html
sapxep_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html'
with codecs.open(sapxep_file, 'r', 'utf-8') as f:
    s_content = f.read()

s_content = re.sub(r'tkb-fet-engine\.js\?v=[^\"]+', 'tkb-fet-engine.js?v=20260818-smooth-clean-v7', s_content)
with codecs.open(sapxep_file, 'w', 'utf-8') as f:
    f.write(s_content)

print("Updated sapxep.html to v=20260818-smooth-clean-v7!")
