# TKBCherry Agent

Agent chạy bộ xếp trên máy Windows hoặc VPS riêng, nhưng toàn bộ trạng thái công việc vẫn nằm trên máy chủ TKBCherry. Vì vậy, bấm **Xếp** ở một trình duyệt rồi mở trình duyệt khác vẫn có thể thấy cùng tiến trình và cùng kết quả.

Agent chỉ tạo kết nối HTTPS đi ra ngoài. Nó không mở cổng, không chạy web server và không nhận kết nối trực tiếp từ Internet.

## Cài trên Windows

Hỗ trợ Windows 10/11 64-bit. Agent chạy hằng ngày bằng quyền người dùng thường. Khi mở, Agent tự chuyển sang **ON**, chạy nền và thu xuống khay thông báo như UniKey; không có màn hình cài đặt phải bấm thủ công. Trên máy bật Smart App Control, Agent tự chuẩn bị bộ giải WSL ở nền và chỉ để Windows hiện một hộp UAC khi hệ điều hành bắt buộc quyền Administrator.

1. Trong trang Xếp trên máy tính Windows, bấm **Agent** để tải `TKBCherryAgent-Windows.zip`.
2. Chọn **Giải nén tất cả**. Gói phát hành chỉ chứa đúng một file `TKBCherryAgent.exe` ngay ở thư mục gốc; không chạy EXE trực tiếp bên trong ZIP.
3. Mở `TKBCherryAgent.exe` mới. Nếu một bản cũ đang chạy đúng tại đường dẫn Agent đã cài, bản mới chỉ dừng cây tiến trình đó, thay file theo kiểu atomic rồi tự khởi động lại; không cần người dùng tắt thủ công. Một file trùng hệt bản đang cài được dùng lại mà không kill/copy lại. Lần đầu Agent tự chép bản chính vào `C:\TKBCherryAgent\TKBCherryAgent.exe`; nếu Windows không cho ghi vào ổ C thì dùng `%LOCALAPPDATA%\TKBCherry\Agent\`. Agent tự chuyển sang **ON**, chạy nền và ẩn xuống khay ngay lập tức. Nếu máy cần WSL, bộ cài chạy nền trong lúc VPS vẫn sẵn sàng; chỉ hộp UAC bắt buộc của Windows mới xuất hiện. Logo TKBCherry được dùng cho EXE, cửa sổ, thanh tác vụ và khay hệ thống; Agent cũng tự đăng ký chạy cùng lần đăng nhập của tài khoản Windows hiện tại mà không cần quyền quản trị.
4. Ở lần đầu, Agent tự mở trang TKBCherry trong trình duyệt với mã dạng `XXXX-XXXX`. Đăng nhập đúng tài khoản, kiểm tra mã rồi chấp thuận trong vòng 5 phút.
5. Sau khi được duyệt, Agent tự nhận một token chỉ có quyền dùng API Agent và bắt đầu chờ công việc. Những lần chạy sau không phải ghép đôi lại khi token còn hợp lệ.

Bấm **TẮT AGENT** để ngừng nhận việc, dừng cả solver đang chạy và gỡ mục tự khởi động; bấm **BẬT AGENT** sẽ đăng ký lại. Nút X chỉ ẩn cửa sổ xuống khay như UniKey; kích đúp icon khay để mở lại, hoặc chuột phải để Mở, Bật, Tắt và Thoát nhanh. Sau khi hoàn tất cài đặt một lần, mọi lần mở thủ công hoặc chạy cùng Windows đều tự ON và chỉ nằm ở khay. Lệnh **Thoát** dừng phiên hiện tại nhưng giữ tự khởi động nếu Agent đang ON. Khi ON nhưng chưa có lượt xếp, Agent chỉ giữ kết nối chờ nhẹ và không chạy solver. Mục tự khởi động chỉ chứa đường dẫn `TKBCherryAgent.exe` và cờ cố định `--startup`; không có token hay dữ liệu người dùng. Gói Windows không dùng bộ cài CMD/PowerShell, không chứa sẵn token hay mật khẩu.

Nếu Windows Smart App Control chặn các thư viện solver native chưa có chữ ký tin cậy, Agent vẫn dùng khay thông báo Win32 thuần và để VPS xếp trong lúc chuẩn bị. Lần mở đầu tiên, Agent tự bật các thành phần WSL/Virtual Machine Platform theo đúng thứ tự, tự sửa/cập nhật gói WSL chính chủ nếu lệnh WSL bị treo, rồi cài Ubuntu cùng OR-Tools/SciPy đang dùng trên VPS. Máy có ảo hóa firmware và SLAT sẽ dùng WSL2; máy không có hai khả năng này tự dùng WSL1 để vẫn chạy bằng CPU/RAM thật mà không cần VM. Nếu Windows yêu cầu khởi động lại, Agent ghi một cờ không bí mật, vẫn nằm dưới khay và tự tiếp tục sau lần đăng nhập kế tiếp; nó không lặp lại UAC trong cùng lần khởi động. Chỉ lỗi thật sự hoặc hủy UAC mới mở cửa sổ để xem chi tiết và thử lại; VPS vẫn xếp bình thường. Không tắt Smart App Control và không chạy Agent bằng Administrator mỗi ngày.

Agent không chạy cùng một lượt song song với VPS. Khi Agent ON và đã nhận lease, Agent là nơi xếp duy nhất; khi Agent OFF, máy ngủ/tắt hoặc mất kết nối, lease hết hạn và VPS nhận lại công việc. Bộ xử lý WSL chạy dưới tài khoản hệ thống hạn chế `tkb-agent`, không nhận token đăng nhập và không mở cổng mạng.

Token Agent không phải mật khẩu đăng nhập, không thể truy cập dữ liệu quản trị và không thể tự tạo một lượt xếp. Trên Windows, token được mã hóa bằng DPAPI cho đúng tài khoản Windows hiện tại rồi lưu tại `%LOCALAPPDATA%\TKBCherry\AgentHelper\agent-credential`; tài khoản Windows khác không thể giải mã file này.

Để gỡ hoàn toàn, mở Agent từ khay, bấm **TẮT AGENT**, chọn **Thoát**, rồi xóa file ZIP, `TKBCherryAgent.exe` đã giải nén và `%LOCALAPPDATA%\TKBCherry\AgentHelper`. Nút TẮT xóa giá trị `TKBCherryAgent` do ứng dụng tạo trong `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` nhưng không xóa khóa Run dùng chung. Xóa thư mục trạng thái cũng thu hồi việc ghép đôi cục bộ; lần mở sau Agent sẽ yêu cầu duyệt một mã mới.

## Cập nhật Agent

Từ Agent `1.6.3`, ứng dụng tự kiểm tra metadata phát hành qua HTTPS khi khởi động. Nếu có phiên bản cao hơn, Agent chỉ hiện câu hỏi cập nhật khi đang kết nối và chờ việc. Nếu một lượt xếp đang chạy, câu hỏi được hoãn đến khi lượt đó kết thúc. Người dùng bấm **OK** thì Agent dừng nhận việc mới, tải gói phát hành, kiểm tra chữ ký RSA của metadata, kích thước và SHA-256 của cả ZIP lẫn EXE, kiểm tra ZIP chỉ chứa đúng một `TKBCherryAgent.exe`, rồi chạy smoke test trước khi bàn giao.

Bản EXE mới dùng cơ chế thay thế atomic hiện có: dừng tiến trình cũ, thay file đã cài và tự mở lại. Tải lỗi, chữ ký/hash sai, ZIP bất thường, smoke test lỗi hoặc không thể ghi file đều không đụng tới EXE đang cài; Agent cũ tự bật lại và báo lỗi. Khóa ký riêng được Windows DPAPI bảo vệ trên máy phát hành, không nằm trong mã nguồn, VPS hoặc gói Agent. Vì các bản trước chưa chứa bộ cập nhật này, người dùng `1.6.2` trở xuống cần cài `1.6.3` thủ công đúng một lần.

## Luồng hoạt động

1. Bản Windows đóng gói tự bật từ OFF sang ON ngay khi mở. Nếu chưa có token, Agent tạo một mã ghép đôi ngắn hạn bằng `/pair/start`, mở `verificationUrl` chứa truy vấn `agentPair=XXXX-XXXX`, rồi chờ `/pair/status`. Trình duyệt đang đăng nhập duyệt đúng một lần qua `/pair/approve`; token Agent chỉ được trả về cho phía đang giữ `deviceCode` bí mật.
2. Agent xác thực bằng token đã ghép đôi; `/hello` trả một `workerToken` ngắn hạn, ràng buộc với đúng phiên đó và chỉ được giữ trong RAM. Sau đó Agent mở một yêu cầu chờ dài (`long-poll`). Khi người dùng bấm **Xếp**, công việc có thể được giao ngay trên kết nối đang chờ.
3. Agent gửi nguyên gói `{data, settings}` cho solver qua stdin. Máy bình thường dùng solver-child Windows; máy bị Smart App Control chặn native dùng cùng pipeline CP-SAT trong WSL.
4. Trong lúc xếp, Agent gia hạn lease và nhận tín hiệu hủy từ máy chủ.
5. Agent tải ứng viên lên, rồi xác nhận ứng viên đã gửi bằng mã băm `tkb-json-tree-sha256-v1` và khóa chống gửi trùng. VPS vẫn là nơi duy nhất quyết định và công bố kết quả cuối.
6. Web chỉ đọc trạng thái/kết quả từ máy chủ; tab trình duyệt không sở hữu tiến trình xếp. Chuyển Agent sang OFF đặt tín hiệu dừng, hủy cây tiến trình solver và ngừng long-poll trước khi cho phép bật lại.

Mỗi Agent xử lý tối đa một công việc cùng lúc. Mặc định Agent tự nhận toàn bộ CPU logic và RAM vật lý của máy để ưu tiên chất lượng TKB; VPS trả lại đúng giới hạn đã khai báo đó cho lượt xếp.

## Chạy từ mã nguồn

Yêu cầu Python 3.11 trở lên. Tại thư mục gốc dự án:

```powershell
python -m pip install -r solver_runtime\requirements.txt
Copy-Item agent_helper\config.example.json agent-helper.json
python -m agent_helper --config agent-helper.json
```

Lần chạy đầu cũng dùng luồng ghép đôi qua trình duyệt như bản đóng gói. Không điền token Agent vào JSON. Chạy từ mã nguồn, `--check`, `--once`, `--solver-child`, `--gui-smoke` và `--version` không tạo hay sửa mục tự khởi động Windows; chỉ bản GUI đã đóng gói mới quản lý mục này. Sau khi ghép đôi thành công, có thể chạy `python -m agent_helper --config agent-helper.json --check` để kiểm tra cấu hình, thông tin xác thực và solver. `token_env` chỉ còn là tùy chọn ghi đè lúc chạy dành cho môi trường phát triển/headless; gói Windows không tạo biến môi trường này và không dùng nó làm cơ chế cài đặt.

Để chạy đúng một lần thăm dò khi kiểm thử:

```powershell
python -m agent_helper --config agent-helper.json --once
```

## Cấu hình chính

- `api_base`: mặc định `https://tkbcherry.com/api/agent-helper/v1`; bắt buộc HTTPS. HTTP chỉ được chấp nhận cho `localhost`/loopback khi bật rõ `allow_local_http`.
- `cpu_workers`: mặc định cho phép tối đa toàn bộ CPU logic của máy, nhưng không ép solver dùng hết. Agent tự chọn theo tải: 2 worker cho TKB nhỏ, 4 cho lượt xếp mới cỡ phổ biến, 3 cho lượt tối ưu cùng cỡ và tối đa 6 cho dữ liệu lớn hơn. `TKB_SOLVER_MAX_WORKERS` cùng BLAS/OpenMP chặn mọi luồng ngoài mức đã chọn cho lượt đó.
- `poll_wait_seconds`: thời gian long-poll, tối đa 60 giây.
- `heartbeat_seconds`: chu kỳ gia hạn công việc đang chạy.
- `solver_timeout_seconds`: trần thời gian tuyệt đối; giới hạn lease từ máy chủ có thể ngắn hơn.
- `max_memory_mb`: mặc định cho phép đến toàn bộ RAM vật lý, nhưng đây chỉ là trần chứ không phải lượng RAM được đặt trước. Windows Job Object hoặc giới hạn địa chỉ Linux trong WSL dùng trần thích ứng 4 GB, 8 GB hoặc 16 GB theo kích thước TKB và không vượt mức người dùng cho phép.
- `max_request_bytes`, `max_result_bytes`, `max_stderr_bytes`: chặn dữ liệu hoặc log native quá lớn. stdout/stderr được hút song song qua pipe có backpressure và chỉ ghi tới giới hạn, nên tiến trình không thể làm đầy RAM hay ổ đĩa bằng log.

