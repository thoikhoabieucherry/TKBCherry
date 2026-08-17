import sys
import os
import hashlib

sys.stdout.reconfigure(encoding='utf-8')

def hash_file(path):
    with open(path, 'rb') as f:
        return hashlib.md5(f.read()).hexdigest()

def check_deployment():
    md_dir = r"C:\Users\Love\Documents\Codex\MD"
    web_dir = r"C:\Users\Love\Documents\Codex\TKBCherry\web"
    
    md_engine = os.path.join(md_dir, "tkb-fet-engine.js")
    web_engine = os.path.join(web_dir, "tkb-fet-engine.js")
    
    md_worker = os.path.join(md_dir, "tkb-fet-worker.js")
    web_worker = os.path.join(web_dir, "tkb-fet-worker.js")
    
    print("=== FILE COMPARISON ===")
    print(f"MD Engine:   size={os.path.getsize(md_engine)}, md5={hash_file(md_engine)}")
    print(f"Web Engine:  size={os.path.getsize(web_engine)}, md5={hash_file(web_engine)}")
    
    print(f"MD Worker:   size={os.path.getsize(md_worker)}, md5={hash_file(md_worker)}")
    print(f"Web Worker:  size={os.path.getsize(web_worker)}, md5={hash_file(web_worker)}")
    
    # Check content of web_engine
    with open(web_engine, "r", encoding="utf-8", errors="ignore") as f:
        web_code = f.read()
        
    has_operator = "tryIntraSessionCrossClassChain" in web_code
    has_call = 'const resChain2 = this.tryIntraSessionCrossClassChain' in web_code
    has_guarded = '"tryIntraSessionCrossClassChain"' in web_code[web_code.find("GUARDED_OPERATORS"):] if "GUARDED_OPERATORS" in web_code else False
    
    print("\n=== WEB ENGINE CAPABILITY CHECK ===")
    print(f"1. Has tryIntraSessionCrossClassChain function: {has_operator}")
    print(f"2. Has call in optimize_gap2:                   {has_call}")
    print(f"3. Has in GUARDED_OPERATORS:                    {has_guarded}")
    
    if hash_file(md_engine) != hash_file(web_engine):
        print("\nNotice: MD engine and Web engine have differences. Synchronizing...")
        with open(md_engine, "r", encoding="utf-8") as f_src:
            src_content = f_src.read()
        with open(web_engine, "w", encoding="utf-8") as f_dst:
            f_dst.write(src_content)
        print("-> SYNCHRONIZED tkb-fet-engine.js to TKBCherry/web!")
    else:
        print("\n-> Both files are 100% IDENTICAL!")

if __name__ == "__main__":
    check_deployment()
