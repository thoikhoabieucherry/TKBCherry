const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

async function profileOperators(fileLabel, filePath) {
  console.log(`\n===============================================================`);
  console.log(`DETAILED OPERATOR PROFILING: ${fileLabel}`);
  console.log(`===============================================================`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const eng = new Engine(data, { mode: 'all', uiBreathingMs: 0 });
  eng.init();

  const stats = {};
  const methods = [
    'tryFastSingletonRepair',
    'trySingletonRelabelCycles',
    'fixDaySingletons',
    'obliterateAllTeacherSingletons',
    'tryIntraClassCrossSubjectSingletonSwap',
    'tryAugmentingSingletonEjectionChain',
    'tryTargetedDeepSingletonChain',
    'tryReinforceTeacherSingletons',
    'tryConsolidateTeacherSingletons',
    'tryVacateTeacherSessions',
    'tryVacateTeacherSession',
    'obliterateAllThinTeacherSessions',
    'tryIntraClassSingleDoubleBlockSwap',
    'tryRelaxAndRepairGapGaps',
    'tryCrushExtremeSpanGaps',
    'tryMergeSameTeacherSplitPeriodsInSession',
    'tryBorrowLessonFromRichSessions',
    'tryInterDayRelocateGapLesson',
    'tryBlockShiftAndGapResolution',
    'tryIntraSessionCrossClassChain',
    'tryDissolveGapSession',
    'tryGapRelabelCycles',
    'tryCrushTeacherGaps',
    'tryFillTeacherGapFromElsewhere',
    'tryMoveDoubleBlockIntoGap'
  ];

  methods.forEach(m => {
    const orig = eng[m];
    if (typeof orig === 'function') {
      stats[m] = { count: 0, totalMs: 0, maxMs: 0, improvedCount: 0 };
      eng[m] = function(...args) {
        const t0 = Date.now();
        const res = orig.apply(this, args);
        const dur = Date.now() - t0;
        stats[m].count++;
        stats[m].totalMs += dur;
        if (dur > stats[m].maxMs) stats[m].maxMs = dur;
        if (res) stats[m].improvedCount++;
        return res;
      };
    }
  });

  const tStart = Date.now();
  await eng.optimizeAll();
  const totalMs = Date.now() - tStart;

  console.log(`\nResults across ${totalMs}ms total execution:`);
  console.log(`-----------------------------------------------------------------------------------------`);
  console.log(`Operator Name                            | Calls | Total(ms) | Max(ms) | Avg(ms) | Gains `);
  console.log(`-----------------------------------------------------------------------------------------`);
  
  const sorted = Object.entries(stats).sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [name, st] of sorted) {
    const avg = st.count ? (st.totalMs / st.count).toFixed(1) : '0.0';
    console.log(
      `${name.padEnd(40)} | ${String(st.count).padStart(5)} | ${String(st.totalMs).padStart(9)} | ${String(st.maxMs).padStart(7)} | ${String(avg).padStart(7)} | ${String(st.improvedCount).padStart(5)}`
    );
  }
  console.log(`-----------------------------------------------------------------------------------------`);
  console.log(`Final metrics:`, JSON.stringify(eng.evaluateMetrics()));
}

async function main() {
  await profileOperators('DEFAULT SCHOOL', 'c:/Users/Love/Documents/Codex/TKBCherry/scratch/default_school_0317.json');
  await profileOperators('SCHOOL 95671c41791', 'c:/Users/Love/Documents/Codex/TKBCherry/scratch/school_95671c41791.json');
}

main().catch(console.error);