Agent lưu một UUID vô danh tại `%LOCALAPPDATA%\TKBCherry\AgentHelper\agent-id` và token Agent đã được DPAPI bảo vệ tại file `agent-credential`; đồng thời dùng khóa hệ điều hành để không cho hai bản Agent chạy cùng lúc. Dữ liệu trường, yêu cầu xếp, kết quả và mật khẩu không được Agent lưu lâu dài. `deviceCode` chỉ tồn tại trong lúc ghép đôi; `workerToken` do `/hello` cấp chỉ tồn tại trong bộ nhớ đến khi Agent dừng hoặc đăng ký lại. Token, `workerToken` và các biến môi trường nhạy cảm bị loại khỏi môi trường solver con. stdin/stdout/stderr dùng file tạm delete-on-close và bị hệ điều hành xóa kể cả khi Agent bị đóng đột ngột; solver được chạy với `TKB_NO_LOGS=1`.

## Đóng gói Windows

Dành cho nhà phát triển, chạy từ thư mục gốc dự án:

```powershell
.\agent_helper\build_windows.ps1 -Clean
```

Máy phát hành có Smart App Control không được chạy lại PyInstaller/OR-Tools cục bộ. Workflow thủ công `Build Windows Agent candidate` build, smoke-test và chạy unit test trên runner `windows-2022`, sau đó trả về ZIP/EXE cùng SHA-256 dưới dạng artifact ngắn hạn. Candidate này cố ý không chứa `TKBCherryAgent-release.json` và không được đưa lên web ngay.

