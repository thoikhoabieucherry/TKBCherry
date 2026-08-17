import sys

sys.stdout.reconfigure(encoding='utf-8')

def update_guarded_operators():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
        
    target = '"tryKempeChainPeriodSwap",'
    replacement = '"tryKempeChainPeriodSwap",\n    "tryIntraSessionCrossClassChain",'
    
    if target in content and '"tryIntraSessionCrossClassChain"' not in content[content.find("GUARDED_OPERATORS"):]:
        content = content.replace(target, replacement, 1)
        with open(engine_path, "w", encoding="utf-8") as f:
            f.write(content)
        print("Added tryIntraSessionCrossClassChain to GUARDED_OPERATORS successfully!")
    else:
        print("Already present or target not found.")

if __name__ == "__main__":
    update_guarded_operators()
