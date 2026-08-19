# Bản giao việc: deploy TKBCherry lên Cloud Run (dành cho Antigravity)

> Mục tiêu: đưa bản solver mới (đã có 2 thuật toán **Cherry** và **Flash**) lên Cloud Run,
> rồi khai báo lại profile cho ứng dụng. **Không sửa thuật toán, không sửa deploy.ps1.**

## 0. Bối cảnh (đọc trước khi làm)
- Repo: `C:\Users\Love\Documents\Codex\TKBCherry`
- Mới thêm: `solver_runtime/src/tkb_engine_v3/**` (Cherry, thuần Python) và
  `solver_runtime/src/tkb_optimizer_ref/unified_cpsat_solver.py` (Flash, CP-SAT, cần `ortools`).
- `solve_stdio.py` định tuyến theo `settings.engine`: `cherry` → Cherry, `flash` → Flash, để trống → bộ giải cũ.
- Gói build của Cloud Run tự lấy **mọi file .py trong `solver_runtime/src`** ⇒ hai engine tự động vào image, KHÔNG cần sửa Dockerfile.
- Cấu hình dịch vụ: region `asia-southeast2`, service `tkb-solver`, 6 vCPU / 4 GiB, timeout 300s, trần solver 285s, max instances 3, luôn `--no-allow-unauthenticated`.

## 1. Điều kiện tiên quyết (kiểm tra, đừng bỏ qua)
```powershell
gcloud version
gcloud auth list          # phải có 1 tài khoản ACTIVE
gcloud config get-value project
```
- Nếu chưa đăng nhập: `gcloud auth login` (đăng nhập tương tác trên chính máy này).
- **Tuyệt đối không** dán mật khẩu / OAuth token / file JSON service-account vào chat, vào tham số lệnh, hay vào repo.
- Billing phải đang bật cho project; script sẽ tự kiểm tra và dừng nếu chưa bật.
- Nên commit hoặc stash thay đổi trước khi deploy, vì script đóng gói từ worktree hiện tại:
```powershell
git status --short
```

## 2. Chạy thử khan (không deploy, chỉ dựng gói build và in digest)
```powershell
powershell -ExecutionPolicy Bypass -File tools\cloud-run\deploy.ps1 `
  -ProjectId project-61ee7855-507e-40a3-879 `
  -ValidateBuildContext
```
Kỳ vọng: in ra JSON `{"ok":true,"files":...,"bytes":...,"solverDigest":"...","includesTests":false}`.
Nếu `ok` khác true hoặc báo file lạ trong gói build ⇒ **dừng lại và báo cáo**, đừng deploy.

## 3. Deploy thật
```powershell
powershell -ExecutionPolicy Bypass -File tools\cloud-run\deploy.ps1 `
  -ProjectId project-61ee7855-507e-40a3-879 `
  -ConfirmDeployment
```
Nếu project đã có sẵn 2 service account thì thêm (không bắt buộc):
```powershell
  -InvokerServiceAccount tkb-cloud-run-invoker@project-61ee7855-507e-40a3-879.iam.gserviceaccount.com `
  -RuntimeServiceAccount tkb-cloud-run-runtime@project-61ee7855-507e-40a3-879.iam.gserviceaccount.com
```
Script sẽ: bật API → tạo Artifact Registry nếu thiếu → build qua Cloud Build → deploy revision mới với
`--no-traffic` + canary tag → tự gọi `/health` và một bài `/solve` tổng hợp → chỉ khi bài kiểm tra đạt
(đủ tiết, hard-valid, 0 chưa xếp, 0 buổi 1 tiết, 0 trống ≥2, đúng digest) mới chuyển 100% traffic.
Thất bại ở bất kỳ bước nào → script tự rollback traffic về revision cũ.

## 4. Sau khi deploy — 3 giá trị script in ra
```
Service URL: https://tkb-solver-....run.app
Solver digest: <sha256>
TKB_CLOUD_PROFILE={"id":"cloud-run-...","projectId":"...","region":"asia-southeast2","url":"...","solverDigest":"...",...}
```
Việc phải làm:
1. **Dán nguyên dòng `TKB_CLOUD_PROFILE=...`** vào ứng dụng: Super Admin → *Đổi tài khoản Google Cloud*.
   (Ứng dụng ghim digest này; ảnh cũ/không đúng sẽ bị từ chối kết quả.)
2. Trên VPS, đặt biến môi trường cho service (không phải trong repo):
   ```
   TKB_CLOUD_RUN_URL=<Service URL>
   TKB_CLOUD_RUN_AUDIENCE=<Service URL>
   TKB_CLOUD_RUN_SOLVER_DIGEST=<Solver digest>
   ```
   VPS cần danh tính ADC có `roles/run.invoker` trên đúng service này (Workload Identity Federation ưu tiên).

## 5. Nghiệm thu
- Mở ứng dụng, bấm lần lượt **▶ Sắp xếp**, **🍒 Cherry**, **⚡ Flash** trên cùng một dữ liệu.
- Kỳ vọng: cả ba đều trả lịch, không báo lỗi; Flash nhanh nhất (~25–90s), Cherry ~50–260s.
- Log đối chiếu: `Cherry/logs/cherry-last.json`, `Flash/logs/flash-last.json`, tiến trình realtime `temp/solver_live.log`.
- Nếu Flash báo `flash_fallback_reason` = thiếu `ortools` ⇒ image build sai, kiểm tra lại `solver_runtime/requirements.txt` (phải có `ortools==9.15.6755`).

## 6. Rollback thủ công (nếu cần)
```powershell
gcloud run revisions list --service tkb-solver --region asia-southeast2 --project project-61ee7855-507e-40a3-879
gcloud run services update-traffic tkb-solver --region asia-southeast2 --project project-61ee7855-507e-40a3-879 --to-revisions <REVISION_CU>=100
```

## 7. Lỗi hay gặp
| Triệu chứng | Xử lý |
|---|---|
| `pwsh ... is not recognized` | Máy chỉ có Windows PowerShell 5.1 → dùng `powershell -ExecutionPolicy Bypass -File ...` như trên |
| `running scripts is disabled` | Đã có `-ExecutionPolicy Bypass` trong lệnh; đừng đổi policy toàn máy |
| `Google Cloud CLI (gcloud) is required` | Cài Google Cloud SDK rồi mở lại terminal |
| `No active gcloud account` | `gcloud auth login` |
| Billing chưa bật | Bật trong Google Cloud Console (thao tác tài chính, không tự động hoá) |
