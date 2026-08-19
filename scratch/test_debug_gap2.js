const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;
const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/default_school_0317.json', 'utf8'));

const eng = new Engine(data, {mode: 'optimize_gap2', optimizeAllBudgetMs: 50000});
eng.init();

const methods = [
    'tryIntraClassSingleDoubleBlockSwap', 'tryRelaxAndRepairGapGaps', 'tryCrushExtremeSpanGaps',
    'tryMergeSameTeacherSplitPeriodsInSession', 'tryBorrowLessonFromRichSessions', 'tryInterDayRelocateGapLesson',
    'tryBlockShiftAndGapResolution', 'tryIntraSessionCrossClassChain', 'tryDissolveGapSession',
    'tryGapRelabelCycles', 'tryCrushTeacherGaps', 'tryFillTeacherGapFromElsewhere',
    'tryMoveDoubleBlockIntoGap'
];

methods.forEach(m => {
    const orig = eng[m];
    if(orig) {
        eng[m] = function(...args) {
            console.log(`[DEBUG] Calling ${m}`);
            const t0 = Date.now();
            const res = orig.apply(this, args);
            const dur = Date.now() - t0;
            if(dur > 1000) console.log(`[DEBUG] ${m} took ${dur}ms`);
            return res;
        };
    }
});

console.log("Starting optimization...");
eng.optimizeAll((metrics) => {
    console.log(`Live metric update: ${metrics.currentMetric}`);
});
console.log("Finished.");
