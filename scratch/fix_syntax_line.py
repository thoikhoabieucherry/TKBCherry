import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

bad_str = """      if(!isTargetAchieved && canRestart && globalVal > restartTargetVal && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){ && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){"""

good_str = """      if(!isTargetAchieved && canRestart && globalVal > restartTargetVal && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){"""

content = content.replace(bad_str, good_str)

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

print("Fixed syntax error at line 8067!")
