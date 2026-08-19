import sys, copy, time
from collections import deque
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

class EjectionChainOptimizer:
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
        sing = []
        for tname, sched in t_grid.items():
            for d in range(6):
                for b in range(2):
                    s_start = d * 10 + b * 5
                    taught = [(p, s_start + p, sched[s_start + p]) for p in range(5) if sched[s_start + p] is not None]
                    if len(taught) == 1:
                        p, s_idx, text = taught[0]
                        info = self.slot_info[s_idx]
                        sing.append({
                            'teacher': tname,
                            'day': info['day'],
                            'session': info['session'],
                            'period': info['period'],
                            'slot': s_idx,
                            'text': text
                        })
        return sing

    def get_gaps_count(self, t_grid=None):
        if t_grid is None:
            t_grid = self.teacher_grid
        gap_count = 0
        for tname, sched in t_grid.items():
            for d in range(6):
                for b in range(2):
                    s_start = d * 10 + b * 5
                    taught = [p for p in range(5) if sched[s_start + p] is not None]
                    if len(taught) > 1:
                        if max(taught) - min(taught) + 1 > len(taught):
                            gap_count += 1
        return gap_count

    def apply_move_sequence(self, moves, t_grid, c_grid):
        # moves is a list of (cname, s_from, s_to, item)
        new_t = {t: list(sched) for t, sched in t_grid.items()}
        new_c = {c: list(sched) for c, sched in c_grid.items()}
        
        for cname, s_from, s_to, item in moves:
            tname = item[0]
            new_c[cname][s_from] = None
            new_c[cname][s_to] = item
            new_t[tname][s_from] = None
            new_t[tname][s_to] = item[2]
            
        return new_t, new_c

    def is_valid_state(self, t_grid, c_grid):
        # 1. Check off slots
        for cname, sched in c_grid.items():
            off_set = self.class_off_slots.get(cname, set())
            for s_idx in range(60):
                if sched[s_idx] is not None and s_idx in off_set:
                    return False
        
        # 2. Check no overlaps
        for s_idx in range(60):
            seen_c = set()
            for tname, sched in t_grid.items():
                if sched[s_idx] is not None:
                    txt = sched[s_idx]
                    cname = txt.split('-')[0].strip()
                    if cname in seen_c:
                        return False
                    seen_c.add(cname)
                    if c_grid[cname][s_idx] is None or c_grid[cname][s_idx][0] != tname:
                        return False
        return True

    def find_chain_for_singleton(self, target_sing, max_depth=4):
        # target_sing has: teacher, slot, text
        gv0 = target_sing['teacher']
        s0 = target_sing['slot']
        txt0 = target_sing['text']
        c0 = txt0.split('-')[0].strip()
        item0 = self.class_grid[c0][s0]
        
        # We want to move item0 from s0 to s_target
        # Where gv0 is free at s_target AND s_target is not off for c0
        # AND ideally s_target is in a session where gv0 already teaches.
        
        # Find candidate destination slots for gv0:
        candidate_slots = []
        for s in range(60):
            if s == s0:
                continue
            if s in self.class_off_slots.get(c0, set()):
                continue
            if self.teacher_grid[gv0][s] is not None:
                continue # gv0 busy
            # Check session of s: does gv0 already teach in that session?
            d = s // 10
            b = (s % 10) // 5
            s_start = d * 10 + b * 5
            taught_in_sess = sum(1 for p in range(5) if self.teacher_grid[gv0][s_start + p] is not None)
            if taught_in_sess > 0:
                candidate_slots.append((s, taught_in_sess))
        
        # Sort candidate slots by how many periods gv0 already teaches in that session (descending)
        candidate_slots.sort(key=lambda x: -x[1])
        
        # BFS Search for cycle of displacements within classes
        # State: (current_c, current_slot, current_item, moves_so_far, visited_slots)
        
        best_solution = None
        
        for s_dest, _ in candidate_slots:
            # We want to move item0 from s0 to s_dest in class c0
            # If s_dest in class c0 is empty:
            if self.class_grid[c0][s_dest] is None:
                moves = [(c0, s0, s_dest, item0)]
                new_t, new_c = self.apply_move_sequence(moves, self.teacher_grid, self.class_grid)
                if self.is_valid_state(new_t, new_c):
                    new_sing = len(self.get_singletons(new_t))
                    old_sing = len(self.get_singletons(self.teacher_grid))
                    if new_sing < old_sing:
                        return moves, new_t, new_c, old_sing - new_sing
            
            # If s_dest in class c0 is occupied by item1:
            item1 = self.class_grid[c0][s_dest]
            gv1 = item1[0]
            
            # Can item1 move to s0 directly? (2-way swap)
            if self.teacher_grid[gv1][s0] is None and s0 not in self.class_off_slots.get(c0, set()):
                moves = [
                    (c0, s0, s_dest, item0),
                    (c0, s_dest, s0, item1)
                ]
                new_t, new_c = self.apply_move_sequence(moves, self.teacher_grid, self.class_grid)
                if self.is_valid_state(new_t, new_c):
                    new_sing = len(self.get_singletons(new_t))
                    old_sing = len(self.get_singletons(self.teacher_grid))
                    if new_sing < old_sing:
                        return moves, new_t, new_c, old_sing - new_sing
                        
            # If not 2-way, try 3-way swap within c0:
            # item0 -> s_dest, item1 -> s_k, item_k -> s0
            for s_k in range(60):
                if s_k == s0 or s_k == s_dest:
                    continue
                if s_k in self.class_off_slots.get(c0, set()):
                    continue
                if self.teacher_grid[gv1][s_k] is not None:
                    continue
                item_k = self.class_grid[c0][s_k]
                if item_k is None:
                    continue
                gv_k = item_k[0]
                if self.teacher_grid[gv_k][s0] is not None:
                    continue
                moves = [
                    (c0, s0, s_dest, item0),
                    (c0, s_dest, s_k, item1),
                    (c0, s_k, s0, item_k)
                ]
                new_t, new_c = self.apply_move_sequence(moves, self.teacher_grid, self.class_grid)
                if self.is_valid_state(new_t, new_c):
                    new_sing = len(self.get_singletons(new_t))
                    old_sing = len(self.get_singletons(self.teacher_grid))
                    if new_sing < old_sing:
                        return moves, new_t, new_c, old_sing - new_sing

            # Try 4-way swap within c0:
            if max_depth >= 4:
                for s_k in range(60):
                    if s_k == s0 or s_k == s_dest:
                        continue
                    if s_k in self.class_off_slots.get(c0, set()):
                        continue
                    if self.teacher_grid[gv1][s_k] is not None:
                        continue
                    item_k = self.class_grid[c0][s_k]
                    if item_k is None:
                        continue
                    gv_k = item_k[0]
                    
                    for s_m in range(60):
                        if s_m in [s0, s_dest, s_k]:
                            continue
                        if s_m in self.class_off_slots.get(c0, set()):
                            continue
                        if self.teacher_grid[gv_k][s_m] is not None:
                            continue
                        item_m = self.class_grid[c0][s_m]
                        if item_m is None:
                            continue
                        gv_m = item_m[0]
                        if self.teacher_grid[gv_m][s0] is not None:
                            continue
                        moves = [
                            (c0, s0, s_dest, item0),
                            (c0, s_dest, s_k, item1),
                            (c0, s_k, s_m, item_k),
                            (c0, s_m, s0, item_m)
                        ]
                        new_t, new_c = self.apply_move_sequence(moves, self.teacher_grid, self.class_grid)
                        if self.is_valid_state(new_t, new_c):
                            new_sing = len(self.get_singletons(new_t))
                            old_sing = len(self.get_singletons(self.teacher_grid))
                            if new_sing < old_sing:
                                return moves, new_t, new_c, old_sing - new_sing

        return None, None, None, 0

    def solve_all(self):
        curr_sing = self.get_singletons()
        print(f"Bắt đầu giải... Tổng số tiết lẻ ban đầu: {len(curr_sing)}")
        
        step = 0
        while True:
            curr_sing = self.get_singletons()
            if not curr_sing:
                print("ĐÃ TRIỆT TIÊU 100% TIẾT LẺ!")
                break
                
            improved = False
            for s in curr_sing:
                moves, new_t, new_c, delta = self.find_chain_for_singleton(s, max_depth=4)
                if moves:
                    step += 1
                    print(f"\n[Bước {step}] Triệt tiêu tiết lẻ của GV {s['teacher']} (Lớp {s['text']}, Thứ {s['day']} {s['session']} Tiết {s['period']})!")
                    for m in moves:
                        info_f = self.slot_info[m[1]]
                        info_t = self.slot_info[m[2]]
                        print(f"   -> Chuyển {m[3][2]} (GV {m[3][0]}) từ Thứ {info_f['day']} {info_f['session']} Tiết {info_f['period']} sang Thứ {info_t['day']} {info_t['session']} Tiết {info_t['period']}")
                    
                    self.teacher_grid = new_t
                    self.class_grid = new_c
                    improved = True
                    break
            
            if not improved:
                print(f"\nKhông tìm thêm được chuỗi trong cùng lớp. Số tiết lẻ còn lại: {len(self.get_singletons())}")
                break
                
        return self.get_singletons()

opt = EjectionChainOptimizer()
rem = opt.solve_all()
print(f"\nKết quả cuối cùng: Còn {len(rem)} tiết lẻ")
