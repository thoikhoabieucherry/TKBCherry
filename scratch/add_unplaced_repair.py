import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# Add auto-unplaced placement at the start of optimize()
target_pos = '      this.__placedBaseline = 0;\n      for(let i = 0; i < this.activities.length; i++){\n        if(this.actPlacement[i] >= 0) this.__placedBaseline += this.activities[i].duration;\n      }'

auto_repair_code = """      // TỰ ĐỘNG VÁ CÁC TIẾT CHƯA XẾP (nếu bảng hiện tại còn Chưa xếp > 0)
      const unplacedAtStart = this.activities.filter(a => this.actPlacement[a.id] < 0 && !a.isFixed);
      if(unplacedAtStart.length > 0){
        this.strictFetGaps = true;
        this.limitCalls = Math.max(8000, 10 * this.activities.length);
        for(const uAct of unplacedAtStart){
          this.nCalls = 0;
          this.randomSwap(uAct.id, 0);
        }
      }

      this.__placedBaseline = 0;
      for(let i = 0; i < this.activities.length; i++){
        if(this.actPlacement[i] >= 0) this.__placedBaseline += this.activities[i].duration;
      }"""

if target_pos in content:
    content = content.replace(target_pos, auto_repair_code)
    print("Added auto-repair for unplaced activities at the start of optimize()!")
else:
    print("Target pos for unplaced repair not found")

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

# Update cache buster in sapxep.html
sapxep_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html'
with codecs.open(sapxep_file, 'r', 'utf-8') as f:
    s_content = f.read()

s_content = s_content.replace('v=20260818-3way-cycle-fast-v2', 'v=20260818-auto-repair-unplaced-v3')
with codecs.open(sapxep_file, 'w', 'utf-8') as f:
    f.write(s_content)

print("Updated cache buster in sapxep.html to v=20260818-auto-repair-unplaced-v3")
