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

function inspectTeacherSlot(teacherName, day, session){
  console.log(`\n--- ALL LESSONS OF TEACHER ${teacherName} ON ${day.toUpperCase()} ${session.toUpperCase()} ---`);
  for(const [cid, cData] of Object.entries(tkb)){
    const cells = (cData[day] && cData[day][session]) || [];
    for(let p = 0; p < cells.length; p++){
      const cell = cells[p];
      if(!cell || cell === "OFF") continue;
      const mon = typeof cell === "object" ? cell.mon : cell;
      const gv = typeof cell === "object" ? (cell.gv || getTeacher(cid, mon)) : getTeacher(cid, mon);
      if(gv.toLowerCase().includes(teacherName.toLowerCase())){
        console.log(`  Class: ${classIdToName[cid] || cid} | Period: ${p+1} | Subject: ${mon}`);
      }
    }
  }
}

// 1. A.Hải on Thu2 Chiều
inspectTeacherSlot("a.hải", "thu2", "chieu");

// 2. T.Phát on Thu2 Chiều & other teachers in 8A13
inspectTeacherSlot("ti.thuận", "thu2", "chieu");
inspectTeacherSlot("cn.bằng", "thu2", "chieu");

// 3. TN.Nữ on Thu4 Chiều & other teachers in 7A16
inspectTeacherSlot("cn.liên", "thu4", "chieu");
inspectTeacherSlot("t.xuân", "thu4", "chieu");

// 4. Ti.Hào on Thu5 Sáng & other teachers in 8A3
inspectTeacherSlot("td.tiền", "thu5", "sang");
inspectTeacherSlot("a.hoa", "thu5", "sang");
