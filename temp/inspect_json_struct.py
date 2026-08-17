import json

with open(r"C:\Users\Love\Documents\Codex\temp\school_default.json", "r", encoding="utf-8") as f:
    data = json.load(f)
    
print("Top-level keys in school_default.json:", list(data.keys()))
if "tkb" in data:
    tkb = data["tkb"]
    print("Type of tkb:", type(tkb))
    if isinstance(tkb, dict):
        print("First 3 class keys in tkb:", list(tkb.keys())[:3])
        first_cls = list(tkb.keys())[0]
        print(f"Structure of tkb[{first_cls}]:", tkb[first_cls])
