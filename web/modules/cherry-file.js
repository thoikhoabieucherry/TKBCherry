/* ============================================================
   FILE .cherry — XUẤT / NHẬP TRỌN BỘ DỮ LIỆU MỘT TRƯỜNG (02/09/2026)

   Chủ dự án: "thêm 1 nút kế bên Dạy ghép, trong đó có xuất và import dữ liệu
   dạng file <mã trường>.cherry ... bao gồm dữ liệu phân công + sắp xếp cũng như
   các ràng buộc mặc định của TKB".

   File .cherry = JSON (UTF-8) bọc TRỌN kho của trường đang mở (biến DATA):
     { format:"tkbcherry", version:1, app, schoolId, schoolName, exportedAt,
       summary:{đếm nhanh}, data:{ khoi, lop, giaovien, monhoc, mon (Tiết chuẩn),
       phong, pccmMatrix / pccmTietMatrix / pccmGioihanMatrix (Phân công), dayGhep,
       tkb (TKB đã xếp, kể cả ô cố định), tkbUserOff, tkbConstraints (Yêu cầu:
       fixedOff 5 nhánh, luật giáo viên, luật môn học, nhóm, timeLimit...),
       tkbLessonTeachers, tkbLessonRooms, tkbSolverResult ... } }
   - XUẤT = toàn bộ DATA đúng như đang lưu trong kho (không lọc) để nhập lại y nguyên.
     Tên file = <mã trường>.cherry (mã kho, ví dụ v2mjxf2tbt1.cherry).
   - NHẬP = THAY toàn bộ kho của trường ĐANG MỞ (hỏi xác nhận, nêu rõ số liệu hai
     bên, cảnh báo nếu file thuộc mã trường khác), đi đúng đường nạp bản mới từ kho
     (appAdoptRemoteData: ensureDataShape + syncDerivedDataIntegrity + vẽ lại) rồi
     saveStore ngay; tab Sắp xếp đang mở sẽ tự nạp bản mới khi quay lại (so _lastModified).
   - Nhận cả kho THÔ (JSON không bọc, có lop/giaovien/pccmMatrix) để cứu dữ liệu
     từ bản dump máy chủ. KHÔNG nhập file rỗng (hasMeaningfulData) — tránh xoá sạch trường.
============================================================ */

const CHERRY_FILE_FORMAT = "tkbcherry";
const CHERRY_FILE_VERSION = 1;

/* ---------------- Trường đang mở ---------------- */
function cherryFileSchoolId(){
    try{
        const sid = (typeof getSchoolId === "function") ? getSchoolId() : "";
        if (sid) return String(sid);
    }catch(_){ /* ignore */ }
    try{ if (typeof CTX !== "undefined" && CTX && CTX.schoolId) return String(CTX.schoolId); }catch(_){ }
    return "default";
}

function cherryFileSchoolLabel(){
    try{
        const s = (typeof getSchoolLabel === "function") ? getSchoolLabel() : "";
        if (s) return String(s);
    }catch(_){ /* ignore */ }
    return cherryFileSchoolId();
}

function cherryFileSafeName(sid){
    const s = String(sid || "default").trim().replace(/[^0-9a-zA-Z_\-]+/g, "");
    return (s || "default") + ".cherry";
}

function cherryFileData(){
    return (typeof DATA !== "undefined" && DATA && typeof DATA === "object") ? DATA : {};
}

/* ---------------- Đếm nhanh để hiện trong hộp thoại / hộp xác nhận ---------------- */
function cherryFileCountTkbCells(tkb){
    let n = 0;
    if (!tkb || typeof tkb !== "object") return 0;
    Object.values(tkb).forEach(byDay => {
        if (!byDay || typeof byDay !== "object") return;
        Object.values(byDay).forEach(byBuoi => {
            if (!byBuoi || typeof byBuoi !== "object") return;
            Object.values(byBuoi).forEach(arr => {
                if (!Array.isArray(arr)) return;
                arr.forEach(cell => {
                    if (!cell || cell === "OFF") return;
                    if (typeof cell === "object"){
                        if (cell.off === true) return;
                        if (String(cell.mon || cell.val || "").trim() === "") return;
                    }
                    n++;
                });
            });
        });
    });
    return n;
}

