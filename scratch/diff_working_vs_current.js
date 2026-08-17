const fs = require('fs');

const working = fs.readFileSync('scratch/test_complete_pair_first.js', 'utf8');
const current = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Let's see what methods/sections differ between working and current
console.log("Working length:", working.length, "Current length:", current.length);

// Compare getConflictsForSlot
const getConflictsWorking = working.substring(working.indexOf('getConflictsForSlot('), working.indexOf('// PRNG') > 0 ? working.indexOf('// PRNG') : working.indexOf('getPlacementPenalty('));
const getConflictsCurrent = current.substring(current.indexOf('getConflictsForSlot('), current.indexOf('getPlacementPenalty('));

console.log("getConflictsForSlot matches?", getConflictsWorking === getConflictsCurrent);
if(getConflictsWorking !== getConflictsCurrent){
  console.log("getConflictsCurrent:\n", getConflictsCurrent.substring(0, 500));
}
