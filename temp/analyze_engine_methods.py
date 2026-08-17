import sys
import os
import re

sys.stdout.reconfigure(encoding='utf-8')

def analyze_engine_methods():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    print(f"Total lines: {len(lines)}")
    
    # Extract method names in FetTimetableEngine
    # format: methodName(...) { or async methodName(...) {
    method_regex = re.compile(r'^\s*(async\s+)?([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*\{')
    
    methods = []
    for idx, line in enumerate(lines):
        m = method_regex.match(line)
        if m:
            is_async = bool(m.group(1))
            name = m.group(2)
            params = m.group(3)
            methods.append((idx + 1, name, is_async, params))
            
    print(f"Found {len(methods)} methods in FetTimetableEngine:")
    for lnum, name, is_async, params in methods:
        print(f"  Line {lnum:4d}: {'async ' if is_async else ''}{name}({params})")

if __name__ == "__main__":
    analyze_engine_methods()