// Số "mục yêu cầu": ô nghỉ/cố định (5 nhánh fixedOff) + số luật giáo viên + số luật môn theo lớp.
function cherryFileCountRules(c){
    if (!c || typeof c !== "object") return 0;
    let n = 0;
    const fixedOff = (c.fixedOff && typeof c.fixedOff === "object") ? c.fixedOff : {};
    Object.values(fixedOff).forEach(branch => {
        if (!branch || typeof branch !== "object") return;
        Object.values(branch).forEach(slots => {
            if (!slots || typeof slots !== "object") return;
            n += Object.values(slots).filter(Boolean).length;
        });
    });
    const teacher = (c.teacher && typeof c.teacher === "object") ? c.teacher : {};
    Object.values(teacher).forEach(rule => { if (rule && typeof rule === "object") n += Object.keys(rule).length; });
    const subject = (c.subject && typeof c.subject === "object") ? c.subject : {};
    Object.values(subject).forEach(s => {
        const byClass = (s && typeof s === "object" && s.byClass && typeof s.byClass === "object") ? s.byClass : {};
        Object.values(byClass).forEach(rule => { if (rule && typeof rule === "object") n += Object.keys(rule).length; });
    });
    return n;
}

function cherryFileSummary(d){
    const data = (d && typeof d === "object") ? d : {};
    const len = a => Array.isArray(a) ? a.length : 0;
    const keys = o => (o && typeof o === "object" && !Array.isArray(o)) ? Object.keys(o).length : 0;
    return {
        khoi: len(data.khoi),
        lop: len(data.lop),
        giaovien: len(data.giaovien),
        monhoc: len(data.monhoc),
        tietchuan: len(data.mon),
        phancong: keys(data.pccmMatrix),
        dayGhep: len(data.dayGhep),
        tkbCells: cherryFileCountTkbCells(data.tkb),
        yeuCau: cherryFileCountRules(data.tkbConstraints)
    };
}

function cherryFileSummaryText(s){
    const x = s || cherryFileSummary({});
    return `${x.lop} lớp · ${x.giaovien} giáo viên · ${x.monhoc} môn · ${x.tietchuan} dòng tiết chuẩn · `
        + `${x.phancong} ô phân công · ${x.dayGhep} dòng dạy ghép · ${x.tkbCells} ô TKB đã xếp · ${x.yeuCau} mục yêu cầu`;
}

// Cùng tiêu chí với shared/storage.js hasMeaningfulData (dùng bản ở đó nếu có).
function cherryFileHasMeaningfulData(data){
    try{
        if (window.TKBStorage && typeof window.TKBStorage.hasMeaningfulData === "function"){
            return !!window.TKBStorage.hasMeaningfulData(data);
        }
    }catch(_){ /* ignore */ }
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const has = o => !!(o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length);
    return ["khoi","lop","giaovien","monhoc","mon"].some(k => Array.isArray(data[k]) && data[k].length > 0)
        || has(data.pccmMatrix) || has(data.pccmTietMatrix) || has(data.pccmGioihanMatrix)
        || has(data.tkb) || has(data.tkbUserOff) || has(data.tkbConstraints);
}

/* ---------------- XUẤT ---------------- */
function cherryFileBuildExport(){
    const sid = cherryFileSchoolId();
    const data = cherryFileData();
    try{ if (typeof appNormalizeDataNFC === "function") appNormalizeDataNFC(); }catch(_){ }
    const payload = {
        format: CHERRY_FILE_FORMAT,
        version: CHERRY_FILE_VERSION,
        app: "tkbcherry.com",
        schoolId: sid,
        schoolName: cherryFileSchoolLabel(),
        exportedAt: new Date().toISOString(),
        summary: cherryFileSummary(data),
        data
    };
    return { name: cherryFileSafeName(sid), text: JSON.stringify(payload), summary: payload.summary };
}

