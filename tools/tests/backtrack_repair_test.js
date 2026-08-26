// Kiem tra pha nhanh: khong duoc bo qua vi "thieu qua nhieu", va phai co
// luot xep lui (backtracking) khi tham lam that bai.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const phanmon = fs.readFileSync(path.join(root, "web", "pages", "phanmon.js"), "utf8");
const bridge = fs.readFileSync(path.join(root, "web", "pages", "tkb-rust-bridge.js"), "utf8");

let fail = 0;
function check(name, cond){
  console.log(`  ${cond ? "OK  " : "SAI "} ${name}`);
  if(!cond) fail++;
}
function bodyOf(src, name){
  const start = src.indexOf(`function ${name}(`);
  if(start < 0) return "";
  // Bo qua phan tham so (co the chua `options={}`) truoc khi tim than ham.
  let p = src.indexOf("(", start), pd = 0, end = p;
  for(let j = p; j < src.length; j++){
    if(src[j] === "(") pd++;
    else if(src[j] === ")"){ pd--; if(pd === 0){ end = j; break; } }
  }
  let i = src.indexOf("{", end), depth = 0;
  for(let j = i; j < src.length; j++){
    if(src[j] === "{") depth++;
    else if(src[j] === "}"){ depth--; if(depth === 0) return src.slice(i, j + 1); }
  }
  return "";
}

const bt = bodyOf(phanmon, "tkbBacktrackPlaceClass");
check("co ham tkbBacktrackPlaceClass", bt.length > 0);
check("dung validateDrop qua tkbAutoRepairValidateAtSlot", /tkbAutoRepairValidateAtSlot/.test(bt));
check("bo qua o NGHI va tiet CO DINH", /=== "OFF"/.test(bt) && /isFixed\(/.test(bt));
check("co ngan sach thoi gian", /budgetMs/.test(bt));
check("hoan tac khi vo nghiem (khong de lai nua voi)", /while\(done\.length\)/.test(bt));
check("sap thu tu MRV (it lua chon truoc)", /base\[a\]\.length - base\[b\]\.length/.test(bt));

const auto = bodyOf(phanmon, "tkbAutoPlaceUnassignedLessons");
check("tham lam that bai thi goi xep lui", /tkbBacktrackPlaceClass\(/.test(auto));
const capMatch = auto.match(/options\.maxPlace \?\? (\d+)/);
check("tran maxPlace > 27 (du cho mot lop thieu 27 tiet)", !!capMatch && Number(capMatch[1]) > 27);

const gate = bodyOf(bridge, "shouldAutoPlaceUnassignedFromUi");
check("co ham shouldAutoPlaceUnassignedFromUi", gate.length > 0);
const gateCode = gate.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
check("KHONG con chan theo nguong 'gan day' (unassigned <= maxMissing)",
  !/unassigned\s*<=\s*maxMissing/.test(gateCode));

const ej = bodyOf(phanmon, "tkbCrossClassEjectionPlace");
check("co go nut cheo lop", ej.length > 0);
check("cheo lop: co nhat ky hoan tac", /journal/.test(ej) && /rollback/.test(ej));
check("cheo lop: van qua validateDrop", /tkbAutoRepairValidateAtSlot/.test(ej));
check("tham lam + xep lui van con sot thi go cheo lop",
  /tkbCrossClassEjectionPlace\(/.test(auto));
check("cheo lop: co giai doan hoan doi trong chinh lop roi moi dat",
  /swap_then_place/.test(ej));
const fb = bodyOf(phanmon, "tkbFreeBlockingLesson");
check("khong bao gio dong vao tiet CO DINH hay o NGHI cua lop bi don",
  /val === "OFF" \|\| isFixed\(val\)/.test(fb));

const rec = bodyOf(bridge, "reconcileStatusWithVisibleSchedule");
check("co doi chieu thong bao voi lich dang hien thi", rec.length > 0);
check("chi bao xong khi lich that su du", /ui\.unassigned > 0 \|\| ui\.scheduled < ui\.expected/.test(rec));

console.log(fail === 0 ? "\nTAT CA DAT" : `\n${fail} MUC SAI`);
process.exit(fail === 0 ? 0 : 1);
