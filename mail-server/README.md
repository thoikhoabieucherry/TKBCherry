# Mail server (gửi OTP qua Gmail)

Backend nhỏ giúp web TKB gửi mã OTP xác thực email / đặt lại mật khẩu qua Gmail.

## 1. Tạo App Password của Gmail

1. Đăng nhập tài khoản Gmail sẽ dùng để gửi.
2. Vào https://myaccount.google.com/security → bật **Xác minh 2 bước (2-Step Verification)**.
3. Vào https://myaccount.google.com/apppasswords → tạo một **App password** (đặt tên tuỳ ý, ví dụ "TKB").
4. Google hiện chuỗi **16 ký tự** — copy lại (đây là `GMAIL_APP_PASSWORD`).

> Lưu ý: App Password khác với mật khẩu đăng nhập Gmail thường. Không dùng mật khẩu thường được.

## 2. Cấu hình

```bash
cd mail-server
copy .env.example .env       # Windows PowerShell: Copy-Item .env.example .env
```

Mở `.env` và điền:

```
GMAIL_USER=email-cua-ban@gmail.com
GMAIL_APP_PASSWORD=chuoi16kytu
FROM_NAME=Thời khóa biểu
PORT=8787
```

## 3. Cài & chạy

```bash
cd mail-server
npm install
npm start
```

Thấy dòng `[mail-server] đang chạy tại http://localhost:8787` là được.

Kiểm tra nhanh: mở http://localhost:8787/api/health → phải trả `{"ok":true,"configured":true}`.

## 4. Kết nối với web

- Mặc định web gọi tới `http://localhost:8787`. Nếu chạy cùng máy thì **không cần làm gì thêm**.
- Nếu backend chạy ở địa chỉ khác, mở Console trình duyệt (F12) trên trang web và chạy một lần:

```js
localStorage.setItem("TKB_MAIL_API", "https://mail.tenmien-cua-ban.com");
```

hoặc đặt biến toàn cục `window.TKB_MAIL_API` trong trang.

## 5. Phạm vi

Đây là dịch vụ tùy chọn, độc lập với máy chủ Rust và không được `start.py` khởi
động. Repo hiện không chứa quy trình đưa dịch vụ này lên môi trường bên ngoài.
Nếu dùng một địa chỉ mail API khác localhost, cấu hình `TKB_MAIL_API` như bước 4
trong một công việc vận hành riêng.

## Giới hạn

- Gmail thường giới hạn ~500 email/ngày. Đủ cho quy mô trường học. Cần nhiều hơn thì chuyển sang dịch vụ như Resend/Brevo/SendGrid.