Sau khi tải artifact về, máy phát hành chỉ chạy `tools/agent-release/sign_release.py` để ký manifest cho đúng byte ZIP/EXE bằng khóa RSA đang được DPAPI bảo vệ. Khóa riêng không được chuyển lên GitHub. Chữ ký manifest bảo vệ cơ chế cập nhật của TKBCherry nhưng không thay thế Authenticode cho các DLL/PYD native.

File phát hành cho web là `agent_helper\dist\TKBCherryAgent-Windows.zip`. Archive này được script kiểm tra bắt buộc chỉ có một entry `TKBCherryAgent.exe` ở root. EXE dùng PyInstaller `onefile`, chế độ cửa sổ; runtime Windows được biên dịch thành bytecode tối ưu. EXE đồng thời mang nguồn runtime tối thiểu cho bước cài WSL; trình cài chép sang Linux, kiểm tra import thật, biên dịch bytecode rồi xóa `.py` trong bản đã cài. Bản phát hành không nén lại bằng UPX để giữ nguyên bootloader chuẩn. Vì EXE tự chứa NumPy, SciPy và OR-Tools nên lần mở đầu có thể chậm hơn vài giây trong lúc giải nén an toàn vào thư mục tạm. Build chỉ thành công sau khi bản onedir và onefile tạo được cửa sổ Tk ẩn thật, đồng thời solver-child trả đúng protocol. Gói không kèm token, mật khẩu, CMD hay PowerShell.

