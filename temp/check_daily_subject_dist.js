const fs = require('fs');

const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));
const tkb = dataJson.tkb || {};
const pccmTiet = dataJson.pccmTietMatrix || {};
const lopList = dataJson.lop || [];

console.log("=== CHECKING SUBJECT MAX PERIODS PER DAY IN SCHOOL_DEFAULT ===");

const classIdToName = {};
for(const l of lopList){
  const cid = (l.id || "").toString().trim();
  const ten = (l.ten || "").toString().trim();
  if(cid && ten) classIdToName[cid] = ten;
}

// Check current maximum periods per day for each subject in each class
const days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const sessions = ["sang", "chieu"];

const classSubjectMaxDay = {};

for(const [cid, cData] of Object.entries(tkb)){
  classSubjectMaxDay[cid] = {};
  for(let d = 0; d < days.length; d++){
    const dayName = days[d];
    const subCount = {};
    for(const s of sessions){
      const cells = (cData[dayName] && cData[dayName][s]) || [];
      for(const c of cells){
        if(!c || c === "OFF") continue;
        const mon = typeof c === "object" ? c.mon : c;
        if(!subCount[mon]) subCount[mon] = 0;
        subCount[mon]++;
      }
    }
    for(const [mon, cnt] of Object.entries(subCount)){
      if(!classSubjectMaxDay[cid][mon] || cnt > classSubjectMaxDay[cid][mon]){
        classSubjectMaxDay[cid][mon] = cnt;
      }
    }
  }
}

console.log("Sample class 6A1 max periods per day for subjects:");
const firstCid = Object.keys(classSubjectMaxDay)[0];
console.log(classIdToName[firstCid] || firstCid, ":", classSubjectMaxDay[firstCid]);
