# SecureApp Pro V5

Portal license hợp pháp gồm 3 phần:
- `index.html`: app chính đăng nhập bằng key
- `free-key.html`: trang riêng tạo short-link và nhận key free 5 giờ theo thiết bị
- `admin.html`: trang admin quản lý key, thiết bị và thông báo

## Deploy nhanh trên Render

Dùng các giá trị sau:
- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: để trống nếu các file nằm ở gốc repo

## Biến môi trường

```env
PORT=3000
APP_BASE_URL=https://your-app.onrender.com
LINK4M_API_TOKEN=
FREE_KEY_TTL_HOURS=5
VERIFY_SESSION_MINUTES=30

ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeMe123!
ADMIN_TOKEN=change_this_admin_token_32_chars_min

TELEGRAM_BOT_TOKEN=
TGBOT_LOGIN_PASSWORD=BotLogin123!
TG_ADMIN_IDS=123456789
```

## Link chính

- App: `/` hoặc `/index.html`
- Free key: `/free-key` hoặc `/free-key.html`
- Admin: `/admin` hoặc `/admin.html`

## Luồng free key

1. App chính có nút `LẤY KEY FREE`
2. Người dùng sang `free-key.html`
3. Portal gọi `/api/free-key/create-link`
4. Backend tạo short-link Link4m trỏ về `/verify`
5. User hoàn tất xác minh và được redirect về portal
6. Portal gọi `/api/free-key/claim`
7. Backend cấp 1 key free ngẫu nhiên, hạn 5 giờ, theo thiết bị

## Telegram bot

Nếu điền `TELEGRAM_BOT_TOKEN`, bot sẽ long-polling và hỗ trợ:
- `/start`
- `/login <mật_khẩu_bot>`
- `/taokey <gio> <so_thiet_bi> <ghi_chu>`
- `/quanlithietbi`
- `/xemkey`
- `/khoakey <KEY>`
- `/mokey <KEY>`
- `/thongbao Tieu de | Noi dung`
- `/logout`

Bot chỉ cho user ID nằm trong `TG_ADMIN_IDS` và đã `/login` thành công.

## Ghi chú

- Bản này lưu dữ liệu trong `data/store.json` để demo nhanh.
- Dùng production nên chuyển sang SQLite hoặc PostgreSQL.
- Nếu chưa cấu hình `LINK4M_API_TOKEN`, server sẽ fallback sang direct verify URL để vẫn test được luồng.
