// Bo giai khong phat khoa `unassigned_periods`. Kiem tra rang giao dien van
// tinh dung so tiet chua xep, va cong tac va nhanh KHONG bi chan.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const bridge = fs.readFileSync(path.join(root, "web", "pages", "tkb-rust-bridge.js"), "utf8");

let fail = 0;
function check(name, cond){
  console.log(`  ${cond ? "OK  " : "SAI "} ${name}`);
  if(!cond) fail++;
}
function srcOf(name){
  const start = bridge.indexOf(`function ${name}(`);
  if(start < 0) return "";
  let p = bridge.indexOf("(", start), pd = 0, end = p;
  for(let j = p; j < bridge.length; j++){
    if(bridge[j] === "(") pd++;
    else if(bridge[j] === ")"){ pd--; if(pd === 0){ end = j; break; } }
  }
  let i = bridge.indexOf("{", end), depth = 0;
  for(let j = i; j < bridge.length; j++){
    if(bridge[j] === "{") depth++;
    else if(bridge[j] === "}"){ depth--; if(depth === 0) return bridge.slice(start, j + 1); }
  }
  return "";
}

const metricNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const ensureSrc = srcOf("ensureUnassignedPeriodsMetric");
check("co ham ensureUnassignedPeriodsMetric", ensureSrc.length > 0);
const ensure = new Function("metricNumber", `${ensureSrc}; return ensureUnassignedPeriodsMetric;`)(metricNumber);

// Payload that dung nhu bo giai tra ve tren sid=95671c41791 (khong co
// `unassigned_periods`, chi co solver_unassigned_periods + unassignedLessons).
const realPayload = () => ({
  metrics: {
    expected_periods: 1554,
    scheduled_periods: 1527,
    solver_unassigned_periods: 27,
    capacity_unassigned_periods: 0,
    app_constraint_violation_count: 5
  },
  unassignedLessons: [
    {className: "6/10", subject: "Toán", periods: 4},
    {className: "6/10", subject: "Ngữ văn", periods: 4},
    {className: "6/10", subject: "Khoa học tự nhiên", periods: 4},
    {className: "6/10", subject: "Lịch sử và Địa lý", periods: 3},
    {className: "6/10", subject: "Ngoại ngữ", periods: 3},
    {className: "6/10", subject: "Công nghệ", periods: 1},
    {className: "6/10", subject: "Giáo dục công dân", periods: 1},
    {className: "6/10", subject: "Nội dung giáo dục địa phương", periods: 1},
    {className: "6/10", subject: "Kỹ năng sống", periods: 1},
    {className: "6/10", subject: "Mĩ thuật", periods: 1},
    {className: "6/10", subject: "Âm nhạc", periods: 1},
    {className: "6/10", subject: "Tiếng Anh bản ngữ", periods: 1},
    {className: "6/10", subject: "Hoạt động trải nghiệm hướng nghiệp", periods: 1},
    {className: "6/10", subject: "Tin học", periods: 1}
  ]
});

const p1 = realPayload();
check("truoc khi bu: khoa unassigned_periods that su vang mat",
  p1.metrics.unassigned_periods === undefined);
check("doc thang metrics.unassigned_periods cho ra 0 (chinh la loi cu)",
  metricNumber(p1.metrics.unassigned_periods, 0) === 0);
check("bu tu unassignedLessons -> 27", ensure(p1) === 27);
check("da ghi nguoc vao metrics", p1.metrics.unassigned_periods === 27);

// Khong co unassignedLessons -> lay tu solver_unassigned_periods.
const p2 = realPayload();
delete p2.unassignedLessons;
check("khong co danh sach -> lay solver_unassigned_periods", ensure(p2) === 27);

// Khong co ca hai -> lay expected - scheduled.
const p3 = {metrics: {expected_periods: 1554, scheduled_periods: 1527}};
check("khong co ca hai -> lay expected tru scheduled", ensure(p3) === 27);

// KHONG duoc ghi de gia tri da co.
const p4 = {metrics: {unassigned_periods: 5, solver_unassigned_periods: 99}};
check("khong ghi de gia tri da co", ensure(p4) === 5 && p4.metrics.unassigned_periods === 5);

// Lich day du -> 0.
const p5 = {metrics: {expected_periods: 1554, scheduled_periods: 1554, solver_unassigned_periods: 0}, unassignedLessons: []};
check("lich day du -> 0", ensure(p5) === 0);

// payloadCompletion phai dung ham bu, khong doc thang.
const pcSrc = srcOf("payloadCompletion");
check("payloadCompletion dung ham bu",
  /ensureUnassignedPeriodsMetric\(payload\)/.test(pcSrc));
check("payloadCompletion khong con doc thang metrics.unassigned_periods",
  !/const unassigned = metricNumber\(metrics\.unassigned_periods\)/.test(pcSrc));

// Cong tac va nhanh sau khi ap ket qua khong con bi chan boi khoa vang mat,
// va khong con tran 24.
const gateLine = bridge.split("\n").findIndex(l => l.includes('autoPlaceUnassignedFromUi("after_payload"'));
check("tim thay cho goi va nhanh sau khi ap ket qua", gateLine >= 0);
const gateBlock = bridge.split("\n").slice(Math.max(0, gateLine - 12), gateLine + 3).join("\n");
check("dieu kien va dung so tiet chua xep THUC TE",
  /ensureUnassignedPeriodsMetric\(payload\)/.test(gateBlock) || /payloadUnassignedPeriods\(payload\)/.test(gateBlock));
check("bo tran 24 o cho goi va nhanh", !/autoPlaceUnassignedFromUi\("after_payload", \{maxPlace: 24\}\)/.test(bridge));

console.log(fail === 0 ? "\nTAT CA DAT" : `\n${fail} MUC SAI`);
process.exit(fail === 0 ? 0 : 1);
