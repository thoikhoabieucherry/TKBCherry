import sys, urllib.request, hashlib, paramiko
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

print("================================================================================")
print("KIỂM TRA THỰC TẾ TRÊN VPS VÀ LIVE WEB (tkbcherry.com)")
print("================================================================================")

# 1. Check directly on VPS via SSH
host, user, password = resolve_vps_connection()
print(f"\n1. Kết nối SSH tới VPS {host}...")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

# Check grep for tryFastSingletonRepair on VPS
stdin, stdout, stderr = client.exec_command("grep -n 'tryFastSingletonRepair' /opt/cherry-scheduler/web/pages/tkb-fet-engine.js /opt/cherry-scheduler/web/tkb-fet-engine.js")
out_grep = stdout.read().decode()
print("Kết quả grep 'tryFastSingletonRepair' trên VPS:")
print(out_grep if out_grep.strip() else "KHÔNG TÌM THẤY!")

# Check MD5 on VPS
stdin, stdout, stderr = client.exec_command("md5sum /opt/cherry-scheduler/web/pages/tkb-fet-engine.js /opt/cherry-scheduler/web/pages/tkb-fet-worker.js")
out_md5 = stdout.read().decode()
print("\nMD5 checksum trên VPS:")
print(out_md5)

# Check service status
stdin, stdout, stderr = client.exec_command("systemctl is-active tkb-app")
print("Trạng thái dịch vụ tkb-app:", stdout.read().decode().strip())
client.close()

# 2. Check via public HTTP requests (như trình duyệt tải về)
print("\n2. Kiểm tra tải file qua HTTP từ https://tkbcherry.com...")

urls = [
    "https://tkbcherry.com/pages/tkb-fet-engine.js",
    "https://tkbcherry.com/tkb-fet-engine.js",
    "https://tkbcherry.com/pages/tkb-fet-worker.js"
]

for url in urls:
    try:
        req = urllib.request.Request(
            url + "?t=" + str(int(hashlib.md5(url.encode()).hexdigest(), 16) % 1000000),
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode('utf-8')
            has_fast = 'tryFastSingletonRepair' in content
            has_throttle = 'SNAPSHOT_INTERVAL_MS' in content
            print(f"- {url}: Length = {len(content)} bytes")
            if 'engine' in url:
                print(f"  -> Chứa 'tryFastSingletonRepair': {has_fast} {'✅ (ĐÃ CẬP NHẬT)' if has_fast else '❌ (CHƯA CẬP NHẬT)'}")
            if 'worker' in url:
                print(f"  -> Chứa 'SNAPSHOT_INTERVAL_MS': {has_throttle} {'✅ (ĐÃ CẬP NHẬT)' if has_throttle else '❌ (CHƯA CẬP NHẬT)'}")
    except Exception as e:
        print(f"- {url}: Lỗi {e}")

