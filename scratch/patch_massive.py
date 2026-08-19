import codecs

file_path = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js'

with codecs.open(file_path, 'r', 'utf-8') as f:
    content = f.read()

# 1. Scale limitCalls in tryLnsRuinAndRecreate based on number of unplaced acts
content = content.replace(
    'this.limitCalls = 6000;',
    'this.limitCalls = Math.min(80000, 2000 * unplacedActs.length);'
)

# 2. Increase cluster size in tryRelatedClusterRuin
content = content.replace(
    'const sample = chosen.slice(0, Math.min(3, chosen.length));',
    'const sample = chosen.slice(0, Math.min(15, chosen.length));'
)

# 3. Add tryRelatedClusterRuin (now massive) as a primary operator, right after the FET Ejection Chain
massive_call = """
          // [MASSIVE CLUSTER RUIN] Phá hủy diện rộng 15 giáo viên liên đới để thoát bẫy cục bộ sâu
          const resMassive = this.tryRelatedClusterRuin(bottleneckTeachersPrimary.slice(0, 3), bestMetrics, mode, 0, notifyLiveProgress);
          if(resMassive && this.compareMetrics(resMassive, bestMetrics, mode) < 0){
            bestMetrics = { ...resMassive };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }
"""

if '// [MASSIVE CLUSTER RUIN]' not in content:
    target_str = '          const oblitM = this.obliterateAllTeacherSingletons('
    replacement = massive_call + '\n          const oblitM = this.obliterateAllTeacherSingletons('
    if target_str in content:
        content = content.replace(target_str, replacement)
        print("Massive cluster ruin added to primary operators.")
    else:
        print("Target string for massive cluster ruin not found.")

with codecs.open(file_path, 'w', 'utf-8') as f:
    f.write(content)
print("Patch applied.")
