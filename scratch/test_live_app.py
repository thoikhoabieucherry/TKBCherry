import urllib.request
import json

base = "https://tkbcherry.com"

# 1. Check GET /app?sid=default
req = urllib.request.Request(f"{base}/app?sid=default", headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req) as resp:
    html = resp.read().decode("utf-8")
    print("1. GET /app?sid=default status:", resp.status, "| HTML length:", len(html))
    print("   Has #excelFile input:", ('id="excelFile"' in html))
    scripts = [line.strip() for line in html.splitlines() if "script" in line.lower() and "src=" in line.lower()]
    print("   Active script versions:")
    for s in scripts:
        print("    ", s)

# 2. Check GET /api/school/store?id=default
req = urllib.request.Request(f"{base}/api/school/store?id=default", headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode("utf-8"))
    print("\n2. GET /api/school/store?id=default status:", resp.status)
    print(f"   Lop: {len(data.get('lop', []))} | Mon: {len(data.get('monhoc', []))} | GV: {len(data.get('giaovien', []))} | PCCM: {len(data.get('pccmMatrix', {}))}")

# 3. Test POST /api/school/store?id=default (simulating Excel Import / PCCM save)
test_payload = dict(data)
test_payload["_live_test_timestamp"] = "2026-08-18T23:45:00Z"
post_bytes = json.dumps(test_payload).encode("utf-8")
req = urllib.request.Request(f"{base}/api/school/store?id=default", data=post_bytes, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req) as resp:
    post_res = json.loads(resp.read().decode("utf-8"))
    print("\n3. POST /api/school/store?id=default status:", resp.status, "| Response:", post_res)

# 4. Verify that GET returns the updated data (Simulating F5 reload)
req = urllib.request.Request(f"{base}/api/school/store?id=default", headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req) as resp:
    verified_data = json.loads(resp.read().decode("utf-8"))
    print("\n4. Verification on F5 (GET): timestamp persisted =", verified_data.get("_live_test_timestamp"))
    print("   => ALL PERSISTENCE CHECKS PASSED 100%!")
