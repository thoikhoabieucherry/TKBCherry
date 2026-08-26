// Thong bao ket thuc phai NOI RO moi lien he giua "cho vuot Gioi han" va
// "pha toi uu 1 tiet/buoi khong chay", va phai doc duoc het (khong bi cat).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const bridge = fs.readFileSync(path.join(root, "web", "pages", "tkb-rust-bridge.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web", "pages", "sapxep.html"), "utf8");

let fail = 0;
function check(name, cond){
  console.log(`  ${cond ? "OK  " : "SAI "} ${name}`);
  if(!cond) fail++;
}
function bodyOf(src, name){
  const start = src.indexOf(`function ${name}(`);
  if(start < 0) return "";
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

// Nguon viet tieng Viet bang escape \\uXXXX, giai ma truoc khi doi chieu.
const unesc = t => t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const rec = unesc(bodyOf(bridge, "reconcileStatusWithVisibleSchedule"));
const panel = unesc(bodyOf(bridge, "renderLimitConflictPanel"));

check("co ham doi chieu thong bao", rec.length > 0);
check("co bang chi tiet cac cho vuot Gioi han", panel.length > 0);
check("dong trang thai NGAN de khong bi cat", /bấm để xem chi tiết/.test(rec));
check("mo san bang sau moi luot xep", /renderLimitConflictPanel\(issues\)/.test(rec));
check("bang noi ro pha toi uu 1 tiet\/buoi bi chan", /1 tiết\/buổi/.test(panel));
check("bang liet ke DU (khong cat top N)", !/\.slice\(0, ?\d\)/.test(panel));
check("bang tach ro nhom CO DINH va nhom tu doi duoc",
  /TIẾT CỐ ĐỊNH/.test(panel) && /tự dời được/.test(panel));
check("bang chi ro cach sua", /đặt Giới hạn của môn đó thành/.test(panel));
check("bang co du cot Lop, Ngay, Buoi, Mon, Dang xep, Gioi han",
  ["Lớp", "Ngày", "Buổi", "Môn", "Đang xếp", "Giới hạn"].every(h => panel.includes(`>${h}<`)));
check("bang thoat HTML cho du lieu nguoi dung", /escapeHtml\(issue\.className\)/.test(panel));
check("bang co nut dong", /tkbLimitConflictClose/.test(panel));
check("day danh sach ra console de tra cuu", /console\.table/.test(rec));
check("phoi danh sach ra window de tra cuu", /__TKB_LIMIT_CONFLICTS/.test(rec));

const ws = bodyOf(bridge, "writeStatus");
check("luon gan title de ro chuot xem het", /el\.title = statusText/.test(ws));
check("bam vao thanh trang thai thi mo bang", /toggleLimitConflictPanel\(\)/.test(ws));

check("CSS mo rong thanh trang thai", /#statusMsg\.is-expanded/.test(html));
check("CSS mo rong bo nowrap", /is-expanded\s*\{[^}]*white-space:\s*normal/s.test(html));

// Moi lien he duoc khang dinh o day phai DUNG voi code that:
// completion.complete can violations === 0, va pha 1 tiet/buoi can complete.
const pc = bodyOf(bridge, "payloadCompletion");
check("completion.complete that su doi violations === 0",
  /hardComplete = unassigned === 0 && violations === 0/.test(pc));
check("pha toi uu 1 tiet/buoi that su doi completion.complete",
  /!skipRetryLoops && completion\.complete && shouldRetryZeroOneQuality\(/.test(bridge));

console.log(fail === 0 ? "\nTAT CA DAT" : `\n${fail} MUC SAI`);
process.exit(fail === 0 ? 0 : 1);