function cherryFileDownload(name, text){
    const blob = new Blob([text], {type: "application/json;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        try{ URL.revokeObjectURL(url); }catch(_){ }
        try{ if (typeof a.remove === "function") a.remove(); }catch(_){ }
    }, 1500);
}

function cherryFileExport(){
    try{
        const out = cherryFileBuildExport();
        cherryFileDownload(out.name, out.text);
        cherryFileSetStatus(`Đã xuất ${out.name} — ${cherryFileSummaryText(out.summary)}.`, "ok");
        return out.name;
    }catch(err){
        console.error("cherryFileExport failed", err);
        alert("❌ Không xuất được file .cherry: " + (err && err.message ? err.message : err));
        cherryFileSetStatus("Xuất file thất bại.", "error");
        return "";
    }
}

/* ---------------- NHẬP ---------------- */
function cherryFileParse(text){
    let obj = null;
    try{ obj = JSON.parse(String(text == null ? "" : text)); }
    catch(_){ return {ok:false, error:"Không đọc được file: nội dung không phải file .cherry hợp lệ (JSON hỏng)."}; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)){
        return {ok:false, error:"File không đúng định dạng .cherry của TKB Cherry."};
    }
    const meta = {schoolId:"", schoolName:"", exportedAt:"", version:0, wrapped:false};
    let data = null;
    if (String(obj.format || "") === CHERRY_FILE_FORMAT){
        if (!obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)){
            return {ok:false, error:"File .cherry thiếu phần dữ liệu (data)."};
        }
        data = obj.data;
        meta.wrapped = true;
        meta.schoolId = String(obj.schoolId || "");
        meta.schoolName = String(obj.schoolName || "");
        meta.exportedAt = String(obj.exportedAt || "");
        meta.version = Number(obj.version) || 0;
    } else if (Array.isArray(obj.lop) || Array.isArray(obj.giaovien) || (obj.pccmMatrix && typeof obj.pccmMatrix === "object")){
        data = obj;   // kho thô (bản dump kvstore / localStorage), không bọc
    } else {
        return {ok:false, error:"File không đúng định dạng .cherry của TKB Cherry (thiếu format \"tkbcherry\")."};
    }
    if (!cherryFileHasMeaningfulData(data)){
        return {ok:false, error:"File không có dữ liệu (không có lớp / giáo viên / môn / phân công / TKB) — không nhập để tránh xoá sạch trường."};
    }
    const warnings = [];
    if (meta.version > CHERRY_FILE_VERSION){
        warnings.push(`File tạo bởi phiên bản mới hơn (v${meta.version}); bản này đọc v${CHERRY_FILE_VERSION} — vẫn nhập được nhưng có thể thiếu mục mới.`);
    }
    return {ok:true, data, meta, warnings, summary: cherryFileSummary(data)};
}

function cherryFileFormatTime(iso){
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso || "");
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

