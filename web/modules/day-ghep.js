/* ============================================================
   DẠY GHÉP (PCGD ghép) — tách khỏi app.js để dễ bảo trì (28/08/2026).

   Một dòng dạy ghép = một hay nhiều LỚP, một hay nhiều MÔN (chỉ để gợi tên) và
   một hay nhiều GIÁO VIÊN cùng dạy trong cùng một tiết:
     - 1 lớp, 1 môn, nhiều GV     : AV-GT (AV.KCương + Gems1 cùng dạy lớp 6A1)
     - nhiều lớp, 1 môn           : CLB-TT (các lớp 6.1, 6.2 học CHUNG một tiết:
                                    chào cờ, câu lạc bộ, hoạt động khối…)
     - 1 lớp, nhiều môn, nhiều GV : TIN/CN (lớp chia nhóm, hai thầy cô cùng giờ)

   29/08/2026 (chỉ đạo chủ dự án): Dạy ghép là DỮ LIỆU RIÊNG, không liên quan
   tới phân công chính của môn thật, không cộng vào "Tổng tiết" ở Phân công.
   Mỗi dòng là một "môn ghép" riêng với hai thứ tách bạch:
     - NHÃN `viettat`: tên hiện trên TKB / xuất file, người dùng đặt TÙY Ý (được
       trùng tên môn học, trùng nhau giữa các dòng); hộp thoại gợi ý "Mã môn + Lớp".
     - KHOÁ `ten` (bản sắc, app tự sinh — dayGhepResolveIdentity): chuỗi lưu trong ô
       TKB và đứng sau "Lớp|" trong bảng phân công
           pccmMatrix["6A1|AV-GT"] = "AV.KCuong, Gems1"
       (mỗi lớp của dòng một khoá; pccmTietMatrix / pccmGioihanMatrix cùng khoá).
       Khoá = nhãn khi không đụng gì (29/08 chiều: " - " trong nhãn được thu thành
       "-" vì planner/▶ FET/xuất file vẫn đọc chuỗi "Môn - GV" dạng cũ — nhãn
       "AI - 1" mà làm khoá thì bảng GV lấy "1" làm giáo viên, TKB GV trống);
       chỉ khi nhãn trùng bí danh môn học, trùng
       "gốc" môn thật theo cách ▶ FET rút gọn (bỏ dấu, bỏ số cuối: "HĐTN 1" ≡ HĐTN),
       trùng dòng khác cùng lớp hay trùng khoá phân công chính đang có thì thêm
       hậu tố " (ghép)", " (ghép 2)"… Mọi chỗ hiển thị tra khoá -> nhãn (tkbMonLabel,
       getMonShort, subjectDisplayName), nên người dùng chỉ thấy nhãn.
     - KHÔNG đụng khoá của môn thật ("6A1|AVGT" vẫn là phân công chính, tiết
       chuẩn của môn thật không bị trừ); planner / bộ giải / thống kê / xuất file
       coi khoá đó là một môn thường (bộ giải nào cũng nhận tên không có trong
       danh mục, đã kiểm chứng 29/08), luật môn đặt riêng ở trang Yêu cầu.
   Trước 29/08 dòng MỘT môn được chiếu dưới khoá môn thật và THAY phân công chính
   của môn đó; syncDayGhepIntegrity di trú các dòng cũ (còn trường `hienthi`):
   lấy tên tự động làm viết tắt, đổi tên ô TKB, trả khoá môn thật về trống.
   DATA.dayGhepProjected ghi các khoá đã chiếu để dọn khi xóa/đổi.

   Nhiều lớp trong một dòng = MỘT TIẾT HỌC CHUNG (chủ dự án 29/08 chiều: "ghép thì
   đương nhiên sẽ trùng rồi vì các lớp này sẽ học ở hội trường"): các lớp học cùng
   lúc, mọi GV của dòng cùng dạy. Mỗi lớp thấy tiết đó trong TKB (đếm 1 tiết/lớp),
   mỗi GV thấy MỘT ô gộp các lớp (đếm 1 tiết); cùng GV ở các lớp của dòng tại cùng
   giờ KHÔNG phải trùng lịch. Planner đồng bộ ô giữa các lớp và ghim tạm trước
   khi giải — xem khối "TIẾT HỌC CHUNG NHIỀU LỚP" trong pages/phanmon.js.

   Bản ghi: { id, lop:[tên lớp...], mon:[khoá môn như PCCM...], gv:[mã GV...],
              sotiet, gioihan, viettat (nhãn), ten (khoá/bản sắc, planner dùng) }

   31/08 (chủ dự án: "khi tôi phân dạy ghép thì cũng sẽ sử dụng môn học nên sẽ sử dụng yêu cầu
   môn học chứ không phải tạo ra một mớ môn học theo tên viết tắt"): khoá `ten` chỉ là BÍ DANH
   của môn gốc `mon[0]` khi TRA LUẬT — bảng luật/bộ kiểm tra (tkb-constraints.js
   ghepRuleSubjectMap), ▶ FET (ensureMonAliasIndex), Cherry/Tối ưu v3 (adapter.py
   _build_ghep_rule_aliases → rules.py rule_subject), lane Rust (native_solver.rs
   ghep_rule_subject_alias). Bộ chọn môn ở Yêu cầu không liệt kê khoá ghép; luật của môn gốc
   áp cho ô ghép và ô ghép được đếm cùng môn gốc. Bản sắc phân công / GV / số tiết / nhãn giữ.

   02/09 — DÒNG KHÔNG GIÁO VIÊN (`gv: []`, chủ dự án: "tiết dạy ghép đặc biệt, có môn học,
   ghép nhiều lớp nhưng không có giáo viên"): tiết chiếm ô của (các) lớp, máy tự xếp
   (tránh trùng ô lớp / ô nghỉ / luật môn gốc) nhưng KHÔNG chiếm giáo viên nào — không tính
   trùng giờ, tải, buổi dạy của ai. Chiếu vào phân công CHỈ pccmTietMatrix + pccmGioihanMatrix
   (không có khoá pccmMatrix — app.js dọn khoá GV rỗng; planner/bộ giải nhận môn của lớp từ
   bảng Tiết). Mỗi lane tự nhận khoá không GV từ DATA.dayGhep: planner (tkbGhepNoTeacherKey),
   bridge (expectedLessonCount), ▶ FET (buildActivities), adapter.py (build_school_data_from_ui
   → Assignment.teacher = ""), Rust (parse_assignments). Xem dayGhepHasNoTeacher / dayGhepNoTeacherKeySet.
============================================================ */

let DG_SELECTED = new Set();   // index các dòng đang chọn trong bảng
let DG_LAST_INDEX = -1;        // dòng bấm gần nhất (Shift+click chọn dải)
let DG_EDIT_INDEX = -1;        // -1 = thêm mới
let DG_SEL = { lop: [], mon: [], gv: [] };   // lựa chọn trong hộp thoại

/* ---------------- Dữ liệu ---------------- */
function dayGhepList(){
    if (!DATA || typeof DATA !== "object") return [];
    if (!Array.isArray(DATA.dayGhep)) DATA.dayGhep = [];
    return DATA.dayGhep;
}

