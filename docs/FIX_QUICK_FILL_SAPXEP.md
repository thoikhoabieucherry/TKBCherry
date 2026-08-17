# Kế hoạch sửa lỗi: Nút "Sắp xếp tự động" không xếp nhanh

## Vấn đề

Nút "Sắp xếp tự động" hiện tại:
1. Chạy thuật toán greedy (`TKBFastSeed`) chỉ **2.8-4.5 giây** rồi gửi kết quả lên backend CP-SAT
2. Backend mất **300 giây** (5 phút) để xử lý
3. Khi áp dụng kết quả, bị lỗi `candidateContractRejected` → toàn bộ bị huỷ

**Yêu cầu:**
- Nút này phải xếp được **100% tiết** ngay lần đầu
- Thời gian xử lý phải **nhanh** (vài giây đến 20 giây)
- Không dùng cơ chế "hint" để backend xếp dần

## Phân tích thuật toán hiện có

### `tkb-fast-seed.js` (đã tốt)

Thuật toán greedy đã có sẵn và đúng hướng:
- Sắp xếp phân công theo độ "chật" (slack = slot khả dụng - số tiết cần xếp)
- Chọn slot bằng greedy best-fit
- Randomized restart (24 attempts)
- Min-conflicts repair (3 vòng)
- **Vấn đề:** Chỉ chạy **2.8-4.5 giây** là quá ngắn cho ~2000 tiết

### Giới hạn trong phân công

- **Phân công (pccmMatrix):** Có thể xếp **từ 1 đến giới hạn trên** tiết
- **Giáo viên yêu cầu (pccmGioihanMatrix):** Phải xếp đủ giới hạn dưới
- **Ví dụ:** Giới hạn trên = 4 → có thể xếp 1, 2, 3, hoặc 4 tiết

## Giải pháp

### Tạo file `web/pages/tkb-quick-fill.js`

File đã được tạo. Nội dung:

```javascript
// web/pages/tkb-quick-fill.js
// Hàm chính: runClientOnlyQuickFill(data, options)
// - Chạy TKBFastSeed với thời gian 12-18 giây (thay vì 2.8-4.5s)
// - Áp dụng trực tiếp vào UI, KHÔNG gửi lên backend
// - Trả về {ok, complete, lessons, unassignedAssignments, quality, elapsedMs}
```

### Sửa `tkb-rust-bridge.js`

#### Bước 1: Thêm script include trong HTML

Trong `sapxep.html` và `app.html`, thêm:

```html
<script src="tkb-quick-fill.js?v=20260813"></script>
```

#### Bước 2: Thêm hàm áp dụng kết quả fast-seed

Thêm vào `tkb-rust-bridge.js` (sau dòng 6500):

```javascript
async function applyFastSeedResult(result, data){
  if(!result || !result.ok) return false;
  if(!data) data = getData();
  if(!data) return false;

  // Xoá các tiết đã xếp (không phải tiết cố định)
  for(const classId of Object.keys(data.tkb || {})){
    for(const day of ["thu2","thu3","thu4","thu5","thu6","thu7"]){
      for(const session of ["sang","chieu"]){
        if(!data.tkb[classId]?.[day]?.[session]) continue;
        data.tkb[classId][day][session] = data.tkb[classId][day][session].map(cell => {
          if(cell && cell.fixed) return cell;
          return null;
        });
      }
    }
  }

  // Áp dụng lessons từ fast-seed
  for(const lesson of result.lessons || []){
    const classId = lesson.classId;
    const day = `thu${lesson.day}`;
    const session = lesson.session === "AM" ? "sang" : "chieu";
    const idx = (lesson.period || 1) - 1;
    
    if(!data.tkb[classId]) data.tkb[classId] = {};
    if(!data.tkb[classId][day]) data.tkb[classId][day] = {};
    if(!data.tkb[classId][day][session]) data.tkb[classId][day][session] = [];
    
    // Đảm bảo đủ độ dài
    while(data.tkb[classId][day][session].length <= idx){
      data.tkb[classId][day][session].push(null);
    }
    
    if(!data.tkb[classId][day][session][idx]){
      data.tkb[classId][day][session][idx] = lesson.subject;
    }
    
    // Lưu teacher/room
    const key = `${classId}|${lesson.subject}`;
    if(lesson.teacher) data.tkbLessonTeachers[key] = lesson.teacher;
    if(lesson.room) data.tkbLessonRooms[key] = lesson.room;
  }

  // Trigger re-render
  if(typeof window.renderTKB === "function") window.renderTKB();
  if(typeof window.saveStore === "function"){
    await Promise.resolve(window.saveStore({force:true, trustedSolverApply:true}));
  }
  return true;
}
```

