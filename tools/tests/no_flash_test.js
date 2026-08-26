// Nut Flash da duoc go bo khoi du an. Test nay giu cho no khong quay lai.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");

let fail = 0;
function check(name, cond){
  console.log(`  ${cond ? "OK  " : "SAI "} ${name}`);
  if(!cond) fail++;
}

const files = {
  "web/pages/sapxep.html": null,
  "web/pages/phanmon.js": null,
  "web/pages/tkb-rust-bridge.js": null,
  "solver_runtime/scripts/solve_stdio.py": null
};
for(const f of Object.keys(files)) files[f] = fs.readFileSync(path.join(root, f), "utf8");

// Cac dinh danh RIENG cua tinh nang Flash — khong duoc con o bat cu dau.
const banned = [
  "btnEngineFlash",
  "runFlashScheduler",
  "ui_flash_scheduler_active",
  "__TKB_FLASH_SOLVING",
  "__TKB_FLASH_REPAIR_V3",
  "flash_repair_with_engine_v3",
  "flash_unified_cpsat",
  "flash_fallback_legacy",
  "flash_fallback_reason",
  "flash_stage",
  "cpsat_modes",
  "solve_unified_cpsat",
  "UnifiedCpSatSolver",
  "tkbRunEngine('flash'",
  'tkbRunEngine("flash"'
];
for(const token of banned){
  const hits = Object.entries(files).filter(([, src]) => src.includes(token)).map(([f]) => f);
  check(`khong con "${token}"`, hits.length === 0);
}

// Hai file Python cua Flash phai bi xoa han.
for(const rel of [
  "solver_runtime/src/tkb_engine_v3/cpsat_modes.py",
  "solver_runtime/src/tkb_optimizer_ref/unified_cpsat_solver.py"
]){
  check(`da xoa ${rel}`, !fs.existsSync(path.join(root, rel)));
}

// Nhung thu PHAI con nguyen.
check("nut Cherry van con", files["web/pages/sapxep.html"].includes('id="btnEngineCherry"'));
check("dinh tuyen Cherry van con", files["solver_runtime/scripts/solve_stdio.py"].includes("cherry_engine_v3"));
check("pipeline mac dinh van con", files["solver_runtime/scripts/solve_stdio.py"].includes("solve_from_ui_data(ui_data, settings"));
// External CP-SAT la he thong KHAC, khong duoc go nham theo.
check("giao thuc External CP-SAT khong bi go nham",
  files["solver_runtime/scripts/solve_stdio.py"].includes("ExternalCpSatPending"));
// Hieu ung nhap nhay o cua bang la thu khac, khong duoc go nham.
check("hieu ung flashInvalid o bang xep khong bi go nham",
  files["web/pages/phanmon.js"].includes("function flashInvalid("));

console.log(fail === 0 ? "\nTAT CA DAT" : `\n${fail} MUC SAI`);
process.exit(fail === 0 ? 0 : 1);