function dayGhepNewId(){
    let max = 0;
    dayGhepList().forEach(e=>{
        const m = String(e?.id || "").match(/(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return "DG" + String(max + 1).padStart(3, "0");
}

function dgUniqueTexts(raw){
    const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;]+/);
    const out = [];
    const seen = new Set();
    parts.forEach(v=>{
        const s = _normText(v);
        const k = s.toLowerCase();
        if (!s || seen.has(k)) return;
        seen.add(k);
        out.push(s);
    });
    return out;
}

// Danh sách lớp của dòng (dữ liệu cũ có thể lưu chuỗi một lớp).
function dayGhepClasses(entry){
    return dgUniqueTexts(entry?.lop);
}

function dayGhepClassLabel(entry){
    return dayGhepClasses(entry).join(", ");
}

function dayGhepMonObj(monKey){
    const k = _normText(monKey).toLowerCase();
    if (!k) return null;
    const list = buildPCCMMonList();
    return list.find(m => _normText(m.key).toLowerCase() === k)
        || list.find(m => [m.ten, m.ma, m.ma2].some(v => v && _normText(v).toLowerCase() === k))
        || null;
}

// Danh sách khoá môn của dòng (dữ liệu cũ có thể lưu chuỗi).
function dayGhepSubjects(entry){
    return dgUniqueTexts(entry?.mon);
}

function dayGhepSubjectCode(monKey){
    const m = dayGhepMonObj(monKey);
    return (m ? pccmSubjectCode(m) : "") || _normText(monKey);
}

// Mã các môn của dòng nối bằng "/" (vd "AVGT", "TIN/CN").
function dayGhepSubjectCodes(entry){
    return dayGhepSubjects(entry).map(dayGhepSubjectCode).filter(Boolean).join("/");
}

function dayGhepSubjectHint(entry){
    return dayGhepSubjects(entry).map(k=>{
        const m = dayGhepMonObj(k);
        return (m ? pccmSubjectHint(m) : "") || k;
    }).join(" · ");
}

// Tên tự động: một lớp = "Mã môn Lớp" (AVGT 6A1); nhiều lớp = "Mã môn (Lớp, Lớp)" (HĐTN 1 - 6A1, 6A2).
// 29/08 chiều: KHÔNG dùng " - " (planner/▶ FET đọc "Môn - GV" dạng cũ); nhiều lớp -> "Mã (6A1, 6A2)".
function dayGhepAutoName(entry){
    const codes = dayGhepSubjectCodes(entry);
    const classes = dayGhepClasses(entry);
    if (classes.length > 1) return `${codes} (${classes.join(", ")})`.trim();
    return `${codes} ${classes[0] || ""}`.trim();
}

// Tên tự động của dòng cũ (trước 29/08 chiều) — chỉ để tìm ô TKB cũ khi di trú.
function dgLegacyAutoName(entry){
    const codes = dayGhepSubjectCodes(entry);
    const classes = dayGhepClasses(entry);
    if (classes.length > 1) return `${codes} - ${classes.join(", ")}`.trim();
    return `${codes} ${classes[0] || ""}`.trim();
}

// NHÃN hiện trên TKB (người dùng đặt tùy ý); dòng cũ chưa có viết tắt tạm dùng tên tự động.
function dayGhepLabel(entry){
    if (!entry) return "";
    return _normText(entry.viettat) || dayGhepAutoName(entry);
}

function dayGhepName(entry){
    return dayGhepLabel(entry);
}

// Các khoá "Lớp|Môn" mà dòng sở hữu trong bảng phân công (một khoá cho mỗi lớp).
function dayGhepKeys(entry){
    const id = dayGhepIdentity(entry);
    if (!id) return [];
    return dayGhepClasses(entry).map(c => `${c}|${id}`);
}

function dayGhepTeachers(entry){
    return pccmTeacherListFromValue(entry?.gv || []);
}

// 02/09: dòng KHÔNG giáo viên — tiết chiếm ô lớp nhưng không chiếm ai (hội trường, sinh hoạt…).
function dayGhepHasNoTeacher(entry){
    return !!entry && dayGhepTeachers(entry).length === 0;
}

// Các khoá "Lớp|Khoá" (chữ thường) của mọi dòng không GV — cho bảng Phân công / thống kê.
function dayGhepNoTeacherKeySet(){
    const out = new Set();
    dayGhepList().forEach(e=>{
        if (!dayGhepHasNoTeacher(e)) return;
        dayGhepKeys(e).forEach(k => out.add(String(k).toLowerCase()));
    });
    return out;
}

// Khoá lưu trữ của một môn trong bảng phân công (mã nếu có, như buildPCCMMonList).
function dayGhepSubjectStorageKey(monKey){
    const m = dayGhepMonObj(monKey);
    return m ? _normText(m.key || m.ten) : _normText(monKey);
}

// KHOÁ (bản sắc) của dòng: chuỗi sau "Lớp|" trong bảng phân công và trong ô TKB.
// Do dayGhepResolveIdentity sinh, lưu ở `ten`; thiếu thì tạm dùng nhãn.
function dayGhepIdentity(entry){
    return _normText(entry?.ten) || dayGhepLabel(entry);
}

// Các chuỗi mà ô TKB đang lưu cho tiết của dòng.
function dayGhepCellNames(entry){
    return [dayGhepIdentity(entry)].filter(Boolean);
}

// Khoá `identity` dùng được cho các lớp `classes`? seen = khoá "lớp|khoá" (chữ thường) của
// các dòng khác. Không được: chứa "|", trùng bí danh môn học, trùng gốc ▶ FET của môn thật,
// trùng dòng khác cùng lớp, hay trùng khoá phân công chính đang có giá trị.
function dgIdentityFree(identity, classes, seen){
    const id = _normText(identity);
    if (!id || id.includes("|")) return false;
    if (dgSubjectClashingWith(id) || dgFetStemClash(id)) return false;
    const low = id.toLowerCase();
    const owned = seen || new Set();
    const pccm = DATA.pccmMatrix || {};
    for (const c of classes){
        const key = `${c}|${low}`.toLowerCase();
        if (owned.has(key)) return false;
        const hit = Object.keys(pccm).find(k => String(k).toLowerCase() === key && _normText(pccm[k]));
        if (hit && !owned.has(key)){
            // khoá đang có giá trị trong bảng mà không phải của dạy ghép -> phân công chính
            const projected = Array.isArray(DATA.dayGhepProjected) ? DATA.dayGhepProjected.map(k => String(k).toLowerCase()) : [];
            if (!projected.includes(key)) return false;
        }
    }
    return true;
}

// Sinh khoá cho dòng từ nhãn: nhãn nếu dùng được, không thì "nhãn (ghép)", "nhãn (ghép 2)"…
// seen = khoá của các dòng KHÁC (chữ thường); khoá cũ của chính dòng này được ưu tiên giữ.
// Khoá không được chứa "|" (ngăn "Lớp|Môn") hay " - " (dạng cũ "Môn - GV").
function dgIdentityBase(label){
    return _normText(label).replace(/\|/g, "/").replace(/\s*-\s+|\s+-\s*/g, "-").replace(/\s+/g, " ").trim();
}

function dayGhepResolveIdentity(entry, seen){
    const classes = dayGhepClasses(entry);
    const base = dgIdentityBase(dayGhepLabel(entry));
    const current = _normText(entry?.ten);
    const stem = current.replace(/ \(ghép(?: \d+)?\)$/, "");
    if (current && stem === base && dgIdentityFree(current, classes, seen)) return current;
    if (dgIdentityFree(base, classes, seen)) return base;
    if (dgIdentityFree(`${base} (ghép)`, classes, seen)) return `${base} (ghép)`;
    let i = 2;
    while (!dgIdentityFree(`${base} (ghép ${i})`, classes, seen)) i += 1;
    return `${base} (ghép ${i})`;
}

/* ---- Dòng cũ (trước 29/08): dòng một môn được chiếu dưới khoá môn thật, ô TKB lưu
   mọi bí danh của môn thật; dòng nhiều môn mang tên tự động/viết tắt. Chỉ dùng khi di trú. */
function dgLegacyIdentity(entry){
    const subs = dayGhepSubjects(entry);
    if (subs.length === 1) return dayGhepSubjectStorageKey(subs[0]);
    return (entry?.hienthi === "viettat" && _normText(entry.viettat)) || dgLegacyAutoName(entry);
}

function dgLegacyCellNames(entry){
    const subs = dayGhepSubjects(entry);
    if (subs.length !== 1) return [dgLegacyIdentity(entry)].filter(Boolean);
    const m = dayGhepMonObj(subs[0]);
    return dgUniqueTexts([subs[0], m?.key, m?.ten, m?.ma, m?.ma2, m?.id].filter(Boolean));
}

// Môn học có bí danh trùng tên (chữ thường) -> nhãn môn đó, không thì "".
function dgSubjectClashingWith(name){
    const low = _normText(name).toLowerCase();
    if (!low) return "";
    const clashMon = (DATA.monhoc || []).find(m => m && [m.ten, m.ma, m.ma2, m.id].some(v => v && _normText(v).toLowerCase() === low))
        || (DATA.mon || []).find(m => m && _normText(m.ten).toLowerCase() === low);
    return clashMon ? _normText(clashMon.ten || clashMon.ma || clashMon.ma2 || name) : "";
}

// Bộ xếp ▶ FET (tkb-fet-engine.js getCanonMonKeyBuiltin) rút gọn tên môn: bỏ dấu, chữ thường,
// bỏ " <số>" ở cuối. Tên ghép rút gọn trùng môn thật thì FET lẫn luật/ô cố định của môn đó.
function dgFetStem(name){
    return _normText(name).toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d")
        .replace(/\s+\d+$/, "").trim();
}

function dgFetStemClash(name){
    const stem = dgFetStem(name);
    if (!stem) return "";
    const hit = (DATA.monhoc || []).find(m => m && [m.ten, m.ma, m.ma2].some(v => v && dgFetStem(v) === stem));
    return hit ? _normText(hit.ma || hit.ma2 || hit.ten) : "";
}

// Các khoá (chữ thường) mà Dạy ghép đang sở hữu trong bảng phân công.
function dayGhepOwnedKeySet(){
    const set = new Set();
    dayGhepList().forEach(e => dayGhepKeys(e).forEach(k => set.add(k.toLowerCase())));
    return set;
}

function dayGhepOwnsKey(key){
    return dayGhepOwnedKeySet().has(_normText(key).toLowerCase());
}

function dayGhepPeriods(entry){
    const n = Number(String(entry?.sotiet ?? "").trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// Tổng tiết dạy ghép theo điều kiện lọc — cho huy hiệu "Tổng tiết" (mỗi lớp của dòng tính một lần).
function dayGhepPeriodsWhere(pred){
    let total = 0;
    dayGhepList().forEach(e=>{ if (!pred || pred(e)) total += dayGhepPeriods(e) * Math.max(1, dayGhepClasses(e).length); });
    return total;
}

/* ---------------- Ô TKB của môn ảo ----------------
   Khi dòng đổi tên (đổi cách hiển thị, đổi lớp/môn) thì ô TKB đã xếp phải đổi
   tên theo để không thành tiết mồ côi; khi xóa dòng / bỏ lớp khỏi dòng thì gỡ ô. */
function dayGhepClassIds(lopCanon){
    const want = _normText(lopCanon).toLowerCase();
    if (!want) return [];
    return (DATA.lop || []).filter(l=>{
        if (!l || typeof l !== "object") return false;
        return [classCanonFromLop(l), canonTen2FromLop(l), l.ten2, l.ten, l.id]
            .map(v => _normText(v).toLowerCase())
            .includes(want);
    }).map(l => String(l.id)).filter(Boolean);
}

function dayGhepCellMon(cell){
    if (!cell || cell === "OFF") return "";
    if (typeof cell === "string") return cell;
    if (typeof cell === "object" && cell.mon) return String(cell.mon);
    return "";
}

function dayGhepCellFixed(cell){
    return !!(cell && typeof cell === "object" && cell.fixed);
}

function dayGhepForEachTkbCell(lopCanon, fn){
    dayGhepClassIds(lopCanon).forEach(id=>{
        const grid = DATA.tkb?.[id];
        if (!grid || typeof grid !== "object") return;
        Object.values(grid).forEach(day=>{
            if (!day || typeof day !== "object") return;
            ["sang","chieu"].forEach(b=>{
                const arr = day[b];
                if (!Array.isArray(arr)) return;
                arr.forEach((cell, i) => fn(arr, i, cell));
            });
        });
    });
}

function dgNameSet(names){
    const list = Array.isArray(names) ? names : [names];
    return new Set(list.map(v => _normText(v).toLowerCase()).filter(Boolean));
}

// tkbLessonTeachers / tkbLessonRooms (màn Sắp xếp lưu theo "Lớp|Môn"): đổi khoá theo tên mới, xóa khi tên mới rỗng.
function dayGhepRekeyLessonMaps(lopCanon, oldNames, newName){
    const cls = _normText(lopCanon).toLowerCase();
    const from = dgNameSet(oldNames);
    const to = _normText(newName);
    if (!cls || !from.size) return;
    ["tkbLessonTeachers","tkbLessonRooms"].forEach(field=>{
        const obj = DATA[field];
        if (!obj || typeof obj !== "object") return;
        Object.keys(obj).forEach(k=>{
            const parts = String(k).split("|");
            if (parts.length < 2) return;
            if (_normText(parts[0]).toLowerCase() !== cls) return;
            if (!from.has(_normText(parts.slice(1).join("|")).toLowerCase())) return;
            const v = obj[k];
            delete obj[k];
            if (to) obj[`${parts[0]}|${to}`] = v;
        });
    });
}

// Đổi tên môn trong các ô TKB của lớp: ô đang lưu một trong oldNames -> newName.
function dayGhepRenameTkbCells(lopCanon, oldNames, newName){
    const from = dgNameSet(oldNames);
    const to = _normText(newName);
    if (!from.size || !to) return 0;
    from.delete(to.toLowerCase());
    if (!from.size) return 0;
    let n = 0;
    dayGhepForEachTkbCell(lopCanon, (arr, i, cell)=>{
        if (!from.has(_normText(dayGhepCellMon(cell)).toLowerCase())) return;
        if (typeof cell === "string") arr[i] = to;
        else cell.mon = to;
        n += 1;
    });
    dayGhepRekeyLessonMaps(lopCanon, Array.from(from), newName);
    return n;
}

// Gỡ các ô TKB của lớp đang lưu một trong names.
function dayGhepRemoveTkbCells(lopCanon, names){
    const from = dgNameSet(names);
    if (!from.size) return 0;
    let n = 0;
    dayGhepForEachTkbCell(lopCanon, (arr, i, cell)=>{
        if (!from.has(_normText(dayGhepCellMon(cell)).toLowerCase())) return;
        arr[i] = "";
        n += 1;
    });
    dayGhepRekeyLessonMaps(lopCanon, Array.from(from), "");
    return n;
}

/* ---------------- Đồng bộ với các bảng khác ----------------
   syncDayGhepIntegrity: dọn dòng mồ côi (lớp/môn không còn, hết GV, số tiết
   không hợp lệ, trùng tên trong cùng lớp) và chuẩn hóa tên lớp. Gọi từ
   syncDerivedDataIntegrity (app.js) với các chỉ mục nó đã dựng sẵn.
   ctx = { hasCore, classAliasToCanon: Map(alias thường -> lớp chuẩn),
           monAliasSet: Set(bí danh môn, chữ thường) } */
function syncDayGhepIntegrity(ctx){
    ctx = ctx || {};
    const list = dayGhepList();
    if (!list.length) return false;
    if (ctx.hasCore === false){
        DATA.dayGhep = [];
        return true;
    }
    const classAliasToCanon = ctx.classAliasToCanon;
    const monAliasSet = ctx.monAliasSet;
    let changed = false;
    const seen = new Set();
    const kept = [];
    list.forEach(raw=>{
        if (!raw || typeof raw !== "object"){ changed = true; return; }
        const e = raw;
        const legacy = Object.prototype.hasOwnProperty.call(e, "hienthi");   // dòng trước 29/08
        const oldNames = legacy ? dgLegacyCellNames(e) : dayGhepCellNames(e);
        const oldIdentity = legacy ? dgLegacyIdentity(e) : dayGhepIdentity(e);
        const oldClasses = dayGhepClasses(e);

        // Lớp: chuẩn hoá bí danh, bỏ lớp không còn
        const classes = [];
        oldClasses.forEach(lop=>{
            const canon = classAliasToCanon ? classAliasToCanon.get(lop.toLowerCase()) : lop;
            if (!canon) return;
            if (!classes.some(c => c.toLowerCase() === canon.toLowerCase())) classes.push(canon);
        });
        if (!classes.length){ changed = true; return; }   // lớp không còn: TKB lớp đã bị dọn theo id
        if (!Array.isArray(e.lop) || classes.join("|") !== e.lop.map(x => String(x)).join("|")){ e.lop = classes; changed = true; }

        // Môn
        const monsBefore = dayGhepSubjects(e);
        const mons = monAliasSet ? monsBefore.filter(k => monAliasSet.has(k.toLowerCase())) : monsBefore;
        if (!mons.length){
            changed = true;
            classes.forEach(c => dayGhepRemoveTkbCells(c, oldNames));
            return;
        }
        if (!Array.isArray(e.mon) || mons.join("|") !== e.mon.map(x => String(x)).join("|")){ e.mon = mons; changed = true; }

        // Giáo viên — 02/09: được để TRỐNG (dòng không GV); trước đây dòng mất GV (xoá GV
        // khỏi danh mục) bị xoá luôn kèm ô TKB. Nay giữ dòng, tiết thành tiết không GV.
        const gv = pccmTeacherListFromValue(e.gv);
        if (!Array.isArray(e.gv) || gv.join("|") !== e.gv.map(x => String(x)).join("|")){ e.gv = gv; changed = true; }

        // Số tiết / giới hạn / cách hiển thị / cố định
        if (!(dayGhepPeriods(e) > 0)){
            changed = true;
            classes.forEach(c => dayGhepRemoveTkbCells(c, oldNames));
            return;
        }
        const gh = Number(String(e.gioihan ?? "").trim());
        if (!(Number.isFinite(gh) && gh > 0)){ e.gioihan = "1"; changed = true; }
        if (Object.prototype.hasOwnProperty.call(e, "codinh")){ delete e.codinh; changed = true; }   // trường cũ, không dùng nữa

        // 29/08: nhãn (viettat) tùy ý; khoá (ten) do app sinh. Dòng cũ (còn `hienthi`) lấy
        // nhãn cũ / tên tự động làm nhãn.
        if (legacy){
            e.viettat = _normText(e.viettat) || dayGhepAutoName(e);
            delete e.hienthi;
            changed = true;
        } else if (!_normText(e.viettat)){
            e.viettat = dayGhepAutoName(e);
            changed = true;
        }
        const newIdentity = dayGhepResolveIdentity(e, seen);
        if (e.ten !== newIdentity){ e.ten = newIdentity; changed = true; }
        const keys = dayGhepKeys(e).map(k => k.toLowerCase());
        if (!keys.length){ changed = true; return; }
        keys.forEach(k => seen.add(k));

        // Khoá đổi (di trú dòng cũ, đổi nhãn) -> đổi tên ô TKB theo
        if (newIdentity !== oldIdentity) classes.forEach(c => dayGhepRenameTkbCells(c, oldNames, newIdentity));
        if (!_normText(e.id)){ e.id = dayGhepNewId(); changed = true; }
        kept.push(e);
    });
    if (kept.length !== list.length) changed = true;
    DATA.dayGhep = kept;
    return changed;
}

// Chiếu DATA.dayGhep vào bảng phân công (idempotent). Trả về true nếu có thay đổi.
function syncDayGhepProjection(){
    if (!DATA || typeof DATA !== "object") return false;
    ["pccmMatrix","pccmTietMatrix","pccmGioihanMatrix"].forEach(f=>{
        if (!DATA[f] || typeof DATA[f] !== "object" || Array.isArray(DATA[f])) DATA[f] = {};
    });
    let changed = false;
    const next = new Map();   // khoá -> {gv, sotiet, gioihan}
    dayGhepList().forEach(e=>{
        // `ten` = khoá do dayGhepResolveIdentity sinh (syncDayGhepIntegrity / dayGhepAccept); planner
        // nhận diện tiết ghép qua khoá này và hiện nhãn `viettat`.
        // 02/09: dòng không GV vẫn chiếu Số tiết / Giới hạn (gv = "" -> không ghi pccmMatrix).
        const gv = pccmNormalizeTeacherValue(e?.gv || []);
        const sotiet = dayGhepPeriods(e);
        if (!sotiet) return;
        const gh = Number(String(e.gioihan ?? "").trim());
        const value = {
            gv: gv || "",
            sotiet: String(sotiet),
            gioihan: (Number.isFinite(gh) && gh > 0) ? String(gh) : "1"
        };
        dayGhepKeys(e).forEach(key => { if (!next.has(key)) next.set(key, value); });
    });

    // Khoá đã chiếu lần trước mà nay không còn (dòng bị xóa / đổi tên) -> gỡ khỏi mọi bảng.
    const prev = Array.isArray(DATA.dayGhepProjected) ? DATA.dayGhepProjected.map(k => String(k)) : [];
    prev.forEach(k=>{
        if (next.has(k)) return;
        ["pccmMatrix","pccmTietMatrix","pccmGioihanMatrix","pccmRoomMatrix","tkbLessonTeachers","tkbLessonRooms"].forEach(f=>{
            const obj = DATA[f];
            if (obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, k)){
                delete obj[k];
                changed = true;
            }
        });
    });

    next.forEach((v, k)=>{
        if (v.gv){
            if (DATA.pccmMatrix[k] !== v.gv){ DATA.pccmMatrix[k] = v.gv; changed = true; }
        } else {
            // dòng không GV: không có khoá GV; dòng vừa bỏ hết GV thì gỡ khoá cũ (giữ Tiết/Giới hạn)
            // và GV bộ giải ghi nhớ cho ô (tkbLessonTeachers) để bảng GV không hiện người cũ.
            if (Object.prototype.hasOwnProperty.call(DATA.pccmMatrix, k)){ delete DATA.pccmMatrix[k]; changed = true; }
            const lt = DATA.tkbLessonTeachers;
            if (lt && typeof lt === "object" && _normText(lt[k])){ delete lt[k]; changed = true; }
        }
        if (String(DATA.pccmTietMatrix[k] ?? "") !== v.sotiet){ DATA.pccmTietMatrix[k] = v.sotiet; changed = true; }
        if (String(DATA.pccmGioihanMatrix[k] ?? "") !== v.gioihan){ DATA.pccmGioihanMatrix[k] = v.gioihan; changed = true; }
    });

    const nextKeys = Array.from(next.keys()).sort();
    const prevSorted = prev.slice().sort();
    const same = nextKeys.length === prevSorted.length && nextKeys.every((k, i) => k === prevSorted[i]);
    if (!same){
        DATA.dayGhepProjected = nextKeys;
        changed = true;
    }
    if (changed){
        try{ invalidateTeacherCodeIndex(); }catch(_){ }
    }
    return changed;
}

// Kiểm tra dòng trước khi lưu. Trả về "" nếu hợp lệ, ngược lại là thông báo lỗi.
// Nhãn đặt tùy ý (được trùng tên môn học / dòng khác) — khoá nội bộ do dayGhepResolveIdentity lo.
function dayGhepNameProblem(entry){
    if (!dayGhepClasses(entry).length) return "Chưa chọn lớp.";
    if (!dayGhepSubjects(entry).length) return "Chưa chọn môn.";
    if (!dayGhepLabel(entry)) return "Chưa có tên viết tắt.";
    return "";
}

/* ---------------- Trang "Dạy ghép" ---------------- */
function dayGhepClassNames(){
    return Array.from(new Set((DATA.lop || []).map(l => canonTen2FromLop(l)).filter(Boolean)));
}

function renderDayGhepPage(target){
    const container = (typeof target === "string")
        ? document.getElementById(target)
        : (target || document.getElementById("section-content"));
    if (!container) return;
    const list = dayGhepList();
    DG_SELECTED = new Set(Array.from(DG_SELECTED).filter(i => i >= 0 && i < list.length));
    const selCount = DG_SELECTED.size;
    const allChecked = list.length > 0 && selCount === list.length;
    const total = dayGhepPeriodsWhere(null);

    let html = `
    <div class="action-bar action-bar-data dg-action-bar">
        <button class="btn primary" onclick="dayGhepOpenDialog(-1)">Thêm mới</button>
        <button class="btn danger" onclick="dayGhepDeleteSelected()" ${selCount ? "" : "disabled"}>Xóa đã chọn${selCount ? ` (${selCount})` : ""}</button>
        <button class="btn danger" onclick="dayGhepDeleteAll()">Xóa mục này</button>
        <button class="btn" onclick="triggerExcel('dayghep')" title="Nhập từ file .xlsx cùng cột với file Xuất Excel">Nhập Excel</button>
        <button class="btn" onclick="dayGhepExportExcel()">Xuất Excel</button>
        <span class="dg-total-badge" title="Tổng số tiết dạy ghép trong tuần (mỗi dòng tính một lần cho mỗi lớp)">Tổng tiết: ${total}</span>
    </div>
    <div class="table-wrap data-table-wrap data-table-wrap-dayghep">
    <table class="data-table data-table-dayghep dg-table">
        <tr>
            <th class="dg-col-tt">TT</th>
            <th class="dg-col-check"><input type="checkbox" ${allChecked ? "checked" : ""} onclick="dayGhepToggleAll(this.checked)" title="Chọn tất cả"></th>
            <th title="Tên hiện trên TKB">Viết tắt</th>
            <th>Lớp học</th>
            <th title="Chỉ để gợi tên viết tắt; không đụng phân công chính của môn">Môn học</th>
            <th>Giáo viên</th>
            <th>Số tiết</th>
            <th>Giới hạn</th>
        </tr>`;

    if (!list.length){
        html += `
        <tr class="data-empty-row">
            <td colspan="8">Chưa có dòng dạy ghép. Bấm <b>Thêm mới</b> để tạo.</td>
        </tr>`;
    }

    list.forEach((e, i)=>{
        const selected = DG_SELECTED.has(i);
        const teachers = dayGhepTeachers(e);
        html += `
        <tr class="${selected ? "row-selected" : ""}" onclick="dayGhepRowClick(event,${i})" ondblclick="dayGhepRowDblClick(event,${i})">
            <td class="dg-col-tt">${i + 1}</td>
            <td class="dg-col-check"><input type="checkbox" ${selected ? "checked" : ""} onclick="dayGhepCheckClick(event,${i})"></td>
            <td class="dg-name" title="${escapeHtml(dayGhepIdentity(e) !== dayGhepLabel(e) ? `Tên hiện trên TKB. Khoá nội bộ: ${dayGhepIdentity(e)}` : "Tên hiện trên TKB")}">${escapeHtml(dayGhepLabel(e))}</td>
            <td>${escapeHtml(dayGhepClassLabel(e))}</td>
            <td title="${escapeHtml(dayGhepSubjectHint(e))}">${escapeHtml(dayGhepSubjectCodes(e))}</td>
            ${teachers.length
                ? `<td title="${escapeHtml(teachers.map(c => pccmTeacherHint(c) || c).join(" · "))}">${escapeHtml(teachers.join(", "))}</td>`
                : `<td class="dg-no-teacher" title="Tiết không giáo viên: chiếm ô của lớp, máy tự xếp, không tính vào giờ dạy của ai">(không GV)</td>`}
            <td>${escapeHtml(String(e.sotiet ?? ""))}</td>
            <td>${escapeHtml(String(e.gioihan ?? ""))}</td>
        </tr>`;
    });

    html += `
    </table>
    </div>`;

    // Giữ vị trí cuộn của bảng khi vẽ lại (chọn dòng, thêm/sửa/xóa)
    const previousWrap = container.querySelector ? container.querySelector(".data-table-wrap-dayghep") : null;
    const keptScrollTop = previousWrap ? previousWrap.scrollTop : 0;
    container.innerHTML = html;
    if (keptScrollTop){
        const wrap = container.querySelector(".data-table-wrap-dayghep");
        if (wrap) wrap.scrollTop = keptScrollTop;
    }
}

function dayGhepRerender(){
    renderDayGhepPage("section-content");
}

function dayGhepRowClick(ev, index){
    try{
        if (ev && ev.target && ev.target.tagName === "INPUT") return; // ô checkbox tự xử lý
        const list = dayGhepList();
        if (index < 0 || index >= list.length) return;
        if (ev && ev.shiftKey && DG_LAST_INDEX >= 0){
            const from = Math.min(DG_LAST_INDEX, index);
            const to = Math.max(DG_LAST_INDEX, index);
            for (let i = from; i <= to; i++) DG_SELECTED.add(i);
        } else if (ev && (ev.ctrlKey || ev.metaKey)){
            if (DG_SELECTED.has(index)) DG_SELECTED.delete(index);
            else DG_SELECTED.add(index);
        } else {
            DG_SELECTED = new Set([index]);
        }
        DG_LAST_INDEX = index;
        dayGhepRerender();
    }catch(e){ /* ignore */ }
}

function dayGhepCheckClick(ev, index){
    try{ ev?.stopPropagation?.(); }catch(_){ }
    if (DG_SELECTED.has(index)) DG_SELECTED.delete(index);
    else DG_SELECTED.add(index);
    DG_LAST_INDEX = index;
    dayGhepRerender();
}

function dayGhepToggleAll(checked){
    const list = dayGhepList();
    DG_SELECTED = checked ? new Set(list.map((_, i) => i)) : new Set();
    dayGhepRerender();
}

function dayGhepRowDblClick(ev, index){
    try{ ev?.preventDefault?.(); }catch(_){ }
    dayGhepOpenDialog(index);
}

function dayGhepDeleteSelected(){
    const list = dayGhepList();
    const idx = Array.from(DG_SELECTED).filter(i => i >= 0 && i < list.length).sort((a, b) => b - a);
    if (!idx.length){
        alert("Chọn dòng cần xóa.");
        return;
    }
    if (!confirm(`Xóa ${idx.length} dòng dạy ghép đã chọn?\nTiết đã xếp / đã cố định của các dòng này trên TKB sẽ bị gỡ.`)) return;
    idx.forEach(i=>{
        const e = list[i];
        const names = dayGhepCellNames(e);
        dayGhepClasses(e).forEach(c => dayGhepRemoveTkbCells(c, names));
        list.splice(i, 1);
    });
    DG_SELECTED = new Set();
    DG_LAST_INDEX = -1;
    syncDayGhepProjection();
    saveStore();
    dayGhepRerender();
    showBottomPopup(`Đã xóa ${idx.length} dòng dạy ghép.`, "ok");
}

function dayGhepDeleteAll(){
    const list = dayGhepList();
    if (!list.length){
        alert("Chưa có dòng dạy ghép nào.");
        return;
    }
    if (!confirm("⚠ Bạn có chắc muốn XÓA toàn bộ Dạy ghép?\nTiết đã xếp / đã cố định của các dòng này trên TKB sẽ bị gỡ.")) return;
    list.forEach(e=>{
        const names = dayGhepCellNames(e);
        dayGhepClasses(e).forEach(c => dayGhepRemoveTkbCells(c, names));
    });
    DATA.dayGhep = [];
    DG_SELECTED = new Set();
    DG_LAST_INDEX = -1;
    syncDayGhepProjection();
    saveStore();
    dayGhepRerender();
    showBottomPopup("Đã xóa toàn bộ Dạy ghép.", "ok");
}

/* ---------------- Xuất / Nhập Excel (31/08/2026) ----------------
   Cùng khuôn với các mục khác (exportExcel / importExcel_* trong app.js): một sheet, dòng đầu là
   tiêu đề cột. Cột: STT | Viết tắt | Lớp học | Môn học | Giáo viên | Số tiết | Giới hạn.
   Lớp / Môn / Giáo viên nhiều giá trị cách nhau bằng dấu phẩy; Môn ghi mã (hoặc tên), Giáo viên
   ghi mã GV (hoặc họ tên). Nhập: dòng nào lớp/môn/GV không có trong danh mục thì báo và KHÔNG nhập
   gì (như Môn học); dòng trùng Viết tắt + cùng bộ Lớp với dòng đang có -> cập nhật dòng đó (nhập lại
   file vừa xuất không nhân đôi), còn lại thêm mới. */
const DG_EXCEL_SHEET = "dayghep";
const DG_EXCEL_COLS = ["STT", "Viết tắt", "Lớp học", "Môn học", "Giáo viên", "Số tiết", "Giới hạn"];

function dayGhepExcelRows(){
    return dayGhepList().map((e, i)=>({
        "STT": i + 1,
        "Viết tắt": dayGhepLabel(e),
        "Lớp học": dayGhepClasses(e).join(", "),
        "Môn học": dayGhepSubjects(e).map(dayGhepSubjectCode).filter(Boolean).join(", "),
        "Giáo viên": dayGhepTeachers(e).join(", "),
        "Số tiết": String(e?.sotiet ?? ""),
        "Giới hạn": String(e?.gioihan ?? "")
    }));
}

function dayGhepExportExcel(){
    if (!window.XLSX){
        alert("❌ Chưa tải thư viện Excel (XLSX). Hãy kiểm tra kết nối mạng rồi thử lại.");
        return;
    }
    const rows = dayGhepExcelRows();
    const cols = DG_EXCEL_COLS.slice();
    const matrix = [cols, ...rows.map(r => cols.map(k => r?.[k] ?? ""))];
    const ws = XLSX.utils.json_to_sheet(rows, { header: cols });
    let widths = [];
    try{
        widths = cols.map((k, idx)=>{
            if (idx === 0) return { wch: 6 };
            let w = String(k).length + 2;
            rows.forEach(r => { w = Math.max(w, String(r?.[k] ?? "").length + 2); });
            return { wch: Math.min(Math.max(12, w), 42) };
        });
        ws["!cols"] = widths;
    }catch(e){
        console.warn("dayGhepExportExcel set column widths failed", e);
    }
    try{
        window.TKBExcelStyle?.styleSheet(ws, matrix, {
            widths,
            headerRows: [0],
            freeze: { xSplit: 0, ySplit: 1 },
            filterRow: 0,
            bodyRowHeight: 22,
            maxWidth: 42
        });
    }catch(e){
        console.warn("dayGhepExportExcel style failed", e);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, DG_EXCEL_SHEET);
    XLSX.writeFile(wb, `${DG_EXCEL_SHEET}.xlsx`, window.TKBExcelStyle?.writeOptions ? window.TKBExcelStyle.writeOptions() : { compression: true, cellStyles: true });
}

// Ô đầu tiên có giá trị trong các tên cột chấp nhận (có dấu / không dấu / khoá nội bộ).
function dgExcelCell(row, keys){
    for (const k of keys){
        if (row && Object.prototype.hasOwnProperty.call(row, k)){
            const v = row[k];
            if (v !== undefined && v !== null && String(v).trim() !== "") return v;
        }
    }
    return "";
}

// Tên lớp trong file -> tên lớp chuẩn của trường (chấp nhận bí danh 6/1 <-> 6A1); "" nếu không có.
function dgResolveClassName(text){
    const t = _normText(text);
    if (!t) return "";
    const names = dayGhepClassNames();
    const low = t.toLowerCase();
    let hit = names.find(n => n.toLowerCase() === low);
    if (hit) return hit;
    try{
        const cands = classLookupCandidates(t).map(c => String(c).toLowerCase());
        hit = names.find(n => cands.includes(n.toLowerCase()));
    }catch(_){ }
    return hit || "";
}

// Mã GV / họ tên trong file -> mã GV có trong bảng Giáo viên; "" nếu không có.
function dgResolveTeacherCode(text){
    const code = resolveTeacherCode(_normText(text));
    if (!code) return "";
    const low = code.toLowerCase();
    const ok = (DATA.giaovien || []).some(g => _normText(g?.magv).toLowerCase() === low);
    return ok ? code : "";
}

// Một dòng Excel -> {entry} | {error} | null (dòng trống).
function dayGhepEntryFromExcelRow(row, rowNo){
    const viettat = _normText(dgExcelCell(row, ["Viết tắt", "Viet tat", "viettat", "Tên viết tắt", "Ten viet tat", "Tên", "ten"]));
    const lopRaw = dgExcelCell(row, ["Lớp học", "Lop hoc", "Lớp", "Lop", "lop"]);
    const monRaw = dgExcelCell(row, ["Môn học", "Mon hoc", "Môn", "Mon", "mon"]);
    const gvRaw = dgExcelCell(row, ["Giáo viên", "Giao vien", "GV", "gv", "Mã GV", "MaGV"]);
    const stRaw = _normText(dgExcelCell(row, ["Số tiết", "So tiet", "sotiet"]));
    const ghRaw = _normText(dgExcelCell(row, ["Giới hạn", "Gioi han", "gioihan"]));
    if (!viettat && !_normText(lopRaw) && !_normText(monRaw) && !_normText(gvRaw) && !stRaw) return null;

    const errs = [];
    const pushUnique = (arr, v) => { if (!arr.some(x => x.toLowerCase() === v.toLowerCase())) arr.push(v); };

    const classes = [], badClasses = [];
    dgUniqueTexts(lopRaw).forEach(t => { const c = dgResolveClassName(t); if (c) pushUnique(classes, c); else badClasses.push(t); });
    if (badClasses.length) errs.push(`lớp không có trong Lớp học: ${badClasses.join(", ")}`);
    else if (!classes.length) errs.push("thiếu Lớp học");

    const mons = [], badMons = [];
    dgUniqueTexts(monRaw).forEach(t => {
        const m = dayGhepMonObj(t);
        if (m) pushUnique(mons, _normText(m.key || m.ten)); else badMons.push(t);
    });
    if (badMons.length) errs.push(`môn không có trong Môn học: ${badMons.join(", ")}`);
    else if (!mons.length) errs.push("thiếu Môn học");

    // 02/09: cột Giáo viên để trống = tiết không giáo viên (hợp lệ).
    const gv = [], badGv = [];
    dgUniqueTexts(gvRaw).forEach(t => { const c = dgResolveTeacherCode(t); if (c) pushUnique(gv, c); else badGv.push(t); });
    if (badGv.length) errs.push(`giáo viên không có trong Giáo viên: ${badGv.join(", ")}`);

    const st = Number(stRaw);
    if (!stRaw || !Number.isInteger(st) || st <= 0) errs.push("Số tiết phải là số nguyên lớn hơn 0");
    const gh = ghRaw ? Number(ghRaw) : 1;
    if (!Number.isInteger(gh) || gh <= 0) errs.push("Giới hạn phải là số nguyên lớn hơn 0 (để trống = 1)");

    if (errs.length) return { error: `Dòng ${rowNo}: ${errs.join("; ")}` };
    const entry = {
        id: "",
        lop: classes,
        mon: mons,
        gv,
        sotiet: String(st),
        gioihan: String(gh),
        viettat: viettat || dayGhepAutoName({ lop: classes, mon: mons })
    };
    return { entry };
}

function dgSameClassSet(a, b){
    const norm = arr => dgUniqueTexts(arr).map(x => x.toLowerCase()).sort().join("|");
    return norm(a) === norm(b);
}

// Nhập từ các dòng sheet_to_json (app.js importFromExcel gọi khi IMPORT_SECTION === "dayghep").
function importExcel_DayGhep(rows){
    if (!Array.isArray(rows) || !rows.length){
        alert("⚠ File không có dòng dữ liệu.");
        return false;
    }
    if (!dayGhepClassNames().length || !buildPCCMMonList().length || !(DATA.giaovien || []).length){
        alert("⚠ Cần có Lớp học, Môn học và Giáo viên trước khi nhập Dạy ghép.");
        return false;
    }
    const parsed = [], errors = [];
    rows.forEach((r, i)=>{
        const res = dayGhepEntryFromExcelRow(r, i + 2);   // dòng 1 là tiêu đề
        if (!res) return;
        if (res.error) errors.push(res.error); else parsed.push(res.entry);
    });
    if (errors.length){
        alert(`⚠ Không thể import Dạy ghép. Sửa các dòng sau rồi nhập lại:\n${errors.slice(0, 20).join("\n")}${errors.length > 20 ? "\n..." : ""}`);
        return false;
    }
    if (!parsed.length){
        alert("⚠ Không tìm thấy dòng Dạy ghép hợp lệ.");
        return false;
    }

    const list = dayGhepList();
    let added = 0, updated = 0;
    parsed.forEach(entry=>{
        const idx = list.findIndex(e => dayGhepLabel(e).toLowerCase() === entry.viettat.toLowerCase() && dgSameClassSet(dayGhepClasses(e), entry.lop));
        const prev = idx >= 0 ? list[idx] : null;
        const seen = new Set();
        list.forEach((e, i) => { if (i !== idx) dayGhepKeys(e).forEach(k => seen.add(k.toLowerCase())); });
        if (prev){
            entry.id = _normText(prev.id);
            entry.ten = _normText(prev.ten);   // giữ khoá cũ nếu còn dùng được
        }
        entry.ten = dayGhepResolveIdentity(entry, seen);
        if (prev){
            const oldNames = dayGhepCellNames(prev);
            const oldIdentity = dayGhepIdentity(prev);
            const newIdentity = dayGhepIdentity(entry);
            if (oldIdentity !== newIdentity) entry.lop.forEach(c => dayGhepRenameTkbCells(c, oldNames, newIdentity));
            if (!entry.id) entry.id = dayGhepNewId();
            list[idx] = entry;
            updated++;
        } else {
            entry.id = dayGhepNewId();
            list.push(entry);
            added++;
        }
    });
    DG_SELECTED = new Set();
    DG_LAST_INDEX = -1;
    syncDayGhepProjection();
    saveStore();
    dayGhepRerender();
    alert(`✔ Import Dạy ghép thành công!\nThêm mới: ${added} dòng.${updated ? `\nCập nhật (trùng Viết tắt + Lớp học): ${updated} dòng.` : ""}`);
    return true;
}

/* ---------------- Hộp thoại "PCGD ghép" ---------------- */
function dayGhepEnsureModal(){
    let el = document.getElementById("dgModal");
    if (el) return el;
    el = document.createElement("div");
    el.id = "dgModal";
    el.className = "modal dg-modal";
    el.innerHTML = `
        <div class="modal-content dg-modal-content" role="dialog" aria-modal="true" aria-labelledby="dgModalTitle">
            <div class="dg-modal-head">
                <span class="dg-modal-icon" aria-hidden="true"></span>
                <h3 id="dgModalTitle">PCGD ghép</h3>
                <button type="button" class="dg-modal-close" title="Đóng" aria-label="Đóng" onclick="dayGhepCloseDialog()">&#x2715;</button>
            </div>
            <div id="dgModalBody" class="dg-modal-body"></div>
            <div class="modal-actions dg-modal-actions">
                <button class="btn primary" onclick="dayGhepAccept()">Chấp nhận</button>
                <button class="btn" onclick="dayGhepCloseDialog()">Hủy bỏ</button>
            </div>
        </div>`;
    document.body.appendChild(el);
    document.addEventListener("keydown", (ev)=>{
        try{
            if (el.style.display !== "flex") return;
            if (ev.key === "Escape"){
                ev.preventDefault();
                dayGhepCloseDialog();
            } else if (ev.key === "Enter" && ev.target && ev.target.tagName === "INPUT" && ev.target.type !== "radio"){
                ev.preventDefault();
                dayGhepAccept();
            }
        }catch(_){ /* ignore */ }
    });
    return el;
}

/* Ba ô chọn của hộp thoại (Lớp / Môn / Giáo viên) dùng chung giao diện
   .pccm-multi-select: bấm để bật/tắt từng mục, chọn được nhiều. */
function dgItems(type){
    if (type === "lop"){
        return dayGhepClassNames().map(c => ({code: c, label: c, title: c}));
    }
    if (type === "mon"){
        return buildPCCMMonList()
            .map(m => ({code: _normText(m.key || m.ten), label: pccmSubjectCode(m) || pccmSubjectName(m), title: pccmSubjectHint(m)}))
            .filter(x => x.code);
    }
    const codes = (DATA.giaovien || []).map(g => _normText(g?.magv)).filter(Boolean);
    const known = new Set(codes.map(c => c.toLowerCase()));
    const missing = (DG_SEL.gv || [])
        .filter(c => !known.has(c.toLowerCase()))
        .map(c => ({code: c, label: `(Đang lưu) ${c}`, title: c}));
    return missing.concat(codes.map(c => ({code: c, label: c, title: pccmTeacherHint(c) || c})));
}

function dgPlaceholder(type){
    if (type === "lop") return "Chọn lớp học (nhiều lớp = học chung một tiết)";
    if (type === "mon") return "Chọn môn học để gợi tên (có thể chọn nhiều)";
    return "Chọn giáo viên (có thể chọn nhiều; để trống = tiết không giáo viên)";
}

function dgSelectedLabel(type){
    const byCode = new Map(dgItems(type).map(it => [it.code.toLowerCase(), it.label]));
    return (DG_SEL[type] || []).map(c => byCode.get(c.toLowerCase()) || c).join(", ");
}

// Lớp và Môn giữ thứ tự danh mục (tên tự động ổn định); Giáo viên giữ thứ tự bấm.
function dgOrder(type){
    if (type === "gv") return;
    const order = new Map(dgItems(type).map((it, i) => [it.code.toLowerCase(), i]));
    DG_SEL[type].sort((a, b) => (order.get(a.toLowerCase()) ?? 1e9) - (order.get(b.toLowerCase()) ?? 1e9));
}

function dgRenderPicker(type, labelText){
    return `
        <div class="form-row">
            <label>${escapeHtml(labelText)}</label>
            <div id="dgBox_${type}" class="pccm-multi-select dg-picker" data-dg-type="${type}">
                <button type="button" class="pccm-multi-button" onclick="dgToggle(event,'${type}')">
                    <span id="dgText_${type}"></span>
                    <span class="pccm-multi-arrow">&#9662;</span>
                </button>
                <div class="pccm-multi-menu" id="dgMenu_${type}"></div>
            </div>
        </div>`;
}

function dgRenderMenu(type){
    const menu = document.getElementById(`dgMenu_${type}`);
    if (!menu) return;
    const sel = new Set((DG_SEL[type] || []).map(c => c.toLowerCase()));
    menu.innerHTML = `<button type="button" class="pccm-multi-item pccm-teacher-clear" onclick="dgClear(event,'${type}')">(Bỏ chọn tất cả)</button>`
        + dgItems(type).map(item => `
        <button type="button"
                class="pccm-multi-item dg-item ${sel.has(item.code.toLowerCase()) ? "selected" : ""}"
                data-dg-code="${escapeHtml(item.code)}"
                title="${escapeHtml(item.title || item.label)}"
                onclick="dgItemClick(event,'${type}', this.getAttribute('data-dg-code'))">
            ${escapeHtml(item.label)}
        </button>`).join("");
}

function dgUpdateUI(type){
    const label = dgSelectedLabel(type);
    const text = document.getElementById(`dgText_${type}`);
    if (text){
        text.textContent = label || dgPlaceholder(type);
        text.classList.toggle("dg-placeholder", !label);
    }
    const btn = document.querySelector(`#dgBox_${type} .pccm-multi-button`);
    if (btn) btn.title = (type === "gv") ? DG_SEL.gv.map(c => pccmTeacherHint(c) || c).join(" · ") : label;
    const sel = new Set((DG_SEL[type] || []).map(c => c.toLowerCase()));
    document.querySelectorAll(`#dgMenu_${type} .dg-item`).forEach(item=>{
        item.classList.toggle("selected", sel.has(_normText(item.getAttribute("data-dg-code")).toLowerCase()));
    });
    dayGhepDialogChanged();
}

function dgToggle(ev, type){
    try{ ev?.stopPropagation?.(); }catch(_){ }
    const box = document.getElementById(`dgBox_${type}`);
    if (!box) return;
    const willOpen = !box.classList.contains("open");
    try{ pccmQuickMultiCloseAll(); }catch(_){ }
    if (willOpen){
        dgRenderMenu(type);
        box.classList.add("open");
    }
}

function dgItemClick(ev, type, code){
    try{ ev?.preventDefault?.(); ev?.stopPropagation?.(); }catch(_){ }
    const c = (type === "gv") ? resolveTeacherCode(_normText(code)) : _normText(code);
    if (!c) return;
    const low = c.toLowerCase();
    const list = DG_SEL[type];
    const i = list.findIndex(x => x.toLowerCase() === low);
    if (i >= 0) list.splice(i, 1);
    else list.push(c);
    dgOrder(type);
    dgUpdateUI(type);
}

function dgClear(ev, type){
    try{ ev?.preventDefault?.(); ev?.stopPropagation?.(); }catch(_){ }
    DG_SEL[type] = [];
    dgUpdateUI(type);
}

function dayGhepOpenDialog(index){
    const list = dayGhepList();
    const classes = dayGhepClassNames();
    const mons = buildPCCMMonList();
    if (!classes.length){ alert("Chưa có Lớp học. Vào menu Lớp học để thêm trước."); return; }
    if (!mons.length){ alert("Chưa có Môn học. Vào menu Môn học để thêm trước."); return; }
    if (!(DATA.giaovien || []).length){ alert("Chưa có Giáo viên. Vào menu Giáo viên để thêm trước."); return; }

    const editing = index >= 0 && index < list.length;
    const e = editing ? list[index] : null;
    DG_EDIT_INDEX = editing ? index : -1;
    DG_SEL = {
        lop: e ? dayGhepClasses(e) : (classes.includes(PCCM_SELECTED_CLASS) ? [PCCM_SELECTED_CLASS] : []),
        mon: e ? dayGhepSubjects(e).map(k => { const m = dayGhepMonObj(k); return m ? _normText(m.key || m.ten) : k; }) : [],
        gv: e ? dayGhepTeachers(e) : []
    };
    const dirty = editing ? ` data-dirty="1"` : "";

    const modal = dayGhepEnsureModal();
    const title = modal.querySelector("#dgModalTitle");
    if (title) title.textContent = editing ? "PCGD ghép (sửa)" : "PCGD ghép";

    document.getElementById("dgModalBody").innerHTML = `
        ${dgRenderPicker("lop", "Lớp học")}
        ${dgRenderPicker("mon", "Môn học")}
        ${dgRenderPicker("gv", "Giáo viên")}
        <div class="form-row">
            <label for="dg_sotiet">Số tiết</label>
            <input id="dg_sotiet" type="number" min="1" step="1" value="${escapeHtml(e ? String(e.sotiet ?? "") : "")}"${dirty}
                   placeholder="số tiết/tuần" oninput="this.dataset.dirty='1'">
        </div>
        <div class="form-row">
            <label for="dg_gioihan">Giới hạn</label>
            <input id="dg_gioihan" type="number" min="1" step="1" value="${escapeHtml(e ? String(e.gioihan ?? "") : "")}"${dirty}
                   placeholder="số tiết tối đa/buổi" oninput="this.dataset.dirty='1'">
        </div>
        <div class="form-row">
            <label for="dg_viettat">Viết tắt</label>
            <input id="dg_viettat" class="dg-viettat-input" maxlength="40" value="${escapeHtml(e ? dayGhepName(e) : "")}"${dirty}
                   placeholder="tên hiện trên TKB, vd AV-GT" oninput="this.dataset.dirty='1'">
        </div>
        <div class="form-row dg-hint-row">
            <span></span>
            <span class="dg-hint">Tên hiện trên TKB — gợi ý theo Môn học + Lớp, đặt tùy ý (được trùng tên môn học).
            Không liên quan phân công chính và tổng tiết ở Phân công. Luật ở Yêu cầu (tiết đôi, nghỉ cố định môn,
            giới hạn/buổi…) áp theo Môn học đã chọn (nhiều môn: môn đầu tiên) — không tạo môn mới.
            Để trống Giáo viên = tiết không giáo viên: chiếm ô của lớp, máy tự xếp, không tính giờ dạy của ai.</span>
        </div>`;

    modal.style.display = "flex";
    ["lop","mon","gv"].forEach(dgUpdateUI);
}

function dayGhepCloseDialog(){
    const el = document.getElementById("dgModal");
    if (el) el.style.display = "none";
    try{ pccmQuickMultiCloseAll(); }catch(_){ }
    DG_EDIT_INDEX = -1;
    DG_SEL = { lop: [], mon: [], gv: [] };
}

// Lớp/môn đổi -> gợi tên viết tắt, điền Số tiết/Giới hạn theo Tiết chuẩn (nếu chưa gõ tay).
function dayGhepDialogChanged(){
    const classes = DG_SEL.lop || [];
    const mons = DG_SEL.mon || [];
    const vt = document.getElementById("dg_viettat");
    if (vt && vt.dataset.dirty !== "1") vt.value = dayGhepAutoName({lop: classes, mon: mons});

    const st = document.getElementById("dg_sotiet");
    const gh = document.getElementById("dg_gioihan");
    const monObj = mons.length ? dayGhepMonObj(mons[0]) : null;
    const tc = (classes.length && monObj) ? lookupTietChuan(pccmGetKhoiNameForClass(classes[0]), monObj) : null;
    if (st && st.dataset.dirty !== "1"){
        st.value = (tc && _toPositiveNumberOrZero(tc.sotiet) > 0) ? String(tc.sotiet).trim() : "";
    }
    if (gh && gh.dataset.dirty !== "1"){
        gh.value = (tc && _toPositiveNumberOrZero(tc.gioihan) > 0) ? String(tc.gioihan).trim() : "1";
    }
}

// Nút "Chấp nhận": kiểm tra, lưu dòng, chiếu vào bảng phân công, đổi tên/gỡ ô TKB cũ nếu sửa dòng đang có.
function dayGhepAccept(){
    const list = dayGhepList();
    const editing = DG_EDIT_INDEX >= 0 && DG_EDIT_INDEX < list.length;
    const prev = editing ? list[DG_EDIT_INDEX] : null;
    const classes = dgUniqueTexts(DG_SEL.lop || []);
    const mons = dgUniqueTexts(DG_SEL.mon || []);
    const gv = pccmTeacherListFromValue(DG_SEL.gv || []);
    const sotietRaw = _normText(document.getElementById("dg_sotiet")?.value);
    const gioihanRaw = _normText(document.getElementById("dg_gioihan")?.value);
    const viettat = _normText(document.getElementById("dg_viettat")?.value);

    if (!classes.length){ alert("Chọn Lớp học."); return; }
    if (!mons.length){ alert("Chọn Môn học."); return; }
    // 02/09: Giáo viên được để trống -> tiết không giáo viên (xem đầu file).
    const st = Number(sotietRaw);
    if (!sotietRaw || !Number.isInteger(st) || st <= 0){ alert("Số tiết phải là số nguyên lớn hơn 0."); return; }
    const gh = gioihanRaw ? Number(gioihanRaw) : 1;
    if (!Number.isInteger(gh) || gh <= 0){ alert("Giới hạn phải là số nguyên lớn hơn 0 (để trống = 1)."); return; }
    if (!viettat){ alert("Nhập tên viết tắt (tên hiện trên TKB)."); return; }

    const entry = {
        id: editing ? _normText(prev?.id) : "",
        lop: classes,
        mon: mons,
        gv,
        sotiet: String(st),
        gioihan: String(gh),
        viettat
    };

    const problem = dayGhepNameProblem(entry);
    if (problem){ alert("⚠ " + problem); return; }

    // Khoá nội bộ: tránh các dòng khác; dòng đang sửa giữ khoá cũ nếu còn dùng được
    const seen = new Set();
    list.forEach((e, i) => { if (!(editing && i === DG_EDIT_INDEX)) dayGhepKeys(e).forEach(k => seen.add(k.toLowerCase())); });
    if (prev) entry.ten = _normText(prev.ten);
    entry.ten = dayGhepResolveIdentity(entry, seen);

    const newName = dayGhepLabel(entry);
    const newIdentity = dayGhepIdentity(entry);
    const oldNames = prev ? dayGhepCellNames(prev) : [];
    const oldIdentity = prev ? dayGhepIdentity(prev) : "";
    const oldClasses = prev ? dayGhepClasses(prev) : [];

    if (prev){
        const keep = new Set(classes.map(c => c.toLowerCase()));
        // Lớp bị bỏ khỏi dòng: gỡ mọi ô tiết của dòng ở lớp đó
        oldClasses.filter(c => !keep.has(c.toLowerCase())).forEach(c => dayGhepRemoveTkbCells(c, oldNames));
        // Lớp còn lại: đổi tên viết tắt -> ô TKB đổi theo, giữ nguyên vị trí
        const stay = oldClasses.filter(c => keep.has(c.toLowerCase()));
        if (oldIdentity !== newIdentity) stay.forEach(c => dayGhepRenameTkbCells(c, oldNames, newIdentity));
        if (!entry.id) entry.id = dayGhepNewId();
        list[DG_EDIT_INDEX] = entry;
    } else {
        entry.id = dayGhepNewId();
        list.push(entry);
    }
    const at = editing ? DG_EDIT_INDEX : list.length - 1;
    syncDayGhepProjection();
    saveStore();
    dayGhepCloseDialog();
    DG_SELECTED = new Set([at]);
    DG_LAST_INDEX = at;
    dayGhepRerender();
    showBottomPopup(editing ? `Đã cập nhật dạy ghép "${newName}".` : `Đã thêm dạy ghép "${newName}".`, "ok");
}
