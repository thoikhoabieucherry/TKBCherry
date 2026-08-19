const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

async function profileSingleMode(fileLabel, filePath, mode, budgetMs = 15000) {
  console.log(`\n===============================================================`);
  console.log(`PROFILING MODE [${mode}] on ${fileLabel} (budget: ${budgetMs}ms)`);
  console.log(`===============================================================`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const eng = new Engine(data, {
    mode,
    optimizeHardCapMs: budgetMs,
    optimizeRestartBudgetMs: budgetMs,
    optimizeMaxRestarts: 5,
    uiBreathingMs: 0
  });
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
  const initMetrics = eng.evaluateMetrics();
  console.log(`Initial metrics:`, JSON.stringify(initMetrics));
  
  await eng.optimize(mode);
  const totalMs = Date.now() - tStart;
  const finalMetrics = eng.evaluateMetrics();

  console.log(`Completed in ${totalMs}ms (${(totalMs/1000).toFixed(2)}s). Restarts: ${eng.__lastRestartCount || 0}`);
  console.log(`-----------------------------------------------------------------------------------------`);
  console.log(`Operator Name                            | Calls | Total(ms) | Max(ms) | Avg(ms) | Gains `);
  console.log(`-----------------------------------------------------------------------------------------`);
  
  const sorted = Object.entries(stats).filter(x => x[1].count > 0).sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [name, st] of sorted) {
    const avg = st.count ? (st.totalMs / st.count).toFixed(1) : '0.0';
    console.log(
      `${name.padEnd(40)} | ${String(st.count).padStart(5)} | ${String(st.totalMs).padStart(9)} | ${String(st.maxMs).padStart(7)} | ${String(avg).padStart(7)} | ${String(st.improvedCount).padStart(5)}`
    );
  }
  console.log(`-----------------------------------------------------------------------------------------`);
  console.log(`Final metrics:`, JSON.stringify(finalMetrics));
}

async function main() {
  const file = 'c:/Users/Love/Documents/Codex/TKBCherry/scratch/default_school_0317.json';
  await profileSingleMode('DEFAULT SCHOOL', file, 'optimize_singletons', 10000);
  await profileSingleMode('DEFAULT SCHOOL', file, 'optimize_gap2', 10000);
  await profileSingleMode('DEFAULT SCHOOL', file, 'optimize_sessions', 10000);
  await profileSingleMode('DEFAULT SCHOOL', file, 'optimize_gap1', 10000);
}

main().catch(console.error);
