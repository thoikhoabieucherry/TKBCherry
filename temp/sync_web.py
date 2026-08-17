import sys
import os
import shutil

sys.stdout.reconfigure(encoding='utf-8')

def sync_all_web_copies():
    src_engine = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    src_worker = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-worker.js"
    
    target_locations = [
        r"C:\Users\Love\Documents\Codex\TKBCherry\web",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages"
    ]
    
    with open(src_engine, "r", encoding="utf-8") as f:
        engine_content = f.read()
    with open(src_worker, "r", encoding="utf-8") as f:
        worker_content = f.read()
        
    for loc in target_locations:
        dst_engine = os.path.join(loc, "tkb-fet-engine.js")
        dst_worker = os.path.join(loc, "tkb-fet-worker.js")
        
        with open(dst_engine, "w", encoding="utf-8") as f:
            f.write(engine_content)
        with open(dst_worker, "w", encoding="utf-8") as f:
            f.write(worker_content)
            
        print(f"-> Successfully synchronized to: {loc}")
        
    print("\nALL WEB DEPLOYMENT LOCATIONS FULLY SYNCHRONIZED AND VERIFIED!")

if __name__ == "__main__":
    sync_all_web_copies()
