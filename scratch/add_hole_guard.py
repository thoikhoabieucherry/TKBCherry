import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# Check student holes in tryFastSingletonRepair
old_check = """                  if(this.isLessonBlockSafe(act1)){
                    const candM = this.evaluateMetrics();
                    const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                          (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                          (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);"""

new_check = """                  if(this.isLessonBlockSafe(act1) && (typeof this.__studentHoleBaseline !== "number" || this.countStudentHoles() <= this.__studentHoleBaseline)){
                    const candM = this.evaluateMetrics();
                    const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                          (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                          (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);"""

content = content.replace(old_check, new_check)

old_check2 = """                              if(this.isLessonBlockSafe(actDonor, actOcc)){
                                const candM = this.evaluateMetrics();
                                const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                      (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                      (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);"""

new_check2 = """                              if(this.isLessonBlockSafe(actDonor, actOcc) && (typeof this.__studentHoleBaseline !== "number" || this.countStudentHoles() <= this.__studentHoleBaseline)){
                                const candM = this.evaluateMetrics();
                                const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                      (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                      (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);"""

content = content.replace(old_check2, new_check2)

old_check3 = """                          if(this.isLessonBlockSafe(actDonor)){
                            const candM = this.evaluateMetrics();
                            const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                  (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                  (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);"""

new_check3 = """                          if(this.isLessonBlockSafe(actDonor) && (typeof this.__studentHoleBaseline !== "number" || this.countStudentHoles() <= this.__studentHoleBaseline)){
                            const candM = this.evaluateMetrics();
                            const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                  (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                  (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);"""

content = content.replace(old_check3, new_check3)

old_check4 = """                      if(this.isLessonBlockSafe(act1, act2)){
                        const candM = this.evaluateMetrics();
                        const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                              (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                              (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);"""

new_check4 = """                      if(this.isLessonBlockSafe(act1, act2) && (typeof this.__studentHoleBaseline !== "number" || this.countStudentHoles() <= this.__studentHoleBaseline)){
                        const candM = this.evaluateMetrics();
                        const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                              (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                              (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);"""

content = content.replace(old_check4, new_check4)

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

print("Updated tryFastSingletonRepair with studentHoleBaseline guard!")
