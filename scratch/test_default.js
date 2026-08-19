const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;
const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/default_school_0317.json', 'utf8'));

console.log("Loading dataset default_school_0317.json");
const eng = new Engine(data, {mode: 'optimize_singletons', optimizeAllBudgetMs: 50000});
eng.init();
console.log("Initial Metrics:", eng.evaluateMetrics());

eng.optimizeAll((metrics) => {
    console.log(`Live metric update: ${JSON.stringify(metrics)}`);
});

const finalMetrics = eng.evaluateMetrics();
console.log("Final Metrics:", finalMetrics);
