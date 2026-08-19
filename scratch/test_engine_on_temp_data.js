const fs = require('fs');

const rawData = JSON.parse(fs.readFileSync('./temp_data.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

// Convert temp_data to schoolData format
// Needs: lop, giaovien, monhoc, pccmMatrix, tkb, tkbConstraints
const lop = rawData.classes.map((c, i) => ({ id: `L${String(i+1).padStart(3, '0')}`, name: c, ten: c }));
const giaovien = rawData.teachers.map((t, i) => ({ id: `GV${String(i+1).padStart(3, '0')}`, name: t, ten: t, code: t }));

const lopMap = new Map();
lop.forEach(l => lopMap.set(l.name, l));
const gvMap = new Map();
giaovien.forEach(g => gvMap.set(g.name, g));

// Map tkb
// In tkb: tkb[lopId][slot] = { gv, mon, ... }
const tkb = {};
lop.forEach(l => {
  tkb[l.id] = Array(60).fill(null);
});

// PCCM Matrix: pccmMatrix[lopId][mon] = gvId
const pccmMatrix = {};
const pccmTietMatrix = {};
lop.forEach(l => {
  pccmMatrix[l.id] = {};
  pccmTietMatrix[l.id] = {};
});

const subjectsSet = new Set();

for(let s = 0; s < 60; s++){
  for(const [cname, sched] of Object.entries(rawData.class_grid)){
    const item = sched[s];
    if(item){
      const l = lopMap.get(cname);
      const gv = gvMap.get(item[0]);
      const mon = item[1];
      subjectsSet.add(mon);
      
      tkb[l.id][s] = {
        gv: gv ? gv.name : item[0],
        mon: mon,
        gvId: gv ? gv.id : item[0]
      };
      
      if(l && gv){
        pccmMatrix[l.id][mon] = gv.id;
        pccmTietMatrix[l.id][mon] = (pccmTietMatrix[l.id][mon] || 0) + 1;
      }
    }
  }
}

const monhoc = Array.from(subjectsSet).map((m, i) => ({ id: `M${String(i+1).padStart(3, '0')}`, name: m, ten: m }));

// Fixed slots / off periods from class_off_slots
// tkbConstraints: coDinhTietLop
const coDinhTietLop = {};
for(const [cname, offList] of Object.entries(rawData.class_off_slots)){
  const l = lopMap.get(cname);
  if(l){
    coDinhTietLop[l.id] = offList;
  }
}

const schoolData = {
  lop,
  giaovien,
  monhoc,
  pccmMatrix,
  pccmTietMatrix,
  tkb,
  tkbConstraints: {
    coDinhTietLop
  }
};

console.log("Constructed schoolData for temp files: Classes:", lop.length, "Teachers:", giaovien.length);

async function runTest(){
  const solver = new FetTimetableEngine(schoolData);
  solver.loadExistingSchedule();
  const initM = solver.evaluateMetrics();
  console.log("Initial Metrics on temp files:", initM);

  const res = await solver.optimize("optimize_singletons", (p) => {
    console.log(`Progress: ${p.percent}% - Current singletons: ${p.currentMetric}`);
  });

  console.log("\nResult Metrics:", res.metrics);
  console.log("Residual Singletons:", res.residualSingletons);
}

runTest();
