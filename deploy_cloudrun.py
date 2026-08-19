"""Deploy Cloud Run TRON GOI bang MOT lenh Python.

Lam thay ban toan bo phan gcloud:
  1. Kiem tra gcloud + tai khoan dang nhap
  2. Don cac revision cu khong con traffic (tra lai han ngach CPU)
  3. Chay deploy.ps1 (build + canary + kiem dinh + chuyen traffic)
  4. Doc lai Service URL / Solver digest / TKB_CLOUD_PROFILE, luu ra file
  5. (tuy chon) Cap nhat 3 bien moi truong tren VPS + restart dich vu

Chay:
    python deploy_cloudrun.py                # don revision cu + deploy (max 1 instance)
    python deploy_cloudrun.py --max-instances 3
    python deploy_cloudrun.py --no-vps       # khong dong vao VPS
    python deploy_cloudrun.py --clean-only   # chi don revision cu, khong deploy
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
PROJECT_ID = "project-61ee7855-507e-40a3-879"
REGION = "asia-southeast2"
SERVICE = "tkb-solver"
DEPLOY_PS1 = ROOT / "tools" / "cloud-run" / "deploy.ps1"
PROFILE_OUT = ROOT / "cloud_run_profile_moi_nhat.txt"


def run(cmd: list[str] | str, *, capture=True, timeout=None, shell=False) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, capture_output=capture, text=True, timeout=timeout, shell=shell,
        encoding="utf-8", errors="replace",
    )


def gcloud_path() -> str:
    for name in ("gcloud.cmd", "gcloud"):
        found = shutil.which(name)
        if found:
            return found
    print("!! Khong tim thay 'gcloud'. Cai Google Cloud SDK roi mo lai cua so lenh.")
    sys.exit(1)


def gcloud(args: list[str], *, timeout=600) -> subprocess.CompletedProcess:
    return run([gcloud_path(), *args, f"--project={PROJECT_ID}"], timeout=timeout)


INVOKER_SA = f"tkb-cloud-run-invoker@{PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA = f"tkb-cloud-run-runtime@{PROJECT_ID}.iam.gserviceaccount.com"


def active_account() -> str:
    res = gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], timeout=120)
    return (res.stdout or "").strip().splitlines()[0].strip() if (res.stdout or "").strip() else ""


def service_account_exists(email: str) -> bool:
    res = gcloud(["iam", "service-accounts", "describe", email, "--format=value(email)"], timeout=180)
    return res.returncode == 0


def ensure_token_creator(account: str, sa_email: str) -> bool:
    """Cho phep tai khoan cua ban 'muon danh tinh' service account invoker.

    deploy.ps1 phai lay ID token cho buoc kiem dinh canary. Tai khoan Google ca
    nhan KHONG the tu tao ID token co audience rieng — bat buoc phai mao danh
    service account invoker. Thieu quyen nay chinh la loi
    'gcloud auth failed with exit code 1'.
    """
    print(f"Cap quyen tao ID token cho {account} tren {sa_email} (neu chua co)...")
    res = gcloud([
        "iam", "service-accounts", "add-iam-policy-binding", sa_email,
        f"--member=user:{account}",
        "--role=roles/iam.serviceAccountTokenCreator",
        "--quiet", "--format=none",
    ], timeout=300)
    if res.returncode == 0:
        print("   OK")
        return True
    err = (res.stderr or res.stdout or "").strip()
    print("   Khong cap duoc quyen:", err[:300])
    return False


def check_account() -> None:
    res = gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], timeout=120)
    account = (res.stdout or "").strip()
    if not account:
        print("!! Chua dang nhap gcloud. Chay:  gcloud auth login")
        sys.exit(1)
    print(f"Tai khoan gcloud: {account}")


def list_revisions() -> list[dict]:
    res = gcloud([
        "run", "revisions", "list", f"--service={SERVICE}", f"--region={REGION}",
        "--format=json",
    ], timeout=300)
    if res.returncode != 0:
        print("!! Khong liet ke duoc revision:", (res.stderr or "").strip()[:400])
        return []
    try:
        return json.loads(res.stdout or "[]")
    except Exception:
        return []


def serving_revisions() -> set[str]:
    res = gcloud([
        "run", "services", "describe", SERVICE, f"--region={REGION}", "--format=json",
    ], timeout=300)
    names: set[str] = set()
    try:
        svc = json.loads(res.stdout or "{}")
        for item in (svc.get("status", {}).get("traffic") or []):
            # chi giu revision DANG NHAN TRAFFIC that su; canary 0% chi la rac
            # va van an han ngach CPU cua vung.
            if item.get("revisionName") and int(item.get("percent") or 0) > 0:
                names.add(item["revisionName"])
        latest = svc.get("status", {}).get("latestReadyRevisionName")
        if latest:
            names.add(latest)
    except Exception:
        pass
    return names


def clean_old_revisions(keep: int = 1) -> None:
    revs = list_revisions()
    if not revs:
        print("Khong co revision nao de don.")
        return
    live = serving_revisions()
    names = [r.get("metadata", {}).get("name", "") for r in revs]
    names = [n for n in names if n]
    print(f"Tong so revision: {len(names)} | dang phuc vu: {', '.join(sorted(live)) or '(khong ro)'}")
    deletable = [n for n in names if n not in live]
    # giu lai `keep` revision moi nhat ngoai cac ban dang phuc vu (de con duong lui)
    deletable = deletable[keep:]
    if not deletable:
        print("Khong co revision cu nao can xoa.")
        return
    print(f"Se xoa {len(deletable)} revision cu de tra lai han ngach CPU:")
    for name in deletable:
        print("   -", name)
    for name in deletable:
        res = gcloud([
            "run", "revisions", "delete", name, f"--region={REGION}", "--quiet",
        ], timeout=300)
        status = "OK" if res.returncode == 0 else "LOI: " + (res.stderr or "").strip()[:160]
        print(f"   xoa {name}: {status}")


def deploy(max_instances: int) -> str:
    if not DEPLOY_PS1.exists():
        print("!! Khong thay", DEPLOY_PS1)
        sys.exit(1)
    powershell = shutil.which("pwsh") or shutil.which("powershell")
    if not powershell:
        print("!! Khong tim thay PowerShell.")
        sys.exit(1)
    cmd = [
        powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(DEPLOY_PS1),
        "-ProjectId", PROJECT_ID, "-Region", REGION, "-ServiceName", SERVICE,
        "-MaxInstances", str(max_instances), "-ConfirmDeployment",
    ]
    if service_account_exists(INVOKER_SA):
        cmd += ["-InvokerServiceAccount", INVOKER_SA]
        print("Dung invoker service account:", INVOKER_SA)
    if service_account_exists(RUNTIME_SA):
        cmd += ["-RuntimeServiceAccount", RUNTIME_SA]
    print("\n=== BAT DAU DEPLOY (co the mat 5-10 phut) ===")
    print(" ".join(cmd[-8:]))
    lines: list[str] = []
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1)
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        print(line)
        lines.append(line)
    proc.wait()
    out = "\n".join(lines)
    if proc.returncode != 0:
        print("\n!! DEPLOY THAT BAI (ma loi %s)." % proc.returncode)
        if "gcloud auth failed" in out or "print-identity-token" in out:
            print("   Nguyen nhan: khong lay duoc ID token cho buoc kiem dinh canary.")
            print("   Tai khoan Google ca nhan phai duoc quyen 'Service Account Token Creator'")
            print(f"   tren {INVOKER_SA}. Chay tay neu can:")
            print(f"     gcloud iam service-accounts add-iam-policy-binding {INVOKER_SA} \\")
            print(f"       --member=user:<email cua ban> --role=roles/iam.serviceAccountTokenCreator \\")
            print(f"       --project={PROJECT_ID}")
        if "Quota exceeded" in out:
            print("   Nguyen nhan: HET HAN NGACH CPU cua vung.")
            print("   Thu lai voi it instance hon:  python deploy_cloudrun.py --max-instances 1")
            print("   Hoac xin nang quota 'Cloud Run Admin API - CPU allocation' cho vung", REGION)
    return out


def extract_profile(out: str) -> dict:
    info = {}
    m = re.search(r"Service URL:\s*(\S+)", out)
    if m:
        info["url"] = m.group(1)
    m = re.search(r"Solver digest:\s*([0-9a-fA-F]{64})", out)
    if m:
        info["digest"] = m.group(1).lower()
    m = re.search(r"(TKB_CLOUD_PROFILE=\{.*\})", out)
    if m:
        info["profile"] = m.group(1)
    return info


def update_vps(url: str, digest: str) -> None:
    tools = ROOT / "tools" / "vps-deploy"
    sys.path.insert(0, str(tools))
    try:
        from vps_credentials import resolve_vps_connection  # type: ignore
        import paramiko  # type: ignore
    except Exception as exc:
        print("Bo qua buoc VPS (thieu thu vien/cau hinh):", repr(exc)[:200])
        return
    host, user, password = resolve_vps_connection()
    print(f"\n=== CAP NHAT BIEN MOI TRUONG TREN VPS {host} ===")
    dropin = (
        "[Service]\n"
        f"Environment=TKB_CLOUD_RUN_URL={url}\n"
        f"Environment=TKB_CLOUD_RUN_AUDIENCE={url}\n"
        f"Environment=TKB_CLOUD_RUN_SOLVER_DIGEST={digest}\n"
    )
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=password, timeout=30)
    cmd = (
        "mkdir -p /etc/systemd/system/tkb-app.service.d && "
        "cat > /etc/systemd/system/tkb-app.service.d/cloudrun.conf <<'EOF'\n"
        + dropin +
        "EOF\n"
        "systemctl daemon-reload && systemctl restart tkb-app && sleep 2 && systemctl is-active tkb-app"
    )
    _, out, err = c.exec_command(cmd, timeout=180)
    print("  trang thai dich vu:", out.read().decode("utf-8", "replace").strip())
    tail = err.read().decode("utf-8", "replace").strip()
    if tail:
        print("  stderr:", tail[:400])
    _, out2, _ = c.exec_command(
        "curl -s --max-time 10 http://127.0.0.1:1010/api/health "
        "| python3 -c \"import sys,json;d=json.load(sys.stdin);print(json.dumps(d['serverless']))\"",
        timeout=60,
    )
    print("  serverless:", out2.read().decode("utf-8", "replace").strip())
    c.close()



REMOTE_SET_PROFILE = '\nimport json, sqlite3, sys, time\nKEY = "serverless_infrastructure_v1"\nDB = "/opt/cherry-scheduler/rust_api/tkb_store.db"\nprofile = json.loads(sys.stdin.read())\nconn = sqlite3.connect(DB, timeout=20)\ncur = conn.cursor()\ncur.execute("SELECT v FROM kvstore WHERE k=?", (KEY,))\nrow = cur.fetchone()\ncfg = json.loads(row[0]) if row and row[0] else {}\nbackup = "/tmp/serverless_config_backup_%d.json" % int(time.time())\nopen(backup, "w", encoding="utf-8").write(json.dumps(cfg, ensure_ascii=False, indent=2))\nprint("SAO LUU cau hinh cu ->", backup)\nprofiles = cfg.get("profiles")\nif not isinstance(profiles, list):\n    profiles = []\nreplaced = False\nfor i, item in enumerate(profiles):\n    if isinstance(item, dict) and str(item.get("id")) == str(profile.get("id")):\n        merged = dict(item); merged.update(profile); profiles[i] = merged\n        replaced = True\n        break\nif not replaced:\n    profiles.append(profile)\ncfg["profiles"] = profiles\nfor key in ("activeProfileId", "selectedProfileId"):\n    if key in cfg:\n        cfg[key] = profile.get("id")\ncur.execute("INSERT INTO kvstore (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",\n            (KEY, json.dumps(cfg, ensure_ascii=False)))\nconn.commit(); conn.close()\nprint("DA GHI profile:", profile.get("id"), "| thay the:", replaced, "| tong profile:", len(profiles))\nprint("digest:", str(profile.get("solverDigest"))[:16], "... | url:", profile.get("url"))\n'

HEALTH_AFTER_RESTART = 'systemctl restart tkb-app && sleep 3 && curl -s --max-time 10 http://127.0.0.1:1010/api/health | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d[\'serverless\']))"'


def update_profile_on_vps(profile_line: str) -> bool:
    """Ghi profile Cloud Run moi thang vao cau hinh tren VPS.

    Thay cho viec vao Super Admin dan tay. Doc ban ghi
    'serverless_infrastructure_v1' trong kvstore, SAO LUU, chi thay/them dung
    mot profile theo id (moi thu khac giu nguyen), restart roi kiem tra lai.
    """
    raw = profile_line.split("=", 1)[1].strip() if "=" in profile_line else profile_line.strip()
    try:
        profile = json.loads(raw)
    except Exception as exc:
        print("Khong doc duoc TKB_CLOUD_PROFILE:", repr(exc)[:200])
        return False
    if not isinstance(profile, dict) or not profile.get("id"):
        print("TKB_CLOUD_PROFILE khong hop le (thieu 'id').")
        return False

    sys.path.insert(0, str(ROOT / "tools" / "vps-deploy"))
    try:
        from vps_credentials import resolve_vps_connection  # type: ignore
        import paramiko  # type: ignore
    except Exception as exc:
        print("Bo qua buoc cap nhat profile (thieu thu vien/cau hinh):", repr(exc)[:200])
        return False

    host, user, password = resolve_vps_connection()
    print("\n=== GHI PROFILE CLOUD RUN VAO CAU HINH TREN VPS %s ===" % host)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=password, timeout=30)
    sftp = c.open_sftp()
    with sftp.file("/tmp/tkb_set_profile.py", "w") as fh:
        fh.write(REMOTE_SET_PROFILE)
    sftp.close()
    stdin, out, err = c.exec_command("python3 /tmp/tkb_set_profile.py", timeout=180)
    stdin.write(json.dumps(profile))
    stdin.channel.shutdown_write()
    print(out.read().decode("utf-8", "replace").strip())
    tail = err.read().decode("utf-8", "replace").strip()
    if tail:
        print("  stderr:", tail[:500])
    _, out2, _ = c.exec_command(HEALTH_AFTER_RESTART, timeout=180)
    health = out2.read().decode("utf-8", "replace").strip()
    print("  sau restart, serverless =", health or "(khong doc duoc)")
    c.exec_command("rm -f /tmp/tkb_set_profile.py")
    c.close()
    compact = health.replace(" ", "").replace("'", '"')
    return '"configured":true' in compact


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-instances", type=int, default=1)
    ap.add_argument("--no-clean", action="store_true", help="khong xoa revision cu")
    ap.add_argument("--clean-only", action="store_true", help="chi don revision cu")
    ap.add_argument("--no-vps", action="store_true", help="khong cap nhat VPS")
    ap.add_argument("--profile-only", action="store_true",
                    help="KHONG build lai — chi ghi profile Cloud Run gan nhat vao VPS")
    ap.add_argument("--set-profile", default="", help="dong TKB_CLOUD_PROFILE={...} cu the")
    args = ap.parse_args()

    if args.profile_only or args.set_profile:
        line = args.set_profile.strip()
        if not line:
            if not PROFILE_OUT.exists():
                print("!! Khong thay", PROFILE_OUT.name, "- hay chay deploy truoc, hoac dung --set-profile")
                return 1
            line = PROFILE_OUT.read_text(encoding="utf-8").strip()
        print("Profile se ghi:", line[:120], "...")
        try:
            prof = json.loads(line.split("=", 1)[1] if "=" in line else line)
        except Exception as exc:
            print("!! Dong profile khong hop le:", repr(exc)[:200])
            return 1
        if prof.get("url") and prof.get("solverDigest"):
            update_vps(prof["url"], prof["solverDigest"])
        ok = update_profile_on_vps(line)
        if ok:
            print("\n>>> XONG. Profile Cloud Run da nam trong cau hinh tren VPS.")
            print(">>> Khong can vao Super Admin dan tay nua. Mo tkbcherry.com va Ctrl+F5.")
            return 0
        print("\n(!) Ghi that bai — hay dan dong tren vao Super Admin -> Doi tai khoan Google Cloud.")
        return 1

    check_account()
    acct = active_account()
    if acct and service_account_exists(INVOKER_SA):
        ensure_token_creator(acct, INVOKER_SA)
    if not args.no_clean:
        clean_old_revisions()
    if args.clean_only:
        return 0

    out = deploy(args.max_instances)
    info = extract_profile(out)
    if info.get("profile"):
        PROFILE_OUT.write_text(info["profile"] + "\n", encoding="utf-8")
        print("\n================ VIEC CAN LAM TIEP ================")
        print("1) Mo ung dung -> Super Admin -> 'Doi tai khoan Google Cloud'")
        print("   Dan nguyen dong duoi day (da luu san o", PROFILE_OUT.name, "):")
        print()
        print(info["profile"])
        print()
        if info.get("url") and info.get("digest") and not args.no_vps:
            update_vps(info["url"], info["digest"])
            if update_profile_on_vps(info["profile"]):
                print("\n>>> DA LAM LUON BUOC SUPER ADMIN: profile Cloud Run moi da duoc ghi")
                print(">>> vao cau hinh tren VPS. BAN KHONG CAN DAN TAY NUA.")
            else:
                print("\n(!) Chua ghi duoc profile tu dong — dan dong TKB_CLOUD_PROFILE o tren")
                print("    vao Super Admin -> Doi tai khoan Google Cloud.")
        else:
            print("Cap nhat tren VPS: TKB_CLOUD_RUN_URL / _AUDIENCE / _SOLVER_DIGEST")
        print("Cuoi cung: mo tkbcherry.com, Ctrl+F5, bam thu Flash va Cherry.")
        print("===================================================")
    else:
        print("\n(Khong doc duoc TKB_CLOUD_PROFILE tu ket qua deploy — xem log o tren.)")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
