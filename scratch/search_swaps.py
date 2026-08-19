import sys, copy
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

class Solver:
    def __init__(self):
        self.teacher_grid = copy.deepcopy(atf.teacher_grid)
        self.class_grid = copy.deepcopy(atf.class_grid)
        self.class_off_slots = atf.class_off_slots
        self.slot_info = atf.slot_info
        self.teachers = list(self.teacher_grid.keys())
        self.classes = list(self.class_grid.keys())

    def get_singletons(self, t_grid=None):
        if t_grid is None:
            t_grid = self.teacher_grid
        singletons = []
        for tname, sched in t_grid.items():
            for d in range(6):
                for b in range(2):
                    s_start = d * 10 + b * 5
                    taught = [(p, s_start + p, sched[s_start + p]) for p in range(5) if sched[s_start + p] is not None]
                    if len(taught) == 1:
                        p, s_idx, text = taught[0]
                        info = self.slot_info[s_idx]
                        singletons.append({
                            'teacher': tname,
                            'day': info['day'],
                            'session': info['session'],
                            'period': info['period'],
                            'slot': s_idx,
                            'text': text
                        })
        return singletons

    def validate(self, t_grid=None, c_grid=None):
        if t_grid is None:
            t_grid = self.teacher_grid
        if c_grid is None:
            c_grid = self.class_grid
            
        # 1. Check off-periods
        for cname, sched in c_grid.items():
            off_set = self.class_off_slots.get(cname, set())
            for s_idx in range(60):
                if sched[s_idx] is not None and s_idx in off_set:
                    return False, f"Class {cname} off-period violation at slot {s_idx}"
        
        # 2. Check consistency between teacher_grid and class_grid
        # (no overlaps)
        for s_idx in range(60):
            # check each class has at most 1 teacher
            # check each teacher has at most 1 class
            # check match
            seen_c = {}
            for tname, sched in t_grid.items():
                if sched[s_idx] is not None:
                    txt = sched[s_idx]
                    cname = txt.split('-')[0].strip()
                    if cname in seen_c:
                        return False, f"Class {cname} double-booked at slot {s_idx} by {tname} and {seen_c[cname]}"
                    seen_c[cname] = tname
                    if c_grid[cname][s_idx] is None:
                        return False, f"Class grid missing entry for {cname} at slot {s_idx}"
        return True, "Valid"

    def try_direct_swap(self, cname, s1, s2):
        # Swap lessons of class cname between slot s1 and s2
        item1 = self.class_grid[cname][s1]
        item2 = self.class_grid[cname][s2]
        
        # Check if s1 or s2 are off-periods for cname
        off_set = self.class_off_slots.get(cname, set())
        if item1 is not None and s2 in off_set:
            return None, "s2 is off for class"
        if item2 is not None and s1 in off_set:
            return None, "s1 is off for class"
            
        t1 = item1[0] if item1 else None
        t2 = item2[0] if item2 else None
        
        # Check teacher availability
        # t1 must be free at s2 (except if t1 == t2, which is trivial)
        if t1 is not None:
            if self.teacher_grid[t1][s2] is not None and self.teacher_grid[t1][s2] != item2[2] if item2 else True:
                if self.teacher_grid[t1][s2] is not None:
                    return None, f"Teacher {t1} busy at s2 ({self.teacher_grid[t1][s2]})"
        if t2 is not None:
            if self.teacher_grid[t2][s1] is not None and self.teacher_grid[t2][s1] != item1[2] if item1 else True:
                if self.teacher_grid[t2][s1] is not None:
                    return None, f"Teacher {t2} busy at s1 ({self.teacher_grid[t2][s1]})"
                    
        # Simulate swap
        new_t_grid = {t: list(sched) for t, sched in self.teacher_grid.items()}
        new_c_grid = {c: list(sched) for c, sched in self.class_grid.items()}
        
        # Update class grid
        new_c_grid[cname][s1] = item2
        new_c_grid[cname][s2] = item1
        
        # Update teacher grid
        if t1 is not None:
            new_t_grid[t1][s1] = None
            new_t_grid[t1][s2] = item1[2]
        if t2 is not None:
            new_t_grid[t2][s2] = None
            new_t_grid[t2][s1] = item2[2]
            
        old_sing = len(self.get_singletons(self.teacher_grid))
        new_sing = len(self.get_singletons(new_t_grid))
        
        return {
            'cname': cname,
            's1': s1,
            's2': s2,
            'item1': item1,
            'item2': item2,
            'old_sing': old_sing,
            'new_sing': new_sing,
            'delta': new_sing - old_sing,
            'new_t_grid': new_t_grid,
            'new_c_grid': new_c_grid
        }, "OK"

solver = Solver()
initial_sing = solver.get_singletons()
print(f"Initial Singletons: {len(initial_sing)}")

# For each singleton, search all possible swaps within the class
for i, s in enumerate(initial_sing):
    gv = s['teacher']
    s1 = s['slot']
    cname = s['text'].split('-')[0].strip()
    
    print(f"\n--- Searching swaps for Singleton {i+1}: GV {gv} (Slot {s1}: {s['text']} - Thứ {s['day']} {s['session']} Tiết {s['period']}) ---")
    
    # Class cname has lessons at various slots
    valid_moves = []
    for s2 in range(60):
        if s2 == s1:
            continue
        res, msg = solver.try_direct_swap(cname, s1, s2)
        if res and res['delta'] < 0:
            item2 = res['item2']
            t2 = item2[0] if item2 else "Trống"
            txt2 = item2[2] if item2 else "Trống"
            info2 = solver.slot_info[s2]
            valid_moves.append((res['delta'], s2, info2, t2, txt2, res))
            
    valid_moves.sort(key=lambda x: x[0])
    if valid_moves:
        for delta, s2, info2, t2, txt2, res in valid_moves:
            print(f"  [GIẢM {abs(delta)} TIẾT LẺ] Hoán đổi với Slot {s2} (Thứ {info2['day']} {info2['session']} Tiết {info2['period']}): Đổi {s['text']} <-> {txt2} (GV {t2})")
    else:
        print("  Không tìm thấy hoán đổi 2 chiều đơn giản (Cần chuỗi hoán đổi 3-chiều hoặc nhiều bước).")