Build đồng thời tạo `agent_helper\dist\TKBCherryAgent-release.json`. Metadata này chứa phiên bản, URL, kích thước và SHA-256 của ZIP/EXE rồi được ký RSA-SHA256 bằng khóa phát hành DPAPI. Script từ chối tạo manifest nếu khóa riêng không khớp khóa công khai đã ghim trong Agent.

Bản `onedir` dành cho chẩn đoán vẫn nằm tại `agent_helper\dist\TKBCherryAgent\` và được đóng riêng thành `agent_helper\dist\TKBCherryAgent-Windows-onedir.zip`; không dùng archive này làm file tải công khai.

Giải nén gói và chạy bản đóng gói. Lần đầu phải chạy bình thường để hoàn tất ghép đôi trước khi dùng `--check`:

```powershell
.\TKBCherryAgent.exe
.\TKBCherryAgent.exe --check
```

## Kiểm thử

```powershell
python -m unittest discover -s agent_helper\tests -v
```

Bộ kiểm thử bao phủ tự bật ON ở lượt sự kiện GUI đầu tiên, vòng đời ON/OFF/đóng cửa sổ, đăng ký và gỡ HKCU Run không cần quyền quản trị, HTTPS bắt buộc, phía Agent của luồng `pair/start → pair/status`, chặn `verificationUrl` khác origin, lưu/đọc token đã bảo vệ, cấm bí mật trong config/solver con, single-instance, giới hạn CPU/RAM, parser lease, timeout/hủy cả cây tiến trình, protocol stdout, heartbeat khi tải kết quả, long-poll không có việc và toàn bộ luồng `hello → lease → heartbeat → candidate → complete`. `--check` thực sự khởi chạy probe solver nên bắt được phụ thuộc bị thiếu. Kiểm thử tích hợp phía máy chủ bao phủ thêm `/pair/approve`, thời hạn năm phút, duyệt một lần và ràng buộc owner.

Hợp đồng phía máy chủ được mô tả đầy đủ trong [PROTOCOL.md](PROTOCOL.md).
