import subprocess
import time
import urllib.request
import urllib.error
import sys
import os
import unittest
import json
import tempfile

def kill_process_tree(pid):
    if os.name == 'nt':
        # On Windows, taskkill /T /F ensures the entire process tree including children (like tkb_rust_api.exe) is killed
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        try:
            os.kill(pid, 15)
        except OSError:
            pass

def cleanup_tempdir(tempdir, retries=5):
    """Let Windows release SQLite handles before removing the E2E runtime."""
    for attempt in range(retries):
        try:
            tempdir.cleanup()
            return
        except PermissionError:
            if attempt + 1 >= retries:
                print(f"WARNING: Could not remove temporary E2E runtime: {tempdir.name}")
                return
            time.sleep(0.5)

def main():
    # Windows Store Python commonly inherits a legacy console encoding. Keep
    # Vietnamese assertion messages reportable instead of crashing the runner.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="backslashreplace")
            except (OSError, ValueError):
                pass

    port = 1085
    try:
        startup_timeout = max(45, int(os.environ.get("TKB_E2E_STARTUP_TIMEOUT", "180")))
    except ValueError:
        startup_timeout = 180
    cmd = [
        sys.executable,
        "start.py",
        "--no-browser",
        "--no-launcher",
        "--foreground",
        "--port",
        str(port)
    ]
    
    print("==================================================")
    print("Starting Rust Backend Server for E2E Tests...")
    print(f"Command: {' '.join(cmd)}")
    print("==================================================")
    
    test_runtime = tempfile.TemporaryDirectory(prefix="tkb-e2e-")
    # Isolate test accounts/exports from the user's real school database and Documents folder.
    env = os.environ.copy()
    env["TKB_SOLVER_MAX_CONCURRENT"] = "2"
    env["TKB_SOLVER_CPU_TOKENS"] = "6"
    env["TKB_DB_PATH"] = os.path.join(test_runtime.name, "tkb_store.db")
    env["TKB_EXPORT_DIR"] = os.path.join(test_runtime.name, "exports")
    
    server_proc = None
    log_file = None
    
    try:
        # Redirect output of start.py to a file so it doesn't block stdout or hide errors
        log_file = open("rust_server_e2e.log", "w", encoding="utf-8")
        server_proc = subprocess.Popen(
            cmd,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT
        )
        
        # A clean workspace may need to compile the Rust backend before it can answer health checks.
        health_url = f"http://127.0.0.1:{port}/api/health"
        ready = False
        start_time = time.time()
        print("Polling /api/health...")
        while time.time() - start_time < startup_timeout:
            if server_proc.poll() is not None:
                print(f"Server subprocess exited early with code {server_proc.returncode}.")
                break
            try:
                req = urllib.request.Request(health_url, method="GET")
                with urllib.request.urlopen(req, timeout=1) as resp:
                    if resp.status == 200:
                        body_bytes = resp.read()
                        try:
                            body = json.loads(body_bytes.decode('utf-8'))
                            if body.get("ok") is True:
                                ready = True
                                break
                        except Exception:
                            pass
            except Exception:
                pass
            time.sleep(1)
            
        if not ready:
            print(f"ERROR: Server failed to start and report healthy in {startup_timeout} seconds.")
            # Print last few lines of server log
            try:
                log_file.flush()
                with open("rust_server_e2e.log", "r", encoding="utf-8") as f:
                    lines = f.readlines()
                    print("Last 20 lines of server log:")
                    for line in lines[-20:]:
                        print(line.rstrip())
            except Exception:
                pass
            sys.exit(1)
            
        print("Server is up and healthy! Starting E2E test suite...")
        print("==================================================")
        
        # Discover and run the tests from e2e_tests/test_suite.py
        sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
        loader = unittest.TestLoader()
        suite = loader.discover(start_dir="e2e_tests", pattern="test_suite.py")
        
        runner = unittest.TextTestRunner(verbosity=2)
        result = runner.run(suite)
        
        # Calculate summary metrics
        total = result.testsRun
        errors = len(result.errors)
        failures = len(result.failures)
        skipped = len(result.skipped)
        passed = total - errors - failures - skipped
        
        print("\n==================================================")
        print("E2E TEST RUN SUMMARY")
        print("==================================================")
        print(f"Total Tests Run: {total}")
        print(f"Passed:         {passed}")
        print(f"Failed:         {failures}")
        print(f"Errors:         {errors}")
        print(f"Skipped:        {skipped}")
        print("==================================================")
        
        # List which tests failed or had errors for easy reporting
        if failures > 0:
            print("\nFailed Tests:")
            for test, tr in result.failures:
                print(f"  - {test.id()}: {tr.splitlines()[-1] if tr else ''}")
        if errors > 0:
            print("\nTests with Errors:")
            for test, tr in result.errors:
                print(f"  - {test.id()}: {tr.splitlines()[-1] if tr else ''}")
        print("==================================================")
        
        if result.wasSuccessful():
            print("Result: ALL TESTS PASSED SUCCESSFULLY!")
            sys.exit(0)
        else:
            print("Result: SOME TESTS FAILED OR ERRORED.")
            sys.exit(1)
            
    finally:
        if server_proc:
            print("Stopping backend server process tree...")
            kill_process_tree(server_proc.pid)
            try:
                server_proc.wait(timeout=5)
            except Exception:
                pass
        if log_file:
            log_file.close()
        cleanup_tempdir(test_runtime)

if __name__ == "__main__":
    main()
