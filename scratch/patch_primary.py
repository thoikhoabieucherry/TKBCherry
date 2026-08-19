import codecs

file_path = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js'

with codecs.open(file_path, 'r', 'utf-8') as f:
    content = f.read()

# Add trySingletonEjectionChain as a primary operator in optimize_singletons
primary_call = """
          // [FET PRIMARY OPERATOR] Ejection Chain ngắm bắn trực tiếp 1 tiết
          const bottleneckTeachersPrimary = Array.from(this.teacherGrid.keys())
            .filter(t => t && this.isScoredTeacher(t))
            .sort((a, b) => {
               const gA = this.teacherGrid.get(a), gB = this.teacherGrid.get(b);
               let cA = 0, cB = 0;
               for(let i=0; i<60; i++){
                 if(gA && gA[i]>=0) cA++;
                 if(gB && gB[i]>=0) cB++;
               }
               return cB - cA;
            });
            
          const resFET = this.trySingletonEjectionChain(bottleneckTeachersPrimary.slice(0, 10), bestMetrics, mode, notifyLiveProgress);
          if(resFET && this.compareMetrics(resFET, bestMetrics, mode) < 0){
            bestMetrics = { ...resFET };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }
"""

if '// [FET PRIMARY OPERATOR]' not in content:
    target_str = '          const oblitM = this.obliterateAllTeacherSingletons('
    replacement = primary_call + '\n          const oblitM = this.obliterateAllTeacherSingletons('
    
    if target_str in content:
        content = content.replace(target_str, replacement)
        with codecs.open(file_path, 'w', 'utf-8') as f:
            f.write(content)
        print("Patched primary operator successfully.")
    else:
        print("Target string not found for primary operator.")
else:
    print("Already patched.")

