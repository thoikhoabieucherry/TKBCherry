# TKB Cherry — Cloud execution và đồng bộ chi phí

Tài liệu này là hợp đồng vận hành để một người hoặc một AI khác có thể tái
tạo luồng Cloud Run/Google Billing mà không phải đoán cấu hình. Không đưa
password, token, cookie, service-account key hay file ADC vào repository.

> **Trạng thái 2026-08-02:** luồng đồng bộ chi phí bên dưới được giữ lại làm
> tài liệu/rollback nhưng không còn thuộc giao diện vận hành chính. Candidate
> `20260802-user-usage-only-v9` chỉ hiển thị số lượt gọi theo người dùng và
> tắt cả `tkb-google-cloud-usage.timer` lẫn
> `tkb-google-cloud-usage.path`; chi phí được chủ hệ thống xem trực tiếp trong
> Google Cloud Console. Không chạy lại installer trong tài liệu này trừ khi có
> quyết định rõ ràng khôi phục thẻ chi phí.

## Mục tiêu và nguyên tắc

- Solver CP-SAT/Python, Rust API và thuật toán VPS/Cloud Run là các thành phần
  riêng. Bộ đồng bộ chi phí không chạy trong luồng POST /api/solve-data.
- Tiền thật chỉ lấy từ Google Detailed Billing Export qua BigQuery. Không dùng
  estimatedCostUsd, reservation hay số liệu nội bộ để giả làm hóa đơn.
- Cloud Monitoring chỉ là số liệu vận hành gần thời gian thực; Google Billing
  Export có thể trễ nhiều giờ, nhất là lần xuất đầu tiên.
- Project ID, service URL, digest, bảng BigQuery, location và IAM nằm ở máy
  chủ/deployment environment. Super Admin chỉ xem trạng thái và chi phí.
- Khi có nhiều nhà cung cấp, mỗi provider phải xuất cùng một hợp đồng snapshot
  và không được trộn tiền của provider này với provider khác.

## Luồng đồng bộ chi phí cũ/tùy chọn (Google Cloud Run)

    Cloud Run tkb-solver
           |
           +-- Cloud Monitoring API ---------+  (gần thời gian thực)
           +-- Detailed Billing Export -> BigQuery (hóa đơn, có độ trễ)
                                             |
                                    google_cloud_usage_sync.py
                                    (systemd timer/path, ADC/WIF)
                                             |
             /opt/cherry-scheduler/data/google-cloud-usage.json (0600)
                                             |
                Rust /api/admin/solver-usage (Super Admin only)
                                             |
                                    Super Admin cost card

Các file vận hành:

- solver_runtime/scripts/google_cloud_usage_sync.py: gọi Monitoring, Cloud Run
  v2 và BigQuery, ghi snapshot atomic.
- tools/cloud-run/tkb-google-cloud-usage.service: one-shot sync.
- tools/cloud-run/tkb-google-cloud-usage.timer: sync tự động mỗi 10 phút; nút
  đồng bộ thủ công vẫn kích hoạt ngay qua systemd path.
- tools/cloud-run/tkb-google-cloud-usage.path: nhận yêu cầu “Đồng bộ chi phí”.
- rust_api/src/google_cloud_usage.rs: allowlist dữ liệu, kiểm tra freshness,
  kiểm tra scope với profile Cloud Run và tạo marker refresh.
- rust_api/src/main.rs: endpoint quản trị.
- web/super-admin.js: POST refresh, poll snapshot mới, hiển thị số tiền.

Super Admin cũng đọc `usage.accountRequests` từ cùng endpoint để tổng hợp số lượt
theo trường: tổng lượt, Cloud Run, VPS, hoàn tất, thất bại và đang chạy. Đây là
số liệu thực thi nội bộ, không phải phép chia hóa đơn Google. Chi phí tổng vẫn
chỉ lấy từ Detailed Billing Export để tránh hiển thị một con số ước tính như
chi phí thật của từng trường.

## Cấu hình máy chủ

/etc/tkb-google-cloud-usage.env (mode 0600) chỉ chứa định danh công khai:

    TKB_GOOGLE_CLOUD_PROJECT_ID=project-61ee7855-507e-40a3-879
    TKB_GOOGLE_CLOUD_REGION=asia-southeast2
    TKB_GOOGLE_CLOUD_SERVICE=tkb-solver
    TKB_GOOGLE_CLOUD_MONITOR_SERVICE_ACCOUNT=tkb-cloud-run-invoker@PROJECT.iam.gserviceaccount.com
    TKB_GOOGLE_CLOUD_LOOKBACK_SECONDS=3600
    TKB_GOOGLE_CLOUD_STALE_AFTER_SECONDS=300
    TKB_GOOGLE_BILLING_EXPORT_TABLE=PROJECT.DATASET.gcp_billing_export_resource_v1_ACCOUNT
    TKB_GOOGLE_BILLING_QUERY_PROJECT=PROJECT
    TKB_GOOGLE_BILLING_LOCATION=US
    TKB_GOOGLE_BILLING_START_DATE=YYYY-MM-DD

