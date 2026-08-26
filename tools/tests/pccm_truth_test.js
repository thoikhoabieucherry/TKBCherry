// Kiem tra: Phan cong (pccmMatrix) phai la nguon su that, tra truoc
// tkbLessonTeachers; va ham dong bo khong duoc XOA du lieu nguoi dung.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "web", "pages", "phanmon.js"), "utf8");
let fail = 0;
function check(name, cond){
  console.log(`  ${cond ? "OK  " : "SAI "} ${name}`);
  if(!cond) fail++;
}

function bodyOf(name){
  const start = src.indexOf(`function ${name}(`);
  if(start < 0) return "";
  let i = src.indexOf("{", start), depth = 0;
  for(let j = i; j < src.length; j++){
    if(src[j] === "{") depth++;
    else if(src[j] === "}"){ depth--; if(depth === 0) return src.slice(i, j + 1); }
  }
  return "";
}

const lookup = bodyOf("getTeacherForClassMon");
check("tim thay getTeacherForClassMon", lookup.length > 0);
const iPccm = lookup.indexOf("DATA.pccmMatrix?.[k]");
const iLesson = lookup.indexOf("DATA.tkbLessonTeachers?.[k]");
check("doc pccmMatrix", iPccm >= 0);
check("doc tkbLessonTeachers", iLesson >= 0);
check("pccmMatrix duoc tra TRUOC tkbLessonTeachers", iPccm >= 0 && iLesson >= 0 && iPccm < iLesson);

const prune = bodyOf("pruneLessonTeacherConflicts");
check("tim thay pruneLessonTeacherConflicts", prune.length > 0);
check("KHONG xoa du lieu nguoi dung (khong co delete lt[key])", !/delete\s+lt\s*\[/.test(prune));
check("ghi de bang gia tri phan cong", /lt\[key\]\s*=\s*pccmValue/.test(prune));
check("reset cache sau khi sua", /TEACHER_FOR_CLASS_MON_CACHE\s*=/.test(prune));

check("duoc goi tu sanitizePlannerDataFromIndex",
  /pruneLessonTeacherConflicts\(\)\s*>\s*0/.test(bodyOf("sanitizePlannerDataFromIndex")));

// Bo giai (tkb-fet-engine) cung phai uu tien pccmMatrix -> hai ben khop nhau.
const eng = fs.readFileSync(path.join(__dirname, "..", "..", "web", "pages", "tkb-fet-engine.js"), "utf8");
const line = (eng.split("\n").find(l => l.includes("data.pccmMatrix?.[key1]") && l.includes("tkbLessonTeachers")) || "");
check("bo giai cung uu tien pccmMatrix",
  line.indexOf("pccmMatrix") >= 0 && line.indexOf("pccmMatrix") < line.indexOf("tkbLessonTeachers"));

console.log(fail === 0 ? "\nTAT CA DAT" : `\n${fail} MUC SAI`);
process.exit(fail === 0 ? 0 : 1);