async function cherryFileApplyImport(parsed, fileName){
    if (!parsed || parsed.ok !== true || !parsed.data) return false;
    const sid = cherryFileSchoolId();
    const label = cherryFileSchoolLabel();
    const cur = cherryFileSummary(cherryFileData());
    const next = parsed.summary || cherryFileSummary(parsed.data);
    const meta = parsed.meta || {};
    const lines = [];
    let head = `Nhập file "${fileName || "(không tên)"}"`;
    if (meta.schoolName || meta.schoolId) head += ` — trường ${meta.schoolName || meta.schoolId}`;
    if (meta.exportedAt) head += `, xuất lúc ${cherryFileFormatTime(meta.exportedAt)}`;
    lines.push(head + ".");
    lines.push(`Nội dung file: ${cherryFileSummaryText(next)}.`);
    lines.push(`Dữ liệu HIỆN TẠI của "${label}": ${cherryFileSummaryText(cur)}.`);
    if (meta.schoolId && meta.schoolId !== sid){
        lines.push(`⚠ File thuộc mã trường "${meta.schoolId}", còn trường đang mở là "${sid}".`);
    }
    (parsed.warnings || []).forEach(w => lines.push("⚠ " + w));
    lines.push("");
    lines.push("TOÀN BỘ dữ liệu hiện tại của trường (Khối, Lớp, Giáo viên, Môn, Tiết chuẩn, Phân công, Dạy ghép, Yêu cầu và TKB đã xếp) sẽ bị THAY THẾ bằng nội dung file. Nếu chưa có bản sao, hãy bấm Hủy rồi Xuất file .cherry trước.");
    lines.push("Tiếp tục nhập?");
    if (!confirm(lines.join("\n"))){
        cherryFileSetStatus("Đã hủy nhập.", "info");
        return false;
    }

    const incoming = JSON.parse(JSON.stringify(parsed.data));
    delete incoming._lastModified;   // saveStore đóng dấu thời gian mới -> tab Sắp xếp nhận ra bản mới
    delete incoming._updatedAt;
    if (typeof appAdoptRemoteData === "function"){
        appAdoptRemoteData(incoming);
    } else {
        DATA = incoming;
        try{ if (typeof ensureDataShape === "function") ensureDataShape(); }catch(_){ }
    }

    let saved = false;
    let saveErr = "";
    try{
        const r = await saveStore({force:true, throwOnError:true});
        saved = r !== false;
    }catch(err){
        saveErr = String(err && err.message ? err.message : (err || ""));
    }
    if (!saved){
        let guardMsg = "";
        try{ guardMsg = String(window.TKBStorage_lastSaveError?.message || ""); }catch(_){ }
        alert("⚠ Đã nạp nội dung file vào trang nhưng CHƯA LƯU được vào kho trường."
            + ((guardMsg || saveErr) ? "\n" + (guardMsg || saveErr) : "")
            + "\nHãy kiểm tra kết nối / đăng nhập rồi thử lại, hoặc tải lại trang để bỏ bản vừa nạp.");
        cherryFileSetStatus("Đã nạp nhưng chưa lưu được vào kho.", "error");
        return false;
    }
    const doneText = cherryFileSummaryText(cherryFileSummary(cherryFileData()));
    cherryFileSetStatus(`Đã nhập ${fileName || "file"} — ${doneText}.`, "ok");
    cherryFileRefreshSummary();
    alert(`✔ Đã nhập file .cherry vào trường "${label}".\n${doneText}.\nTrang Sắp xếp TKB (nếu đang mở ở tab khác) sẽ tự nạp bản mới khi bạn quay lại tab đó.`);
    return true;
}

async function cherryFileImportText(text, fileName){
    const parsed = cherryFileParse(text);
    if (!parsed.ok){
        alert("❌ " + parsed.error);
        cherryFileSetStatus(parsed.error, "error");
        return false;
    }
    return await cherryFileApplyImport(parsed, fileName);
}

function cherryFileReadText(file){
    if (file && typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Không đọc được file."));
        reader.readAsText(file, "utf-8");
    });
}

function cherryFileEnsureInput(){
    let inp = document.getElementById("cherryFileInput");
    if (inp) return inp;
    inp = document.createElement("input");
    inp.type = "file";
    inp.id = "cherryFileInput";
    inp.accept = ".cherry,.json,application/json";
    inp.style.display = "none";
    inp.addEventListener("change", async (ev) => {
        const file = ev.target && ev.target.files && ev.target.files[0];
        if (!file) return;
        cherryFileSetStatus(`Đang đọc ${file.name}…`, "info");
        try{
            const text = await cherryFileReadText(file);
            await cherryFileImportText(text, file.name);
        }catch(err){
            console.error("cherryFile import failed", err);
            alert("❌ Lỗi đọc file: " + (err && err.message ? err.message : err));
            cherryFileSetStatus("Đọc file thất bại.", "error");
        }finally{
            try{ ev.target.value = ""; }catch(_){ }   // chọn lại cùng một file vẫn kích hoạt change
        }
    });
    document.body.appendChild(inp);
    return inp;
}

