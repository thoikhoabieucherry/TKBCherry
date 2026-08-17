const fs = require('fs');
const path = require('path');

// Load FetTimetableEngine from tkb-fet-engine.js
const engineCode = fs.readFileSync(path.join(__dirname, 'tkb-fet-engine.js'), 'utf8');
eval(engineCode); // FetTimetableEngine is now in global scope

// Helper to convert XLSX into DATA object for FetTimetableEngine
// We can use Python to export DATA JSON first or write a small script
console.log("FetTimetableEngine loaded:", typeof FetTimetableEngine);
