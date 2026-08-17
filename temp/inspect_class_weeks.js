const fs = require('fs');

const data = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default_gap7.json", 'utf8'));
const tkb = data.tkb;
const pccm = data.pccmMatrix || {};
const lopList = data.lop || [];

const classIdToName = {};
const classNameToId = {};
for(const l of lopList){
  const cid = (l.id || "").toString().trim();
  const ten = (l.ten || "").toString().trim();
  if(cid && ten){
    classIdToName[cid] = ten;
    classNameToId[ten] = cid;
  }
}

function getTeacher(cid, mon){
  const ten = classIdToName[cid] || cid;
  return pccm[`${ten}|${mon}`] || pccm[`${cid}|${mon}`] || "";
}

function inspectClassWeek(className){
  const cid = classNameToId[className] || className;
  const cData = tkb[cid];
  if(!cData){
    console.log(`Class ${className} not found in tkb`);
    return;
  }
  console.log(`\n================ WEEK SCHEDULE OF CLASS ${className} (${cid}) ================`);
  const days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  for(const d of days){
    for(const s of ["sang", "chieu"]){
      const cells = (cData[d] && cData[d][s]) || [];
      if(cells.length > 0 && cells.some(c => c && c !== "OFF")){
        const row = cells.map((c, idx) => {
          if(!c || c === "OFF") return `[P${idx+1}: OFF]`;
          const mon = typeof c === "object" ? c.mon : c;
          const gv = typeof c === "object" ? (c.gv || getTeacher(cid, mon)) : getTeacher(cid, mon);
          const fix = (typeof c === "object" && c.fixed) ? "*" : "";
          return `[P${idx+1}: ${mon}${fix} (${gv})]`;
        });
        console.log(`  ${d.toUpperCase()} ${s}: ${row.join(" ")}`);
      }
    }
  }
}

inspectClassWeek("7A5");
inspectClassWeek("8A13");
inspectClassWeek("7A16");
inspectClassWeek("8A3");