function cherryFileTriggerImport(){
    const inp = cherryFileEnsureInput();
    try{ inp.value = ""; }catch(_){ }
    inp.click();
}

/* ---------------- Hộp thoại ---------------- */
function cherryFileSetStatus(msg, level){
    const el = document.getElementById("cfStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "cf-status" + (level ? " cf-status-" + level : "");
}

function cherryFileRefreshSummary(){
    const el = document.getElementById("cfSummary");
    if (el) el.textContent = "Đang có: " + cherryFileSummaryText(cherryFileSummary(cherryFileData())) + ".";
}

function cherryFileEnsureModal(){
    let el = document.getElementById("cfModal");
    if (el) return el;
    el = document.createElement("div");
    el.id = "cfModal";
    el.className = "modal cf-modal";
    el.innerHTML = `
        <div class="modal-content dg-modal-content cf-modal-content" role="dialog" aria-modal="true" aria-labelledby="cfModalTitle">
            <div class="dg-modal-head">
                <span class="dg-modal-icon" aria-hidden="true"></span>
                <h3 id="cfModalTitle">File .cherry</h3>
                <button type="button" class="dg-modal-close" title="Đóng" aria-label="Đóng" onclick="cherryFileClose()">&#x2715;</button>
            </div>
            <div class="dg-modal-body cf-modal-body">
                <p class="cf-intro">Một file <code id="cfFileName">default.cherry</code> chứa <b>trọn bộ dữ liệu</b> của trường
                <b id="cfSchool"></b>: Khối, Lớp, Giáo viên, Môn học, Tiết chuẩn, Phân công, Dạy ghép,
                <b>Yêu cầu</b> (ô nghỉ / cố định, luật giáo viên, luật môn học) và <b>thời khóa biểu đã xếp</b>
                (kể cả ô cố định). Nhập lại file này sẽ khôi phục đúng trạng thái lúc xuất.</p>
                <div class="cf-actions">
                    <div class="cf-action">
                        <button type="button" class="btn primary cf-btn" onclick="cherryFileExport()">&#x2B07; Xuất file .cherry</button>
                        <div class="cf-hint">Tải về máy bản sao toàn bộ dữ liệu hiện tại. Dùng để sao lưu, chuyển sang trường / tài khoản khác hoặc gửi hỗ trợ.</div>
                    </div>
                    <div class="cf-action">
                        <button type="button" class="btn cf-btn" onclick="cherryFileTriggerImport()">&#x2B06; Nhập file .cherry</button>
                        <div class="cf-hint"><b>Thay toàn bộ</b> dữ liệu của trường đang mở bằng nội dung file (có hỏi xác nhận, nêu rõ số liệu hai bên). Nên xuất một bản .cherry trước khi nhập.</div>
                    </div>
                </div>
                <div id="cfSummary" class="cf-summary"></div>
                <div id="cfStatus" class="cf-status" aria-live="polite"></div>
            </div>
            <div class="modal-actions dg-modal-actions">
                <button type="button" class="btn" onclick="cherryFileClose()">Đóng</button>
            </div>
        </div>`;
    document.body.appendChild(el);
    document.addEventListener("keydown", (ev) => {
        try{
            if (el.style.display !== "flex") return;
            if (ev.key === "Escape"){ ev.preventDefault(); cherryFileClose(); }
        }catch(_){ /* ignore */ }
    });
    return el;
}

function cherryFileOpen(){
    const modal = cherryFileEnsureModal();
    const fileName = document.getElementById("cfFileName");
    if (fileName) fileName.textContent = cherryFileSafeName(cherryFileSchoolId());
    const school = document.getElementById("cfSchool");
    if (school) school.textContent = cherryFileSchoolLabel();
    cherryFileRefreshSummary();
    cherryFileSetStatus("", "");
    modal.style.display = "flex";
}

function cherryFileClose(){
    const el = document.getElementById("cfModal");
    if (el) el.style.display = "none";
}
