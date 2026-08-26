/**
 * Quet cac bien duoc GAN nhung khong duoc KHAI BAO trong ma nguon web.
 *
 * Ly do co bai test nay: `capacityShortageRun` duoc gan o 4 cho trong
 * tkb-rust-bridge.js nhung khong he co `let/const/var`. Doc no truoc lan gan
 * dau tien nem ReferenceError, va vi no nam trong mot chuoi `||` nen chi no ra
 * khi may chu tra ve lich CHUA DU TIET — luc do ket qua bi vut bo im lang,
 * nguoi dung thay "bam Flash/Cherry ma khong co gi xay ra".
 *
 *   node tools/tests/js_undeclared_scan.js
 */
const fs = require("fs");
const path = require("path");

const FILES = [
  "web/pages/tkb-rust-bridge.js",
  "web/pages/phanmon.js",
  "web/pages/tkb-fet-engine.js",
  "web/pages/tkb-fet-worker.js"
];

// Bien toan cuc hop le hoac ket qua duong tinh gia da xac minh bang tay.
const ALLOWED = new Set([
  "window", "document", "self", "globalThis", "module", "exports",
  "console", "location", "navigator", "performance",
  "currentEngine",   // khai bao bang `let currentEngine = null` o dau worker
  "mtR", "mtL",      // khai bao chung dong: `let mtG = null, mtR = -1, mtL = -1;`
  "draggable"        // thuoc tinh HTML trong chuoi template, khong phai bien
]);

const root = path.resolve(__dirname, "..", "..");
let failures = 0;

for(const rel of FILES){
  const file = path.join(root, rel);
  if(!fs.existsSync(file)){
    console.log("  BO QUA " + rel + " (khong thay file)");
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  const assigned = new Set();
  const assignRe = /^\s*([A-Za-z_$][\w$]*)\s*=\s*[^=]/gm;
  let m;
  while((m = assignRe.exec(src))) assigned.add(m[1]);

  const declared = new Set();
  const declRes = [
    /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g
  ];
  for(const re of declRes){
    let x;
    while((x = re.exec(src))) declared.add(x[1]);
  }

  const suspects = [...assigned].filter(n => !declared.has(n) && !ALLOWED.has(n));
  if(suspects.length){
    failures += suspects.length;
    console.log("  FAIL " + rel + " -> gan nhung khong khai bao: " + suspects.join(", "));
  }else{
    console.log("  OK   " + rel);
  }
}

console.log(failures === 0 ? "\nTAT CA DAT" : `\n${failures} BIEN CHUA KHAI BAO`);
process.exit(failures === 0 ? 0 : 1);