PROJECT, DATASET, ACCOUNT phải là giá trị thật của deployment. Dùng Detailed
export có tên gcp_billing_export_resource_v1_*, không dùng Standard export,
vì query phải lọc đúng resource Cloud Run tkb-solver. Query lọc project,
Cloud Run, ngày, resource.name/resource.global_name, region và service; không
cộng toàn bộ Cloud Run khác trong project.

ADC/WIF nằm ngoài application tree, ví dụ
/root/.config/tkb-cherry/wif/credentials.json, mode 0600. Không tạo hoặc
commit service-account key. Identity đọc dữ liệu cần tối thiểu:

    roles/monitoring.viewer       (project)
    roles/run.viewer              (project)
    roles/bigquery.jobUser        (query project)
    roles/bigquery.dataViewer     (Billing Export dataset)

Cài/kiểm tra trên VPS:

    install -m 0600 tools/cloud-run/google-cloud-usage.env.example \
      /etc/tkb-google-cloud-usage.env
    bash tools/cloud-run/install-google-cloud-usage-sync.sh
    systemctl is-enabled --quiet tkb-google-cloud-usage.timer
    systemctl is-enabled --quiet tkb-google-cloud-usage.path

## API contract

Đọc snapshot:

    GET /api/admin/solver-usage
    GET /api/admin/solver-infrastructure
    Authorization: Bearer <session>

Chỉ session role=superadmin được phép. googleCloud.billing có thể có:

- reconciled=true cùng grossCost, credits, promotionCreditsApplied, netCost,
  currency, rowCount, latestExportAtMs: số liệu Billing Export thật đến thời
  điểm latestExportAtMs.
- reconciled=false và status=billing_export_pending: bảng chưa có dòng.
- stale=true cùng refreshStatus: lỗi tạm thời; giữ số tiền đối soát gần nhất
  nhưng UI phải cảnh báo stale.
- status=google_usage_scope_mismatch: profile Cloud Run và project/region/
  service của snapshot lệch nhau; tuyệt đối không hiển thị số tiền.

Yêu cầu đồng bộ ngay:

    POST /api/admin/solver-usage/refresh
    Authorization: Bearer <session>
    -> HTTP 202

Response có ok=true, refreshRequested=true, refreshRequestedAtMs và snapshot
hiện tại. Endpoint chỉ ghi một marker timestamp. systemd.path kích hoạt helper
tách biệt; Rust không chờ Google và không làm chậm solver. Frontend poll GET
đến khi sampledAtMs >= refreshRequestedAtMs hoặc hết thời gian chờ có giới hạn.
Nút này không thể ép Google xuất Billing rows sớm hơn; nó chỉ yêu cầu đọc lại
dữ liệu Google mới nhất hiện có.

## Provider contract cho tương lai

Google là provider đầu tiên. Khi thêm Microsoft/Azure hoặc Cloudflare:

1. Tạo adapter riêng, không sửa solver, chuyển API chi phí/metrics của provider
   thành snapshot có provider, scope, sampledAtMs, billing và warnings.
2. Lưu credential/refresh token ở secret manager hoặc file root-owned ngoài
   repo; API web chỉ nhận providerId đã được server allowlist.
3. Giữ billing.reconciled chỉ cho hóa đơn thật; estimate phải nằm ở telemetry
   khác và không được cộng vào netCost.
4. Mỗi profile phải có scope bất biến: provider, project/subscription/account,
   region và service. Rust phải ẩn tiền khi snapshot không trùng active profile.
5. Giữ endpoint /api/admin/solver-usage ổn định; có thể trả thêm providers[],
   nhưng không đổi nghĩa googleCloud đang dùng.

Không đưa “đổi tài khoản Google” vào giao diện bằng cách nhận token/cookie.
Đổi cloud ownership là thao tác deployment một lần trên máy chủ; sau đó timer
và API tự vận hành.

## Kiểm thử và chẩn đoán

    python -m unittest solver_runtime.tests.test_google_cloud_usage_sync
    node --test e2e_tests/solver_infrastructure_portals_node.test.js

Trên VPS, chỉ đọc và không in credential:

    systemctl status tkb-google-cloud-usage.timer tkb-google-cloud-usage.path
    journalctl -u tkb-google-cloud-usage.service -n 30 --no-pager

Nếu billing_export_pending, kiểm tra bảng BigQuery và chờ Google. Lần đầu
thường vài giờ, đôi khi hơn 24 giờ. Không đổi query thành tổng mọi Cloud Run
chỉ để làm hiện một con số.

## Dọn Agent cũ

Agent Web/EXE đã bị tắt ở client. Các build/cache/ZIP cũ không thuộc runtime
Cloud Run phải được xóa khỏi workspace và không đưa vào production package.
Backend compatibility chỉ giữ lại khi cần cho client cache cũ; không được
quảng bá hoặc bật lại lane Agent trong planner.