#### Bước 3: Sửa `sapXepTuDongAll` để gọi quick-fill TRƯỚC TIÊN

Tìm và sửa hàm `sapXepTuDongAll` (dòng ~19061):

Thêm kiểm tra ở đầu hàm, sau các kiểm tra preflight:

```javascript
// Sau dòng 19235 (prepareManualSolveIntent) và trước backend call:
// Thử quick-fill client-side TRƯỚC TIÊN
const quickFillResult = await new Promise(resolve => {
  if(!window.TKBQuickFill || typeof window.TKBQuickFill.runClientOnlyQuickFill !== "function"){
    resolve(null);
    return;
  }
  const data = getData();
  const expected = expectedLessonCount(data);
  if(expected <= 0 || expected > 5000){
    resolve(null);
    return;
  }
  setStatus("Đang xếp nhanh...", "info");
  window.TKBQuickFill.runClientOnlyQuickFill(data, {expected}).then(resolve).catch(() => resolve(null));
});

// Nếu quick-fill thành công (100%)
if(quickFillResult?.ok && quickFillResult?.complete){
  await applyFastSeedResult(quickFillResult, data);
  finishProgress("100%", "ok");
  setStatus("Đã xếp xong!", "ok");
  publishE2EState("done", {lessons: quickFillResult.lessons}, {message: "Đã xếp xong!"});
  releaseAutoSortButtonSoon();
  return {lessons: quickFillResult.lessons};
}

// Nếu quick-fill không đạt 100% - hiển thị chi tiết
if(quickFillResult && !quickFillResult.complete){
  const msg = quickFillResult.unassignedMessage || 
    `Còn thiếu ${quickFillResult.unassignedPeriods} tiết chưa xếp được.`;
  setStatus(msg, "warning");
  
  // Áp dụng những gì có được
  if(quickFillResult.lessons?.length > 0){
    await applyFastSeedResult(quickFillResult, data);
  }
  
  // Đừng tự động gọi backend - để user quyết định
  // Bỏ comment dòng dưới nếu muốn tự động thử backend
  // return null; // để user chọn
  
  releaseAutoSortButtonSoon();
  return null;
}

// Tiếp tục luồng backend hiện tại (nếu user muốn tối ưu)
```

## Kiểm tra

### 1. Test nhanh

Mở devtools, chạy:
```javascript
const result = await window.TKBQuickFill.runClientOnlyQuickFill(window.getData(), {expected: 2175});
console.log("Complete:", result.complete);
console.log("Scheduled:", result.scheduledPeriods);
console.log("Missing:", result.unassignedPeriods);
```

### 2. Test trên UI

1. Bấm "Sắp xếp tự động"
2. Thanh tiến trình phải chạy nhanh (vài giây)
3. Không hiện lỗi "Backend đã xếp đủ... nhưng khi áp dụng..."
4. Tất cả tiết phải lên lưới

### 3. Regression test

Chạy `node e2e_tests/test_suite.py` để đảm bảo không phá gì khác.

## Tóm tắt files cần sửa

| File | Hành động |
|------|-----------|
| `web/pages/tkb-quick-fill.js` | Đã tạo ✓ |
| `sapxep.html`, `app.html` | Thêm `<script src="tkb-quick-fill.js">` |
| `web/pages/tkb-rust-bridge.js` | Thêm `applyFastSeedResult`, sửa `sapXepTuDongAll` |

## Thời gian ước tính

- Tạo file: 5 phút
- Tích hợp: 15-20 phút
- Test: 10 phút
- **Tổng: ~30-40 phút**
