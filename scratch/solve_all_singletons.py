import sys, copy, random
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

class TimetableManager:
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

    def get_teacher_sessions_count(self, t_grid=None):
        if t_grid is None:
            t_grid = self.teacher_grid
        cnt = 0
        for tname, sched in t_grid.items():
            for d in range(6):
                for b in range(2):
                    s_start = d * 10 + b * 5
                    if any(sched[s_start + p] is not None for p in range(5)):
                        cnt += 1
        return cnt

    def get_cost(self, t_grid=None):
        if t_grid is None:
            t_grid = self.teacher_grid
        sings = self.get_singletons(t_grid)
        
        # Calculate gaps
        gaps = 0
        for tname, sched in t_grid.items():
            for d in range(6):
                for b in range(2):
                    s_start = d * 10 + b * 5
                    taught = [p for p in range(5) if sched[s_start + p] is not None]
                    if len(taught) > 1:
                        if max(taught) - min(taught) + 1 > len(taught):
                            gaps += 1
        return len(sings) * 1000 + gaps * 10 + self.get_teacher_sessions_count(t_grid)

    def is_valid_swap(self, cname, s1, s2, t_grid, c_grid):
        item1 = c_grid[cname][s1]
        item2 = c_grid[cname][s2]
        
        off_set = self.class_off_slots.get(cname, set())
        if item1 is not None and s2 in off_set:
            return False
        if item2 is not None and s1 in off_set:
            return False
            
        t1 = item1[0] if item1 else None
        t2 = item2[0] if item2 else None
        
        if t1 is not None and t1 != t2:
            if t_grid[t1][s2] is not None:
                return False
        if t2 is not None and t1 != t2:
            if t_grid[t2][s1] is not None:
                return False
                
        return True

    def apply_swap(self, cname, s1, s2, t_grid, c_grid):
        item1 = c_grid[cname][s1]
        item2 = c_grid[cname][s2]
        t1 = item1[0] if item1 else None
        t2 = item2[0] if item2 else None
        
        c_grid[cname][s1] = item2
        c_grid[cname][s2] = item1
        
        if t1 is not None:
            t_grid[t1][s1] = None
            t_grid[t1][s2] = item1[2]
        if t2 is not None:
            t_grid[t2][s2] = None
            t_grid[t2][s1] = item2[2]

    def solve_simulated_annealing(self, max_iter=200000):
        t_grid = copy.deepcopy(self.teacher_grid)
        c_grid = copy.deepcopy(self.class_grid)
        
        best_t = copy.deepcopy(t_grid)
        best_c = copy.deepcopy(c_grid)
        best_sings = len(self.get_singletons(best_t))
        best_cost = self.get_cost(best_t)
        
        curr_cost = best_cost
        
        print(f"Initial Singletons: {best_sings}, Initial Cost: {best_cost}")
        
        temp = 50.0
        cooling = 0.99995
        
        moves_history = []
        
        for it in range(max_iter):
            # Pick a class
            # With 70% probability, pick a class that has a singleton teacher
            sings = self.get_singletons(t_grid)
            if sings and random.random() < 0.8:
                chosen_sing = random.choice(sings)
                cname = chosen_sing['text'].split('-')[0].strip()
            else:
                cname = random.choice(self.classes)
                
            s1 = random.randint(0, 59)
            s2 = random.randint(0, 59)
            if s1 == s2:
                continue
                
            if self.is_valid_swap(cname, s1, s2, t_grid, c_grid):
                # Apply swap
                self.apply_swap(cname, s1, s2, t_grid, c_grid)
                new_cost = self.get_cost(t_grid)
                delta = new_cost - curr_cost
                
                # Acceptance criterion
                if delta < 0 or (temp > 0.01 and random.random() < pow(2.71828, -delta / temp)):
                    curr_cost = new_cost
                    curr_sings = len(self.get_singletons(t_grid))
                    if new_cost < best_cost:
                        best_cost = new_cost
                        best_sings = curr_sings
                        best_t = copy.deepcopy(t_grid)
                        best_c = copy.deepcopy(c_grid)
                        print(f"Iter {it}: Found better solution -> Singletons: {best_sings}, Cost: {best_cost}")
                        if best_sings == 0:
                            print("REACHED 0 SINGLETONS!")
                            break
                else:
                    # Revert swap
                    self.apply_swap(cname, s2, s1, t_grid, c_grid)
                    
            temp *= cooling
            if it % 20000 == 0:
                print(f"Iter {it}: Temp={temp:.2f}, CurrCost={curr_cost}, BestSings={best_sings}")
                
        print(f"\nFinal Best Singletons: {best_sings}, Cost: {best_cost}")
        self.teacher_grid = best_t
        self.class_grid = best_c
        return best_sings

tm = TimetableManager()
tm.solve_simulated_annealing(max_iter=150000)
