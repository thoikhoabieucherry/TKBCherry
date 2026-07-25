use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Map, Value};

const DAYS: [(&str, i64); 6] = [
    ("thu2", 2),
    ("thu3", 3),
    ("thu4", 4),
    ("thu5", 5),
    ("thu6", 6),
    ("thu7", 7),
];
const SESSIONS: [(&str, &str); 2] = [("sang", "AM"), ("chieu", "PM")];
const PERIODS_PER_SESSION: i64 = 5;
const MIN_SOLVER_DEADLINE_MS: u64 = 1_000;
const MAX_SOLVER_DEADLINE_MS: u64 = 1_800_000;
const DEFAULT_SOLVER_DEADLINE_MS: u64 = 180_000;
const DEFAULT_SOLVER_RESERVE_MS: u64 = 1_500;
const MAX_SOLVER_RESERVE_MS: u64 = 30_000;
const QUALITY_PRIORITY_BALANCED: &str = "one_period_gap2_teacher_sessions_gap1";
const QUALITY_PRIORITY_TWO_STAGE: &str = "one_period_teacher_sessions_gap2_gap1";

pub struct NativeSolveResult {
    pub payload: String,
    pub status: u16,
}

#[derive(Clone, Debug)]
pub struct ValidatedAgentCandidate {
    pub payload: Value,
    pub quality: [i64; 4],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OptimizationFocus {
    Automatic,
    QuickComplete,
    Singletons,
    Sessions,
    Gaps,
}

impl OptimizationFocus {
    fn from_settings(settings: Option<&Map<String, Value>>) -> Self {
        let normalized = settings
            .and_then(|value| value.get("optimization_focus"))
            .and_then(Value::as_str)
            .unwrap_or("automatic")
            .trim()
            .to_ascii_lowercase()
            .replace('-', "_")
            .replace(' ', "_");
        match normalized.as_str() {
            "quick" | "complete" | "quick_complete" => Self::QuickComplete,
            "singleton" | "singletons" | "one_period_teacher_sessions" => Self::Singletons,
            "session" | "sessions" | "teacher_sessions" => Self::Sessions,
            "gap" | "gaps" | "teacher_gaps" => Self::Gaps,
            _ => Self::Automatic,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::QuickComplete => "quick_complete",
            Self::Singletons => "singletons",
            Self::Sessions => "sessions",
            Self::Gaps => "gaps",
        }
    }
}

#[derive(Clone, Copy)]
struct SolverConfig {
    backend_deadline_ms: u64,
    native_global_deadline_ms: u64,
    native_deadline_reserve_ms: u64,
    require_complete_schedule: bool,
    best_effort_on_timeout: bool,
    skip_teacher_optimization: bool,
    two_stage_teacher_quality: bool,
    optimization_focus: OptimizationFocus,
    random_seed: u64,
}

impl SolverConfig {
    fn from_request(request: &Value, random_seed: u64) -> Self {
        let settings = request.get("settings").and_then(Value::as_object);
        let optimization_focus = OptimizationFocus::from_settings(settings);
        let require_complete_schedule = settings_bool(settings, "require_complete_schedule", true);
        let backend_deadline_ms =
            settings_u64(settings, "backend_deadline_ms", DEFAULT_SOLVER_DEADLINE_MS)
                .clamp(MIN_SOLVER_DEADLINE_MS, MAX_SOLVER_DEADLINE_MS);
        let native_global_deadline_ms =
            settings_u64(settings, "native_global_deadline_ms", backend_deadline_ms)
                .clamp(MIN_SOLVER_DEADLINE_MS, MAX_SOLVER_DEADLINE_MS);
        let effective_deadline_ms = backend_deadline_ms.min(native_global_deadline_ms);
        let requested_reserve_ms = settings_u64_allow_zero(
            settings,
            "native_deadline_reserve_ms",
            DEFAULT_SOLVER_RESERVE_MS,
        )
        .min(MAX_SOLVER_RESERVE_MS);
        Self {
            backend_deadline_ms,
            native_global_deadline_ms,
            native_deadline_reserve_ms: requested_reserve_ms
                .min(effective_deadline_ms.saturating_sub(MIN_SOLVER_DEADLINE_MS)),
            require_complete_schedule,
            best_effort_on_timeout: settings_bool(
                settings,
                "best_effort_on_timeout",
                !require_complete_schedule,
            ),
            skip_teacher_optimization: optimization_focus == OptimizationFocus::QuickComplete
                || settings
                    .and_then(|value| value.get("native_skip_teacher_optimization"))
                    .map(truthy)
                    .unwrap_or(false),
            two_stage_teacher_quality: two_stage_teacher_quality_requested(settings),
            optimization_focus,
            random_seed,
        }
    }

    fn effective_deadline_ms(&self) -> u64 {
        self.backend_deadline_ms
            .min(self.native_global_deadline_ms)
            .max(1_000)
    }
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn tkb_now_ms() -> f64;
}

fn wall_clock_ms() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        // The browser host provides Date.now(). Keeping time outside the WASM
        // module avoids a WASI/Linux runtime and lets the same solver run in
        // signed Microsoft Edge on Windows.
        let value = unsafe { tkb_now_ms() };
        if value.is_finite() && value > 0.0 {
            return value.min(u64::MAX as f64) as u64;
        }
        return 0;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0)
    }
}

struct SolveClock<'a> {
    started_at_ms: u64,
    deadline_at_ms: u64,
    reserve_ms: u64,
    cancel_requested: Option<&'a AtomicBool>,
}

impl<'a> SolveClock<'a> {
    fn new(config: SolverConfig, cancel_requested: Option<&'a AtomicBool>) -> Self {
        let started_at_ms = wall_clock_ms();
        Self {
            started_at_ms,
            deadline_at_ms: started_at_ms.saturating_add(config.effective_deadline_ms()),
            reserve_ms: config.native_deadline_reserve_ms,
            cancel_requested,
        }
    }

    fn elapsed_seconds(&self) -> f64 {
        wall_clock_ms().saturating_sub(self.started_at_ms) as f64 / 1_000.0
    }

    fn time_remaining_ms(&self) -> i64 {
        self.deadline_at_ms
            .saturating_sub(wall_clock_ms())
            .min(i64::MAX as u64) as i64
    }

    fn deadline_hit(&self) -> bool {
        if self.cancelled() {
            return true;
        }
        self.time_remaining_ms() <= 0
    }

    fn should_stop_quality(&self) -> bool {
        if self.cancelled() {
            return true;
        }
        self.deadline_hit() || self.time_remaining_ms() <= self.reserve_ms as i64
    }

    fn cancelled(&self) -> bool {
        self.cancel_requested
            .map(|flag| flag.load(Ordering::SeqCst))
            .unwrap_or(false)
    }
}

#[derive(Clone, Debug)]
struct ClassInfo {
    id: String,
    name: String,
    grade: String,
    aliases: Vec<String>,
}

#[derive(Clone, Debug)]
struct SubjectInfo {
    canonical: String,
    aliases: Vec<String>,
}

#[derive(Clone, Debug)]
struct Assignment {
    class_id: String,
    class_name: String,
    subject: String,
    teacher: String,
    room: String,
    periods: i64,
    session_limit: i64,
    day_limits: HashMap<i64, i64>,
    quick_min_two_blocks: i64,
    quick_avoid_pair23_morning: bool,
    quick_avoid_pair23_afternoon: bool,
}

#[derive(Clone, Debug)]
struct PendingQuickAssignment {
    assignment: Assignment,
    remaining: i64,
    sequence: i64,
    required_two_blocks: i64,
}

#[derive(Clone, Copy, Debug)]
struct QuickPlacementChoice {
    domain_size: usize,
    unit_size: i64,
    remaining: i64,
    teacher_load: i64,
    tie_break: u64,
}

#[derive(Default)]
struct QuickOccupancyIndex {
    off_by_class: HashMap<String, u64>,
    occupied_by_class: HashMap<String, u64>,
    occupied_by_teacher: HashMap<String, u64>,
    occupied_by_room: HashMap<String, u64>,
    occupied_by_subject: HashMap<(String, String), u64>,
}

impl QuickOccupancyIndex {
    fn from_state(
        assignments: &[PendingQuickAssignment],
        off_slots: &HashSet<String>,
        lessons: &[Value],
    ) -> Self {
        let mut index = Self::default();
        let mut seen_classes = HashSet::new();
        for item in assignments {
            let assignment = &item.assignment;
            if !seen_classes.insert(assignment.class_id.clone()) {
                continue;
            }
            for (_, day) in DAYS {
                for (session_key, _) in SESSIONS {
                    for period in 0..PERIODS_PER_SESSION {
                        let slot = make_slot(day, session_key, period);
                        let bit = quick_slot_bit(&slot);
                        if off_slots.contains(&slot_key(&assignment.class_id, &slot)) {
                            *index
                                .off_by_class
                                .entry(assignment.class_id.clone())
                                .or_insert(0) |= bit;
                        }
                    }
                }
            }
        }
        for lesson in lessons {
            let Some(slot) = lesson_slot(lesson) else {
                continue;
            };
            let bit = quick_slot_bit(&slot);
            let class_id = lesson_class_id(lesson);
            let subject = norm(&lesson_subject(lesson));
            let teacher = lesson_teacher_key(lesson);
            let room = norm(&lesson_room(lesson));
            *index.occupied_by_class.entry(class_id.clone()).or_insert(0) |= bit;
            if !subject.is_empty() {
                *index
                    .occupied_by_subject
                    .entry((class_id, subject))
                    .or_insert(0) |= bit;
            }
            if !teacher.is_empty() {
                *index.occupied_by_teacher.entry(teacher).or_insert(0) |= bit;
            }
            if !room.is_empty() {
                *index.occupied_by_room.entry(room).or_insert(0) |= bit;
            }
        }
        index
    }

    fn available_mask(&self, assignment: &Assignment) -> u64 {
        let mut blocked = self
            .off_by_class
            .get(&assignment.class_id)
            .copied()
            .unwrap_or(0)
            | self
                .occupied_by_class
                .get(&assignment.class_id)
                .copied()
                .unwrap_or(0);
        let teacher = norm(&assignment.teacher);
        if !teacher.is_empty() {
            blocked |= self.occupied_by_teacher.get(&teacher).copied().unwrap_or(0);
        }
        let room = norm(&assignment.room);
        if !room.is_empty() {
            blocked |= self.occupied_by_room.get(&room).copied().unwrap_or(0);
        }
        QUICK_ALL_SLOTS_MASK & !blocked
    }

    fn subject_mask(&self, assignment: &Assignment) -> u64 {
        self.occupied_by_subject
            .get(&(assignment.class_id.clone(), norm(&assignment.subject)))
            .copied()
            .unwrap_or(0)
    }

    fn add(&mut self, assignment: &Assignment, slot: &Slot) {
        let bit = quick_slot_bit(slot);
        *self
            .occupied_by_class
            .entry(assignment.class_id.clone())
            .or_insert(0) |= bit;
        *self
            .occupied_by_subject
            .entry((assignment.class_id.clone(), norm(&assignment.subject)))
            .or_insert(0) |= bit;
        if !assignment.teacher.is_empty() {
            *self
                .occupied_by_teacher
                .entry(norm(&assignment.teacher))
                .or_insert(0) |= bit;
        }
        if !assignment.room.is_empty() {
            *self
                .occupied_by_room
                .entry(norm(&assignment.room))
                .or_insert(0) |= bit;
        }
    }
}

const QUICK_ALL_SLOTS_MASK: u64 = (1_u64 << 60) - 1;

fn quick_slot_bit(slot: &Slot) -> u64 {
    let day_offset = slot.day.saturating_sub(2).clamp(0, 5) as u32;
    let session_offset = if slot.session_key == "chieu" { 5 } else { 0 };
    let offset = day_offset * 10 + session_offset + slot.period_index.clamp(0, 4) as u32;
    1_u64 << offset
}

#[derive(Clone, Debug)]
struct SubjectLimit {
    per_session: i64,
    per_day: HashMap<i64, i64>,
}

type SubjectLimitMap = HashMap<(String, String), SubjectLimit>;

#[derive(Clone, Debug)]
struct Slot {
    day_key: String,
    day: i64,
    session_key: String,
    session: &'static str,
    period_index: i64,
}

#[derive(Default)]
struct HeuristicState {
    class_day_load: HashMap<String, i64>,
    class_session_load: HashMap<String, i64>,
    class_subject_day_load: HashMap<String, i64>,
    class_subject_session_load: HashMap<String, i64>,
    class_subject_session_slots: HashMap<String, Vec<i64>>,
    teacher_day_load: HashMap<String, i64>,
    teacher_session_load: HashMap<String, i64>,
    teacher_session_periods: HashMap<String, Vec<i64>>,
}

impl HeuristicState {
    fn add(&mut self, class_id: &str, subject: &str, teacher: &str, slot: &Slot) {
        *self
            .class_day_load
            .entry(format!("{}|{}", class_id, slot.day_key))
            .or_insert(0) += 1;
        *self
            .class_session_load
            .entry(format!(
                "{}|{}|{}",
                class_id, slot.day_key, slot.session_key
            ))
            .or_insert(0) += 1;
        *self
            .class_subject_day_load
            .entry(format!("{}|{}|{}", class_id, norm(subject), slot.day_key))
            .or_insert(0) += 1;
        self.class_subject_session_slots
            .entry(format!(
                "{}|{}|{}|{}",
                class_id,
                norm(subject),
                slot.day_key,
                slot.session_key
            ))
            .or_default()
            .push(slot.period_index);
        *self
            .class_subject_session_load
            .entry(format!(
                "{}|{}|{}|{}",
                class_id,
                norm(subject),
                slot.day_key,
                slot.session_key
            ))
            .or_insert(0) += 1;
        if !teacher.trim().is_empty() {
            let teacher_key = norm(teacher);
            *self
                .teacher_day_load
                .entry(format!("{}|{}", teacher_key, slot.day_key))
                .or_insert(0) += 1;
            *self
                .teacher_session_load
                .entry(format!(
                    "{}|{}|{}",
                    teacher_key, slot.day_key, slot.session_key
                ))
                .or_insert(0) += 1;
            self.teacher_session_periods
                .entry(format!(
                    "{}|{}|{}",
                    teacher_key, slot.day_key, slot.session_key
                ))
                .or_default()
                .push(slot.period_index);
        }
    }

    fn score(&self, assignment: &Assignment, slot: &Slot, run_seed: u64) -> i64 {
        let class_day = self
            .class_day_load
            .get(&format!("{}|{}", assignment.class_id, slot.day_key))
            .copied()
            .unwrap_or(0);
        let class_session = self
            .class_session_load
            .get(&format!(
                "{}|{}|{}",
                assignment.class_id, slot.day_key, slot.session_key
            ))
            .copied()
            .unwrap_or(0);
        let subject_day = self
            .class_subject_day_load
            .get(&format!(
                "{}|{}|{}",
                assignment.class_id,
                norm(&assignment.subject),
                slot.day_key
            ))
            .copied()
            .unwrap_or(0);
        let subject_session = self
            .class_subject_session_load
            .get(&format!(
                "{}|{}|{}|{}",
                assignment.class_id,
                norm(&assignment.subject),
                slot.day_key,
                slot.session_key
            ))
            .copied()
            .unwrap_or(0);
        let teacher_key = norm(&assignment.teacher);
        let teacher_day = self
            .teacher_day_load
            .get(&format!("{}|{}", teacher_key, slot.day_key))
            .copied()
            .unwrap_or(0);
        let teacher_session = self
            .teacher_session_load
            .get(&format!(
                "{}|{}|{}",
                teacher_key, slot.day_key, slot.session_key
            ))
            .copied()
            .unwrap_or(0);
        let teacher_compact = if teacher_key.is_empty() {
            0
        } else if teacher_session == 1 {
            -760
        } else if teacher_session > 0 {
            -420 - teacher_session * 30
        } else if teacher_day > 0 {
            80 - teacher_day * 8
        } else {
            180
        };

        subject_day * 95
            + subject_session * 60
            + class_session * 10
            + class_day * 4
            + teacher_compact
            + slot.period_index
            + slot_jitter(assignment, slot, run_seed)
    }

    fn subject_day_count(&self, class_id: &str, subject: &str, slot: &Slot) -> i64 {
        self.class_subject_day_load
            .get(&format!("{}|{}|{}", class_id, norm(subject), slot.day_key))
            .copied()
            .unwrap_or(0)
    }

    fn subject_session_count(&self, class_id: &str, subject: &str, slot: &Slot) -> i64 {
        self.class_subject_session_load
            .get(&format!(
                "{}|{}|{}|{}",
                class_id,
                norm(subject),
                slot.day_key,
                slot.session_key
            ))
            .copied()
            .unwrap_or(0)
    }

    fn can_place_subject_session(&self, assignment: &Assignment, slot: &Slot) -> bool {
        let day_count = self.subject_day_count(&assignment.class_id, &assignment.subject, slot);
        if assignment
            .day_limits
            .get(&slot.day)
            .is_some_and(|limit| day_count >= *limit)
        {
            return false;
        }

        let current = self.subject_session_count(&assignment.class_id, &assignment.subject, slot);
        if assignment.session_limit > 0 && current >= assignment.session_limit {
            return false;
        }
        if assignment.session_limit < 2 || current == 0 {
            return true;
        }
        let mut periods = self
            .class_subject_session_slots
            .get(&format!(
                "{}|{}|{}|{}",
                assignment.class_id,
                norm(&assignment.subject),
                slot.day_key,
                slot.session_key
            ))
            .cloned()
            .unwrap_or_default();
        periods.push(slot.period_index);
        consecutive_periods(&periods)
    }
}

pub fn validate_agent_candidate(
    request_body: &[u8],
    candidate: &Value,
) -> Result<ValidatedAgentCandidate, String> {
    let request: Value = serde_json::from_slice(request_body)
        .map_err(|err| format!("solver request JSON invalid: {err}"))?;
    let request_settings = request.get("settings").and_then(Value::as_object);
    let data = request
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "solver request is missing its data object".to_string())?;
    let candidate_object = candidate
        .as_object()
        .ok_or_else(|| "agent candidate must be a JSON object".to_string())?;
    if candidate_object.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("agent candidate did not report a successful result".to_string());
    }
    let reported_metrics = candidate_object
        .get("metrics")
        .and_then(Value::as_object)
        .ok_or_else(|| "agent candidate is missing metrics".to_string())?;
    if reported_metrics.get("hard_ok").and_then(Value::as_bool) != Some(true)
        || int_value(reported_metrics.get("app_constraint_violation_count"), -1) != 0
        || int_value(reported_metrics.get("unassigned_periods"), -1) != 0
    {
        return Err("agent candidate did not report a complete hard-valid schedule".to_string());
    }
    if candidate_object
        .get("validation")
        .and_then(|value| value.get("hard_ok"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err("agent candidate validation did not report hard_ok".to_string());
    }
    let reported_unassigned = candidate_object
        .get("unassignedLessons")
        .and_then(Value::as_array)
        .ok_or_else(|| "agent candidate is missing unassignedLessons".to_string())?;
    if !reported_unassigned.is_empty() {
        return Err("agent candidate contains unassigned lessons".to_string());
    }
    let candidate_lessons = candidate_object
        .get("lessons")
        .and_then(Value::as_array)
        .ok_or_else(|| "agent candidate is missing lessons".to_string())?;

    let classes = parse_classes(data);
    let subjects = parse_subjects(data);
    let subject_alias = subject_alias_map(&subjects);
    let class_alias = class_alias_map(&classes);
    let period_map = period_map(data, &subject_alias);
    let session_limit_map = session_limit_map(data, &subject_alias);
    let constraint_day_limits =
        constraint_subject_day_limit_map(data, &class_alias, &subject_alias);
    let pccm_periods = numeric_matrix(data.get("pccmTietMatrix"));
    let pccm_session_limits = numeric_matrix(data.get("pccmGioihanMatrix"));
    let pccm_rooms = string_matrix(data.get("pccmRoomMatrix"));
    let assignments = parse_assignments(
        data,
        &classes,
        &class_alias,
        &subject_alias,
        &period_map,
        &session_limit_map,
        &constraint_day_limits,
        &pccm_periods,
        &pccm_session_limits,
        &pccm_rooms,
    );
    if assignments.is_empty() {
        return Err("solver request contains no schedulable assignments".to_string());
    }
    let subject_limits = subject_limit_map(&assignments);
    let off_slots = collect_off_slots(data, &class_alias);
    let fixed_lessons = collect_fixed_lessons(data, &class_alias, &subject_alias);

    type AssignmentKey = (String, String);
    let mut expected_counts: HashMap<AssignmentKey, i64> = HashMap::new();
    let mut expected_resources: HashMap<AssignmentKey, (String, String)> = HashMap::new();
    for assignment in &assignments {
        let key = (assignment.class_id.clone(), norm(&assignment.subject));
        *expected_counts.entry(key.clone()).or_insert(0) += assignment.periods;
        let resources = (assignment.teacher.clone(), assignment.room.clone());
        if expected_resources
            .insert(key.clone(), resources.clone())
            .is_some_and(|existing| {
                norm(&existing.0) != norm(&resources.0) || norm(&existing.1) != norm(&resources.1)
            })
        {
            return Err("solver request has conflicting assignment resources".to_string());
        }
    }
    let expected_periods = expected_counts.values().copied().sum::<i64>();
    if expected_periods <= 0 || candidate_lessons.len() as i64 != expected_periods {
        return Err("agent candidate lesson count does not match the request".to_string());
    }
    if int_value(reported_metrics.get("scheduled_periods"), -1) != expected_periods
        || int_value(reported_metrics.get("expected_periods"), -1) != expected_periods
    {
        return Err("agent candidate reported inconsistent lesson totals".to_string());
    }

    type FixedKey = (String, String, i64, String, i64);
    let mut required_fixed = HashSet::<FixedKey>::new();
    for fixed in &fixed_lessons {
        let key = (
            fixed.class_id.clone(),
            norm(&fixed.subject),
            fixed.slot.day,
            fixed.slot.session_key.clone(),
            fixed.slot.period_index,
        );
        if !required_fixed.insert(key) {
            return Err("solver request contains duplicate fixed lessons".to_string());
        }
    }

    let mut normalized_lessons = Vec::with_capacity(candidate_lessons.len());
    let mut observed_counts: HashMap<AssignmentKey, i64> = HashMap::new();
    let mut observed_fixed = HashSet::<FixedKey>::new();
    for (index, raw_lesson) in candidate_lessons.iter().enumerate() {
        if !raw_lesson.is_object() {
            return Err(format!("agent candidate lesson {index} is not an object"));
        }
        let raw_class = {
            let class_id = lesson_class_id(raw_lesson);
            if !class_id.is_empty() {
                class_id
            } else {
                let class_name = lesson_string(raw_lesson, "className");
                if !class_name.is_empty() {
                    class_name
                } else {
                    lesson_string(raw_lesson, "class")
                }
            }
        };
        let class = class_alias
            .get(&norm(&raw_class))
            .ok_or_else(|| format!("agent candidate lesson {index} has an unknown class"))?;
        let subject = canonical_subject(&lesson_subject(raw_lesson), &subject_alias);
        let assignment_key = (class.id.clone(), norm(&subject));
        let expected_count = expected_counts
            .get(&assignment_key)
            .copied()
            .ok_or_else(|| {
                format!("agent candidate lesson {index} is not part of the requested demand")
            })?;
        let (expected_teacher, expected_room) = expected_resources
            .get(&assignment_key)
            .ok_or_else(|| "solver request assignment resources are missing".to_string())?;
        let candidate_teacher = lesson_string(raw_lesson, "teacher");
        let candidate_room = lesson_room(raw_lesson);
        if norm(&candidate_teacher) != norm(expected_teacher)
            || norm(&candidate_room) != norm(expected_room)
        {
            return Err(format!(
                "agent candidate lesson {index} changed its assigned teacher or room"
            ));
        }
        let slot = lesson_slot(raw_lesson)
            .ok_or_else(|| format!("agent candidate lesson {index} has an invalid slot"))?;
        if !DAYS.iter().any(|(_, day)| *day == slot.day)
            || !SESSIONS
                .iter()
                .any(|(session_key, _)| *session_key == slot.session_key)
        {
            return Err(format!(
                "agent candidate lesson {index} has an unsupported day or session"
            ));
        }
        let observed = observed_counts.entry(assignment_key.clone()).or_insert(0);
        *observed += 1;
        if *observed > expected_count {
            return Err("agent candidate exceeds a requested class-subject demand".to_string());
        }
        let fixed_key = (
            class.id.clone(),
            assignment_key.1.clone(),
            slot.day,
            slot.session_key.clone(),
            slot.period_index,
        );
        let is_fixed = required_fixed.contains(&fixed_key);
        if is_fixed {
            observed_fixed.insert(fixed_key);
        }
        normalized_lessons.push(lesson_json(
            &class.id,
            &class.name,
            &subject,
            expected_teacher,
            expected_room,
            &slot,
            is_fixed,
        ));
    }

    if observed_counts != expected_counts {
        return Err("agent candidate does not preserve exact assignment demand".to_string());
    }
    if observed_fixed != required_fixed {
        return Err("agent candidate moved or removed a fixed lesson".to_string());
    }
    let subject_violations = subject_limit_violations(&normalized_lessons, &subject_limits);
    if !subject_violations.is_empty()
        || !schedule_hard_ok(&normalized_lessons, &off_slots, &subject_limits)
    {
        return Err("agent candidate violates timetable hard constraints".to_string());
    }

    let gap_metrics = teacher_gap_metrics(&normalized_lessons);
    let one_period_sessions = count_one_period_teacher_sessions(&normalized_lessons);
    let teacher_sessions = count_teacher_sessions(&normalized_lessons);
    let two_stage_teacher_quality = two_stage_teacher_quality_requested(request_settings);
    let quality_priority_order = quality_priority_order(two_stage_teacher_quality);
    let optimization_focus = OptimizationFocus::from_settings(request_settings);
    let candidate_teacher_quality = TeacherOptimizationQuality {
        one_period_sessions,
        teacher_sessions,
        gap2_plus_sessions: gap_metrics.gap2_plus_sessions,
        gap1_sessions: gap_metrics.distribution.get("1").copied().unwrap_or(0),
        total_gap: gap_metrics.total_gap,
    };
    let incumbent_lessons = collect_existing_schedule_lessons(data, &class_alias, &subject_alias);
    if incumbent_lessons.len() as i64 == expected_periods
        && schedule_hard_ok(&incumbent_lessons, &off_slots, &subject_limits)
    {
        let incumbent_quality = teacher_optimization_quality(&incumbent_lessons);
        if !focused_agent_candidate_acceptable(
            optimization_focus,
            two_stage_teacher_quality,
            &incumbent_quality,
            &candidate_teacher_quality,
        ) {
            return Err(
                "agent candidate regresses the requested optimization-focus envelope".to_string(),
            );
        }
    }
    // These two request fields are search goals, not authored timetable
    // constraints. A hard-valid complete Agent result must remain publishable
    // when the user's real constraints make zero singletons or zero gap-2
    // impossible. Complete-incumbent refinements are still protected above by
    // the focus-specific non-regression envelope.
    let quality = if two_stage_teacher_quality {
        [
            one_period_sessions,
            teacher_sessions,
            gap_metrics.gap2_plus_sessions,
            gap_metrics.total_gap,
        ]
    } else {
        [
            one_period_sessions,
            gap_metrics.gap2_plus_sessions,
            teacher_sessions,
            gap_metrics.total_gap,
        ]
    };
    let class_payload = classes
        .iter()
        .map(|class| {
            json!({
                "id": class.id,
                "name": class.name,
                "grade": class.grade
            })
        })
        .collect::<Vec<_>>();
    let mut payload = candidate.clone();
    let payload_object = payload
        .as_object_mut()
        .ok_or_else(|| "agent candidate must be a JSON object".to_string())?;
    payload_object.insert("ok".to_string(), json!(true));
    payload_object.insert("kind".to_string(), json!(""));
    payload_object.insert("error".to_string(), json!(""));
    payload_object.insert("classes".to_string(), json!(class_payload));
    payload_object.insert("lessons".to_string(), json!(normalized_lessons));
    payload_object.insert("unassignedLessons".to_string(), json!([]));
    payload_object.insert("warnings".to_string(), json!([]));
    payload_object.insert("bestEffort".to_string(), json!(false));
    payload_object.insert("generatedAt".to_string(), json!(current_timestamp_string()));

    let metrics = payload_object
        .entry("metrics".to_string())
        .or_insert_with(|| json!({}));
    if !metrics.is_object() {
        *metrics = json!({});
    }
    let metrics = metrics
        .as_object_mut()
        .ok_or_else(|| "cannot normalize agent candidate metrics".to_string())?;
    metrics.insert("scheduled_periods".to_string(), json!(expected_periods));
    metrics.insert("expected_periods".to_string(), json!(expected_periods));
    metrics.insert("unassigned_periods".to_string(), json!(0));
    metrics.insert("app_constraint_violation_count".to_string(), json!(0));
    metrics.insert("hard_ok".to_string(), json!(true));
    metrics.insert("core_hard_ok".to_string(), json!(true));
    metrics.insert("placement_hard_ok".to_string(), json!(true));
    metrics.insert("placement_core_hard_ok".to_string(), json!(true));
    metrics.insert("best_effort".to_string(), json!(false));
    metrics.insert("teacher_sessions".to_string(), json!(teacher_sessions));
    metrics.insert(
        "one_period_teacher_sessions".to_string(),
        json!(one_period_sessions),
    );
    metrics.insert("gap_total".to_string(), json!(gap_metrics.total_gap));
    metrics.insert(
        "gap_distribution".to_string(),
        json!(gap_metrics.distribution),
    );
    metrics.insert(
        "teacher_gap2_sessions".to_string(),
        json!(gap_metrics.gap2_plus_sessions),
    );
    metrics.insert(
        "quality_priority_order".to_string(),
        json!(quality_priority_order),
    );
    metrics.insert(
        "optimization_focus".to_string(),
        json!(optimization_focus.as_str()),
    );

    let validation = payload_object
        .entry("validation".to_string())
        .or_insert_with(|| json!({}));
    if !validation.is_object() {
        *validation = json!({});
    }
    let validation = validation
        .as_object_mut()
        .ok_or_else(|| "cannot normalize agent candidate validation".to_string())?;
    validation.insert("hard_ok".to_string(), json!(true));
    validation.insert("placement_hard_ok".to_string(), json!(true));
    validation.insert("violations".to_string(), json!([]));
    validation.insert("agent_helper_vps_validated".to_string(), json!(true));

    let solver = payload_object
        .entry("solver".to_string())
        .or_insert_with(|| json!({}));
    if !solver.is_object() {
        *solver = json!({});
    }
    let solver = solver
        .as_object_mut()
        .ok_or_else(|| "cannot normalize agent candidate solver metadata".to_string())?;
    solver.insert("agentHelperValidated".to_string(), json!(true));
    solver.insert("validationAuthority".to_string(), json!("vps"));
    let runtime_settings = solver
        .entry("runtime_settings".to_string())
        .or_insert_with(|| json!({}));
    if !runtime_settings.is_object() {
        *runtime_settings = json!({});
    }
    runtime_settings
        .as_object_mut()
        .ok_or_else(|| "cannot normalize agent candidate runtime settings".to_string())?
        .insert(
            "quality_priority_order".to_string(),
            json!(quality_priority_order),
        );
    runtime_settings
        .as_object_mut()
        .ok_or_else(|| "cannot normalize agent candidate runtime settings".to_string())?
        .insert(
            "optimization_focus".to_string(),
            json!(optimization_focus.as_str()),
        );

    Ok(ValidatedAgentCandidate { payload, quality })
}

pub fn solve_native_hint_json(
    _root: &Path,
    stdin_body: &[u8],
    cancel_requested: Option<&AtomicBool>,
) -> Result<Option<NativeSolveResult>, String> {
    let request: Value = serde_json::from_slice(stdin_body)
        .map_err(|err| format!("solver request JSON invalid: {err}"))?;
    let Some(data) = request.get("data").and_then(Value::as_object) else {
        return Err("missing data object".to_string());
    };
    let run_seed = solve_seed(&request);
    let config = SolverConfig::from_request(&request, run_seed);
    let clock = SolveClock::new(config, cancel_requested);
    let optimize_existing = request
        .get("settings")
        .and_then(|value| value.get("optimize_existing_schedule"))
        .map(truthy)
        .unwrap_or(false);
    let result = if optimize_existing {
        solve_existing_schedule(data, run_seed, config, &clock)?
    } else {
        solve_simple(data, run_seed, config, &clock)?
    };
    Ok(Some(result))
}

fn solve_existing_schedule(
    data: &Map<String, Value>,
    run_seed: u64,
    config: SolverConfig,
    clock: &SolveClock,
) -> Result<NativeSolveResult, String> {
    let classes = parse_classes(data);
    let subjects = parse_subjects(data);
    let subject_alias = subject_alias_map(&subjects);
    let class_alias = class_alias_map(&classes);
    let period_map = period_map(data, &subject_alias);
    let session_limit_map = session_limit_map(data, &subject_alias);
    let constraint_day_limits =
        constraint_subject_day_limit_map(data, &class_alias, &subject_alias);
    let pccm_periods = numeric_matrix(data.get("pccmTietMatrix"));
    let pccm_session_limits = numeric_matrix(data.get("pccmGioihanMatrix"));
    let pccm_rooms = string_matrix(data.get("pccmRoomMatrix"));
    let assignments = parse_assignments(
        data,
        &classes,
        &class_alias,
        &subject_alias,
        &period_map,
        &session_limit_map,
        &constraint_day_limits,
        &pccm_periods,
        &pccm_session_limits,
        &pccm_rooms,
    );
    let subject_limits = subject_limit_map(&assignments);
    let off_slots = collect_off_slots(data, &class_alias);
    let mut lessons = collect_existing_schedule_lessons(data, &class_alias, &subject_alias);
    if lessons.is_empty() {
        return Err("missing existing schedule to optimize".to_string());
    }
    let assignment_expected_periods = assignments.iter().map(|item| item.periods).sum::<i64>();
    let expected_periods = data
        .get("tkbSolverResult")
        .and_then(|value| value.get("metrics"))
        .and_then(|value| value.get("expected_periods"))
        .and_then(Value::as_i64)
        .unwrap_or(assignment_expected_periods)
        .max(assignment_expected_periods)
        .max(lessons.len() as i64);
    let initial_scheduled = lessons.len() as i64;
    let mut unassigned = fill_missing_existing_lessons(
        &mut lessons,
        &assignments,
        &off_slots,
        &subject_limits,
        run_seed,
        clock,
    );
    let filled_missing_periods = lessons.len() as i64 - initial_scheduled;
    let mut returned_incumbent = false;
    let mut best_complete_incumbent =
        complete_incumbent(&lessons, &unassigned, &off_slots, &subject_limits);
    let unassigned_repair_moves = if clock.deadline_hit() {
        0
    } else {
        repair_unassigned_lessons(
            &mut lessons,
            &mut unassigned,
            &off_slots,
            &subject_limits,
            run_seed,
            clock,
        )
    };
    if let Some(incumbent) = complete_incumbent(&lessons, &unassigned, &off_slots, &subject_limits)
    {
        best_complete_incumbent = Some(incumbent);
    }
    let (optimization_stats, phase) = if config.skip_teacher_optimization {
        (teacher_session_opt_snapshot(&lessons), "quality_skipped")
    } else if best_complete_incumbent.is_some() && !clock.should_stop_quality() {
        let mut phase = "quality";
        let stats = optimize_teacher_single_sessions(
            &mut lessons,
            &off_slots,
            &subject_limits,
            run_seed,
            true,
            config.two_stage_teacher_quality,
            config.optimization_focus,
            clock,
        );
        if complete_incumbent(&lessons, &unassigned, &off_slots, &subject_limits).is_none() {
            let Some(incumbent) = best_complete_incumbent.clone() else {
                return Err("complete incumbent missing after quality phase".to_string());
            };
            lessons = incumbent;
            returned_incumbent = true;
            phase = "quality_incumbent_restore";
        }
        (stats, phase)
    } else {
        let phase = if best_complete_incumbent.is_some() && clock.should_stop_quality() {
            returned_incumbent = true;
            "deadline_incumbent"
        } else {
            "incomplete"
        };
        (teacher_session_opt_snapshot(&lessons), phase)
    };
    let scheduled_periods = lessons.len() as i64;
    let unassigned_periods = unassigned.len() as i64;
    let subject_violations = subject_limit_violations(&lessons, &subject_limits);
    let placement_hard_ok =
        schedule_hard_ok(&lessons, &off_slots, &subject_limits) && subject_violations.is_empty();
    let hard_ok = expected_periods > 0
        && scheduled_periods == expected_periods
        && unassigned_periods == 0
        && placement_hard_ok;
    let usable_partial = scheduled_periods > 0
        && scheduled_periods < expected_periods
        && unassigned_periods > 0
        && placement_hard_ok;
    let timed_out = clock.deadline_hit() && !clock.cancelled();
    let status = solve_response_status(config, hard_ok, usable_partial, timed_out);
    let best_effort = status == 200 && !hard_ok;
    let failure_kind = if clock.cancelled() {
        "solver_cancelled"
    } else if timed_out {
        "no_complete_schedule_before_deadline"
    } else {
        "incomplete_schedule"
    };
    let failure_error = if clock.cancelled() {
        "Solver run was cancelled.".to_string()
    } else {
        incomplete_schedule_error(
            scheduled_periods,
            expected_periods,
            unassigned_periods,
            subject_violations.len() as i64,
        )
    };
    let gap_metrics = teacher_gap_metrics(&lessons);
    let class_payload = classes
        .iter()
        .map(|class| {
            json!({
                "id": class.id,
                "name": class.name,
                "grade": class.grade
            })
        })
        .collect::<Vec<_>>();

    let payload = serde_json::to_string(&json!({
        "ok": status == 200,
        "kind": if status == 422 { failure_kind } else { "" },
        "error": if status == 422 { failure_error } else { String::new() },
        "generatedAt": current_timestamp_string(),
        "classes": class_payload,
        "lessons": lessons,
        "unassignedLessons": unassigned,
        "warnings": if unassigned_periods > 0 {
            vec![json!({"kind": "existing_schedule_incomplete", "message": "Existing schedule is incomplete after backend fill/repair."})]
        } else {
            Vec::<Value>::new()
        },
        "metrics": {
            "scheduled_periods": scheduled_periods,
            "expected_periods": expected_periods,
            "unassigned_periods": unassigned_periods,
            "app_constraint_violation_count": subject_violations.len() as i64,
            "hard_ok": hard_ok,
            "core_hard_ok": hard_ok,
            "placement_hard_ok": placement_hard_ok,
            "placement_core_hard_ok": placement_hard_ok,
            "best_effort": best_effort,
            "teacher_sessions": count_teacher_sessions(&lessons),
            "one_period_teacher_sessions": count_one_period_teacher_sessions(&lessons),
            "gap_total": gap_metrics.total_gap,
            "gap_distribution": gap_metrics.distribution,
            "teacher_gap2_sessions": gap_metrics.gap2_plus_sessions,
            "quality_priority_order": quality_priority_order(config.two_stage_teacher_quality),
            "optimization_focus": config.optimization_focus.as_str()
        },
        "validation": {
            "hard_ok": hard_ok,
            "placement_hard_ok": placement_hard_ok,
            "simple_non_off_solver": true,
            "violations": subject_violations
        },
        "solver": {
            "name": "teacher_gap2_existing_optimize_v1",
            "backend": "rust",
            "description": "Optimize the already scheduled timetable without unassigning lessons, prioritizing removal of teacher sessions with two or more internal gaps.",
            "teacherSessionOptimization": {
                "initialScheduledPeriods": initial_scheduled,
                "finalScheduledPeriods": scheduled_periods,
                "filledMissingPeriods": filled_missing_periods,
                "unassignedRepairMoves": unassigned_repair_moves,
                "initialTeacherSessions": optimization_stats.initial_teacher_sessions,
                "finalTeacherSessions": optimization_stats.final_teacher_sessions,
                "initialOnePeriodTeacherSessions": optimization_stats.initial_one_period_sessions,
                "finalOnePeriodTeacherSessions": optimization_stats.final_one_period_sessions,
                "initialGapTotal": optimization_stats.initial_gap_total,
                "finalGapTotal": optimization_stats.final_gap_total,
                "initialGap2PlusTeacherSessions": optimization_stats.initial_gap2_plus_sessions,
                "finalGap2PlusTeacherSessions": optimization_stats.final_gap2_plus_sessions,
                "singleSessionMoves": optimization_stats.single_session_moves,
                "gapMoves": optimization_stats.gap_moves,
                "singleGapMoves": optimization_stats.single_gap_moves,
                "moves": optimization_stats.moves
            },
            "runSeed": run_seed,
            "runtime_settings": runtime_settings_json(config, clock, phase, returned_incumbent)
        },
        "inputs": {
            "classes": classes.len(),
            "assignments": expected_periods,
            "fixedLessons": lessons.iter().filter(|lesson| lesson_fixed(lesson)).count()
        }
    }))
    .map_err(|err| format!("failed to serialize existing optimized schedule: {err}"))?;
    Ok(NativeSolveResult { payload, status })
}

fn solve_simple(
    data: &Map<String, Value>,
    run_seed: u64,
    config: SolverConfig,
    clock: &SolveClock,
) -> Result<NativeSolveResult, String> {
    let classes = parse_classes(data);
    let subjects = parse_subjects(data);
    let subject_alias = subject_alias_map(&subjects);
    let class_alias = class_alias_map(&classes);
    let period_map = period_map(data, &subject_alias);
    let session_limit_map = session_limit_map(data, &subject_alias);
    let constraint_day_limits =
        constraint_subject_day_limit_map(data, &class_alias, &subject_alias);
    let pccm_periods = numeric_matrix(data.get("pccmTietMatrix"));
    let pccm_session_limits = numeric_matrix(data.get("pccmGioihanMatrix"));
    let pccm_rooms = string_matrix(data.get("pccmRoomMatrix"));
    let off_slots = collect_off_slots(data, &class_alias);
    let mut fixed_lessons = collect_fixed_lessons(data, &class_alias, &subject_alias);
    let mut assignments = parse_assignments(
        data,
        &classes,
        &class_alias,
        &subject_alias,
        &period_map,
        &session_limit_map,
        &constraint_day_limits,
        &pccm_periods,
        &pccm_session_limits,
        &pccm_rooms,
    );
    if config.optimization_focus == OptimizationFocus::QuickComplete {
        apply_quick_authored_subject_rules(data, &mut assignments, &class_alias, &subject_alias);
        for fixed in &mut fixed_lessons {
            let Some(assignment) = assignments.iter().find(|assignment| {
                assignment.class_id == fixed.class_id
                    && norm(&assignment.subject) == norm(&fixed.subject)
            }) else {
                continue;
            };
            if fixed.teacher.is_empty() {
                fixed.teacher = assignment.teacher.clone();
            }
            if fixed.room.is_empty() {
                fixed.room = assignment.room.clone();
            }
        }
    }
    let teacher_load = teacher_period_load_map(&assignments);
    let mut rng = SimpleRng::new(run_seed);
    shuffle_slice(&mut assignments, &mut rng);
    assignments.sort_by(|a, b| {
        let a_block = a.session_limit >= 2 && a.periods >= 2;
        let b_block = b.session_limit >= 2 && b.periods >= 2;
        let a_teacher_load = teacher_load.get(&norm(&a.teacher)).copied().unwrap_or(0);
        let b_teacher_load = teacher_load.get(&norm(&b.teacher)).copied().unwrap_or(0);
        b_block
            .cmp(&a_block)
            .then_with(|| b_teacher_load.cmp(&a_teacher_load))
            .then_with(|| b.periods.cmp(&a.periods))
    });
    let quick_authored_assignments = (config.optimization_focus
        == OptimizationFocus::QuickComplete)
        .then(|| assignments.clone());
    let subject_limits = subject_limit_map(&assignments);

    let mut lessons = Vec::new();
    let mut unassigned = Vec::new();
    let mut occupied_by_class: HashSet<String> = HashSet::new();
    let mut teacher_occ: HashSet<String> = HashSet::new();
    let mut room_occ: HashSet<String> = HashSet::new();
    let mut fixed_by_class_subject: HashMap<(String, String), i64> = HashMap::new();
    let mut heuristic_state = HeuristicState::default();

    for fixed in fixed_lessons {
        let key = slot_key(&fixed.class_id, &fixed.slot);
        occupied_by_class.insert(key);
        if !fixed.teacher.is_empty() {
            teacher_occ.insert(resource_slot_key(&fixed.teacher, &fixed.slot));
        }
        if !fixed.room.is_empty() {
            room_occ.insert(resource_slot_key(&fixed.room, &fixed.slot));
        }
        heuristic_state.add(&fixed.class_id, &fixed.subject, &fixed.teacher, &fixed.slot);
        *fixed_by_class_subject
            .entry((fixed.class_id.clone(), norm(&fixed.subject)))
            .or_insert(0) += 1;
        lessons.push(lesson_json(
            &fixed.class_id,
            &fixed.class_name,
            &fixed.subject,
            &fixed.teacher,
            &fixed.room,
            &fixed.slot,
            true,
        ));
    }

    let expected_periods = assignments.iter().map(|item| item.periods).sum::<i64>();
    if config.optimization_focus == OptimizationFocus::QuickComplete {
        place_quick_assignments_mrv(
            assignments,
            &fixed_by_class_subject,
            &teacher_load,
            &off_slots,
            &mut occupied_by_class,
            &mut teacher_occ,
            &mut room_occ,
            &mut heuristic_state,
            &mut lessons,
            &mut unassigned,
            run_seed,
            clock,
        );
    } else {
        for assignment in assignments {
            let fixed_count = fixed_by_class_subject
                .get(&(assignment.class_id.clone(), norm(&assignment.subject)))
                .copied()
                .unwrap_or(0);
            let mut remaining = assignment.periods.saturating_sub(fixed_count);
            let mut seq = 0_i64;
            if clock.deadline_hit() {
                push_unassigned_periods(
                    &mut unassigned,
                    &assignment,
                    remaining,
                    &mut seq,
                    "backend_deadline_hit",
                );
                continue;
            }
            while remaining > 0 {
                if clock.deadline_hit() {
                    push_unassigned_periods(
                        &mut unassigned,
                        &assignment,
                        remaining,
                        &mut seq,
                        "backend_deadline_hit",
                    );
                    break;
                }
                let slots = choose_assignment_slots(
                    &assignment,
                    remaining,
                    &off_slots,
                    &occupied_by_class,
                    &teacher_occ,
                    &room_occ,
                    &heuristic_state,
                    run_seed,
                );

                let Some(slots) = slots else {
                    seq += 1;
                    unassigned.push(json!({
                        "classId": assignment.class_id,
                        "className": assignment.class_name,
                        "subject": assignment.subject,
                        "teacher": assignment.teacher,
                        "room": assignment.room,
                        "reason": "not_enough_non_off_slots_or_subject_limit",
                        "sessionLimit": assignment.session_limit,
                        "index": seq
                    }));
                    remaining = remaining.saturating_sub(1);
                    continue;
                };

                for slot in slots {
                    seq += 1;
                    occupied_by_class.insert(slot_key(&assignment.class_id, &slot));
                    if !assignment.teacher.is_empty() {
                        teacher_occ.insert(resource_slot_key(&assignment.teacher, &slot));
                    }
                    if !assignment.room.is_empty() {
                        room_occ.insert(resource_slot_key(&assignment.room, &slot));
                    }
                    heuristic_state.add(
                        &assignment.class_id,
                        &assignment.subject,
                        &assignment.teacher,
                        &slot,
                    );
                    lessons.push(lesson_json(
                        &assignment.class_id,
                        &assignment.class_name,
                        &assignment.subject,
                        &assignment.teacher,
                        &assignment.room,
                        &slot,
                        false,
                    ));
                    remaining = remaining.saturating_sub(1);
                }
            }
        }
    }

    let quick_repair_moves = if config.optimization_focus == OptimizationFocus::QuickComplete {
        repair_quick_unassigned_lessons_first_fit(
            &mut lessons,
            &mut unassigned,
            &off_slots,
            &subject_limits,
            quick_authored_assignments.as_deref().unwrap_or(&[]),
            run_seed,
            clock,
        )
    } else {
        0
    };
    let unassigned_repair_moves = if config.optimization_focus == OptimizationFocus::QuickComplete {
        quick_repair_moves
    } else {
        repair_unassigned_lessons(
            &mut lessons,
            &mut unassigned,
            &off_slots,
            &subject_limits,
            run_seed,
            clock,
        )
    };

    let mut returned_incumbent = false;
    let best_complete_incumbent =
        complete_incumbent(&lessons, &unassigned, &off_slots, &subject_limits);
    let (optimization_stats, phase) = if config.skip_teacher_optimization {
        (teacher_session_opt_snapshot(&lessons), "quality_skipped")
    } else if best_complete_incumbent.is_some() && !clock.should_stop_quality() {
        let mut phase = "quality";
        let stats = optimize_teacher_single_sessions(
            &mut lessons,
            &off_slots,
            &subject_limits,
            run_seed,
            true,
            config.two_stage_teacher_quality,
            config.optimization_focus,
            clock,
        );
        if complete_incumbent(&lessons, &unassigned, &off_slots, &subject_limits).is_none() {
            let Some(incumbent) = best_complete_incumbent.clone() else {
                return Err("complete incumbent missing after quality phase".to_string());
            };
            lessons = incumbent;
            returned_incumbent = true;
            phase = "quality_incumbent_restore";
        }
        (stats, phase)
    } else {
        let phase = if best_complete_incumbent.is_some() && clock.should_stop_quality() {
            returned_incumbent = true;
            "deadline_incumbent"
        } else if !unassigned.is_empty() {
            "incomplete"
        } else {
            "base"
        };
        (teacher_session_opt_snapshot(&lessons), phase)
    };
    let gap_metrics = teacher_gap_metrics(&lessons);

    let scheduled_periods = lessons.len() as i64;
    let unassigned_periods = unassigned.len() as i64;
    let subject_violations = subject_limit_violations(&lessons, &subject_limits);
    let app_constraint_violation_count = subject_violations.len() as i64;
    let placement_hard_ok = schedule_hard_ok(&lessons, &off_slots, &subject_limits)
        && app_constraint_violation_count == 0;
    let hard_ok = expected_periods > 0
        && scheduled_periods == expected_periods
        && unassigned_periods == 0
        && placement_hard_ok;
    let usable_partial = scheduled_periods > 0
        && scheduled_periods < expected_periods
        && unassigned_periods > 0
        && placement_hard_ok;
    let timed_out = clock.deadline_hit() && !clock.cancelled();
    let status = solve_response_status(config, hard_ok, usable_partial, timed_out);
    let best_effort = status == 200 && !hard_ok;
    let failure_kind = if clock.cancelled() {
        "solver_cancelled"
    } else if timed_out {
        "no_complete_schedule_before_deadline"
    } else {
        "incomplete_schedule"
    };
    let failure_error = if clock.cancelled() {
        "Solver run was cancelled.".to_string()
    } else {
        incomplete_schedule_error(
            scheduled_periods,
            expected_periods,
            unassigned_periods,
            app_constraint_violation_count,
        )
    };
    let class_payload = classes
        .iter()
        .map(|class| {
            json!({
                "id": class.id,
                "name": class.name,
                "grade": class.grade
            })
        })
        .collect::<Vec<_>>();

    let payload = serde_json::to_string(&json!({
        "ok": status == 200,
        "kind": if status == 422 { failure_kind } else { "" },
        "error": if status == 422 { failure_error } else { String::new() },
        "generatedAt": current_timestamp_string(),
        "classes": class_payload,
        "lessons": lessons,
        "unassignedLessons": unassigned,
        "warnings": if best_effort {
            vec![json!({"kind": "best_effort", "message": "Khong du cho khong nghi de xep tat ca tiet."})]
        } else {
            Vec::<Value>::new()
        },
        "metrics": {
            "scheduled_periods": scheduled_periods,
            "expected_periods": expected_periods,
            "unassigned_periods": unassigned_periods,
            "app_constraint_violation_count": app_constraint_violation_count,
            "hard_ok": hard_ok,
            "core_hard_ok": hard_ok,
            "placement_hard_ok": placement_hard_ok,
            "placement_core_hard_ok": placement_hard_ok,
            "best_effort": best_effort,
            "teacher_sessions": count_teacher_sessions(&lessons),
            "one_period_teacher_sessions": count_one_period_teacher_sessions(&lessons),
            "gap_total": gap_metrics.total_gap,
            "gap_distribution": gap_metrics.distribution,
            "teacher_gap2_sessions": gap_metrics.gap2_plus_sessions,
            "quality_priority_order": quality_priority_order(config.two_stage_teacher_quality),
            "optimization_focus": config.optimization_focus.as_str()
        },
        "validation": {
            "hard_ok": hard_ok,
            "placement_hard_ok": placement_hard_ok,
            "simple_non_off_solver": true,
            "violations": subject_violations
        },
        "solver": {
            "name": "teacher_gap2_compact_v3",
            "backend": "rust",
            "description": "Fill into non-off class slots, then improve teacher sessions without unassigning scheduled lessons: avoid teacher conflicts, reduce one-period sessions, and compact teacher sessions with two or more internal gaps.",
            "teacherSessionOptimization": {
                "initialTeacherSessions": optimization_stats.initial_teacher_sessions,
                "finalTeacherSessions": optimization_stats.final_teacher_sessions,
                "initialOnePeriodTeacherSessions": optimization_stats.initial_one_period_sessions,
                "finalOnePeriodTeacherSessions": optimization_stats.final_one_period_sessions,
                "initialGapTotal": optimization_stats.initial_gap_total,
                "finalGapTotal": optimization_stats.final_gap_total,
                "initialGap2PlusTeacherSessions": optimization_stats.initial_gap2_plus_sessions,
                "finalGap2PlusTeacherSessions": optimization_stats.final_gap2_plus_sessions,
                "singleSessionMoves": optimization_stats.single_session_moves,
                "gapMoves": optimization_stats.gap_moves,
                "singleGapMoves": optimization_stats.single_gap_moves,
                "unassignedRepairMoves": unassigned_repair_moves,
                "moves": optimization_stats.moves
            },
            "runSeed": run_seed,
            "runtime_settings": runtime_settings_json(config, clock, phase, returned_incumbent)
        },
        "inputs": {
            "classes": classes.len(),
            "assignments": scheduled_periods + unassigned_periods,
            "fixedLessons": fixed_by_class_subject.values().copied().sum::<i64>()
        },
        "bestEffort": best_effort
    }))
    .map_err(|err| format!("cannot serialize simple solver payload: {err}"))?;
    Ok(NativeSolveResult { payload, status })
}

fn settings_bool(settings: Option<&Map<String, Value>>, key: &str, default: bool) -> bool {
    settings
        .and_then(|value| value.get(key))
        .map(truthy)
        .unwrap_or(default)
}

fn two_stage_teacher_quality_requested(settings: Option<&Map<String, Value>>) -> bool {
    settings_bool(settings, "optimization_two_stage_teacher_quality", false)
        || settings
            .and_then(|value| value.get("quality_priority_order"))
            .and_then(Value::as_str)
            .is_some_and(|value| {
                value
                    .trim()
                    .eq_ignore_ascii_case(QUALITY_PRIORITY_TWO_STAGE)
            })
}

fn quality_priority_order(two_stage_teacher_quality: bool) -> &'static str {
    if two_stage_teacher_quality {
        QUALITY_PRIORITY_TWO_STAGE
    } else {
        QUALITY_PRIORITY_BALANCED
    }
}

fn settings_u64(settings: Option<&Map<String, Value>>, key: &str, default: u64) -> u64 {
    settings
        .and_then(|value| value.get(key))
        .map(|value| int_value(Some(value), default as i64))
        .filter(|value| *value > 0)
        .map(|value| value as u64)
        .unwrap_or(default)
}

fn settings_u64_allow_zero(settings: Option<&Map<String, Value>>, key: &str, default: u64) -> u64 {
    settings
        .and_then(|value| value.get(key))
        .map(|value| int_value(Some(value), default as i64))
        .filter(|value| *value >= 0)
        .map(|value| value as u64)
        .unwrap_or(default)
}

fn solve_response_status(
    config: SolverConfig,
    hard_ok: bool,
    has_usable_partial: bool,
    deadline_hit: bool,
) -> u16 {
    if hard_ok {
        return 200;
    }
    if has_usable_partial
        && (!config.require_complete_schedule || (config.best_effort_on_timeout && deadline_hit))
    {
        return 200;
    }
    422
}

fn complete_incumbent(
    lessons: &[Value],
    unassigned: &[Value],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
) -> Option<Vec<Value>> {
    if unassigned.is_empty() && schedule_hard_ok(lessons, off_slots, subject_limits) {
        Some(lessons.to_vec())
    } else {
        None
    }
}

fn runtime_settings_json(
    config: SolverConfig,
    clock: &SolveClock,
    phase: &str,
    returned_incumbent: bool,
) -> Value {
    json!({
        "elapsed_seconds": (clock.elapsed_seconds() * 100.0).round() / 100.0,
        "backend_deadline_ms": config.backend_deadline_ms,
        "native_global_deadline_ms": config.native_global_deadline_ms,
        "native_deadline_reserve_ms": config.native_deadline_reserve_ms,
        "time_remaining_ms": clock.time_remaining_ms(),
        "deadline_hit": clock.deadline_hit() && !clock.cancelled(),
        "cancelled": clock.cancelled(),
        "returned_incumbent": returned_incumbent,
        "phase": phase,
        "require_complete_schedule": config.require_complete_schedule,
        "best_effort_on_timeout": config.best_effort_on_timeout,
        "native_skip_teacher_optimization": config.skip_teacher_optimization,
        "optimization_two_stage_teacher_quality": config.two_stage_teacher_quality,
        "quality_priority_order": quality_priority_order(config.two_stage_teacher_quality),
        "optimization_focus": config.optimization_focus.as_str(),
        "random_seed": config.random_seed
    })
}

fn incomplete_schedule_error(
    scheduled_periods: i64,
    expected_periods: i64,
    unassigned_periods: i64,
    app_constraint_violation_count: i64,
) -> String {
    let mut parts = Vec::new();
    if expected_periods > 0 {
        parts.push(format!(
            "moi xep {scheduled_periods}/{expected_periods} tiet"
        ));
    }
    if unassigned_periods > 0 {
        parts.push(format!("con {unassigned_periods} tiet chua xep"));
    }
    if app_constraint_violation_count > 0 {
        parts.push(format!(
            "con {app_constraint_violation_count} loi rang buoc cung"
        ));
    }
    if parts.is_empty() {
        "Khong co lich hoan chinh truoc deadline backend.".to_string()
    } else {
        format!(
            "Khong co lich hoan chinh truoc deadline backend: {}.",
            parts.join("; ")
        )
    }
}

fn push_unassigned_periods(
    unassigned: &mut Vec<Value>,
    assignment: &Assignment,
    count: i64,
    seq: &mut i64,
    reason: &str,
) {
    for _ in 0..count.max(0) {
        *seq += 1;
        unassigned.push(json!({
            "classId": assignment.class_id.clone(),
            "className": assignment.class_name.clone(),
            "subject": assignment.subject.clone(),
            "teacher": assignment.teacher.clone(),
            "room": assignment.room.clone(),
            "reason": reason,
            "sessionLimit": assignment.session_limit,
            "index": *seq
        }));
    }
}

fn parse_classes(data: &Map<String, Value>) -> Vec<ClassInfo> {
    value_array(data.get("lop"))
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let id = get_str(value, "id")
                .or_else(|| get_str(value, "ma"))
                .or_else(|| get_str(value, "ten"))
                .unwrap_or_default()
                .trim()
                .to_string();
            if id.is_empty() {
                return None;
            }
            let name = get_str(value, "ten2")
                .filter(|v| !v.trim().is_empty())
                .or_else(|| get_str(value, "ten"))
                .unwrap_or(&id)
                .trim()
                .to_string();
            let grade = get_str(value, "khoi")
                .unwrap_or_default()
                .trim()
                .to_string();
            let mut aliases = vec![
                id.clone(),
                name.clone(),
                get_str(value, "ten").unwrap_or_default().trim().to_string(),
                get_str(value, "ten2")
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                format!("L{:03}", index + 1),
            ];
            aliases.retain(|item| !item.is_empty());
            aliases.sort();
            aliases.dedup();
            Some(ClassInfo {
                id,
                name,
                grade,
                aliases,
            })
        })
        .collect()
}

fn parse_subjects(data: &Map<String, Value>) -> Vec<SubjectInfo> {
    value_array(data.get("monhoc"))
        .iter()
        .filter_map(|value| {
            let canonical = get_str(value, "ten").unwrap_or_default().trim().to_string();
            if canonical.is_empty() {
                return None;
            }
            let mut aliases = vec![
                canonical.clone(),
                get_str(value, "ma").unwrap_or_default().trim().to_string(),
                get_str(value, "ma2").unwrap_or_default().trim().to_string(),
                get_str(value, "id").unwrap_or_default().trim().to_string(),
            ];
            aliases.retain(|item| !item.is_empty());
            aliases.sort();
            aliases.dedup();
            Some(SubjectInfo { canonical, aliases })
        })
        .collect()
}

fn class_alias_map(classes: &[ClassInfo]) -> HashMap<String, ClassInfo> {
    let mut out = HashMap::new();
    for class in classes {
        for alias in &class.aliases {
            let key = norm(alias);
            if !key.is_empty() {
                out.entry(key).or_insert_with(|| class.clone());
            }
        }
    }
    out
}

fn subject_alias_map(subjects: &[SubjectInfo]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for subject in subjects {
        for alias in &subject.aliases {
            let key = norm(alias);
            if !key.is_empty() {
                out.entry(key).or_insert_with(|| subject.canonical.clone());
            }
        }
    }
    out
}

fn period_map(
    data: &Map<String, Value>,
    subject_alias: &HashMap<String, String>,
) -> HashMap<(String, String), i64> {
    let mut out = HashMap::new();
    for row in value_array(data.get("mon")) {
        let grade = get_str(row, "khoi").unwrap_or_default().trim().to_string();
        let subject = canonical_subject(
            get_str(row, "ten")
                .or_else(|| get_str(row, "mon"))
                .unwrap_or_default(),
            subject_alias,
        );
        let periods = int_value(row.get("sotiet"), 0);
        if !grade.is_empty() && !subject.is_empty() && periods > 0 {
            out.insert((norm(&grade), norm(&subject)), periods);
        }
    }
    out
}

fn session_limit_map(
    data: &Map<String, Value>,
    subject_alias: &HashMap<String, String>,
) -> HashMap<(String, String), i64> {
    let mut out = HashMap::new();
    for row in value_array(data.get("mon")) {
        let grade = get_str(row, "khoi").unwrap_or_default().trim().to_string();
        let subject = canonical_subject(
            get_str(row, "ten")
                .or_else(|| get_str(row, "mon"))
                .unwrap_or_default(),
            subject_alias,
        );
        let session_limit = int_value(row.get("gioihan"), 1).max(1);
        if !grade.is_empty() && !subject.is_empty() {
            out.insert((norm(&grade), norm(&subject)), session_limit);
        }
    }
    out
}

fn constraint_subject_day_limit_map(
    data: &Map<String, Value>,
    class_alias: &HashMap<String, ClassInfo>,
    subject_alias: &HashMap<String, String>,
) -> HashMap<(String, String, i64), i64> {
    let mut out = HashMap::new();
    let Some(subject_rules) = data
        .get("tkbConstraints")
        .and_then(|value| value.get("subject"))
        .and_then(Value::as_object)
    else {
        return out;
    };

    for (raw_subject, subject_rule) in subject_rules {
        let subject = canonical_subject(raw_subject, subject_alias);
        if subject.is_empty() {
            continue;
        }
        let Some(by_class) = subject_rule.get("byClass").and_then(Value::as_object) else {
            continue;
        };
        for (raw_class, class_rule) in by_class {
            let Some(class) = class_alias.get(&norm(raw_class)) else {
                continue;
            };
            let Some(raw_day_limit) = class_rule
                .get("maxPeriods")
                .and_then(|value| value.get("day"))
            else {
                continue;
            };

            let mut insert_limit = |day: i64, limit: i64| {
                if limit <= 0 {
                    return;
                }
                out.entry((class.id.clone(), norm(&subject), day))
                    .and_modify(|value: &mut i64| *value = (*value).min(limit))
                    .or_insert(limit);
            };
            if let Some(per_day) = raw_day_limit.as_object() {
                for (day_key, day) in DAYS {
                    insert_limit(day, int_value(per_day.get(day_key), 0));
                }
            } else {
                let limit = int_value(Some(raw_day_limit), 0);
                for (_, day) in DAYS {
                    insert_limit(day, limit);
                }
            }
        }
    }
    out
}

fn apply_quick_authored_subject_rules(
    data: &Map<String, Value>,
    assignments: &mut [Assignment],
    class_alias: &HashMap<String, ClassInfo>,
    subject_alias: &HashMap<String, String>,
) {
    let Some(subject_rules) = data
        .get("tkbConstraints")
        .and_then(|value| value.get("subject"))
        .and_then(Value::as_object)
    else {
        return;
    };
    for (raw_subject, subject_rule) in subject_rules {
        let subject = canonical_subject(raw_subject, subject_alias);
        let Some(by_class) = subject_rule.get("byClass").and_then(Value::as_object) else {
            continue;
        };
        for (raw_class, class_rule) in by_class {
            let Some(class) = class_alias.get(&norm(raw_class)) else {
                continue;
            };
            let min_two_blocks = class_rule
                .get("lessonBlocks")
                .and_then(|value| value.get("2"))
                .and_then(|value| value.get("min"))
                .map(|value| int_value(Some(value), 0).max(0))
                .unwrap_or(0);
            let avoid_pair = class_rule.get("avoidBreakPair23");
            let avoid_morning = avoid_pair
                .and_then(|value| value.get("morning"))
                .is_some_and(truthy);
            let avoid_afternoon = avoid_pair
                .and_then(|value| value.get("afternoon"))
                .is_some_and(truthy);
            for assignment in assignments.iter_mut().filter(|assignment| {
                assignment.class_id == class.id && norm(&assignment.subject) == norm(&subject)
            }) {
                assignment.quick_min_two_blocks =
                    assignment.quick_min_two_blocks.max(min_two_blocks);
                assignment.quick_avoid_pair23_morning |= avoid_morning;
                assignment.quick_avoid_pair23_afternoon |= avoid_afternoon;
            }
        }
    }
}

fn parse_assignments(
    data: &Map<String, Value>,
    classes: &[ClassInfo],
    class_alias: &HashMap<String, ClassInfo>,
    subject_alias: &HashMap<String, String>,
    period_map: &HashMap<(String, String), i64>,
    session_limit_map: &HashMap<(String, String), i64>,
    constraint_day_limits: &HashMap<(String, String, i64), i64>,
    pccm_periods: &HashMap<String, i64>,
    pccm_session_limits: &HashMap<String, i64>,
    pccm_rooms: &HashMap<String, String>,
) -> Vec<Assignment> {
    let mut out = Vec::new();
    let Some(pccm) = data.get("pccmMatrix").and_then(Value::as_object) else {
        return out;
    };
    let class_by_id = classes
        .iter()
        .map(|class| (class.id.clone(), class.clone()))
        .collect::<HashMap<_, _>>();

    for (raw_key, raw_teacher) in pccm {
        let Some((raw_class, raw_subject)) = raw_key.split_once('|') else {
            continue;
        };
        let Some(class) = class_alias
            .get(&norm(raw_class))
            .cloned()
            .or_else(|| class_by_id.get(raw_class).cloned())
        else {
            continue;
        };
        let subject = canonical_subject(raw_subject, subject_alias);
        if subject.is_empty() {
            continue;
        }
        let teacher = teacher_value(raw_teacher);
        if teacher.is_empty() {
            continue;
        }
        let periods = pccm_periods
            .get(raw_key)
            .copied()
            .or_else(|| {
                pccm_periods
                    .get(&format!("{}|{}", class.id, raw_subject))
                    .copied()
            })
            .or_else(|| {
                pccm_periods
                    .get(&format!("{}|{}", class.name, raw_subject))
                    .copied()
            })
            .unwrap_or_else(|| {
                period_map
                    .get(&(norm(&class.grade), norm(&subject)))
                    .copied()
                    .unwrap_or(0)
            });
        if periods <= 0 {
            continue;
        }
        let session_limit = pccm_session_limits
            .get(raw_key)
            .copied()
            .or_else(|| {
                pccm_session_limits
                    .get(&format!("{}|{}", class.id, raw_subject))
                    .copied()
            })
            .or_else(|| {
                pccm_session_limits
                    .get(&format!("{}|{}", class.name, raw_subject))
                    .copied()
            })
            .or_else(|| {
                pccm_session_limits
                    .get(&format!("{}|{}", class.id, subject))
                    .copied()
            })
            .or_else(|| {
                session_limit_map
                    .get(&(norm(&class.grade), norm(&subject)))
                    .copied()
            })
            .unwrap_or(1)
            .max(1);
        let day_limits = DAYS
            .iter()
            .filter_map(|(_, day)| {
                constraint_day_limits
                    .get(&(class.id.clone(), norm(&subject), *day))
                    .copied()
                    .map(|limit| (*day, limit))
            })
            .collect();
        let room = pccm_rooms.get(raw_key).cloned().unwrap_or_default();
        out.push(Assignment {
            class_id: class.id,
            class_name: class.name,
            subject,
            teacher,
            room,
            periods,
            session_limit,
            day_limits,
            quick_min_two_blocks: 0,
            quick_avoid_pair23_morning: false,
            quick_avoid_pair23_afternoon: false,
        });
    }
    out.sort_by(|a, b| {
        a.class_id
            .cmp(&b.class_id)
            .then_with(|| b.periods.cmp(&a.periods))
            .then_with(|| a.subject.cmp(&b.subject))
    });
    out
}

#[derive(Clone, Debug)]
struct FixedLesson {
    class_id: String,
    class_name: String,
    subject: String,
    teacher: String,
    room: String,
    slot: Slot,
}

fn collect_fixed_lessons(
    data: &Map<String, Value>,
    class_alias: &HashMap<String, ClassInfo>,
    subject_alias: &HashMap<String, String>,
) -> Vec<FixedLesson> {
    let mut out = Vec::new();
    let tkb = data.get("tkb").and_then(Value::as_object);
    let Some(tkb) = tkb else {
        return out;
    };
    for (raw_class, class_tkb) in tkb {
        let Some(class) = class_alias.get(&norm(raw_class)).cloned() else {
            continue;
        };
        for (day_key, day_num) in DAYS {
            for (session_key, session_name) in SESSIONS {
                let arr = class_tkb
                    .get(day_key)
                    .and_then(|day| day.get(session_key))
                    .and_then(Value::as_array);
                let Some(arr) = arr else {
                    continue;
                };
                for (index, cell) in arr.iter().enumerate() {
                    if !cell.get("fixed").and_then(Value::as_bool).unwrap_or(false) {
                        continue;
                    }
                    let raw_subject = cell_subject(cell);
                    let subject = canonical_subject(&raw_subject, subject_alias);
                    if subject.is_empty() {
                        continue;
                    }
                    let slot = Slot {
                        day_key: day_key.to_string(),
                        day: day_num,
                        session_key: session_key.to_string(),
                        session: session_name,
                        period_index: index as i64,
                    };
                    let teacher =
                        lookup_lesson_resource(data, "tkbLessonTeachers", &class.id, &subject);
                    let teacher = if teacher.is_empty() && raw_subject != subject {
                        lookup_lesson_resource(data, "tkbLessonTeachers", &class.id, &raw_subject)
                    } else {
                        teacher
                    };
                    let room = lookup_lesson_resource(data, "tkbLessonRooms", &class.id, &subject);
                    let room = if room.is_empty() && raw_subject != subject {
                        lookup_lesson_resource(data, "tkbLessonRooms", &class.id, &raw_subject)
                    } else {
                        room
                    };
                    out.push(FixedLesson {
                        class_id: class.id.clone(),
                        class_name: class.name.clone(),
                        teacher,
                        room,
                        subject,
                        slot,
                    });
                }
            }
        }
    }
    out
}

fn collect_existing_schedule_lessons(
    data: &Map<String, Value>,
    class_alias: &HashMap<String, ClassInfo>,
    subject_alias: &HashMap<String, String>,
) -> Vec<Value> {
    if let Some(items) = data
        .get("tkbSolverResult")
        .and_then(|value| value.get("lessons"))
        .and_then(Value::as_array)
    {
        let lessons = items
            .iter()
            .filter_map(|lesson| {
                let raw_class = lesson_class_id(lesson);
                let class = class_alias.get(&norm(&raw_class));
                let class_id = class
                    .map(|item| item.id.clone())
                    .unwrap_or_else(|| raw_class.clone());
                let class_name = class
                    .map(|item| item.name.clone())
                    .unwrap_or_else(|| lesson_string(lesson, "className"));
                let subject = canonical_subject(&lesson_subject(lesson), subject_alias);
                let slot = lesson_slot(lesson)?;
                if class_id.is_empty() || subject.is_empty() {
                    return None;
                }
                Some(lesson_json(
                    &class_id,
                    &class_name,
                    &subject,
                    &lesson_string(lesson, "teacher"),
                    &lesson_room(lesson),
                    &slot,
                    lesson_fixed(lesson),
                ))
            })
            .collect::<Vec<_>>();
        if !lessons.is_empty() {
            return lessons;
        }
    }

    let mut out = Vec::new();
    let Some(tkb) = data.get("tkb").and_then(Value::as_object) else {
        return out;
    };
    for (raw_class, class_tkb) in tkb {
        let Some(class) = class_alias.get(&norm(raw_class)).cloned() else {
            continue;
        };
        for (day_key, day_num) in DAYS {
            for (session_key, session_name) in SESSIONS {
                let Some(arr) = class_tkb
                    .get(day_key)
                    .and_then(|day| day.get(session_key))
                    .and_then(Value::as_array)
                else {
                    continue;
                };
                for (index, cell) in arr.iter().enumerate() {
                    let raw_subject = cell_subject(cell);
                    let subject = canonical_subject(&raw_subject, subject_alias);
                    if subject.is_empty() || subject == "OFF" {
                        continue;
                    }
                    let slot = Slot {
                        day_key: day_key.to_string(),
                        day: day_num,
                        session_key: session_key.to_string(),
                        session: session_name,
                        period_index: index as i64,
                    };
                    let teacher =
                        lookup_lesson_resource(data, "tkbLessonTeachers", &class.id, &subject);
                    let teacher = if teacher.is_empty() && raw_subject != subject {
                        lookup_lesson_resource(data, "tkbLessonTeachers", &class.id, &raw_subject)
                    } else {
                        teacher
                    };
                    let room = lookup_lesson_resource(data, "tkbLessonRooms", &class.id, &subject);
                    let room = if room.is_empty() && raw_subject != subject {
                        lookup_lesson_resource(data, "tkbLessonRooms", &class.id, &raw_subject)
                    } else {
                        room
                    };
                    out.push(lesson_json(
                        &class.id,
                        &class.name,
                        &subject,
                        &teacher,
                        &room,
                        &slot,
                        cell.get("fixed").and_then(Value::as_bool).unwrap_or(false),
                    ));
                }
            }
        }
    }
    out
}

fn collect_off_slots(
    data: &Map<String, Value>,
    class_alias: &HashMap<String, ClassInfo>,
) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut add = |raw_class: &str, raw_slot: &str| {
        let Some(class) = class_alias.get(&norm(raw_class)) else {
            return;
        };
        if parse_slot_key(raw_slot).is_some() {
            out.insert(format!("{}|{}", class.id, raw_slot));
        }
    };

    if let Some(root) = data.get("tkbUserOff").and_then(Value::as_object) {
        for (class, value) in root {
            match value {
                Value::Array(items) => {
                    for item in items {
                        if let Some(slot) = item.as_str() {
                            add(class, slot);
                        }
                    }
                }
                Value::Object(items) => {
                    for (slot, enabled) in items {
                        if truthy(enabled) {
                            add(class, slot);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(root) = data
        .get("tkbConstraints")
        .and_then(|v| v.get("fixedOff"))
        .and_then(|v| v.get("class"))
        .and_then(Value::as_object)
    {
        for (class, slots) in root {
            if let Some(slots) = slots.as_object() {
                for (slot, enabled) in slots {
                    if truthy(enabled) {
                        add(class, slot);
                    }
                }
            }
        }
    }

    if let Some(tkb) = data.get("tkb").and_then(Value::as_object) {
        for (raw_class, class_tkb) in tkb {
            let Some(class) = class_alias.get(&norm(raw_class)) else {
                continue;
            };
            for (day_key, _) in DAYS {
                for (session_key, _) in SESSIONS {
                    if let Some(arr) = class_tkb
                        .get(day_key)
                        .and_then(|day| day.get(session_key))
                        .and_then(Value::as_array)
                    {
                        for (index, cell) in arr.iter().enumerate() {
                            if cell.as_str() == Some("OFF") {
                                out.insert(format!(
                                    "{}|{}|{}|{}",
                                    class.id, day_key, session_key, index
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn place_quick_assignments_mrv(
    assignments: Vec<Assignment>,
    fixed_by_class_subject: &HashMap<(String, String), i64>,
    teacher_load: &HashMap<String, i64>,
    off_slots: &HashSet<String>,
    occupied_by_class: &mut HashSet<String>,
    teacher_occ: &mut HashSet<String>,
    room_occ: &mut HashSet<String>,
    heuristic_state: &mut HeuristicState,
    lessons: &mut Vec<Value>,
    unassigned: &mut Vec<Value>,
    run_seed: u64,
    clock: &SolveClock,
) {
    let mut pending = assignments
        .into_iter()
        .filter_map(|assignment| {
            let fixed_count = fixed_by_class_subject
                .get(&(assignment.class_id.clone(), norm(&assignment.subject)))
                .copied()
                .unwrap_or(0);
            let remaining = assignment.periods.saturating_sub(fixed_count);
            let required_two_blocks =
                assignment
                    .quick_min_two_blocks
                    .saturating_sub(quick_subject_two_block_count(
                        lessons,
                        &assignment.class_id,
                        &assignment.subject,
                    ));
            (remaining > 0).then_some(PendingQuickAssignment {
                assignment,
                remaining,
                sequence: fixed_count,
                required_two_blocks,
            })
        })
        .collect::<Vec<_>>();
    let mut occupancy_index = QuickOccupancyIndex::from_state(&pending, off_slots, lessons);

    while !pending.is_empty() && !clock.deadline_hit() {
        let mut best: Option<(QuickPlacementChoice, usize)> = None;
        for (pending_index, item) in pending.iter().enumerate() {
            let (domain_size, unit_size) = quick_assignment_domain(
                &item.assignment,
                item.remaining,
                item.required_two_blocks,
                &occupancy_index,
            );
            let choice = QuickPlacementChoice {
                domain_size,
                unit_size,
                remaining: item.remaining,
                teacher_load: teacher_load
                    .get(&norm(&item.assignment.teacher))
                    .copied()
                    .unwrap_or(0),
                tie_break: quick_assignment_jitter(&item.assignment, run_seed),
            };
            if best
                .as_ref()
                .is_none_or(|(current, _)| quick_choice_precedes(&choice, current))
            {
                best = Some((choice, pending_index));
            }
        }

        let Some((choice, pending_index)) = best else {
            break;
        };
        if choice.domain_size == 0 {
            let mut item = pending.swap_remove(pending_index);
            push_unassigned_periods(
                unassigned,
                &item.assignment,
                item.remaining,
                &mut item.sequence,
                "quick_mrv_domain_exhausted",
            );
            continue;
        }

        let item = &mut pending[pending_index];
        let Some(slots) = choose_quick_assignment_slots(
            &item.assignment,
            item.remaining,
            item.required_two_blocks > 0,
            off_slots,
            occupied_by_class,
            teacher_occ,
            room_occ,
            heuristic_state,
            run_seed,
        ) else {
            let mut item = pending.swap_remove(pending_index);
            push_unassigned_periods(
                unassigned,
                &item.assignment,
                item.remaining,
                &mut item.sequence,
                "quick_mrv_domain_changed",
            );
            continue;
        };
        let placed_two_block = (slots.len() == 2
            && slots[0].day == slots[1].day
            && slots[0].session_key == slots[1].session_key
            && (slots[0].period_index - slots[1].period_index).abs() == 1)
            || (slots.len() == 1
                && item.required_two_blocks > 0
                && quick_single_extends_isolated_subject(
                    &item.assignment,
                    &slots[0],
                    heuristic_state,
                ));
        for slot in slots {
            item.sequence += 1;
            occupancy_index.add(&item.assignment, &slot);
            occupied_by_class.insert(slot_key(&item.assignment.class_id, &slot));
            if !item.assignment.teacher.is_empty() {
                teacher_occ.insert(resource_slot_key(&item.assignment.teacher, &slot));
            }
            if !item.assignment.room.is_empty() {
                room_occ.insert(resource_slot_key(&item.assignment.room, &slot));
            }
            heuristic_state.add(
                &item.assignment.class_id,
                &item.assignment.subject,
                &item.assignment.teacher,
                &slot,
            );
            lessons.push(lesson_json(
                &item.assignment.class_id,
                &item.assignment.class_name,
                &item.assignment.subject,
                &item.assignment.teacher,
                &item.assignment.room,
                &slot,
                false,
            ));
            item.remaining = item.remaining.saturating_sub(1);
        }
        if item.required_two_blocks > 0 && placed_two_block {
            item.required_two_blocks -= 1;
        }
        if item.remaining == 0 {
            pending.swap_remove(pending_index);
        }
    }

    for mut item in pending {
        let reason = if clock.deadline_hit() {
            "backend_deadline_hit"
        } else {
            "quick_mrv_incomplete"
        };
        push_unassigned_periods(
            unassigned,
            &item.assignment,
            item.remaining,
            &mut item.sequence,
            reason,
        );
    }
}

fn quick_subject_two_block_count(lessons: &[Value], class_id: &str, subject: &str) -> i64 {
    let subject_key = norm(subject);
    let mut sessions: HashMap<(i64, String), Vec<i64>> = HashMap::new();
    for lesson in lessons {
        if lesson_class_id(lesson) != class_id || norm(&lesson_subject(lesson)) != subject_key {
            continue;
        }
        let Some(slot) = lesson_slot(lesson) else {
            continue;
        };
        sessions
            .entry((slot.day, slot.session_key))
            .or_default()
            .push(slot.period_index);
    }
    let mut blocks = 0_i64;
    for periods in sessions.values_mut() {
        periods.sort_unstable();
        let mut run_length = 1_usize;
        for index in 1..periods.len() {
            if periods[index] == periods[index - 1] + 1 {
                run_length += 1;
            } else {
                blocks += i64::from(run_length >= 2);
                run_length = 1;
            }
        }
        blocks += i64::from(run_length >= 2);
    }
    blocks
}

fn quick_choice_precedes(candidate: &QuickPlacementChoice, current: &QuickPlacementChoice) -> bool {
    if candidate.domain_size == 0 || current.domain_size == 0 {
        return candidate.domain_size < current.domain_size;
    }
    let candidate_slack =
        candidate.domain_size as i128 * candidate.unit_size as i128 * current.remaining as i128;
    let current_slack =
        current.domain_size as i128 * current.unit_size as i128 * candidate.remaining as i128;
    candidate_slack < current_slack
        || (candidate_slack == current_slack
            && (candidate.domain_size < current.domain_size
                || (candidate.domain_size == current.domain_size
                    && (candidate.teacher_load > current.teacher_load
                        || (candidate.teacher_load == current.teacher_load
                            && (candidate.remaining > current.remaining
                                || (candidate.remaining == current.remaining
                                    && candidate.tie_break < current.tie_break)))))))
}

fn quick_assignment_jitter(assignment: &Assignment, run_seed: u64) -> u64 {
    let mut hash = run_seed ^ 0x517c_c1b7_2722_0a95;
    hash_part(&mut hash, &assignment.class_id);
    hash_part(&mut hash, &assignment.subject);
    hash_part(&mut hash, &assignment.teacher);
    hash
}

fn quick_assignment_domain(
    assignment: &Assignment,
    remaining: i64,
    required_two_blocks: i64,
    occupancy_index: &QuickOccupancyIndex,
) -> (usize, i64) {
    let available = occupancy_index.available_mask(assignment);
    let subject_mask = occupancy_index.subject_mask(assignment);
    if required_two_blocks > 0 {
        let extensions = available & quick_required_pair_extension_mask(assignment, subject_mask);
        if extensions != 0 {
            return (extensions.count_ones() as usize, 1);
        }
        if remaining < 2 {
            return (0, 2);
        }
    }
    if assignment.session_limit >= 2 && remaining >= 2 {
        let mut blocks = 0_usize;
        for day_offset in 0..6_u32 {
            let day = day_offset as i64 + 2;
            let day_subject_count = ((subject_mask >> (day_offset * 10)) & 0x3ff).count_ones();
            if assignment
                .day_limits
                .get(&day)
                .is_some_and(|limit| day_subject_count as i64 + 2 > *limit)
            {
                continue;
            }
            for session_offset in [0_u32, 5_u32] {
                let offset = day_offset * 10 + session_offset;
                if ((subject_mask >> offset) & 0x1f) != 0 {
                    continue;
                }
                let free = (available >> offset) & 0x1f;
                let mut starts = free & (free >> 1) & 0x0f;
                if quick_avoid_pair23_for_session(assignment, session_offset) {
                    starts &= !(1_u64 << 1);
                }
                blocks += starts.count_ones() as usize;
            }
        }
        if blocks > 0 {
            return (blocks, 2);
        }
        if required_two_blocks > 0 {
            return (0, 2);
        }
    }

    let singles =
        (available & quick_subject_single_mask(assignment, subject_mask)).count_ones() as usize;
    (singles, 1)
}

fn quick_required_pair_extension_mask(assignment: &Assignment, subject_mask: u64) -> u64 {
    let mut extensions = 0_u64;
    for day_offset in 0..6_u32 {
        for session_offset in [0_u32, 5_u32] {
            let offset = day_offset * 10 + session_offset;
            let session_subject = (subject_mask >> offset) & 0x1f;
            if session_subject.count_ones() == 1 {
                let adjacent = ((session_subject << 1) | (session_subject >> 1)) & 0x1f;
                extensions |= adjacent << offset;
            }
        }
    }
    extensions & quick_subject_single_mask(assignment, subject_mask)
}

fn quick_subject_single_mask(assignment: &Assignment, subject_mask: u64) -> u64 {
    let mut allowed = 0_u64;
    for day_offset in 0..6_u32 {
        let day = day_offset as i64 + 2;
        let day_subject_count = ((subject_mask >> (day_offset * 10)) & 0x3ff).count_ones();
        if assignment
            .day_limits
            .get(&day)
            .is_some_and(|limit| day_subject_count as i64 >= *limit)
        {
            continue;
        }
        for session_offset in [0_u32, 5_u32] {
            let offset = day_offset * 10 + session_offset;
            let session_subject = (subject_mask >> offset) & 0x1f;
            let session_count = session_subject.count_ones() as i64;
            if assignment.session_limit > 0 && session_count >= assignment.session_limit {
                continue;
            }
            let mut session_allowed = 0x1f_u64;
            if assignment.session_limit >= 2 && session_count > 0 {
                session_allowed = 0;
                for period in 0..5_u32 {
                    let with_candidate = session_subject | (1_u64 << period);
                    let first = with_candidate.trailing_zeros();
                    let last = 63 - with_candidate.leading_zeros();
                    if last.saturating_sub(first) + 1 == with_candidate.count_ones() {
                        session_allowed |= 1_u64 << period;
                    }
                }
            }
            if quick_avoid_pair23_for_session(assignment, session_offset) {
                if session_subject & (1_u64 << 1) != 0 {
                    session_allowed &= !(1_u64 << 2);
                }
                if session_subject & (1_u64 << 2) != 0 {
                    session_allowed &= !(1_u64 << 1);
                }
            }
            allowed |= session_allowed << offset;
        }
    }
    allowed
}

fn quick_avoid_pair23_for_session(assignment: &Assignment, session_offset: u32) -> bool {
    if session_offset == 0 {
        assignment.quick_avoid_pair23_morning
    } else {
        assignment.quick_avoid_pair23_afternoon
    }
}

fn choose_quick_assignment_slots(
    assignment: &Assignment,
    remaining: i64,
    require_two_block: bool,
    off_slots: &HashSet<String>,
    occupied_by_class: &HashSet<String>,
    teacher_occ: &HashSet<String>,
    room_occ: &HashSet<String>,
    heuristic_state: &HeuristicState,
    run_seed: u64,
) -> Option<Vec<Slot>> {
    if require_two_block {
        if let Some(slot) = choose_quick_slot(
            assignment,
            off_slots,
            occupied_by_class,
            teacher_occ,
            room_occ,
            heuristic_state,
            true,
            run_seed,
        ) {
            return Some(vec![slot]);
        }
    }
    if assignment.session_limit >= 2 && remaining >= 2 {
        if let Some(block) = choose_quick_slot_block(
            assignment,
            off_slots,
            occupied_by_class,
            teacher_occ,
            room_occ,
            heuristic_state,
            run_seed,
        ) {
            return Some(block);
        }
    }
    if require_two_block {
        return None;
    }
    choose_quick_slot(
        assignment,
        off_slots,
        occupied_by_class,
        teacher_occ,
        room_occ,
        heuristic_state,
        false,
        run_seed,
    )
    .map(|slot| vec![slot])
}

#[allow(clippy::too_many_arguments)]
fn choose_quick_slot(
    assignment: &Assignment,
    off_slots: &HashSet<String>,
    occupied_by_class: &HashSet<String>,
    teacher_occ: &HashSet<String>,
    room_occ: &HashSet<String>,
    heuristic_state: &HeuristicState,
    require_pair_extension: bool,
    run_seed: u64,
) -> Option<Slot> {
    let mut best: Option<(i64, Slot)> = None;
    for (day_key, day) in DAYS {
        for (session_key, session) in SESSIONS {
            for period_index in 0..PERIODS_PER_SESSION {
                let slot = Slot {
                    day_key: day_key.to_string(),
                    day,
                    session_key: session_key.to_string(),
                    session,
                    period_index,
                };
                if off_slots.contains(&slot_key(&assignment.class_id, &slot))
                    || occupied_by_class.contains(&slot_key(&assignment.class_id, &slot))
                    || !heuristic_state.can_place_subject_session(assignment, &slot)
                    || !quick_single_avoids_pair23(assignment, &slot, heuristic_state)
                    || (require_pair_extension
                        && !quick_single_extends_isolated_subject(
                            assignment,
                            &slot,
                            heuristic_state,
                        ))
                    || (!assignment.teacher.is_empty()
                        && teacher_occ.contains(&resource_slot_key(&assignment.teacher, &slot)))
                    || (!assignment.room.is_empty()
                        && room_occ.contains(&resource_slot_key(&assignment.room, &slot)))
                {
                    continue;
                }
                let score = heuristic_state.score(assignment, &slot, run_seed);
                match &best {
                    Some((best_score, _)) if *best_score <= score => {}
                    _ => best = Some((score, slot)),
                }
            }
        }
    }
    best.map(|(_, slot)| slot)
}

fn quick_single_extends_isolated_subject(
    assignment: &Assignment,
    slot: &Slot,
    heuristic_state: &HeuristicState,
) -> bool {
    heuristic_state
        .class_subject_session_slots
        .get(&format!(
            "{}|{}|{}|{}",
            assignment.class_id,
            norm(&assignment.subject),
            slot.day_key,
            slot.session_key
        ))
        .is_some_and(|periods| periods.len() == 1 && (periods[0] - slot.period_index).abs() == 1)
}

#[allow(clippy::too_many_arguments)]
fn choose_quick_slot_block(
    assignment: &Assignment,
    off_slots: &HashSet<String>,
    occupied_by_class: &HashSet<String>,
    teacher_occ: &HashSet<String>,
    room_occ: &HashSet<String>,
    heuristic_state: &HeuristicState,
    run_seed: u64,
) -> Option<Vec<Slot>> {
    let mut best: Option<(i64, Vec<Slot>)> = None;
    for (_, day) in DAYS {
        for (session_key, _) in SESSIONS {
            for period_index in 0..(PERIODS_PER_SESSION - 1) {
                let session_offset = if session_key == "chieu" { 5 } else { 0 };
                if period_index == 1 && quick_avoid_pair23_for_session(assignment, session_offset) {
                    continue;
                }
                let slots = vec![
                    make_slot(day, session_key, period_index),
                    make_slot(day, session_key, period_index + 1),
                ];
                if !can_place_slot_block(
                    assignment,
                    &slots,
                    off_slots,
                    occupied_by_class,
                    teacher_occ,
                    room_occ,
                    heuristic_state,
                    true,
                ) {
                    continue;
                }
                let score = slots
                    .iter()
                    .map(|slot| heuristic_state.score(assignment, slot, run_seed))
                    .sum::<i64>()
                    + block_jitter(assignment, &slots, run_seed);
                match &best {
                    Some((best_score, _)) if *best_score <= score => {}
                    _ => best = Some((score, slots)),
                }
            }
        }
    }
    best.map(|(_, slots)| slots)
}

fn quick_single_avoids_pair23(
    assignment: &Assignment,
    slot: &Slot,
    heuristic_state: &HeuristicState,
) -> bool {
    let avoid = if slot.session_key == "sang" {
        assignment.quick_avoid_pair23_morning
    } else {
        assignment.quick_avoid_pair23_afternoon
    };
    if !avoid || !matches!(slot.period_index, 1 | 2) {
        return true;
    }
    let counterpart = if slot.period_index == 1 { 2 } else { 1 };
    heuristic_state
        .class_subject_session_slots
        .get(&format!(
            "{}|{}|{}|{}",
            assignment.class_id,
            norm(&assignment.subject),
            slot.day_key,
            slot.session_key
        ))
        .is_none_or(|periods| !periods.contains(&counterpart))
}

fn choose_slot(
    assignment: &Assignment,
    off_slots: &HashSet<String>,
    occupied_by_class: &HashSet<String>,
    teacher_occ: &HashSet<String>,
    room_occ: &HashSet<String>,
    heuristic_state: &HeuristicState,
    avoid_resource_conflict: bool,
    run_seed: u64,
) -> Option<Slot> {
    let mut best: Option<(i64, Slot)> = None;
    for (day_key, day_num) in DAYS {
        for (session_key, session_name) in SESSIONS {
            for period_index in 0..PERIODS_PER_SESSION {
                let slot = Slot {
                    day_key: day_key.to_string(),
                    day: day_num,
                    session_key: session_key.to_string(),
                    session: session_name,
                    period_index,
                };
                if off_slots.contains(&slot_key(&assignment.class_id, &slot)) {
                    continue;
                }
                if occupied_by_class.contains(&slot_key(&assignment.class_id, &slot)) {
                    continue;
                }
                if !heuristic_state.can_place_subject_session(assignment, &slot) {
                    continue;
                }
                if !assignment.teacher.is_empty()
                    && teacher_occ.contains(&resource_slot_key(&assignment.teacher, &slot))
                {
                    continue;
                }
                if avoid_resource_conflict {
                    if !assignment.room.is_empty()
                        && room_occ.contains(&resource_slot_key(&assignment.room, &slot))
                    {
                        continue;
                    }
                }
                let score = heuristic_state.score(assignment, &slot, run_seed);
                match &best {
                    Some((best_score, _)) if *best_score <= score => {}
                    _ => best = Some((score, slot)),
                }
            }
        }
    }
    best.map(|(_, slot)| slot)
}

fn choose_slot_block(
    assignment: &Assignment,
    off_slots: &HashSet<String>,
    occupied_by_class: &HashSet<String>,
    teacher_occ: &HashSet<String>,
    room_occ: &HashSet<String>,
    heuristic_state: &HeuristicState,
    avoid_resource_conflict: bool,
    run_seed: u64,
) -> Option<Vec<Slot>> {
    let mut best: Option<(i64, Vec<Slot>)> = None;
    for (day_key, day_num) in DAYS {
        for (session_key, session_name) in SESSIONS {
            for period_index in 0..(PERIODS_PER_SESSION - 1) {
                let first = Slot {
                    day_key: day_key.to_string(),
                    day: day_num,
                    session_key: session_key.to_string(),
                    session: session_name,
                    period_index,
                };
                let second = Slot {
                    day_key: day_key.to_string(),
                    day: day_num,
                    session_key: session_key.to_string(),
                    session: session_name,
                    period_index: period_index + 1,
                };
                let slots = vec![first, second];
                if !can_place_slot_block(
                    assignment,
                    &slots,
                    off_slots,
                    occupied_by_class,
                    teacher_occ,
                    room_occ,
                    heuristic_state,
                    avoid_resource_conflict,
                ) {
                    continue;
                }
                let score = slots
                    .iter()
                    .map(|slot| heuristic_state.score(assignment, slot, run_seed))
                    .sum::<i64>()
                    + block_jitter(assignment, &slots, run_seed);
                match &best {
                    Some((best_score, _)) if *best_score <= score => {}
                    _ => best = Some((score, slots)),
                }
            }
        }
    }
    best.map(|(_, slots)| slots)
}

fn choose_assignment_slots(
    assignment: &Assignment,
    remaining: i64,
    off_slots: &HashSet<String>,
    occupied_by_class: &HashSet<String>,
    teacher_occ: &HashSet<String>,
    room_occ: &HashSet<String>,
    heuristic_state: &HeuristicState,
    run_seed: u64,
) -> Option<Vec<Slot>> {
    if assignment.session_limit >= 2 && remaining >= 2 {
        let block = choose_slot_block(
            assignment,
            off_slots,
            occupied_by_class,
            teacher_occ,
            room_occ,
            heuristic_state,
            true,
            run_seed,
        )
        .or_else(|| {
            choose_slot_block(
                assignment,
                off_slots,
                occupied_by_class,
                teacher_occ,
                room_occ,
                heuristic_state,
                false,
                run_seed,
            )
        });
        if block.is_some() {
            return block;
        }
    }

    choose_slot(
        assignment,
        off_slots,
        occupied_by_class,
        teacher_occ,
        room_occ,
        heuristic_state,
        true,
        run_seed,
    )
    .or_else(|| {
        choose_slot(
            assignment,
            off_slots,
            occupied_by_class,
            teacher_occ,
            room_occ,
            heuristic_state,
            false,
            run_seed,
        )
    })
    .map(|slot| vec![slot])
}

fn can_place_slot_block(
    assignment: &Assignment,
    slots: &[Slot],
    off_slots: &HashSet<String>,
    occupied_by_class: &HashSet<String>,
    teacher_occ: &HashSet<String>,
    room_occ: &HashSet<String>,
    heuristic_state: &HeuristicState,
    avoid_resource_conflict: bool,
) -> bool {
    if slots.is_empty() {
        return false;
    }
    let existing_session =
        heuristic_state.subject_session_count(&assignment.class_id, &assignment.subject, &slots[0]);
    if existing_session > 0 {
        return false;
    }
    let existing_day =
        heuristic_state.subject_day_count(&assignment.class_id, &assignment.subject, &slots[0]);
    if assignment
        .day_limits
        .get(&slots[0].day)
        .is_some_and(|limit| existing_day + slots.len() as i64 > *limit)
    {
        return false;
    }
    if assignment.session_limit > 0
        && existing_session + slots.len() as i64 > assignment.session_limit
    {
        return false;
    }
    for slot in slots {
        if off_slots.contains(&slot_key(&assignment.class_id, slot)) {
            return false;
        }
        if occupied_by_class.contains(&slot_key(&assignment.class_id, slot)) {
            return false;
        }
        if !assignment.teacher.is_empty()
            && teacher_occ.contains(&resource_slot_key(&assignment.teacher, slot))
        {
            return false;
        }
        if avoid_resource_conflict {
            if !assignment.room.is_empty()
                && room_occ.contains(&resource_slot_key(&assignment.room, slot))
            {
                return false;
            }
        }
    }
    true
}

fn lesson_json(
    class_id: &str,
    class_name: &str,
    subject: &str,
    teacher: &str,
    room: &str,
    slot: &Slot,
    fixed: bool,
) -> Value {
    json!({
        "classId": class_id,
        "class": class_name,
        "className": class_name,
        "subject": subject,
        "teacher": teacher,
        "room": room,
        "day": slot.day,
        "session": slot.session,
        "period": slot.period_index + 1,
        "fixed": fixed
    })
}

fn fill_missing_existing_lessons(
    lessons: &mut Vec<Value>,
    assignments: &[Assignment],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    clock: &SolveClock,
) -> Vec<Value> {
    let mut occupied_by_class: HashSet<String> = HashSet::new();
    let mut teacher_occ: HashSet<String> = HashSet::new();
    let mut room_occ: HashSet<String> = HashSet::new();
    let mut existing_by_class_subject: HashMap<(String, String), i64> = HashMap::new();
    let mut heuristic_state = HeuristicState::default();

    for lesson in lessons.iter() {
        let class_id = lesson_class_id(lesson);
        let subject = lesson_subject(lesson);
        let Some(slot) = lesson_slot(lesson) else {
            continue;
        };
        if class_id.is_empty() || subject.is_empty() {
            continue;
        }
        occupied_by_class.insert(slot_key(&class_id, &slot));
        let teacher = lesson_string(lesson, "teacher");
        if !teacher.is_empty() {
            teacher_occ.insert(resource_slot_key(&teacher, &slot));
        }
        let room = lesson_room(lesson);
        if !room.is_empty() {
            room_occ.insert(resource_slot_key(&room, &slot));
        }
        heuristic_state.add(&class_id, &subject, &teacher, &slot);
        *existing_by_class_subject
            .entry((class_id, norm(&subject)))
            .or_insert(0) += 1;
    }

    let teacher_load = teacher_period_load_map(assignments);
    let mut ordered = assignments.to_vec();
    let mut rng = SimpleRng::new(run_seed ^ 0x6f6c6c696e675f2d_u64);
    shuffle_slice(&mut ordered, &mut rng);
    ordered.sort_by(|a, b| {
        let a_missing = a.periods.saturating_sub(
            existing_by_class_subject
                .get(&(a.class_id.clone(), norm(&a.subject)))
                .copied()
                .unwrap_or(0),
        );
        let b_missing = b.periods.saturating_sub(
            existing_by_class_subject
                .get(&(b.class_id.clone(), norm(&b.subject)))
                .copied()
                .unwrap_or(0),
        );
        let a_block = a.session_limit >= 2 && a_missing >= 2;
        let b_block = b.session_limit >= 2 && b_missing >= 2;
        let a_teacher_load = teacher_load.get(&norm(&a.teacher)).copied().unwrap_or(0);
        let b_teacher_load = teacher_load.get(&norm(&b.teacher)).copied().unwrap_or(0);
        b_missing
            .cmp(&a_missing)
            .then_with(|| b_block.cmp(&a_block))
            .then_with(|| b_teacher_load.cmp(&a_teacher_load))
            .then_with(|| b.periods.cmp(&a.periods))
    });

    let mut unassigned = Vec::new();
    for assignment in ordered {
        let mut remaining = assignment.periods.saturating_sub(
            existing_by_class_subject
                .get(&(assignment.class_id.clone(), norm(&assignment.subject)))
                .copied()
                .unwrap_or(0),
        );
        let mut seq = 0_i64;
        if clock.deadline_hit() {
            push_unassigned_periods(
                &mut unassigned,
                &assignment,
                remaining,
                &mut seq,
                "backend_deadline_hit",
            );
            continue;
        }
        while remaining > 0 {
            if clock.deadline_hit() {
                push_unassigned_periods(
                    &mut unassigned,
                    &assignment,
                    remaining,
                    &mut seq,
                    "backend_deadline_hit",
                );
                break;
            }
            let slots = choose_assignment_slots(
                &assignment,
                remaining,
                off_slots,
                &occupied_by_class,
                &teacher_occ,
                &room_occ,
                &heuristic_state,
                run_seed,
            );

            let Some(slots) = slots else {
                seq += 1;
                unassigned.push(json!({
                    "classId": assignment.class_id,
                    "className": assignment.class_name,
                    "subject": assignment.subject,
                    "teacher": assignment.teacher,
                    "room": assignment.room,
                    "reason": "not_enough_non_off_slots_or_subject_limit",
                    "sessionLimit": assignment.session_limit,
                    "index": seq
                }));
                remaining = remaining.saturating_sub(1);
                continue;
            };

            for slot in slots {
                seq += 1;
                occupied_by_class.insert(slot_key(&assignment.class_id, &slot));
                if !assignment.teacher.is_empty() {
                    teacher_occ.insert(resource_slot_key(&assignment.teacher, &slot));
                }
                if !assignment.room.is_empty() {
                    room_occ.insert(resource_slot_key(&assignment.room, &slot));
                }
                heuristic_state.add(
                    &assignment.class_id,
                    &assignment.subject,
                    &assignment.teacher,
                    &slot,
                );
                *existing_by_class_subject
                    .entry((assignment.class_id.clone(), norm(&assignment.subject)))
                    .or_insert(0) += 1;
                lessons.push(lesson_json(
                    &assignment.class_id,
                    &assignment.class_name,
                    &assignment.subject,
                    &assignment.teacher,
                    &assignment.room,
                    &slot,
                    false,
                ));
                remaining = remaining.saturating_sub(1);
            }
        }
    }

    if !schedule_hard_ok(lessons, off_slots, subject_limits) {
        return unassigned;
    }
    unassigned
}

fn slot_key(class_id: &str, slot: &Slot) -> String {
    format!(
        "{}|{}|{}|{}",
        class_id, slot.day_key, slot.session_key, slot.period_index
    )
}

fn resource_slot_key(resource: &str, slot: &Slot) -> String {
    format!(
        "{}|{}|{}|{}",
        norm(resource),
        slot.day_key,
        slot.session_key,
        slot.period_index
    )
}

fn solve_seed(request: &Value) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    let mut has_explicit_entropy = false;
    if let Some(seed_value) = request
        .get("settings")
        .and_then(|value| value.get("random_seed"))
    {
        has_explicit_entropy = true;
        if let Some(seed) = seed_value.as_u64() {
            hash ^= seed;
        } else if let Some(seed) = seed_value.as_i64() {
            hash ^= seed as u64;
        } else if let Some(seed) = seed_value.as_str() {
            hash_part(&mut hash, seed);
        }
    }
    if let Some(run_id) = request
        .get("settings")
        .and_then(|value| value.get("solve_run_id"))
        .and_then(Value::as_str)
    {
        has_explicit_entropy = true;
        hash_part(&mut hash, run_id);
    }
    if let Some(nonce) = request
        .get("data")
        .and_then(|value| value.get("__tkbSolverRequestNonce"))
        .and_then(Value::as_str)
    {
        has_explicit_entropy = true;
        hash_part(&mut hash, nonce);
    }
    if !has_explicit_entropy {
        hash ^= wall_clock_ms();
        hash = hash.wrapping_mul(0x100000001b3);
    }
    if hash == 0 {
        0x9e3779b97f4a7c15
    } else {
        hash
    }
}

struct SimpleRng {
    state: u64,
}

impl SimpleRng {
    fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 { 0x9e3779b97f4a7c15 } else { seed },
        }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }
}

fn shuffle_slice<T>(items: &mut [T], rng: &mut SimpleRng) {
    if items.len() < 2 {
        return;
    }
    for index in (1..items.len()).rev() {
        let swap_with = (rng.next_u64() as usize) % (index + 1);
        items.swap(index, swap_with);
    }
}

fn slot_jitter(assignment: &Assignment, slot: &Slot, run_seed: u64) -> i64 {
    let mut hash = run_seed ^ 0xcbf29ce484222325_u64;
    hash_part(&mut hash, &assignment.class_id);
    hash_part(&mut hash, &assignment.subject);
    hash_part(&mut hash, &assignment.teacher);
    hash_part(&mut hash, &slot.day_key);
    hash_part(&mut hash, &slot.session_key);
    hash_part(&mut hash, &slot.period_index.to_string());
    (hash % 173) as i64
}

fn block_jitter(assignment: &Assignment, slots: &[Slot], run_seed: u64) -> i64 {
    let mut hash = run_seed ^ 0x9e3779b97f4a7c15_u64;
    hash_part(&mut hash, &assignment.class_id);
    hash_part(&mut hash, &assignment.subject);
    for slot in slots {
        hash_part(&mut hash, &slot.day_key);
        hash_part(&mut hash, &slot.session_key);
        hash_part(&mut hash, &slot.period_index.to_string());
    }
    (hash % 211) as i64
}

fn hash_part(hash: &mut u64, value: &str) {
    for byte in value.as_bytes() {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
    *hash ^= 0xff;
    *hash = hash.wrapping_mul(0x100000001b3);
}

fn consecutive_periods(periods: &[i64]) -> bool {
    if periods.len() < 2 {
        return true;
    }
    let original_len = periods.len();
    let mut periods = periods.to_vec();
    periods.sort();
    periods.dedup();
    if periods.len() != original_len {
        return false;
    }
    periods.windows(2).all(|pair| pair[1] == pair[0] + 1)
}

fn teacher_gap_count(periods: &[i64]) -> i64 {
    if periods.len() < 2 {
        return 0;
    }
    let mut values = periods.to_vec();
    values.sort();
    values.dedup();
    if values.len() < 2 {
        return 0;
    }
    let min_period = values.first().copied().unwrap_or(0);
    let max_period = values.last().copied().unwrap_or(0);
    (max_period - min_period + 1 - values.len() as i64).max(0)
}

fn session_key_from_label(value: &str) -> &str {
    match value.trim().to_ascii_uppercase().as_str() {
        "AM" | "SANG" => "sang",
        "PM" | "CHIEU" => "chieu",
        _ => value,
    }
}

fn teacher_period_load_map(assignments: &[Assignment]) -> HashMap<String, i64> {
    let mut out = HashMap::new();
    for assignment in assignments {
        let teacher_key = norm(&assignment.teacher);
        if teacher_key.is_empty() {
            continue;
        }
        *out.entry(teacher_key).or_insert(0) += assignment.periods.max(0);
    }
    out
}

fn subject_limit_map(assignments: &[Assignment]) -> SubjectLimitMap {
    let mut out = HashMap::new();
    for assignment in assignments {
        let key = (assignment.class_id.clone(), norm(&assignment.subject));
        out.entry(key)
            .and_modify(|value: &mut SubjectLimit| {
                value.per_session = value.per_session.min(assignment.session_limit);
                for (day, limit) in &assignment.day_limits {
                    value
                        .per_day
                        .entry(*day)
                        .and_modify(|current| *current = (*current).min(*limit))
                        .or_insert(*limit);
                }
            })
            .or_insert_with(|| SubjectLimit {
                per_session: assignment.session_limit,
                per_day: assignment.day_limits.clone(),
            });
    }
    out
}

fn subject_limit_violations(lessons: &[Value], limits: &SubjectLimitMap) -> Vec<Value> {
    let mut session_positions: HashMap<(String, String, i64, String), Vec<i64>> = HashMap::new();
    let mut day_counts: HashMap<(String, String, i64), i64> = HashMap::new();
    let mut display_subjects: HashMap<(String, String), String> = HashMap::new();
    for lesson in lessons {
        let class_id = lesson
            .get("classId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let subject = lesson
            .get("subject")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let day = lesson.get("day").and_then(Value::as_i64).unwrap_or(0);
        if class_id.is_empty() || subject.is_empty() || day <= 0 {
            continue;
        }
        let session = lesson
            .get("session")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let period = lesson.get("period").and_then(Value::as_i64).unwrap_or(0) - 1;
        let subject_key = norm(&subject);
        let session_key = session_key_from_label(&session).to_string();
        session_positions
            .entry((class_id.clone(), subject_key.clone(), day, session_key))
            .or_default()
            .push(period);
        *day_counts
            .entry((class_id.clone(), subject_key.clone(), day))
            .or_insert(0) += 1;
        display_subjects
            .entry((class_id, subject_key))
            .or_insert(subject);
    }

    let mut violations = Vec::new();
    for ((class_id, subject_key, day, session), periods) in session_positions {
        let Some(rule) = limits.get(&(class_id.clone(), subject_key.clone())) else {
            continue;
        };
        let subject = display_subjects
            .get(&(class_id.clone(), subject_key))
            .cloned()
            .unwrap_or_default();
        let count = periods.len() as i64;
        if count > rule.per_session {
            violations.push(json!({
                "kind": "subject_session_limit",
                "classId": class_id,
                "subject": subject,
                "day": day,
                "session": session,
                "count": count,
                "limit": rule.per_session,
                "message": format!("Subject session limit exceeded: {count}/{}", rule.per_session)
            }));
            continue;
        }
        if count > 1 && !consecutive_periods(&periods) {
            violations.push(json!({
                "kind": "subject_session_block",
                "classId": class_id,
                "subject": subject,
                "day": day,
                "session": session,
                "count": count,
                "limit": rule.per_session,
                "message": "Multiple periods of one subject in a session must be consecutive."
            }));
        }
    }

    for ((class_id, subject_key, day), count) in day_counts {
        let Some(limit) = limits
            .get(&(class_id.clone(), subject_key.clone()))
            .and_then(|rule| rule.per_day.get(&day))
            .copied()
        else {
            continue;
        };
        if count <= limit {
            continue;
        }
        let subject = display_subjects
            .get(&(class_id.clone(), subject_key))
            .cloned()
            .unwrap_or_default();
        violations.push(json!({
            "kind": "subject_day_limit",
            "classId": class_id,
            "subject": subject,
            "day": day,
            "count": count,
            "limit": limit,
            "message": format!("Explicit subject day limit exceeded: {count}/{limit}")
        }));
    }
    violations.sort_by(|a, b| {
        string_value(a.get("classId").unwrap_or(&Value::Null))
            .cmp(&string_value(b.get("classId").unwrap_or(&Value::Null)))
            .then_with(|| {
                string_value(a.get("subject").unwrap_or(&Value::Null))
                    .cmp(&string_value(b.get("subject").unwrap_or(&Value::Null)))
            })
            .then_with(|| int_value(a.get("day"), 0).cmp(&int_value(b.get("day"), 0)))
    });
    violations
}

#[derive(Default)]
struct TeacherSessionOptStats {
    initial_teacher_sessions: i64,
    final_teacher_sessions: i64,
    initial_one_period_sessions: i64,
    final_one_period_sessions: i64,
    initial_gap_total: i64,
    final_gap_total: i64,
    initial_gap2_plus_sessions: i64,
    final_gap2_plus_sessions: i64,
    single_session_moves: i64,
    gap_moves: i64,
    single_gap_moves: i64,
    moves: i64,
}

fn teacher_session_opt_snapshot(lessons: &[Value]) -> TeacherSessionOptStats {
    let gap_metrics = teacher_gap_metrics(lessons);
    let teacher_sessions = count_teacher_sessions(lessons);
    let one_period_sessions = count_one_period_teacher_sessions(lessons);
    TeacherSessionOptStats {
        initial_teacher_sessions: teacher_sessions,
        final_teacher_sessions: teacher_sessions,
        initial_one_period_sessions: one_period_sessions,
        final_one_period_sessions: one_period_sessions,
        initial_gap_total: gap_metrics.total_gap,
        final_gap_total: gap_metrics.total_gap,
        initial_gap2_plus_sessions: gap_metrics.gap2_plus_sessions,
        final_gap2_plus_sessions: gap_metrics.gap2_plus_sessions,
        single_session_moves: 0,
        gap_moves: 0,
        single_gap_moves: 0,
        moves: 0,
    }
}

#[derive(Default)]
struct TeacherGapMetrics {
    total_gap: i64,
    distribution: HashMap<String, i64>,
    gap2_plus_sessions: i64,
}

struct TeacherGapSession {
    key: String,
    day: i64,
    session_key: String,
    indices: Vec<usize>,
    gap_slots: Vec<i64>,
    gaps: i64,
}

fn optimize_teacher_single_sessions(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    deep_gap_repair: bool,
    two_stage_teacher_quality: bool,
    optimization_focus: OptimizationFocus,
    clock: &SolveClock,
) -> TeacherSessionOptStats {
    match optimization_focus {
        OptimizationFocus::QuickComplete => {
            return teacher_session_opt_snapshot(lessons);
        }
        OptimizationFocus::Singletons => {
            return optimize_teacher_singletons_focused(
                lessons,
                off_slots,
                subject_limits,
                run_seed,
                clock,
            );
        }
        OptimizationFocus::Sessions => {
            return optimize_teacher_sessions_focused(
                lessons,
                off_slots,
                subject_limits,
                run_seed,
                clock,
            );
        }
        OptimizationFocus::Gaps => {
            return optimize_teacher_gaps_focused(
                lessons,
                off_slots,
                subject_limits,
                run_seed,
                deep_gap_repair,
                clock,
            );
        }
        OptimizationFocus::Automatic => {}
    }

    if !two_stage_teacher_quality {
        return optimize_teacher_single_sessions_balanced(
            lessons,
            off_slots,
            subject_limits,
            run_seed,
            deep_gap_repair,
            clock,
        );
    }

    let automatic_incumbent = lessons.clone();
    let initial_quality = teacher_optimization_quality(lessons);
    let initial_gap_metrics = teacher_gap_metrics(lessons);
    let mut session_phase_moves = 0_i64;

    // Phase S may take on temporary gap debt, but only a strict teacher-session
    // reduction with the zero-singleton invariant is allowed to replace the
    // incumbent.
    if initial_quality.one_period_sessions == 0 && !clock.should_stop_quality() {
        let mut candidate = lessons.clone();
        let candidate_moves = optimize_teacher_session_reduction(
            &mut candidate,
            off_slots,
            subject_limits,
            run_seed ^ 0x5a17_9c43_d2e8_6b01_u64,
            true,
            clock,
        );
        let candidate_quality = teacher_optimization_quality(&candidate);
        if candidate_moves > 0
            && two_stage_session_phase_acceptable(&initial_quality, &candidate_quality)
            && schedule_hard_ok(&candidate, off_slots, subject_limits)
        {
            *lessons = candidate;
            session_phase_moves = candidate_moves;
        }
    }

    // Phase G starts from the accepted Phase-S incumbent. The balanced cleanup
    // may improve gaps (or reduce sessions again), but it cannot raise the
    // achieved teacher-session ceiling or reintroduce singleton sessions.
    let phase_s_lessons = lessons.clone();
    let phase_s_quality = teacher_optimization_quality(&phase_s_lessons);
    let mut cleanup_stats = optimize_teacher_single_sessions_balanced(
        lessons,
        off_slots,
        subject_limits,
        run_seed ^ 0xc361_4e92_7a05_bd8f_u64,
        deep_gap_repair,
        clock,
    );
    let cleanup_quality = teacher_optimization_quality(lessons);
    if !schedule_hard_ok(lessons, off_slots, subject_limits)
        || !two_stage_cleanup_acceptable(&phase_s_quality, &cleanup_quality)
    {
        *lessons = phase_s_lessons;
        cleanup_stats = teacher_session_opt_snapshot(lessons);
    }

    let final_quality = teacher_optimization_quality(lessons);
    if !schedule_hard_ok(lessons, off_slots, subject_limits)
        || !automatic_two_stage_final_acceptable(&initial_quality, &final_quality)
    {
        *lessons = automatic_incumbent;
        return teacher_session_opt_snapshot(lessons);
    }
    let final_gap_metrics = teacher_gap_metrics(lessons);
    TeacherSessionOptStats {
        initial_teacher_sessions: initial_quality.teacher_sessions,
        final_teacher_sessions: final_quality.teacher_sessions,
        initial_one_period_sessions: initial_quality.one_period_sessions,
        final_one_period_sessions: final_quality.one_period_sessions,
        initial_gap_total: initial_gap_metrics.total_gap,
        final_gap_total: final_gap_metrics.total_gap,
        initial_gap2_plus_sessions: initial_gap_metrics.gap2_plus_sessions,
        final_gap2_plus_sessions: final_gap_metrics.gap2_plus_sessions,
        single_session_moves: session_phase_moves + cleanup_stats.single_session_moves,
        gap_moves: cleanup_stats.gap_moves,
        single_gap_moves: cleanup_stats.single_gap_moves,
        moves: session_phase_moves + cleanup_stats.moves,
    }
}

fn teacher_session_opt_stats_from_focus(
    initial: TeacherOptimizationQuality,
    lessons: &[Value],
    single_session_moves: i64,
    gap_moves: i64,
    single_gap_moves: i64,
    moves: i64,
) -> TeacherSessionOptStats {
    let final_quality = teacher_optimization_quality(lessons);
    TeacherSessionOptStats {
        initial_teacher_sessions: initial.teacher_sessions,
        final_teacher_sessions: final_quality.teacher_sessions,
        initial_one_period_sessions: initial.one_period_sessions,
        final_one_period_sessions: final_quality.one_period_sessions,
        initial_gap_total: initial.total_gap,
        final_gap_total: final_quality.total_gap,
        initial_gap2_plus_sessions: initial.gap2_plus_sessions,
        final_gap2_plus_sessions: final_quality.gap2_plus_sessions,
        single_session_moves,
        gap_moves,
        single_gap_moves,
        moves,
    }
}

fn optimize_teacher_singletons_focused(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    clock: &SolveClock,
) -> TeacherSessionOptStats {
    let initial = teacher_optimization_quality(lessons);
    let mut moves = 0_i64;
    for round in 0..4_u64 {
        if clock.should_stop_quality() {
            break;
        }
        let before = teacher_optimization_quality(lessons);
        if before.one_period_sessions <= 0 {
            break;
        }
        let mut candidate = lessons.clone();
        let mut phase_moves = if round == 0 {
            optimize_teacher_session_reduction(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed ^ 0x2b7e_4a19_93d0_6c51_u64,
                false,
                clock,
            )
        } else {
            run_teacher_optimization_phase(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed ^ round.wrapping_mul(0x9e37_79b9_u64),
                false,
                TeacherOptimizationPhase::OnePeriod,
                clock,
            )
        };
        let mut after = teacher_optimization_quality(&candidate);
        let mut acceptable = phase_moves > 0
            && after.one_period_sessions < before.one_period_sessions
            && after.teacher_sessions <= before.teacher_sessions
            && schedule_hard_ok(&candidate, off_slots, subject_limits);
        if round == 0 && !acceptable && !clock.should_stop_quality() {
            candidate = lessons.clone();
            phase_moves = run_teacher_optimization_phase(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed ^ 0xd18c_35a7_64e2_09bf_u64,
                false,
                TeacherOptimizationPhase::OnePeriod,
                clock,
            );
            after = teacher_optimization_quality(&candidate);
            acceptable = phase_moves > 0
                && after.one_period_sessions < before.one_period_sessions
                && after.teacher_sessions <= before.teacher_sessions
                && schedule_hard_ok(&candidate, off_slots, subject_limits);
        }
        if !acceptable {
            break;
        }
        *lessons = candidate;
        moves += phase_moves;
    }
    teacher_session_opt_stats_from_focus(initial, lessons, moves, 0, 0, moves)
}

fn optimize_teacher_sessions_focused(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    clock: &SolveClock,
) -> TeacherSessionOptStats {
    let initial = teacher_optimization_quality(lessons);
    let mut moves = 0_i64;
    for round in 0..3_u64 {
        if clock.should_stop_quality() {
            break;
        }
        let before = teacher_optimization_quality(lessons);
        let mut candidate = lessons.clone();
        let phase_moves = optimize_teacher_session_reduction(
            &mut candidate,
            off_slots,
            subject_limits,
            run_seed ^ 0x7c4d_91e2_5ab8_063f_u64 ^ round.wrapping_mul(0x517c_cc1b_u64),
            true,
            clock,
        );
        let after = teacher_optimization_quality(&candidate);
        let singleton_improved = after.one_period_sessions < before.one_period_sessions;
        let sessions_improved = after.teacher_sessions < before.teacher_sessions;
        let acceptable = phase_moves > 0
            && after.one_period_sessions <= before.one_period_sessions
            && (sessions_improved || singleton_improved)
            && after.teacher_sessions <= before.teacher_sessions
            && schedule_hard_ok(&candidate, off_slots, subject_limits);
        if !acceptable {
            break;
        }
        *lessons = candidate;
        moves += phase_moves;
        if !sessions_improved && after.one_period_sessions > 0 {
            break;
        }
    }
    teacher_session_opt_stats_from_focus(initial, lessons, moves, 0, 0, moves)
}

fn focused_gap_candidate_acceptable(
    before: &TeacherOptimizationQuality,
    after: &TeacherOptimizationQuality,
) -> bool {
    after.one_period_sessions <= before.one_period_sessions
        && after.teacher_sessions <= before.teacher_sessions
        && (after.gap2_plus_sessions < before.gap2_plus_sessions
            || (after.gap2_plus_sessions == before.gap2_plus_sessions
                && (after.gap1_sessions < before.gap1_sessions
                    || (after.gap1_sessions == before.gap1_sessions
                        && after.total_gap < before.total_gap))))
}

fn optimize_teacher_gaps_focused(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    deep_gap_repair: bool,
    clock: &SolveClock,
) -> TeacherSessionOptStats {
    let initial = teacher_optimization_quality(lessons);
    let mut gap_moves = 0_i64;
    let mut single_gap_moves = 0_i64;
    for round in 0..3_u64 {
        if clock.should_stop_quality() {
            break;
        }
        let mut changed = false;
        let before_large = teacher_optimization_quality(lessons);
        let mut large_candidate = lessons.clone();
        let large_moves = optimize_teacher_large_gaps(
            &mut large_candidate,
            off_slots,
            subject_limits,
            run_seed ^ 0xa31e_7b4c_52d9_068f_u64 ^ round,
            deep_gap_repair,
            clock,
        );
        let after_large = teacher_optimization_quality(&large_candidate);
        if large_moves > 0
            && focused_gap_candidate_acceptable(&before_large, &after_large)
            && schedule_hard_ok(&large_candidate, off_slots, subject_limits)
        {
            *lessons = large_candidate;
            gap_moves += large_moves;
            changed = true;
        }

        if clock.should_stop_quality() {
            break;
        }

        let before_single = teacher_optimization_quality(lessons);
        let mut single_candidate = lessons.clone();
        let single_moves = optimize_teacher_single_gaps(
            &mut single_candidate,
            off_slots,
            subject_limits,
            run_seed ^ 0x6d2f_98a1_40c3_75be_u64 ^ round,
            clock,
        );
        let after_single = teacher_optimization_quality(&single_candidate);
        if single_moves > 0
            && focused_gap_candidate_acceptable(&before_single, &after_single)
            && schedule_hard_ok(&single_candidate, off_slots, subject_limits)
        {
            *lessons = single_candidate;
            single_gap_moves += single_moves;
            gap_moves += single_moves;
            changed = true;
        }
        if !changed {
            break;
        }
    }
    teacher_session_opt_stats_from_focus(
        initial,
        lessons,
        0,
        gap_moves,
        single_gap_moves,
        gap_moves,
    )
}

fn optimize_teacher_single_sessions_balanced(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    deep_gap_repair: bool,
    clock: &SolveClock,
) -> TeacherSessionOptStats {
    let initial_teacher_sessions = count_teacher_sessions(lessons);
    let initial_one_period_sessions = count_one_period_teacher_sessions(lessons);
    let initial_gap_metrics = teacher_gap_metrics(lessons);
    let mut moves = 0_i64;
    let mut single_session_moves = 0_i64;
    let mut gap_moves = 0_i64;
    let mut single_gap_moves = 0_i64;
    let max_cycles = if deep_gap_repair { 3 } else { 2 };

    for _ in 0..max_cycles {
        if clock.should_stop_quality() {
            break;
        }
        let before_cycle = teacher_optimization_quality(lessons);
        let mut cycle_moves = 0_i64;

        if before_cycle.one_period_sessions > 0 && !clock.should_stop_quality() {
            let before = teacher_optimization_quality(lessons);
            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_session_reduction(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                false,
                clock,
            );
            let cleanup_moves = if phase_moves > 0 {
                optimize_teacher_large_gaps(
                    &mut candidate,
                    off_slots,
                    subject_limits,
                    run_seed,
                    false,
                    clock,
                )
            } else {
                0
            };
            let after = teacher_optimization_quality(&candidate);
            if phase_moves > 0
                && after.one_period_sessions < before.one_period_sessions
                && after.teacher_sessions <= before.teacher_sessions
                && after.gap2_plus_sessions <= before.gap2_plus_sessions
            {
                *lessons = candidate;
                single_session_moves += phase_moves;
                gap_moves += cleanup_moves;
                moves += phase_moves;
                moves += cleanup_moves;
                cycle_moves += phase_moves;
                cycle_moves += cleanup_moves;
            }
        }

        let before_gap2 = teacher_optimization_quality(lessons);
        if before_gap2.gap2_plus_sessions > 0 && !clock.should_stop_quality() {
            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_large_gaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                true,
                clock,
            );
            let after = teacher_optimization_quality(&candidate);
            if phase_moves > 0
                && after.one_period_sessions <= before_gap2.one_period_sessions
                && after.teacher_sessions <= before_gap2.teacher_sessions
                && after.gap2_plus_sessions < before_gap2.gap2_plus_sessions
            {
                *lessons = candidate;
                gap_moves += phase_moves;
                moves += phase_moves;
                cycle_moves += phase_moves;
            }
        }

        let before_sessions = teacher_optimization_quality(lessons);
        if before_sessions.one_period_sessions == 0
            && before_sessions.gap2_plus_sessions == 0
            && !clock.should_stop_quality()
        {
            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_session_reduction(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                true,
                clock,
            );
            let after = teacher_optimization_quality(&candidate);
            if phase_moves > 0
                && after.one_period_sessions == 0
                && after.gap2_plus_sessions == 0
                && after.teacher_sessions < before_sessions.teacher_sessions
            {
                *lessons = candidate;
                single_session_moves += phase_moves;
                moves += phase_moves;
                cycle_moves += phase_moves;
            }
        }

        let before_gap1 = teacher_optimization_quality(lessons);
        if before_gap1.one_period_sessions == 0
            && before_gap1.gap2_plus_sessions == 0
            && before_gap1.gap1_sessions > 0
            && !clock.should_stop_quality()
        {
            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_single_gaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                clock,
            );
            let after = teacher_optimization_quality(&candidate);
            if phase_moves > 0
                && after.one_period_sessions == 0
                && after.gap2_plus_sessions == 0
                && after.gap1_sessions < before_gap1.gap1_sessions
            {
                *lessons = candidate;
                single_gap_moves += phase_moves;
                moves += phase_moves;
                cycle_moves += phase_moves;
            }
        }

        let after_cycle = teacher_optimization_quality(lessons);
        if cycle_moves == 0 || !teacher_optimization_improved(&before_cycle, &after_cycle) {
            break;
        }
    }

    for _ in 0..3 {
        if clock.should_stop_quality() {
            break;
        }
        let before = teacher_optimization_quality(lessons);
        if before.one_period_sessions <= 0 {
            break;
        }
        let mut candidate = lessons.clone();
        let mut phase_moves = run_teacher_optimization_phase(
            &mut candidate,
            off_slots,
            subject_limits,
            run_seed,
            false,
            TeacherOptimizationPhase::OnePeriod,
            clock,
        );
        if phase_moves > 0 {
            phase_moves += optimize_teacher_large_gaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                true,
                clock,
            );
        }
        let after = teacher_optimization_quality(&candidate);
        if phase_moves > 0
            && after.one_period_sessions < before.one_period_sessions
            && after.teacher_sessions <= before.teacher_sessions
            && after.gap2_plus_sessions <= before.gap2_plus_sessions
        {
            *lessons = candidate;
            single_session_moves += phase_moves;
            moves += phase_moves;
        } else {
            break;
        }
    }

    let global_cleanup_moves = if clock.should_stop_quality() {
        0
    } else {
        optimize_remaining_singletons_global_cleanup(
            lessons,
            off_slots,
            subject_limits,
            run_seed,
            5,
            12_000,
            clock,
        )
    };
    if global_cleanup_moves > 0 {
        single_session_moves += global_cleanup_moves;
        moves += global_cleanup_moves;
        let cleanup_moves =
            optimize_teacher_large_gaps(lessons, off_slots, subject_limits, run_seed, true, clock);
        gap_moves += cleanup_moves;
        moves += cleanup_moves;
    }

    let cycle_rescue_moves = if clock.should_stop_quality() {
        0
    } else {
        optimize_remaining_singletons_by_class_cycles(
            lessons,
            off_slots,
            subject_limits,
            run_seed,
            8,
            4,
            4_000,
            clock,
        )
    };
    if cycle_rescue_moves > 0 {
        single_session_moves += cycle_rescue_moves;
        moves += cycle_rescue_moves;
        let cleanup_moves =
            optimize_teacher_large_gaps(lessons, off_slots, subject_limits, run_seed, true, clock);
        gap_moves += cleanup_moves;
        moves += cleanup_moves;
    }
    let same_class_cycle_moves = 0;
    if same_class_cycle_moves > 0 {
        single_session_moves += same_class_cycle_moves;
        moves += same_class_cycle_moves;
        let cleanup_moves =
            optimize_teacher_large_gaps(lessons, off_slots, subject_limits, run_seed, true, clock);
        gap_moves += cleanup_moves;
        moves += cleanup_moves;
    }
    for (seed_salt, max_moves, chain_depth, check_limit) in [
        (0x24d9_7b31_5ce4_18a7_u64, 4, 5_usize, 12_000),
        (0x41b2_d697_0f35_e8c9_u64, 3, 6_usize, 28_000),
    ] {
        if clock.should_stop_quality() {
            break;
        }
        let before_chain = teacher_optimization_quality(lessons);
        if before_chain.one_period_sessions <= 0 {
            break;
        }
        let chain_moves = optimize_remaining_singletons_by_class_cycles(
            lessons,
            off_slots,
            subject_limits,
            run_seed ^ seed_salt,
            max_moves,
            chain_depth,
            check_limit,
            clock,
        );
        if chain_moves <= 0 {
            continue;
        }
        single_session_moves += chain_moves;
        moves += chain_moves;

        let follow_cleanup_moves = optimize_remaining_singletons_global_cleanup(
            lessons,
            off_slots,
            subject_limits,
            run_seed ^ seed_salt.rotate_left(17),
            2,
            8_000,
            clock,
        );
        if follow_cleanup_moves > 0 {
            single_session_moves += follow_cleanup_moves;
            moves += follow_cleanup_moves;
        }

        let before_follow_phase = teacher_optimization_quality(lessons);
        if before_follow_phase.one_period_sessions > 0 {
            let mut candidate = lessons.clone();
            let follow_phase_moves = optimize_teacher_session_reduction(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed ^ seed_salt.rotate_right(11),
                false,
                clock,
            );
            let after_follow_phase = teacher_optimization_quality(&candidate);
            if follow_phase_moves > 0
                && after_follow_phase.one_period_sessions < before_follow_phase.one_period_sessions
                && after_follow_phase.teacher_sessions <= before_follow_phase.teacher_sessions
                && after_follow_phase.gap2_plus_sessions <= before_follow_phase.gap2_plus_sessions
            {
                *lessons = candidate;
                single_session_moves += follow_phase_moves;
                moves += follow_phase_moves;
            }
        }

        let cleanup_moves = optimize_teacher_large_gaps(
            lessons,
            off_slots,
            subject_limits,
            run_seed ^ seed_salt,
            true,
            clock,
        );
        gap_moves += cleanup_moves;
        moves += cleanup_moves;
    }

    for _ in 0..2 {
        if clock.should_stop_quality() {
            break;
        }
        let before_final_one = teacher_optimization_quality(lessons);
        if before_final_one.one_period_sessions <= 0 {
            break;
        }
        let mut candidate = lessons.clone();
        let phase_moves = run_teacher_optimization_phase(
            &mut candidate,
            off_slots,
            subject_limits,
            run_seed,
            false,
            TeacherOptimizationPhase::OnePeriod,
            clock,
        );
        let after_final_one = teacher_optimization_quality(&candidate);
        if phase_moves > 0
            && after_final_one.one_period_sessions < before_final_one.one_period_sessions
            && after_final_one.teacher_sessions <= before_final_one.teacher_sessions
            && after_final_one.gap2_plus_sessions <= before_final_one.gap2_plus_sessions
        {
            *lessons = candidate;
            single_session_moves += phase_moves;
            moves += phase_moves;
        } else {
            break;
        }
    }

    let before_deep_chain = teacher_optimization_quality(lessons);
    if before_deep_chain.one_period_sessions > 0 && !clock.should_stop_quality() {
        let beam_chain_moves = optimize_remaining_singletons_by_class_beam(
            lessons,
            off_slots,
            subject_limits,
            run_seed ^ 0x3598_9c21_ed67_4ab5_u64,
            2,
            8,
            96,
            36,
            120_000,
            clock,
        );
        if beam_chain_moves > 0 {
            single_session_moves += beam_chain_moves;
            moves += beam_chain_moves;
        }
        let deep_chain_moves = optimize_remaining_singletons_by_class_cycles(
            lessons,
            off_slots,
            subject_limits,
            run_seed ^ 0x6d0f_3a77_13c9_5b21_u64,
            2,
            8,
            80_000,
            clock,
        );
        if deep_chain_moves > 0 {
            single_session_moves += deep_chain_moves;
            moves += deep_chain_moves;
            for _ in 0..2 {
                if clock.should_stop_quality() {
                    break;
                }
                let before_deep_phase = teacher_optimization_quality(lessons);
                if before_deep_phase.one_period_sessions <= 0 {
                    break;
                }
                let mut candidate = lessons.clone();
                let deep_phase_moves = run_teacher_optimization_phase(
                    &mut candidate,
                    off_slots,
                    subject_limits,
                    run_seed,
                    false,
                    TeacherOptimizationPhase::OnePeriod,
                    clock,
                );
                let after_deep_phase = teacher_optimization_quality(&candidate);
                if deep_phase_moves > 0
                    && after_deep_phase.one_period_sessions < before_deep_phase.one_period_sessions
                    && after_deep_phase.teacher_sessions <= before_deep_phase.teacher_sessions
                    && after_deep_phase.gap2_plus_sessions <= before_deep_phase.gap2_plus_sessions
                {
                    *lessons = candidate;
                    single_session_moves += deep_phase_moves;
                    moves += deep_phase_moves;
                } else {
                    break;
                }
            }
        }
    }

    let before_final_gap1 = teacher_optimization_quality(lessons);
    if before_final_gap1.one_period_sessions == 0
        && before_final_gap1.gap2_plus_sessions == 0
        && before_final_gap1.gap1_sessions > 0
        && !clock.should_stop_quality()
    {
        let final_gap1_moves =
            optimize_teacher_single_gaps(lessons, off_slots, subject_limits, run_seed, clock);
        if final_gap1_moves > 0 {
            single_gap_moves += final_gap1_moves;
            moves += final_gap1_moves;
        }
    }

    let final_gap_metrics = teacher_gap_metrics(lessons);

    TeacherSessionOptStats {
        initial_teacher_sessions,
        final_teacher_sessions: count_teacher_sessions(lessons),
        initial_one_period_sessions,
        final_one_period_sessions: count_one_period_teacher_sessions(lessons),
        initial_gap_total: initial_gap_metrics.total_gap,
        final_gap_total: final_gap_metrics.total_gap,
        initial_gap2_plus_sessions: initial_gap_metrics.gap2_plus_sessions,
        final_gap2_plus_sessions: final_gap_metrics.gap2_plus_sessions,
        single_session_moves,
        gap_moves,
        single_gap_moves,
        moves,
    }
}

fn optimize_remaining_singletons_by_class_beam(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    max_moves: i64,
    chain_depth: usize,
    _beam_width: usize,
    _branch_limit: usize,
    check_limit: i64,
    clock: &SolveClock,
) -> i64 {
    if clock.should_stop_quality() {
        return 0;
    }
    optimize_remaining_singletons_by_class_cycles(
        lessons,
        off_slots,
        subject_limits,
        run_seed,
        max_moves,
        chain_depth,
        check_limit,
        clock,
    )
}

fn optimize_remaining_singletons_by_class_cycles(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    max_moves: i64,
    chain_depth: usize,
    check_limit: i64,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    for _ in 0..max_moves {
        if clock.should_stop_quality() {
            break;
        }
        let before = teacher_optimization_quality(lessons);
        if before.one_period_sessions <= 0 {
            break;
        }
        let session_index = teacher_session_index(lessons);
        let mut singletons = session_index
            .iter()
            .filter_map(|(key, indices)| (indices.len() == 1).then(|| (key.clone(), indices[0])))
            .collect::<Vec<_>>();
        singletons.sort_by(|(left_key, _), (right_key, _)| {
            teacher_session_jitter(left_key, run_seed)
                .cmp(&teacher_session_jitter(right_key, run_seed))
                .then_with(|| left_key.cmp(right_key))
        });

        let mut best: Option<(i64, Vec<(usize, Slot)>)> = None;
        let mut checked = 0_i64;
        let check_limit = check_limit.max(1_000);
        let chain_depth = chain_depth.max(1);
        for (singleton_key, singleton_index) in singletons {
            if clock.should_stop_quality() {
                break;
            }
            if singleton_index >= lessons.len() || lesson_fixed(&lessons[singleton_index]) {
                continue;
            }
            let teacher = lesson_teacher_key(&lessons[singleton_index]);
            let class_id = lesson_class_id(&lessons[singleton_index]);
            let Some(source_slot) = lesson_slot(&lessons[singleton_index]) else {
                continue;
            };
            if teacher.is_empty() || class_id.is_empty() {
                continue;
            }
            let mut target_sessions = session_index
                .keys()
                .filter_map(|key| {
                    let (session_teacher, _, _) = parse_teacher_session_key(key)?;
                    (session_teacher == teacher && key != &singleton_key).then(|| key.clone())
                })
                .collect::<Vec<_>>();
            target_sessions.sort_by(|left, right| {
                let left_len = session_index
                    .get(left)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let right_len = session_index
                    .get(right)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let left_singleton = i64::from(left_len != 1);
                let right_singleton = i64::from(right_len != 1);
                left_singleton
                    .cmp(&right_singleton)
                    .then_with(|| right_len.cmp(&left_len))
                    .then_with(|| {
                        teacher_session_jitter(left, run_seed)
                            .cmp(&teacher_session_jitter(right, run_seed))
                    })
                    .then_with(|| left.cmp(right))
            });
            target_sessions.truncate(10);

            let class_slots = usable_slots_for_class(&class_id, off_slots);
            for target_session_key in target_sessions {
                if clock.should_stop_quality() {
                    break;
                }
                let Some((_, day, session_key)) = parse_teacher_session_key(&target_session_key)
                else {
                    continue;
                };
                for target_period in 0..PERIODS_PER_SESSION {
                    if clock.should_stop_quality() {
                        break;
                    }
                    let target_slot = make_slot(day, &session_key, target_period);
                    if same_slot(&source_slot, &target_slot) {
                        continue;
                    }
                    let Some(first_occupant) =
                        class_slot_occupant(lessons, &class_id, &target_slot)
                    else {
                        continue;
                    };
                    if first_occupant == singleton_index || lesson_fixed(&lessons[first_occupant]) {
                        continue;
                    }
                    for second_slot in &class_slots {
                        if clock.should_stop_quality() {
                            break;
                        }
                        checked += 1;
                        if checked > check_limit {
                            break;
                        }
                        if same_slot(second_slot, &source_slot)
                            || same_slot(second_slot, &target_slot)
                        {
                            continue;
                        }
                        let Some(second_occupant) =
                            class_slot_occupant(lessons, &class_id, second_slot)
                        else {
                            continue;
                        };
                        if second_occupant == singleton_index
                            || second_occupant == first_occupant
                            || lesson_fixed(&lessons[second_occupant])
                        {
                            continue;
                        }
                        let moves_candidate = vec![
                            (singleton_index, target_slot.clone()),
                            (first_occupant, second_slot.clone()),
                            (second_occupant, source_slot.clone()),
                        ];
                        let mut candidate = lessons.clone();
                        for (index, slot) in &moves_candidate {
                            set_lesson_slot(&mut candidate[*index], slot);
                        }
                        if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                            continue;
                        }
                        let after = teacher_optimization_quality(&candidate);
                        if after.one_period_sessions >= before.one_period_sessions
                            || after.gap2_plus_sessions > before.gap2_plus_sessions
                            || after.teacher_sessions > before.teacher_sessions
                        {
                            continue;
                        }
                        let jitter = moves_candidate
                            .iter()
                            .map(|(index, slot)| move_jitter(&lessons[*index], slot, run_seed))
                            .sum::<i64>();
                        let score = after.one_period_sessions * 1_000_000
                            + after.gap2_plus_sessions * 100_000
                            + after.teacher_sessions * 1_000
                            + after.gap1_sessions * 20
                            + jitter;
                        match &best {
                            Some((best_score, _)) if *best_score <= score => {}
                            _ => best = Some((score, moves_candidate)),
                        }
                    }
                    if checked > check_limit {
                        break;
                    }
                    let mut moves_candidate = vec![(singleton_index, target_slot.clone())];
                    let mut used_indices = HashSet::new();
                    used_indices.insert(singleton_index);
                    used_indices.insert(first_occupant);
                    let mut used_targets = HashSet::new();
                    used_targets.insert(target_slot_identity(&target_slot));
                    search_singleton_class_chain(
                        lessons,
                        &class_id,
                        &source_slot,
                        first_occupant,
                        &class_slots,
                        &session_index,
                        chain_depth,
                        &mut moves_candidate,
                        &mut used_indices,
                        &mut used_targets,
                        off_slots,
                        subject_limits,
                        &before,
                        run_seed,
                        &mut checked,
                        check_limit,
                        &mut best,
                    );
                    if checked > check_limit {
                        break;
                    }
                }
            }
            if checked > check_limit {
                break;
            }
        }

        let Some((_, best_moves)) = best else {
            break;
        };
        for (index, slot) in best_moves {
            set_lesson_slot(&mut lessons[index], &slot);
        }
        moves += 1;
    }
    moves
}

fn optimize_remaining_singletons_global_cleanup(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    max_passes: i64,
    max_evaluated_per_pass: i64,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    for _ in 0..max_passes.max(0) {
        if clock.should_stop_quality() {
            break;
        }
        let before = teacher_optimization_quality(lessons);
        if before.one_period_sessions <= 0 {
            break;
        }
        let session_index = teacher_session_index(lessons);
        let mut singletons = session_index
            .iter()
            .filter_map(|(key, indices)| (indices.len() == 1).then(|| (key.clone(), indices[0])))
            .collect::<Vec<_>>();
        if singletons.is_empty() {
            break;
        }
        singletons.sort_by(|(left_key, _), (right_key, _)| {
            teacher_session_jitter(left_key, run_seed)
                .cmp(&teacher_session_jitter(right_key, run_seed))
                .then_with(|| left_key.cmp(right_key))
        });

        let mut best: Option<(i64, Vec<(usize, Slot)>)> = None;
        let mut evaluated = 0_i64;
        let max_evaluated = max_evaluated_per_pass.max(100);
        let singleton_count = singletons.len() as i64;
        let per_singleton_limit = if singleton_count <= 2 {
            max_evaluated
        } else {
            (max_evaluated / singleton_count).clamp(1_200, 2_400)
        }
        .min(max_evaluated);

        for (singleton_key, singleton_index) in singletons {
            if clock.should_stop_quality() {
                break;
            }
            if evaluated >= max_evaluated
                || singleton_index >= lessons.len()
                || lesson_fixed(&lessons[singleton_index])
            {
                if evaluated >= max_evaluated {
                    break;
                }
                continue;
            }
            let singleton_start = evaluated;
            let single_teacher = lesson_teacher_key(&lessons[singleton_index]);
            let Some(single_slot) = lesson_slot(&lessons[singleton_index]) else {
                continue;
            };
            if single_teacher.is_empty() {
                continue;
            }

            let mut target_sessions = session_index
                .keys()
                .filter_map(|key| {
                    let (teacher, day, session_key) = parse_teacher_session_key(key)?;
                    (teacher == single_teacher && key != &singleton_key).then_some((
                        key.clone(),
                        day,
                        session_key,
                    ))
                })
                .collect::<Vec<_>>();
            target_sessions.sort_by(|(left_key, _, _), (right_key, _, _)| {
                let left_len = session_index
                    .get(left_key)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let right_len = session_index
                    .get(right_key)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let left_singleton = i64::from(left_len != 1);
                let right_singleton = i64::from(right_len != 1);
                left_singleton
                    .cmp(&right_singleton)
                    .then_with(|| right_len.cmp(&left_len))
                    .then_with(|| {
                        teacher_session_jitter(left_key, run_seed)
                            .cmp(&teacher_session_jitter(right_key, run_seed))
                    })
                    .then_with(|| left_key.cmp(right_key))
            });
            target_sessions.truncate(14);
            for (_, day, session_key) in target_sessions {
                if clock.should_stop_quality() {
                    break;
                }
                if evaluated >= max_evaluated || evaluated - singleton_start >= per_singleton_limit
                {
                    break;
                }
                for period_index in 0..PERIODS_PER_SESSION {
                    if clock.should_stop_quality() {
                        break;
                    }
                    if evaluated >= max_evaluated
                        || evaluated - singleton_start >= per_singleton_limit
                    {
                        break;
                    }
                    let target_slot = make_slot(day, &session_key, period_index);
                    if same_slot(&single_slot, &target_slot) {
                        continue;
                    }
                    evaluated += 1;
                    consider_global_singleton_cleanup_candidate(
                        lessons,
                        &[(singleton_index, target_slot)],
                        off_slots,
                        subject_limits,
                        &before,
                        run_seed,
                        &mut best,
                    );
                }
            }
            if evaluated >= max_evaluated {
                break;
            }
            if evaluated - singleton_start >= per_singleton_limit {
                continue;
            }

            let mut ordered = (0..lessons.len())
                .filter(|index| *index != singleton_index && !lesson_fixed(&lessons[*index]))
                .collect::<Vec<_>>();
            ordered.sort_by(|left, right| {
                singleton_cleanup_order_key(lessons, singleton_index, *left, run_seed)
                    .cmp(&singleton_cleanup_order_key(
                        lessons,
                        singleton_index,
                        *right,
                        run_seed,
                    ))
                    .then_with(|| left.cmp(right))
            });
            ordered.truncate(240);

            for other_index in ordered.iter().copied() {
                if clock.should_stop_quality() {
                    break;
                }
                if evaluated >= max_evaluated || evaluated - singleton_start >= per_singleton_limit
                {
                    break;
                }
                let Some(other_slot) = lesson_slot(&lessons[other_index]) else {
                    continue;
                };
                if same_slot(&single_slot, &other_slot) {
                    continue;
                }
                evaluated += 1;
                consider_global_singleton_cleanup_candidate(
                    lessons,
                    &[
                        (singleton_index, other_slot.clone()),
                        (other_index, single_slot.clone()),
                    ],
                    off_slots,
                    subject_limits,
                    &before,
                    run_seed,
                    &mut best,
                );

                let mut third_candidates = ordered
                    .iter()
                    .copied()
                    .filter(|index| *index != other_index && *index != singleton_index)
                    .collect::<Vec<_>>();
                third_candidates.truncate(220);
                for third_index in third_candidates {
                    if clock.should_stop_quality() {
                        break;
                    }
                    if evaluated >= max_evaluated
                        || evaluated - singleton_start >= per_singleton_limit
                    {
                        break;
                    }
                    let Some(third_slot) = lesson_slot(&lessons[third_index]) else {
                        continue;
                    };
                    if same_slot(&third_slot, &single_slot) || same_slot(&third_slot, &other_slot) {
                        continue;
                    }
                    evaluated += 1;
                    consider_global_singleton_cleanup_candidate(
                        lessons,
                        &[
                            (singleton_index, other_slot.clone()),
                            (other_index, third_slot),
                            (third_index, single_slot.clone()),
                        ],
                        off_slots,
                        subject_limits,
                        &before,
                        run_seed,
                        &mut best,
                    );
                }
            }
        }

        let Some((_, best_moves)) = best else {
            break;
        };
        for (index, slot) in best_moves {
            set_lesson_slot(&mut lessons[index], &slot);
        }
        moves += 1;
    }
    moves
}

fn singleton_cleanup_order_key(
    lessons: &[Value],
    singleton_index: usize,
    index: usize,
    run_seed: u64,
) -> (i64, i64, i64, i64, i64, i64) {
    if singleton_index >= lessons.len() || index >= lessons.len() {
        return (9, 9, 9, 999, 999, index as i64);
    }
    let anchor = &lessons[singleton_index];
    let item = &lessons[index];
    let same_class = i64::from(lesson_class_id(item) != lesson_class_id(anchor));
    let same_teacher = i64::from(lesson_teacher_key(item) != lesson_teacher_key(anchor));
    let (same_session, day_distance, period_distance) =
        match (lesson_slot(anchor), lesson_slot(item)) {
            (Some(anchor_slot), Some(item_slot)) => (
                i64::from(
                    anchor_slot.day != item_slot.day
                        || anchor_slot.session_key != item_slot.session_key,
                ),
                (anchor_slot.day - item_slot.day).abs(),
                (anchor_slot.period_index - item_slot.period_index).abs(),
            ),
            _ => (9, 999, 999),
        };
    (
        same_class,
        same_teacher,
        same_session,
        day_distance,
        period_distance,
        lesson_jitter(item, run_seed),
    )
}

fn candidate_move_slots_precheck(
    lessons: &[Value],
    moves: &[(usize, Slot)],
    off_slots: &HashSet<String>,
) -> bool {
    let moving_indices = moves
        .iter()
        .map(|(index, _)| *index)
        .collect::<HashSet<_>>();
    let mut target_class_slots = HashSet::new();
    let mut target_teacher_slots = HashSet::new();
    let mut target_room_slots = HashSet::new();

    for (index, target_slot) in moves {
        if *index >= lessons.len() {
            return false;
        }
        let lesson = &lessons[*index];
        let class_id = lesson_class_id(lesson);
        if class_id.is_empty() || off_slots.contains(&slot_key(&class_id, target_slot)) {
            return false;
        }
        if !target_class_slots.insert(slot_key(&class_id, target_slot)) {
            return false;
        }

        let teacher = lesson_teacher_key(lesson);
        if !teacher.is_empty()
            && !target_teacher_slots.insert(resource_slot_key(&teacher, target_slot))
        {
            return false;
        }

        let room = norm(&lesson_room(lesson));
        if !room.is_empty() && !target_room_slots.insert(resource_slot_key(&room, target_slot)) {
            return false;
        }
    }

    for (index, lesson) in lessons.iter().enumerate() {
        if moving_indices.contains(&index) {
            continue;
        }
        let Some(slot) = lesson_slot(lesson) else {
            continue;
        };
        let class_id = lesson_class_id(lesson);
        if !class_id.is_empty() && target_class_slots.contains(&slot_key(&class_id, &slot)) {
            return false;
        }
        let teacher = lesson_teacher_key(lesson);
        if !teacher.is_empty() && target_teacher_slots.contains(&resource_slot_key(&teacher, &slot))
        {
            return false;
        }
        let room = norm(&lesson_room(lesson));
        if !room.is_empty() && target_room_slots.contains(&resource_slot_key(&room, &slot)) {
            return false;
        }
    }

    true
}

fn consider_global_singleton_cleanup_candidate(
    lessons: &[Value],
    moves: &[(usize, Slot)],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    before: &TeacherOptimizationQuality,
    run_seed: u64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
) {
    let mut seen_indices = HashSet::new();
    for (index, _) in moves {
        if *index >= lessons.len() || lesson_fixed(&lessons[*index]) || !seen_indices.insert(*index)
        {
            return;
        }
    }
    if !candidate_move_slots_precheck(lessons, moves, off_slots) {
        return;
    }
    let mut candidate = lessons.to_vec();
    for (index, slot) in moves {
        set_lesson_slot(&mut candidate[*index], slot);
    }
    if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
        return;
    }
    let after = teacher_optimization_quality(&candidate);
    if after.one_period_sessions >= before.one_period_sessions
        || after.gap2_plus_sessions > before.gap2_plus_sessions
        || after.teacher_sessions > before.teacher_sessions
    {
        return;
    }
    let jitter = moves
        .iter()
        .map(|(index, slot)| move_jitter(&lessons[*index], slot, run_seed))
        .sum::<i64>();
    let score = after.one_period_sessions * 1_000_000_000
        + after.gap2_plus_sessions * 10_000_000
        + after.teacher_sessions * 100_000
        + after.gap1_sessions * 1_000
        + after.total_gap
        + moves.len() as i64 * 29
        + jitter;
    match best {
        Some((best_score, _)) if *best_score <= score => {}
        _ => *best = Some((score, moves.to_vec())),
    }
}

#[allow(dead_code)]
fn search_singleton_class_chain(
    lessons: &[Value],
    class_id: &str,
    source_slot: &Slot,
    current_index: usize,
    class_slots: &[Slot],
    session_index: &HashMap<String, Vec<usize>>,
    depth_remaining: usize,
    moves: &mut Vec<(usize, Slot)>,
    used_indices: &mut HashSet<usize>,
    used_targets: &mut HashSet<String>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    before: &TeacherOptimizationQuality,
    run_seed: u64,
    checked: &mut i64,
    check_limit: i64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
) {
    if *checked > check_limit
        || current_index >= lessons.len()
        || lesson_fixed(&lessons[current_index])
    {
        return;
    }

    let source_key = target_slot_identity(source_slot);
    if !used_targets.contains(&source_key)
        && singleton_chain_lesson_session_allowed(
            lessons,
            current_index,
            source_slot,
            session_index,
        )
    {
        *checked += 1;
        moves.push((current_index, source_slot.clone()));
        consider_singleton_chain_candidate(
            lessons,
            moves,
            off_slots,
            subject_limits,
            before,
            run_seed,
            best,
        );
        moves.pop();
    }

    if depth_remaining == 0 || *checked > check_limit {
        return;
    }

    let Some(current_slot) = lesson_slot(&lessons[current_index]) else {
        return;
    };
    let mut next_slots = singleton_chain_candidate_slots(
        lessons,
        class_id,
        current_index,
        class_slots,
        session_index,
        &current_slot,
        used_targets,
        run_seed,
    );
    let branch_limit = if depth_remaining >= 5 { 24 } else { 14 };
    next_slots.truncate(branch_limit);

    for next_slot in next_slots {
        if *checked > check_limit {
            break;
        }
        if same_slot(&next_slot, source_slot) {
            continue;
        }
        let next_key = target_slot_identity(&next_slot);
        if used_targets.contains(&next_key) {
            continue;
        }
        let occupant = class_slot_occupant(lessons, class_id, &next_slot);
        moves.push((current_index, next_slot.clone()));
        used_targets.insert(next_key.clone());
        match occupant {
            Some(next_index) => {
                if !used_indices.contains(&next_index) && !lesson_fixed(&lessons[next_index]) {
                    used_indices.insert(next_index);
                    search_singleton_class_chain(
                        lessons,
                        class_id,
                        source_slot,
                        next_index,
                        class_slots,
                        session_index,
                        depth_remaining.saturating_sub(1),
                        moves,
                        used_indices,
                        used_targets,
                        off_slots,
                        subject_limits,
                        before,
                        run_seed,
                        checked,
                        check_limit,
                        best,
                    );
                    used_indices.remove(&next_index);
                }
            }
            None => {
                *checked += 1;
                consider_singleton_chain_candidate(
                    lessons,
                    moves,
                    off_slots,
                    subject_limits,
                    before,
                    run_seed,
                    best,
                );
            }
        }
        used_targets.remove(&next_key);
        moves.pop();
    }
}

#[allow(dead_code)]
fn singleton_chain_candidate_slots(
    lessons: &[Value],
    class_id: &str,
    lesson_index: usize,
    class_slots: &[Slot],
    session_index: &HashMap<String, Vec<usize>>,
    current_slot: &Slot,
    used_targets: &HashSet<String>,
    run_seed: u64,
) -> Vec<Slot> {
    let teacher = lesson_teacher_key(&lessons[lesson_index]);
    let mut slots = class_slots
        .iter()
        .filter(|slot| {
            !used_targets.contains(&target_slot_identity(slot))
                && singleton_chain_lesson_session_allowed(
                    lessons,
                    lesson_index,
                    slot,
                    session_index,
                )
        })
        .cloned()
        .collect::<Vec<_>>();
    slots.sort_by(|left, right| {
        let left_key = teacher_session_key(&teacher, left.day, &left.session_key);
        let right_key = teacher_session_key(&teacher, right.day, &right.session_key);
        let left_load = session_index
            .get(&left_key)
            .map(|items| items.len())
            .unwrap_or(0);
        let right_load = session_index
            .get(&right_key)
            .map(|items| items.len())
            .unwrap_or(0);
        let left_empty = class_slot_occupant(lessons, class_id, left).is_none();
        let right_empty = class_slot_occupant(lessons, class_id, right).is_none();
        right_load
            .cmp(&left_load)
            .then_with(|| left_empty.cmp(&right_empty))
            .then_with(|| {
                let left_distance = (left.day - current_slot.day).abs() * 10
                    + if left.session_key == current_slot.session_key {
                        0
                    } else {
                        5
                    }
                    + (left.period_index - current_slot.period_index).abs();
                let right_distance = (right.day - current_slot.day).abs() * 10
                    + if right.session_key == current_slot.session_key {
                        0
                    } else {
                        5
                    }
                    + (right.period_index - current_slot.period_index).abs();
                left_distance.cmp(&right_distance)
            })
            .then_with(|| {
                move_jitter(&lessons[lesson_index], left, run_seed).cmp(&move_jitter(
                    &lessons[lesson_index],
                    right,
                    run_seed,
                ))
            })
    });
    slots
}

fn singleton_chain_lesson_session_allowed(
    lessons: &[Value],
    lesson_index: usize,
    slot: &Slot,
    session_index: &HashMap<String, Vec<usize>>,
) -> bool {
    if lesson_index >= lessons.len() {
        return false;
    }
    let teacher = lesson_teacher_key(&lessons[lesson_index]);
    teacher.is_empty()
        || session_index.contains_key(&teacher_session_key(&teacher, slot.day, &slot.session_key))
}

fn consider_singleton_chain_candidate(
    lessons: &[Value],
    moves: &[(usize, Slot)],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    before: &TeacherOptimizationQuality,
    run_seed: u64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
) {
    let mut candidate = lessons.to_vec();
    for (index, slot) in moves {
        if *index >= candidate.len() {
            return;
        }
        set_lesson_slot(&mut candidate[*index], slot);
    }
    if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
        return;
    }
    let after = teacher_optimization_quality(&candidate);
    if after.one_period_sessions >= before.one_period_sessions
        || after.gap2_plus_sessions > before.gap2_plus_sessions
        || after.teacher_sessions > before.teacher_sessions
    {
        return;
    }
    let jitter = moves
        .iter()
        .map(|(index, slot)| move_jitter(&lessons[*index], slot, run_seed))
        .sum::<i64>();
    let score = after.one_period_sessions * 1_000_000
        + after.gap2_plus_sessions * 100_000
        + after.teacher_sessions * 1_000
        + after.gap1_sessions * 20
        + moves.len() as i64 * 7
        + jitter;
    match best {
        Some((best_score, _)) if *best_score <= score => {}
        _ => *best = Some((score, moves.to_vec())),
    }
}

#[allow(dead_code)]
fn optimize_remaining_singletons_random_walk(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    max_iters: i64,
) -> i64 {
    let start_quality = teacher_optimization_quality(lessons);
    if start_quality.one_period_sessions <= 0 {
        return 0;
    }

    let mut rng = SimpleRng::new(run_seed ^ 0x4f1bbcdc2d9a4c31_u64);
    let mut current = lessons.clone();
    let mut current_quality = start_quality;
    let mut best = current.clone();
    let mut best_quality = current_quality;
    let mut accepted = 0_i64;

    for iter in 0..max_iters {
        if best_quality.one_period_sessions <= 0 {
            break;
        }
        let focus_classes = singleton_focus_classes(&current);
        if focus_classes.is_empty() {
            break;
        }
        let class_id = &focus_classes[(rng.next_u64() as usize) % focus_classes.len()];
        let indices = current
            .iter()
            .enumerate()
            .filter_map(|(index, lesson)| {
                (!lesson_fixed(lesson) && lesson_class_id(lesson) == *class_id).then_some(index)
            })
            .collect::<Vec<_>>();
        if indices.len() < 2 {
            continue;
        }

        let cycle_len = 2 + (rng.next_u64() as usize % 3);
        let cycle_len = cycle_len.min(indices.len());
        let mut chosen = Vec::new();
        let mut guard = 0;
        while chosen.len() < cycle_len && guard < 40 {
            guard += 1;
            let index = indices[(rng.next_u64() as usize) % indices.len()];
            if !chosen.contains(&index) {
                chosen.push(index);
            }
        }
        if chosen.len() < 2 || !cycle_contains_singleton(&current, &chosen) {
            continue;
        }

        let mut slots = Vec::new();
        let mut ok = true;
        for index in &chosen {
            let Some(slot) = lesson_slot(&current[*index]) else {
                ok = false;
                break;
            };
            slots.push(slot);
        }
        if !ok {
            continue;
        }

        let reverse = (rng.next_u64() & 1) == 1;
        let mut candidate = current.clone();
        for pos in 0..chosen.len() {
            let target_pos = if reverse {
                (pos + chosen.len() - 1) % chosen.len()
            } else {
                (pos + 1) % chosen.len()
            };
            set_lesson_slot(&mut candidate[chosen[pos]], &slots[target_pos]);
        }
        if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
            continue;
        }
        let candidate_quality = teacher_optimization_quality(&candidate);
        if candidate_quality.gap2_plus_sessions > best_quality.gap2_plus_sessions
            || candidate_quality.gap2_plus_sessions > start_quality.gap2_plus_sessions
        {
            continue;
        }

        if candidate_quality.teacher_sessions <= start_quality.teacher_sessions
            && teacher_zero_gap_quality_improved(&best_quality, &candidate_quality)
        {
            best = candidate.clone();
            best_quality = candidate_quality;
        }

        let accept = teacher_zero_gap_quality_improved(&current_quality, &candidate_quality)
            || (candidate_quality.one_period_sessions <= current_quality.one_period_sessions
                && candidate_quality.gap2_plus_sessions <= current_quality.gap2_plus_sessions
                && candidate_quality.teacher_sessions <= current_quality.teacher_sessions + 1
                && candidate_quality.gap1_sessions <= current_quality.gap1_sessions + 3
                && (rng.next_u64() % 11 == 0 || iter % 997 == 0));
        if accept {
            current = candidate;
            current_quality = candidate_quality;
            accepted += 1;
        }
    }

    if best_quality.teacher_sessions <= start_quality.teacher_sessions
        && teacher_zero_gap_quality_improved(&start_quality, &best_quality)
    {
        *lessons = best;
        accepted.max(1)
    } else {
        0
    }
}

#[allow(dead_code)]
fn singleton_focus_classes(lessons: &[Value]) -> Vec<String> {
    let mut classes = HashSet::new();
    for indices in teacher_session_index(lessons).values() {
        if indices.len() != 1 {
            continue;
        }
        if let Some(lesson) = lessons.get(indices[0]) {
            let class_id = lesson_class_id(lesson);
            if !class_id.is_empty() {
                classes.insert(class_id);
            }
        }
    }
    let mut out = classes.into_iter().collect::<Vec<_>>();
    out.sort();
    out
}

#[allow(dead_code)]
fn cycle_contains_singleton(lessons: &[Value], indices: &[usize]) -> bool {
    let singleton_indices = teacher_session_index(lessons)
        .values()
        .filter_map(|items| (items.len() == 1).then_some(items[0]))
        .collect::<HashSet<_>>();
    indices
        .iter()
        .any(|index| singleton_indices.contains(index))
}

#[allow(dead_code)]
#[derive(Clone, Copy)]
enum TeacherOptimizationPhase {
    OnePeriod,
    Gap2,
    TeacherSessions,
    Gap1,
}

fn run_teacher_optimization_phase(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    deep_gap_repair: bool,
    phase: TeacherOptimizationPhase,
    clock: &SolveClock,
) -> i64 {
    if clock.should_stop_quality() {
        return 0;
    }
    let before = teacher_optimization_quality(lessons);
    if teacher_phase_done(phase, &before) {
        return 0;
    }

    let mut best: Option<(i64, i64, Vec<Value>)> = None;
    let mut consider = |candidate: Vec<Value>, phase_moves: i64| {
        if phase_moves <= 0 || !schedule_hard_ok(&candidate, off_slots, subject_limits) {
            return;
        }
        let after = teacher_optimization_quality(&candidate);
        if !teacher_phase_improved(phase, &before, &after) {
            return;
        }
        let score = teacher_phase_score(phase, &after) + phase_moves * 17;
        match &best {
            Some((best_score, _, _)) if *best_score <= score => {}
            _ => best = Some((score, phase_moves, candidate)),
        }
    };

    match phase {
        TeacherOptimizationPhase::OnePeriod => {
            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_session_reduction(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                false,
                clock,
            );
            consider(candidate, phase_moves);

            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_global_same_class_swaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                phase,
                clock,
            );
            consider(candidate, phase_moves);

            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_focused_three_cycles(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                phase,
                clock,
            );
            consider(candidate, phase_moves);
        }
        TeacherOptimizationPhase::Gap2 => {
            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_large_gaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                deep_gap_repair,
                clock,
            );
            consider(candidate, phase_moves);

            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_focused_three_cycles(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                phase,
                clock,
            );
            consider(candidate, phase_moves);

            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_global_same_class_swaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                phase,
                clock,
            );
            consider(candidate, phase_moves);
        }
        TeacherOptimizationPhase::TeacherSessions => {
            let mut candidate = lessons.clone();
            let mut phase_moves = optimize_teacher_session_reduction(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                true,
                clock,
            );
            if phase_moves > 0 {
                phase_moves += cleanup_teacher_phase_large_gaps(
                    &mut candidate,
                    off_slots,
                    subject_limits,
                    run_seed,
                    deep_gap_repair,
                    clock,
                );
            }
            consider(candidate, phase_moves);

            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_global_same_class_swaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                phase,
                clock,
            );
            consider(candidate, phase_moves);

            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_focused_three_cycles(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                phase,
                clock,
            );
            consider(candidate, phase_moves);
        }
        TeacherOptimizationPhase::Gap1 => {
            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_single_gaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                clock,
            );
            consider(candidate, phase_moves);

            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_global_same_class_swaps(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                phase,
                clock,
            );
            consider(candidate, phase_moves);

            let mut candidate = lessons.clone();
            let phase_moves = optimize_teacher_focused_three_cycles(
                &mut candidate,
                off_slots,
                subject_limits,
                run_seed,
                phase,
                clock,
            );
            consider(candidate, phase_moves);
        }
    }

    let mut candidate = lessons.clone();
    let phase_moves = optimize_teacher_phase_random_swaps(
        &mut candidate,
        off_slots,
        subject_limits,
        run_seed,
        deep_gap_repair,
        phase,
    );
    consider(candidate, phase_moves);

    let Some((_, phase_moves, candidate)) = best else {
        return 0;
    };
    *lessons = candidate;
    phase_moves
}

fn cleanup_teacher_phase_large_gaps(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    deep_gap_repair: bool,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    for _ in 0..12 {
        if clock.should_stop_quality() {
            break;
        }
        let before = teacher_optimization_quality(lessons);
        if before.one_period_sessions > 0 || before.gap2_plus_sessions == 0 {
            break;
        }
        let phase_moves = optimize_teacher_large_gaps(
            lessons,
            off_slots,
            subject_limits,
            run_seed,
            deep_gap_repair,
            clock,
        );
        if phase_moves == 0 {
            break;
        }
        moves += phase_moves;
    }
    moves
}

fn optimize_teacher_phase_random_swaps(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    deep_gap_repair: bool,
    phase: TeacherOptimizationPhase,
) -> i64 {
    let mut moves = 0_i64;
    let max_moves = match phase {
        TeacherOptimizationPhase::OnePeriod => {
            if deep_gap_repair {
                3
            } else {
                2
            }
        }
        TeacherOptimizationPhase::Gap2 => {
            if deep_gap_repair {
                3
            } else {
                2
            }
        }
        TeacherOptimizationPhase::TeacherSessions | TeacherOptimizationPhase::Gap1 => 0,
    };
    if max_moves == 0 {
        return 0;
    }

    for _ in 0..max_moves {
        let before = teacher_optimization_quality(lessons);
        if teacher_phase_done(phase, &before) {
            break;
        }

        let focus_indices = teacher_phase_focus_indices(lessons, phase);
        if focus_indices.is_empty() {
            break;
        }

        let allowed_sessions = teacher_session_key_set(lessons);
        let mut by_class: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, lesson) in lessons.iter().enumerate() {
            if lesson_fixed(lesson) {
                continue;
            }
            let class_id = lesson_class_id(lesson);
            if class_id.is_empty() {
                continue;
            }
            by_class.entry(class_id).or_default().push(index);
        }

        let mut class_groups = by_class.into_iter().collect::<Vec<_>>();
        class_groups.sort_by(|(left_class, left_indices), (right_class, right_indices)| {
            let left_focus = left_indices
                .iter()
                .filter(|index| focus_indices.contains(index))
                .count();
            let right_focus = right_indices
                .iter()
                .filter(|index| focus_indices.contains(index))
                .count();
            right_focus
                .cmp(&left_focus)
                .then_with(|| {
                    class_jitter(left_class, run_seed).cmp(&class_jitter(right_class, run_seed))
                })
                .then_with(|| left_class.cmp(right_class))
        });

        let mut best: Option<(i64, usize, usize, Slot, Slot)> = None;
        let mut checked = 0_i64;
        let check_limit = (focus_indices.len() as i64 * 45).clamp(250, 1_200);

        for (_, mut indices) in class_groups {
            if !indices.iter().any(|index| focus_indices.contains(index)) {
                continue;
            }
            indices.sort_by(|left, right| {
                let left_focus = focus_indices.contains(left);
                let right_focus = focus_indices.contains(right);
                right_focus
                    .cmp(&left_focus)
                    .then_with(|| {
                        lesson_jitter(&lessons[*left], run_seed)
                            .cmp(&lesson_jitter(&lessons[*right], run_seed))
                    })
                    .then_with(|| left.cmp(right))
            });
            indices.truncate(if deep_gap_repair { 14 } else { 10 });

            for left_pos in 0..indices.len() {
                for right_pos in (left_pos + 1)..indices.len() {
                    checked += 1;
                    if checked > check_limit {
                        break;
                    }
                    let left = indices[left_pos];
                    let right = indices[right_pos];
                    let Some(left_slot) = lesson_slot(&lessons[left]) else {
                        continue;
                    };
                    let Some(right_slot) = lesson_slot(&lessons[right]) else {
                        continue;
                    };
                    if same_slot(&left_slot, &right_slot) {
                        continue;
                    }

                    let mut candidate = lessons.clone();
                    set_lesson_slot(&mut candidate[left], &right_slot);
                    set_lesson_slot(&mut candidate[right], &left_slot);
                    if !schedule_hard_ok(&candidate, off_slots, subject_limits)
                        || !teacher_sessions_subset(&candidate, &allowed_sessions)
                    {
                        continue;
                    }
                    let after = teacher_optimization_quality(&candidate);
                    if !teacher_phase_improved(phase, &before, &after) {
                        continue;
                    }
                    let score = teacher_phase_score(phase, &after)
                        + move_jitter(&lessons[left], &right_slot, run_seed)
                        + move_jitter(&lessons[right], &left_slot, run_seed);
                    match &best {
                        Some((best_score, _, _, _, _)) if *best_score <= score => {}
                        _ => best = Some((score, left, right, right_slot, left_slot)),
                    }
                }
                if checked > check_limit {
                    break;
                }
            }
            if checked > check_limit {
                break;
            }
        }

        let Some((_, left, right, left_target, right_target)) = best else {
            break;
        };
        set_lesson_slot(&mut lessons[left], &left_target);
        set_lesson_slot(&mut lessons[right], &right_target);
        moves += 1;
    }

    moves
}

fn optimize_teacher_global_same_class_swaps(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    phase: TeacherOptimizationPhase,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    let max_moves = 24_i64;
    for _ in 0..max_moves {
        if clock.should_stop_quality() {
            break;
        }
        let before = teacher_optimization_quality(lessons);
        if teacher_phase_done(phase, &before) {
            break;
        }
        let allowed_sessions = teacher_session_key_set(lessons);
        let mut by_class: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, lesson) in lessons.iter().enumerate() {
            if lesson_fixed(lesson) {
                continue;
            }
            let class_id = lesson_class_id(lesson);
            if class_id.is_empty() {
                continue;
            }
            by_class.entry(class_id).or_default().push(index);
        }

        let mut best: Option<(i64, usize, usize, Slot, Slot)> = None;
        'class_pairs: for indices in by_class.values() {
            for left_pos in 0..indices.len() {
                for right_pos in (left_pos + 1)..indices.len() {
                    if clock.should_stop_quality() {
                        break 'class_pairs;
                    }
                    let left = indices[left_pos];
                    let right = indices[right_pos];
                    let Some(left_slot) = lesson_slot(&lessons[left]) else {
                        continue;
                    };
                    let Some(right_slot) = lesson_slot(&lessons[right]) else {
                        continue;
                    };
                    if same_slot(&left_slot, &right_slot) {
                        continue;
                    }

                    let mut candidate = lessons.clone();
                    set_lesson_slot(&mut candidate[left], &right_slot);
                    set_lesson_slot(&mut candidate[right], &left_slot);
                    if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                        continue;
                    }
                    if !teacher_sessions_subset(&candidate, &allowed_sessions) {
                        continue;
                    }

                    let after = teacher_optimization_quality(&candidate);
                    if !teacher_phase_improved(phase, &before, &after) {
                        continue;
                    }
                    let score = teacher_phase_score(phase, &after)
                        + move_jitter(&lessons[left], &right_slot, run_seed)
                        + move_jitter(&lessons[right], &left_slot, run_seed);
                    match &best {
                        Some((best_score, _, _, _, _)) if *best_score <= score => {}
                        _ => best = Some((score, left, right, right_slot, left_slot)),
                    }
                }
            }
        }

        let Some((_, left, right, left_target, right_target)) = best else {
            break;
        };
        set_lesson_slot(&mut lessons[left], &left_target);
        set_lesson_slot(&mut lessons[right], &right_target);
        moves += 1;
    }
    moves
}

fn optimize_teacher_focused_three_cycles(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    phase: TeacherOptimizationPhase,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    let max_moves = 6_i64;
    for _ in 0..max_moves {
        if clock.should_stop_quality() {
            break;
        }
        let before = teacher_optimization_quality(lessons);
        if teacher_phase_done(phase, &before) {
            break;
        }

        let allowed_sessions = teacher_session_key_set(lessons);
        let session_index = teacher_session_index(lessons);
        let mut by_class: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, lesson) in lessons.iter().enumerate() {
            if lesson_fixed(lesson) {
                continue;
            }
            let class_id = lesson_class_id(lesson);
            if class_id.is_empty() {
                continue;
            }
            by_class.entry(class_id).or_default().push(index);
        }

        let mut best: Option<(i64, Vec<(usize, Slot)>)> = None;
        let mut checked = 0_i64;
        let check_limit = 1_800_i64;

        let mut singletons = session_index
            .iter()
            .filter_map(|(key, indices)| (indices.len() == 1).then(|| (key.clone(), indices[0])))
            .collect::<Vec<_>>();
        singletons.sort_by(|(left_key, _), (right_key, _)| {
            teacher_session_jitter(left_key, run_seed)
                .cmp(&teacher_session_jitter(right_key, run_seed))
                .then_with(|| left_key.cmp(right_key))
        });

        for (singleton_key, singleton_index) in singletons {
            if clock.should_stop_quality() {
                break;
            }
            if singleton_index >= lessons.len() || lesson_fixed(&lessons[singleton_index]) {
                continue;
            }
            let teacher = lesson_teacher_key(&lessons[singleton_index]);
            let class_id = lesson_class_id(&lessons[singleton_index]);
            let Some(class_indices) = by_class.get(&class_id) else {
                continue;
            };

            let mut target_indices = class_indices
                .iter()
                .copied()
                .filter(|target_index| {
                    *target_index != singleton_index && *target_index < lessons.len()
                })
                .filter(|target_index| {
                    let Some(target_slot) = lesson_slot(&lessons[*target_index]) else {
                        return false;
                    };
                    let target_session =
                        teacher_session_key(&teacher, target_slot.day, &target_slot.session_key);
                    target_session != singleton_key && allowed_sessions.contains(&target_session)
                })
                .collect::<Vec<_>>();
            target_indices.sort_by(|left, right| {
                let left_score = lesson_slot(&lessons[*left])
                    .map(|slot| move_jitter(&lessons[*left], &slot, run_seed))
                    .unwrap_or(0);
                let right_score = lesson_slot(&lessons[*right])
                    .map(|slot| move_jitter(&lessons[*right], &slot, run_seed))
                    .unwrap_or(0);
                left_score.cmp(&right_score).then_with(|| left.cmp(right))
            });
            target_indices.truncate(12);

            for target_index in target_indices {
                if checked >= check_limit || clock.should_stop_quality() {
                    break;
                }
                if target_index >= lessons.len() {
                    continue;
                }
                consider_focused_three_cycle(
                    lessons,
                    singleton_index,
                    target_index,
                    class_indices,
                    off_slots,
                    subject_limits,
                    &allowed_sessions,
                    &before,
                    phase,
                    run_seed,
                    &mut best,
                    &mut checked,
                    check_limit,
                    clock,
                );
            }
            if checked >= check_limit || clock.should_stop_quality() {
                break;
            }

            let Some((target_teacher, target_day, target_session)) =
                parse_teacher_session_key(&singleton_key)
            else {
                continue;
            };
            let mut source_indices = lessons
                .iter()
                .enumerate()
                .filter_map(|(source_index, lesson)| {
                    (source_index != singleton_index
                        && !lesson_fixed(lesson)
                        && lesson_teacher_key(lesson) == target_teacher)
                        .then_some(source_index)
                })
                .collect::<Vec<_>>();
            source_indices.sort_by(|left, right| {
                let left_score = lesson_slot(&lessons[*left])
                    .map(|slot| move_jitter(&lessons[*left], &slot, run_seed))
                    .unwrap_or(0);
                let right_score = lesson_slot(&lessons[*right])
                    .map(|slot| move_jitter(&lessons[*right], &slot, run_seed))
                    .unwrap_or(0);
                left_score.cmp(&right_score).then_with(|| left.cmp(right))
            });
            source_indices.truncate(12);

            for source_index in source_indices {
                if checked >= check_limit || clock.should_stop_quality() {
                    break;
                }
                let source_class = lesson_class_id(&lessons[source_index]);
                let Some(source_class_indices) = by_class.get(&source_class) else {
                    continue;
                };
                for period_index in 0..PERIODS_PER_SESSION {
                    if checked >= check_limit || clock.should_stop_quality() {
                        break;
                    }
                    let target_slot = make_slot(target_day, &target_session, period_index);
                    let Some(target_index) =
                        class_slot_occupant(lessons, &source_class, &target_slot)
                    else {
                        continue;
                    };
                    if target_index == source_index || lesson_fixed(&lessons[target_index]) {
                        continue;
                    }
                    consider_focused_three_cycle(
                        lessons,
                        source_index,
                        target_index,
                        source_class_indices,
                        off_slots,
                        subject_limits,
                        &allowed_sessions,
                        &before,
                        phase,
                        run_seed,
                        &mut best,
                        &mut checked,
                        check_limit,
                        clock,
                    );
                }
            }
            if checked >= check_limit || clock.should_stop_quality() {
                break;
            }
        }
        if checked >= check_limit || clock.should_stop_quality() {
            if let Some((_, best_moves)) = best {
                for (index, slot) in best_moves {
                    set_lesson_slot(&mut lessons[index], &slot);
                }
                moves += 1;
                continue;
            }
            break;
        }

        let mut gap_sessions = teacher_gap_sessions(lessons)
            .into_iter()
            .filter(|session| session.gaps > 0)
            .collect::<Vec<_>>();
        gap_sessions.sort_by(|left, right| {
            right
                .gaps
                .cmp(&left.gaps)
                .then_with(|| {
                    teacher_session_jitter(&left.key, run_seed)
                        .cmp(&teacher_session_jitter(&right.key, run_seed))
                })
                .then_with(|| left.key.cmp(&right.key))
        });
        gap_sessions.truncate(10);

        for gap_session in gap_sessions {
            if checked >= check_limit || clock.should_stop_quality() {
                break;
            }
            let Some((target_teacher, _, _)) = parse_teacher_session_key(&gap_session.key) else {
                continue;
            };
            let mut source_indices = gap_session.indices.clone();
            for (index, lesson) in lessons.iter().enumerate() {
                if lesson_fixed(lesson)
                    || lesson_teacher_key(lesson) != target_teacher
                    || gap_session.indices.contains(&index)
                {
                    continue;
                }
                source_indices.push(index);
            }
            source_indices.sort_by(|left, right| {
                let left_in_gap = gap_session.indices.contains(left);
                let right_in_gap = gap_session.indices.contains(right);
                right_in_gap
                    .cmp(&left_in_gap)
                    .then_with(|| {
                        let left_score = lesson_slot(&lessons[*left])
                            .map(|slot| move_jitter(&lessons[*left], &slot, run_seed))
                            .unwrap_or(0);
                        let right_score = lesson_slot(&lessons[*right])
                            .map(|slot| move_jitter(&lessons[*right], &slot, run_seed))
                            .unwrap_or(0);
                        left_score.cmp(&right_score)
                    })
                    .then_with(|| left.cmp(right))
            });
            source_indices.truncate(10);

            for source_index in source_indices {
                if checked >= check_limit || clock.should_stop_quality() {
                    break;
                }
                if source_index >= lessons.len() || lesson_fixed(&lessons[source_index]) {
                    continue;
                }
                let source_class = lesson_class_id(&lessons[source_index]);
                let Some(class_indices) = by_class.get(&source_class) else {
                    continue;
                };
                for target_period in &gap_session.gap_slots {
                    if checked >= check_limit || clock.should_stop_quality() {
                        break;
                    }
                    let target_slot =
                        make_slot(gap_session.day, &gap_session.session_key, *target_period);
                    let Some(target_index) =
                        class_slot_occupant(lessons, &source_class, &target_slot)
                    else {
                        continue;
                    };
                    if target_index == source_index || lesson_fixed(&lessons[target_index]) {
                        continue;
                    }
                    consider_focused_three_cycle(
                        lessons,
                        source_index,
                        target_index,
                        class_indices,
                        off_slots,
                        subject_limits,
                        &allowed_sessions,
                        &before,
                        phase,
                        run_seed,
                        &mut best,
                        &mut checked,
                        check_limit,
                        clock,
                    );
                }
            }
        }

        let Some((_, best_moves)) = best else {
            break;
        };
        for (index, slot) in best_moves {
            set_lesson_slot(&mut lessons[index], &slot);
        }
        moves += 1;
    }
    moves
}

fn consider_focused_three_cycle(
    lessons: &[Value],
    source_index: usize,
    target_index: usize,
    class_indices: &[usize],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    allowed_sessions: &HashSet<String>,
    before: &TeacherOptimizationQuality,
    phase: TeacherOptimizationPhase,
    run_seed: u64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
    checked: &mut i64,
    check_limit: i64,
    clock: &SolveClock,
) {
    if clock.should_stop_quality() {
        return;
    }
    if source_index >= lessons.len()
        || target_index >= lessons.len()
        || source_index == target_index
        || lesson_fixed(&lessons[source_index])
        || lesson_fixed(&lessons[target_index])
    {
        return;
    }
    let source_class = lesson_class_id(&lessons[source_index]);
    if source_class.is_empty() || lesson_class_id(&lessons[target_index]) != source_class {
        return;
    }
    let Some(source_slot) = lesson_slot(&lessons[source_index]) else {
        return;
    };
    let Some(target_slot) = lesson_slot(&lessons[target_index]) else {
        return;
    };
    if same_slot(&source_slot, &target_slot) {
        return;
    }

    let mut third_indices = class_indices
        .iter()
        .copied()
        .filter(|third_index| {
            *third_index < lessons.len()
                && *third_index != source_index
                && *third_index != target_index
                && !lesson_fixed(&lessons[*third_index])
        })
        .collect::<Vec<_>>();
    third_indices.sort_by(|left, right| {
        let left_score = lesson_slot(&lessons[*left])
            .map(|slot| move_jitter(&lessons[*left], &slot, run_seed))
            .unwrap_or(0);
        let right_score = lesson_slot(&lessons[*right])
            .map(|slot| move_jitter(&lessons[*right], &slot, run_seed))
            .unwrap_or(0);
        left_score.cmp(&right_score).then_with(|| left.cmp(right))
    });
    third_indices.truncate(8);

    for third_index in third_indices {
        if *checked >= check_limit || clock.should_stop_quality() {
            break;
        }
        if third_index >= lessons.len()
            || third_index == source_index
            || third_index == target_index
            || lesson_fixed(&lessons[third_index])
        {
            continue;
        }
        let Some(third_slot) = lesson_slot(&lessons[third_index]) else {
            continue;
        };
        if same_slot(&third_slot, &source_slot) || same_slot(&third_slot, &target_slot) {
            continue;
        }

        let moves = vec![
            (source_index, target_slot.clone()),
            (target_index, third_slot.clone()),
            (third_index, source_slot.clone()),
        ];
        *checked += 1;
        consider_focused_move_candidate(
            lessons,
            &moves,
            off_slots,
            subject_limits,
            allowed_sessions,
            before,
            phase,
            run_seed,
            best,
        );

        let reverse_moves = vec![
            (source_index, third_slot.clone()),
            (third_index, target_slot.clone()),
            (target_index, source_slot.clone()),
        ];
        *checked += 1;
        consider_focused_move_candidate(
            lessons,
            &reverse_moves,
            off_slots,
            subject_limits,
            allowed_sessions,
            before,
            phase,
            run_seed,
            best,
        );
    }
}

fn consider_focused_move_candidate(
    lessons: &[Value],
    moves: &[(usize, Slot)],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    allowed_sessions: &HashSet<String>,
    before: &TeacherOptimizationQuality,
    phase: TeacherOptimizationPhase,
    run_seed: u64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
) {
    let mut candidate = lessons.to_vec();
    for (index, slot) in moves {
        if *index >= candidate.len() {
            return;
        }
        set_lesson_slot(&mut candidate[*index], slot);
    }
    if !schedule_hard_ok(&candidate, off_slots, subject_limits)
        || !teacher_sessions_subset(&candidate, allowed_sessions)
    {
        return;
    }
    let after = teacher_optimization_quality(&candidate);
    if !teacher_phase_improved(phase, before, &after) {
        return;
    }
    let jitter = moves
        .iter()
        .map(|(index, slot)| move_jitter(&lessons[*index], slot, run_seed))
        .sum::<i64>();
    let score = teacher_phase_score(phase, &after) + moves.len() as i64 * 25 + jitter;
    match best {
        Some((best_score, _)) if *best_score <= score => {}
        _ => *best = Some((score, moves.to_vec())),
    }
}

#[allow(dead_code)]
fn optimize_teacher_global_same_class_cycles(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
) -> i64 {
    let mut moves = 0_i64;
    let max_moves = 4_i64;
    for _ in 0..max_moves {
        let before = teacher_optimization_quality(lessons);
        if before.one_period_sessions == 0 && before.total_gap == 0 {
            break;
        }

        let focus_indices = teacher_quality_focus_indices(lessons);
        if focus_indices.is_empty() {
            break;
        }

        let allowed_sessions = teacher_session_key_set(lessons);
        let mut by_class: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, lesson) in lessons.iter().enumerate() {
            if lesson_fixed(lesson) {
                continue;
            }
            let class_id = lesson_class_id(lesson);
            if class_id.is_empty() {
                continue;
            }
            by_class.entry(class_id).or_default().push(index);
        }

        let mut class_groups = by_class.into_iter().collect::<Vec<_>>();
        class_groups.sort_by(|(left_class, left_indices), (right_class, right_indices)| {
            let left_focus = left_indices
                .iter()
                .filter(|index| focus_indices.contains(index))
                .count();
            let right_focus = right_indices
                .iter()
                .filter(|index| focus_indices.contains(index))
                .count();
            right_focus
                .cmp(&left_focus)
                .then_with(|| left_indices.len().cmp(&right_indices.len()))
                .then_with(|| left_class.cmp(right_class))
        });

        let mut best: Option<(i64, Vec<(usize, Slot)>)> = None;
        let mut checked = 0_i64;
        let check_limit = (focus_indices.len() as i64 * 60).clamp(300, 1_500);

        for (_, mut indices) in class_groups {
            if !indices.iter().any(|index| focus_indices.contains(index)) {
                continue;
            }
            indices.sort_by(|left, right| {
                let left_focus = focus_indices.contains(left);
                let right_focus = focus_indices.contains(right);
                right_focus
                    .cmp(&left_focus)
                    .then_with(|| {
                        let left_score = lesson_slot(&lessons[*left])
                            .map(|slot| move_jitter(&lessons[*left], &slot, run_seed))
                            .unwrap_or(0);
                        let right_score = lesson_slot(&lessons[*right])
                            .map(|slot| move_jitter(&lessons[*right], &slot, run_seed))
                            .unwrap_or(0);
                        left_score.cmp(&right_score)
                    })
                    .then_with(|| left.cmp(right))
            });
            indices.truncate(14);

            let len = indices.len();
            for a_pos in 0..len {
                for b_pos in (a_pos + 1)..len {
                    for c_pos in (b_pos + 1)..len {
                        checked += 1;
                        if checked > check_limit {
                            break;
                        }
                        let triple = [indices[a_pos], indices[b_pos], indices[c_pos]];
                        if !triple.iter().any(|index| focus_indices.contains(index)) {
                            continue;
                        }
                        consider_same_class_cycle_candidate(
                            lessons,
                            &triple,
                            false,
                            off_slots,
                            subject_limits,
                            &allowed_sessions,
                            &before,
                            run_seed,
                            &mut best,
                        );
                        consider_same_class_cycle_candidate(
                            lessons,
                            &triple,
                            true,
                            off_slots,
                            subject_limits,
                            &allowed_sessions,
                            &before,
                            run_seed,
                            &mut best,
                        );
                    }
                    if checked > check_limit {
                        break;
                    }
                }
                if checked > check_limit {
                    break;
                }
            }

            if checked > check_limit {
                break;
            }
        }

        let Some((_, best_moves)) = best else {
            break;
        };
        for (index, slot) in best_moves {
            set_lesson_slot(&mut lessons[index], &slot);
        }
        moves += 1;
    }
    moves
}

#[allow(dead_code)]
fn teacher_quality_focus_indices(lessons: &[Value]) -> HashSet<usize> {
    let mut focus = HashSet::new();
    let session_index = teacher_session_index(lessons);
    for indices in session_index.values() {
        if indices.len() == 1 {
            for index in indices {
                focus.insert(*index);
            }
        }
    }
    for session in teacher_gap_sessions(lessons) {
        if session.gaps > 0 {
            for index in session.indices {
                focus.insert(index);
            }
        }
    }
    focus
}

fn teacher_phase_focus_indices(
    lessons: &[Value],
    phase: TeacherOptimizationPhase,
) -> HashSet<usize> {
    let mut focus = HashSet::new();
    let session_index = teacher_session_index(lessons);
    match phase {
        TeacherOptimizationPhase::OnePeriod => {
            for indices in session_index.values() {
                if indices.len() == 1 {
                    for index in indices {
                        focus.insert(*index);
                    }
                }
            }
        }
        TeacherOptimizationPhase::Gap2 => {
            for session in teacher_gap_sessions(lessons) {
                if session.gaps >= 2 {
                    for index in session.indices {
                        focus.insert(index);
                    }
                }
            }
        }
        TeacherOptimizationPhase::TeacherSessions => {
            for indices in session_index.values() {
                if (2..=3).contains(&indices.len()) {
                    for index in indices {
                        focus.insert(*index);
                    }
                }
            }
        }
        TeacherOptimizationPhase::Gap1 => {
            for session in teacher_gap_sessions(lessons) {
                if session.gaps == 1 {
                    for index in session.indices {
                        focus.insert(index);
                    }
                }
            }
        }
    }
    if focus.is_empty() {
        teacher_quality_focus_indices(lessons)
    } else {
        focus
    }
}

#[allow(dead_code)]
fn consider_same_class_cycle_candidate<const N: usize>(
    lessons: &[Value],
    indices: &[usize; N],
    reverse: bool,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    allowed_sessions: &HashSet<String>,
    before: &TeacherOptimizationQuality,
    run_seed: u64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
) {
    if N < 3 {
        return;
    }
    let mut seen = HashSet::new();
    let mut slots = Vec::new();
    let mut class_id = String::new();
    for index in indices {
        if *index >= lessons.len() || lesson_fixed(&lessons[*index]) || !seen.insert(*index) {
            return;
        }
        let lesson_class = lesson_class_id(&lessons[*index]);
        if lesson_class.is_empty() {
            return;
        }
        if class_id.is_empty() {
            class_id = lesson_class;
        } else if class_id != lesson_class {
            return;
        }
        let Some(slot) = lesson_slot(&lessons[*index]) else {
            return;
        };
        slots.push(slot);
    }

    let mut moves = Vec::new();
    for pos in 0..N {
        let target_pos = if reverse {
            (pos + N - 1) % N
        } else {
            (pos + 1) % N
        };
        moves.push((indices[pos], slots[target_pos].clone()));
    }

    let mut candidate = lessons.to_vec();
    for (index, slot) in &moves {
        set_lesson_slot(&mut candidate[*index], slot);
    }
    if !schedule_hard_ok(&candidate, off_slots, subject_limits)
        || !teacher_sessions_subset(&candidate, allowed_sessions)
    {
        return;
    }

    let after = teacher_optimization_quality(&candidate);
    if !teacher_zero_gap_quality_improved(before, &after) {
        return;
    }

    let jitter = moves
        .iter()
        .map(|(index, slot)| move_jitter(&lessons[*index], slot, run_seed))
        .sum::<i64>();
    let score = teacher_zero_gap_quality_score(&after) + moves.len() as i64 * 25 + jitter;
    match best {
        Some((best_score, _)) if *best_score <= score => {}
        _ => *best = Some((score, moves)),
    }
}

#[derive(Clone, Copy)]
struct TeacherOptimizationQuality {
    one_period_sessions: i64,
    teacher_sessions: i64,
    gap2_plus_sessions: i64,
    gap1_sessions: i64,
    total_gap: i64,
}

fn teacher_optimization_quality(lessons: &[Value]) -> TeacherOptimizationQuality {
    let gap_metrics = teacher_gap_metrics(lessons);
    TeacherOptimizationQuality {
        one_period_sessions: count_one_period_teacher_sessions(lessons),
        teacher_sessions: count_teacher_sessions(lessons),
        gap2_plus_sessions: gap_metrics.gap2_plus_sessions,
        gap1_sessions: gap_metrics.distribution.get("1").copied().unwrap_or(0),
        total_gap: gap_metrics.total_gap,
    }
}

fn two_stage_quality_key(value: &TeacherOptimizationQuality) -> [i64; 4] {
    [
        value.one_period_sessions,
        value.teacher_sessions,
        value.gap2_plus_sessions,
        value.total_gap,
    ]
}

fn two_stage_session_phase_acceptable(
    before: &TeacherOptimizationQuality,
    after: &TeacherOptimizationQuality,
) -> bool {
    after.one_period_sessions <= before.one_period_sessions
        && after.teacher_sessions < before.teacher_sessions
}

fn two_stage_cleanup_acceptable(
    before: &TeacherOptimizationQuality,
    after: &TeacherOptimizationQuality,
) -> bool {
    after.one_period_sessions <= before.one_period_sessions
        && after.teacher_sessions <= before.teacher_sessions
        && two_stage_quality_key(after) <= two_stage_quality_key(before)
}

fn automatic_two_stage_final_acceptable(
    before: &TeacherOptimizationQuality,
    after: &TeacherOptimizationQuality,
) -> bool {
    after.one_period_sessions <= before.one_period_sessions
        && (before.one_period_sessions != 0 || after.one_period_sessions == 0)
        && after.teacher_sessions <= before.teacher_sessions
        && after.gap2_plus_sessions <= before.gap2_plus_sessions
}

fn focused_agent_candidate_acceptable(
    focus: OptimizationFocus,
    two_stage_teacher_quality: bool,
    before: &TeacherOptimizationQuality,
    after: &TeacherOptimizationQuality,
) -> bool {
    match focus {
        OptimizationFocus::Automatic if two_stage_teacher_quality => {
            automatic_two_stage_final_acceptable(before, after)
        }
        OptimizationFocus::QuickComplete | OptimizationFocus::Singletons => {
            after.one_period_sessions <= before.one_period_sessions
                && after.teacher_sessions <= before.teacher_sessions
                && (after.one_period_sessions < before.one_period_sessions
                    || two_stage_quality_key(after) <= two_stage_quality_key(before))
        }
        OptimizationFocus::Sessions => {
            after.one_period_sessions <= before.one_period_sessions
                && after.teacher_sessions <= before.teacher_sessions
                && (after.one_period_sessions < before.one_period_sessions
                    || after.teacher_sessions < before.teacher_sessions
                    || (
                        after.gap2_plus_sessions,
                        after.gap1_sessions,
                        after.total_gap,
                    ) <= (
                        before.gap2_plus_sessions,
                        before.gap1_sessions,
                        before.total_gap,
                    ))
        }
        OptimizationFocus::Gaps => {
            after.one_period_sessions <= before.one_period_sessions
                && after.teacher_sessions <= before.teacher_sessions
                && (
                    after.gap2_plus_sessions,
                    after.gap1_sessions,
                    after.total_gap,
                ) <= (
                    before.gap2_plus_sessions,
                    before.gap1_sessions,
                    before.total_gap,
                )
        }
        _ => true,
    }
}

fn teacher_phase_done(phase: TeacherOptimizationPhase, value: &TeacherOptimizationQuality) -> bool {
    match phase {
        TeacherOptimizationPhase::OnePeriod => value.one_period_sessions <= 0,
        TeacherOptimizationPhase::Gap2 => {
            value.one_period_sessions > 0 || value.gap2_plus_sessions <= 0
        }
        TeacherOptimizationPhase::TeacherSessions => value.one_period_sessions > 0,
        TeacherOptimizationPhase::Gap1 => {
            value.one_period_sessions > 0
                || value.gap2_plus_sessions > 0
                || value.gap1_sessions <= 0
        }
    }
}

fn teacher_phase_improved(
    phase: TeacherOptimizationPhase,
    before: &TeacherOptimizationQuality,
    after: &TeacherOptimizationQuality,
) -> bool {
    match phase {
        TeacherOptimizationPhase::OnePeriod => {
            after.one_period_sessions < before.one_period_sessions
                && after.teacher_sessions <= before.teacher_sessions
        }
        TeacherOptimizationPhase::Gap2 => {
            after.one_period_sessions == before.one_period_sessions
                && after.teacher_sessions <= before.teacher_sessions
                && after.gap2_plus_sessions < before.gap2_plus_sessions
        }
        TeacherOptimizationPhase::TeacherSessions => {
            after.one_period_sessions == before.one_period_sessions
                && after.teacher_sessions < before.teacher_sessions
        }
        TeacherOptimizationPhase::Gap1 => {
            after.one_period_sessions == before.one_period_sessions
                && after.gap2_plus_sessions == before.gap2_plus_sessions
                && after.teacher_sessions <= before.teacher_sessions
                && (after.gap1_sessions < before.gap1_sessions
                    || (after.gap1_sessions == before.gap1_sessions
                        && after.total_gap < before.total_gap))
        }
    }
}

fn teacher_phase_score(phase: TeacherOptimizationPhase, value: &TeacherOptimizationQuality) -> i64 {
    match phase {
        TeacherOptimizationPhase::OnePeriod => {
            value.one_period_sessions * 1_000_000_000
                + value.gap2_plus_sessions * 10_000_000
                + value.teacher_sessions * 100_000
                + value.gap1_sessions * 1_000
                + value.total_gap
        }
        TeacherOptimizationPhase::Gap2 => {
            value.one_period_sessions * 1_000_000_000
                + value.gap2_plus_sessions * 10_000_000
                + value.teacher_sessions * 100_000
                + value.gap1_sessions * 1_000
                + value.total_gap
        }
        TeacherOptimizationPhase::TeacherSessions => {
            value.one_period_sessions * 1_000_000_000
                + value.gap2_plus_sessions * 10_000_000
                + value.teacher_sessions * 100_000
                + value.gap1_sessions * 1_000
                + value.total_gap
        }
        TeacherOptimizationPhase::Gap1 => {
            value.one_period_sessions * 1_000_000_000
                + value.gap2_plus_sessions * 10_000_000
                + value.gap1_sessions * 100_000
                + value.total_gap * 1_000
                + value.teacher_sessions
        }
    }
}

fn teacher_optimization_improved(
    before: &TeacherOptimizationQuality,
    after: &TeacherOptimizationQuality,
) -> bool {
    after.one_period_sessions < before.one_period_sessions
        || (after.one_period_sessions == before.one_period_sessions
            && after.gap2_plus_sessions < before.gap2_plus_sessions)
        || (after.one_period_sessions == before.one_period_sessions
            && after.gap2_plus_sessions == before.gap2_plus_sessions
            && after.teacher_sessions < before.teacher_sessions)
        || (after.one_period_sessions == before.one_period_sessions
            && after.gap2_plus_sessions == before.gap2_plus_sessions
            && after.teacher_sessions == before.teacher_sessions
            && after.gap1_sessions < before.gap1_sessions)
        || (after.one_period_sessions == before.one_period_sessions
            && after.gap2_plus_sessions == before.gap2_plus_sessions
            && after.teacher_sessions == before.teacher_sessions
            && after.gap1_sessions == before.gap1_sessions
            && after.total_gap < before.total_gap)
}

#[allow(dead_code)]
fn teacher_quality_score(value: &TeacherOptimizationQuality) -> i64 {
    value.one_period_sessions * 1_000_000_000
        + value.gap2_plus_sessions * 10_000_000
        + value.teacher_sessions * 100_000
        + value.gap1_sessions * 1_000
        + value.total_gap
}

fn teacher_zero_gap_quality_improved(
    before: &TeacherOptimizationQuality,
    after: &TeacherOptimizationQuality,
) -> bool {
    after.one_period_sessions < before.one_period_sessions
        || (after.one_period_sessions == before.one_period_sessions
            && after.gap2_plus_sessions < before.gap2_plus_sessions)
        || (after.one_period_sessions == before.one_period_sessions
            && after.gap2_plus_sessions == before.gap2_plus_sessions
            && after.gap1_sessions < before.gap1_sessions)
        || (after.one_period_sessions == before.one_period_sessions
            && after.gap2_plus_sessions == before.gap2_plus_sessions
            && after.gap1_sessions == before.gap1_sessions
            && after.total_gap < before.total_gap)
        || (after.one_period_sessions == before.one_period_sessions
            && after.gap2_plus_sessions == before.gap2_plus_sessions
            && after.gap1_sessions == before.gap1_sessions
            && after.total_gap == before.total_gap
            && after.teacher_sessions < before.teacher_sessions)
}

fn teacher_zero_gap_quality_score(value: &TeacherOptimizationQuality) -> i64 {
    value.one_period_sessions * 1_000_000_000
        + value.gap2_plus_sessions * 10_000_000
        + value.gap1_sessions * 100_000
        + value.total_gap * 1_000
        + value.teacher_sessions * 10
}

fn optimize_teacher_session_reduction(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    allow_small_session_merge: bool,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    let max_moves = (lessons.len() * 8).max(1);
    for _ in 0..max_moves {
        if clock.should_stop_quality() {
            break;
        }
        if allow_small_session_merge
            && try_merge_small_teacher_session(lessons, off_slots, subject_limits, run_seed, clock)
        {
            moves += 1;
            continue;
        }

        let session_index = teacher_session_index(lessons);
        let mut singletons = session_index
            .iter()
            .filter_map(|(key, indices)| (indices.len() == 1).then(|| key.clone()))
            .collect::<Vec<_>>();
        singletons.sort_by(|a, b| {
            teacher_session_jitter(a, run_seed)
                .cmp(&teacher_session_jitter(b, run_seed))
                .then_with(|| a.cmp(b))
        });

        let mut moved = false;
        for session_key in singletons {
            if clock.should_stop_quality() {
                break;
            }
            let fresh_index = teacher_session_index(lessons);
            let Some(indices) = fresh_index.get(&session_key) else {
                continue;
            };
            if indices.len() != 1 {
                continue;
            }
            let singleton_idx = indices[0];
            if try_move_singleton_out(
                lessons,
                singleton_idx,
                &session_key,
                &fresh_index,
                off_slots,
                subject_limits,
                run_seed,
            ) || try_swap_singleton_out(
                lessons,
                singleton_idx,
                &session_key,
                &fresh_index,
                off_slots,
                subject_limits,
                run_seed,
            ) || try_move_singleton_into_teacher_session_by_relaxed_class_swap(
                lessons,
                singleton_idx,
                &session_key,
                &fresh_index,
                off_slots,
                subject_limits,
                run_seed,
            ) || try_pair_singleton_session(
                lessons,
                &session_key,
                &fresh_index,
                off_slots,
                subject_limits,
                run_seed,
            ) || try_pair_singleton_session_by_class_swap(
                lessons,
                &session_key,
                &fresh_index,
                off_slots,
                subject_limits,
                run_seed,
            ) || try_pair_singleton_session_by_class_rehome(
                lessons,
                &session_key,
                &fresh_index,
                off_slots,
                subject_limits,
                run_seed,
            ) || try_pair_singleton_session_by_relaxed_class_swap(
                lessons,
                &session_key,
                &fresh_index,
                off_slots,
                subject_limits,
                run_seed,
            ) {
                moves += 1;
                moved = true;
                break;
            }
        }

        if !moved {
            break;
        }
    }
    moves
}

fn try_merge_small_teacher_session(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    clock: &SolveClock,
) -> bool {
    if clock.should_stop_quality() {
        return false;
    }
    let before_sessions = count_teacher_sessions(lessons);
    let before_one_period = count_one_period_teacher_sessions(lessons);
    let allowed_sessions = teacher_session_key_set(lessons);
    let session_index = teacher_session_index(lessons);
    let mut source_sessions = session_index
        .iter()
        .filter_map(|(key, indices)| {
            let count = indices.len();
            if !(2..=3).contains(&count) {
                return None;
            }
            if indices
                .iter()
                .any(|index| *index >= lessons.len() || lesson_fixed(&lessons[*index]))
            {
                return None;
            }
            Some((key.clone(), indices.clone()))
        })
        .collect::<Vec<_>>();
    source_sessions.sort_by(|(left_key, left_indices), (right_key, right_indices)| {
        left_indices
            .len()
            .cmp(&right_indices.len())
            .then_with(|| {
                teacher_session_jitter(left_key, run_seed)
                    .cmp(&teacher_session_jitter(right_key, run_seed))
            })
            .then_with(|| left_key.cmp(right_key))
    });
    source_sessions.truncate(20);

    for (source_key, source_indices) in source_sessions {
        if clock.should_stop_quality() {
            break;
        }
        let Some((source_teacher, _, _)) = parse_teacher_session_key(&source_key) else {
            continue;
        };
        if source_teacher.is_empty() {
            continue;
        }
        let mut target_session_keys = session_index
            .keys()
            .filter_map(|key| {
                let (teacher, _, _) = parse_teacher_session_key(key)?;
                (teacher == source_teacher && key != &source_key).then(|| key.clone())
            })
            .collect::<Vec<_>>();
        target_session_keys.sort_by(|left, right| {
            let left_len = session_index
                .get(left)
                .map(|items| items.len())
                .unwrap_or(0);
            let right_len = session_index
                .get(right)
                .map(|items| items.len())
                .unwrap_or(0);
            let left_singleton = i64::from(left_len != 1);
            let right_singleton = i64::from(right_len != 1);
            left_singleton
                .cmp(&right_singleton)
                .then_with(|| right_len.cmp(&left_len))
                .then_with(|| {
                    teacher_session_jitter(left, run_seed)
                        .cmp(&teacher_session_jitter(right, run_seed))
                })
                .then_with(|| left.cmp(right))
        });
        target_session_keys.truncate(12);
        if target_session_keys.is_empty() {
            continue;
        }

        let mut candidate_slots = Vec::new();
        for source_index in &source_indices {
            let slots = small_session_merge_target_slots(
                lessons,
                *source_index,
                &target_session_keys,
                &session_index,
                off_slots,
                run_seed,
                clock,
            );
            if slots.is_empty() {
                candidate_slots.clear();
                break;
            }
            candidate_slots.push(slots);
        }
        if candidate_slots.len() != source_indices.len() {
            continue;
        }

        let mut best: Option<(i64, Vec<(usize, Slot)>)> = None;
        let mut moves = Vec::new();
        let mut used_target_slots = HashSet::new();
        let mut used_blockers = HashSet::new();
        search_small_session_merge(
            lessons,
            &source_indices,
            &candidate_slots,
            0,
            &allowed_sessions,
            off_slots,
            subject_limits,
            before_sessions,
            before_one_period,
            run_seed,
            &mut moves,
            &mut used_target_slots,
            &mut used_blockers,
            &mut best,
            clock,
        );

        if let Some((_, best_moves)) = best {
            for (index, slot) in best_moves {
                set_lesson_slot(&mut lessons[index], &slot);
            }
            return true;
        }
    }
    false
}

fn small_session_merge_target_slots(
    lessons: &[Value],
    lesson_index: usize,
    target_session_keys: &[String],
    session_index: &HashMap<String, Vec<usize>>,
    off_slots: &HashSet<String>,
    run_seed: u64,
    clock: &SolveClock,
) -> Vec<Slot> {
    if lesson_index >= lessons.len() || lesson_fixed(&lessons[lesson_index]) {
        return Vec::new();
    }
    let class_id = lesson_class_id(&lessons[lesson_index]);
    if class_id.is_empty() {
        return Vec::new();
    }
    let Some(source_slot) = lesson_slot(&lessons[lesson_index]) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    'target_sessions: for target_key in target_session_keys {
        if clock.should_stop_quality() {
            break;
        }
        let Some((_, day, session_key)) = parse_teacher_session_key(target_key) else {
            continue;
        };
        let occupied_periods = session_index
            .get(target_key)
            .map(|indices| {
                indices
                    .iter()
                    .filter_map(|index| {
                        lesson_slot(lessons.get(*index)?).map(|slot| slot.period_index)
                    })
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        for period_index in 0..PERIODS_PER_SESSION {
            if clock.should_stop_quality() {
                break 'target_sessions;
            }
            if occupied_periods.contains(&period_index) {
                continue;
            }
            let slot = make_slot(day, &session_key, period_index);
            if same_slot(&source_slot, &slot) || off_slots.contains(&slot_key(&class_id, &slot)) {
                continue;
            }
            if let Some(blocker_index) = class_slot_occupant(lessons, &class_id, &slot) {
                if blocker_index == lesson_index || lesson_fixed(&lessons[blocker_index]) {
                    continue;
                }
            }
            out.push(slot);
        }
    }
    out.sort_by(|left, right| {
        let left_key = teacher_session_key(
            &lesson_teacher_key(&lessons[lesson_index]),
            left.day,
            &left.session_key,
        );
        let right_key = teacher_session_key(
            &lesson_teacher_key(&lessons[lesson_index]),
            right.day,
            &right.session_key,
        );
        let left_load = session_index
            .get(&left_key)
            .map(|items| items.len())
            .unwrap_or(0);
        let right_load = session_index
            .get(&right_key)
            .map(|items| items.len())
            .unwrap_or(0);
        let left_singleton = i64::from(left_load != 1);
        let right_singleton = i64::from(right_load != 1);
        left_singleton
            .cmp(&right_singleton)
            .then_with(|| right_load.cmp(&left_load))
            .then_with(|| {
                move_jitter(&lessons[lesson_index], left, run_seed).cmp(&move_jitter(
                    &lessons[lesson_index],
                    right,
                    run_seed,
                ))
            })
    });
    out.truncate(8);
    out
}

fn search_small_session_merge(
    lessons: &[Value],
    source_indices: &[usize],
    candidate_slots: &[Vec<Slot>],
    position: usize,
    allowed_sessions: &HashSet<String>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    before_sessions: i64,
    before_one_period: i64,
    run_seed: u64,
    moves: &mut Vec<(usize, Slot)>,
    used_target_slots: &mut HashSet<String>,
    used_blockers: &mut HashSet<usize>,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
    clock: &SolveClock,
) {
    if clock.should_stop_quality() {
        return;
    }
    if position >= source_indices.len() {
        consider_small_session_merge_candidate(
            lessons,
            moves,
            allowed_sessions,
            off_slots,
            subject_limits,
            before_sessions,
            before_one_period,
            run_seed,
            best,
            clock,
        );
        return;
    }

    let source_index = source_indices[position];
    if source_index >= lessons.len() || lesson_fixed(&lessons[source_index]) {
        return;
    }
    let class_id = lesson_class_id(&lessons[source_index]);
    let Some(source_slot) = lesson_slot(&lessons[source_index]) else {
        return;
    };

    for target_slot in &candidate_slots[position] {
        if clock.should_stop_quality() {
            break;
        }
        let target_key = target_slot_identity(target_slot);
        if used_target_slots.contains(&target_key) {
            continue;
        }
        let blocker_index = class_slot_occupant(lessons, &class_id, target_slot);
        if let Some(blocker_index) = blocker_index {
            if used_blockers.contains(&blocker_index)
                || source_indices.contains(&blocker_index)
                || lesson_fixed(&lessons[blocker_index])
            {
                continue;
            }
        }

        used_target_slots.insert(target_key.clone());
        moves.push((source_index, target_slot.clone()));
        if let Some(blocker_index) = blocker_index {
            used_blockers.insert(blocker_index);
            moves.push((blocker_index, source_slot.clone()));
        }

        search_small_session_merge(
            lessons,
            source_indices,
            candidate_slots,
            position + 1,
            allowed_sessions,
            off_slots,
            subject_limits,
            before_sessions,
            before_one_period,
            run_seed,
            moves,
            used_target_slots,
            used_blockers,
            best,
            clock,
        );

        if blocker_index.is_some() {
            moves.pop();
            if let Some(blocker_index) = blocker_index {
                used_blockers.remove(&blocker_index);
            }
        }
        moves.pop();
        used_target_slots.remove(&target_key);
    }
}

fn consider_small_session_merge_candidate(
    lessons: &[Value],
    moves: &[(usize, Slot)],
    allowed_sessions: &HashSet<String>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    before_sessions: i64,
    before_one_period: i64,
    run_seed: u64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
    clock: &SolveClock,
) {
    if clock.should_stop_quality() {
        return;
    }
    let mut candidate = lessons.to_vec();
    for (index, slot) in moves {
        if *index >= candidate.len() {
            return;
        }
        set_lesson_slot(&mut candidate[*index], slot);
    }
    if !schedule_hard_ok(&candidate, off_slots, subject_limits)
        || !teacher_sessions_subset(&candidate, allowed_sessions)
    {
        return;
    }
    let after_sessions = count_teacher_sessions(&candidate);
    let after_one_period = count_one_period_teacher_sessions(&candidate);
    if after_sessions >= before_sessions || after_one_period > before_one_period {
        return;
    }
    let gap_metrics = teacher_gap_metrics(&candidate);
    let jitter = moves
        .iter()
        .map(|(index, slot)| move_jitter(&lessons[*index], slot, run_seed))
        .sum::<i64>();
    let score = after_one_period * 1_000_000
        + after_sessions * 10_000
        + gap_metrics.gap2_plus_sessions * 1_000
        + gap_metrics.total_gap * 100
        + moves.len() as i64 * 10
        + jitter;
    match best {
        Some((best_score, _)) if *best_score <= score => {}
        _ => *best = Some((score, moves.to_vec())),
    }
}

fn target_slot_identity(slot: &Slot) -> String {
    format!(
        "{}|{}|{}",
        slot.day_key, slot.session_key, slot.period_index
    )
}

fn repair_unassigned_lessons(
    lessons: &mut Vec<Value>,
    unassigned: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    let max_rounds = unassigned.len().saturating_mul(3).max(1);
    for _ in 0..max_rounds {
        if unassigned.is_empty() || clock.deadline_hit() {
            break;
        }
        let allow_expensive_cycles = unassigned.len() <= 16;
        let Some((unassigned_index, candidate_lessons)) = best_unassigned_repair(
            lessons,
            unassigned,
            off_slots,
            subject_limits,
            run_seed,
            allow_expensive_cycles,
            false,
            None,
            clock,
        ) else {
            break;
        };
        *lessons = candidate_lessons;
        unassigned.remove(unassigned_index);
        moves += 1;
    }
    moves
}

fn repair_quick_unassigned_lessons_first_fit(
    lessons: &mut Vec<Value>,
    unassigned: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    quick_authored_assignments: &[Assignment],
    run_seed: u64,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    let max_rounds = unassigned.len().saturating_mul(2).max(1);
    for _ in 0..max_rounds {
        if unassigned.is_empty() || clock.deadline_hit() {
            break;
        }
        let Some((unassigned_index, candidate_lessons)) = best_unassigned_repair(
            lessons,
            unassigned,
            off_slots,
            subject_limits,
            run_seed,
            true,
            true,
            Some(quick_authored_assignments),
            clock,
        ) else {
            break;
        };
        *lessons = candidate_lessons;
        unassigned.remove(unassigned_index);
        moves += 1;
    }
    moves
}

fn best_unassigned_repair(
    lessons: &[Value],
    unassigned: &[Value],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    allow_expensive_cycles: bool,
    first_fit: bool,
    quick_authored_assignments: Option<&[Assignment]>,
    clock: &SolveClock,
) -> Option<(usize, Vec<Value>)> {
    let mut best: Option<(i64, usize, Vec<Value>)> = None;
    for (unassigned_index, item) in unassigned.iter().enumerate() {
        if clock.deadline_hit() {
            break;
        }
        let class_id = lesson_class_id(item);
        let subject = lesson_subject(item);
        if class_id.is_empty() || subject.is_empty() {
            continue;
        }
        let class_name = lesson_string(item, "className");
        let teacher = lesson_string(item, "teacher");
        let room = lesson_room(item);
        let empty_slots = empty_slots_for_class(lessons, &class_id, off_slots);

        for slot in &empty_slots {
            if clock.deadline_hit() {
                break;
            }
            let mut candidate = lessons.to_vec();
            candidate.push(lesson_json(
                &class_id,
                &class_name,
                &subject,
                &teacher,
                &room,
                slot,
                false,
            ));
            if !repair_candidate_hard_ok(
                &candidate,
                off_slots,
                subject_limits,
                quick_authored_assignments,
            ) {
                continue;
            }
            if first_fit {
                return Some((unassigned_index, candidate));
            }
            let score = repair_candidate_score(&candidate, 1, item, slot, run_seed);
            match &best {
                Some((best_score, _, _)) if *best_score <= score => {}
                _ => best = Some((score, unassigned_index, candidate)),
            }
        }

        for slot in &empty_slots {
            if clock.deadline_hit() {
                break;
            }
            let blockers = resource_blockers_for_lesson_at_slot(lessons, item, slot);
            if blockers.len() != 1 {
                continue;
            }
            let blocker_index = blockers[0];
            let Some(blocker) = lessons.get(blocker_index) else {
                continue;
            };
            if lesson_fixed(blocker) {
                continue;
            }
            let blocker_class_id = lesson_class_id(blocker);
            if blocker_class_id.is_empty() {
                continue;
            }
            for blocker_slot in empty_slots_for_class(lessons, &blocker_class_id, off_slots) {
                if same_slot(slot, &blocker_slot) {
                    continue;
                }
                let mut candidate = lessons.to_vec();
                set_lesson_slot(&mut candidate[blocker_index], &blocker_slot);
                candidate.push(lesson_json(
                    &class_id,
                    &class_name,
                    &subject,
                    &teacher,
                    &room,
                    slot,
                    false,
                ));
                if !repair_candidate_hard_ok(
                    &candidate,
                    off_slots,
                    subject_limits,
                    quick_authored_assignments,
                ) {
                    continue;
                }
                if first_fit {
                    return Some((unassigned_index, candidate));
                }
                let score = repair_candidate_score(&candidate, 2, item, slot, run_seed)
                    + move_jitter(blocker, &blocker_slot, run_seed);
                match &best {
                    Some((best_score, _, _)) if *best_score <= score => {}
                    _ => best = Some((score, unassigned_index, candidate)),
                }
            }

            let Some(current_blocker_slot) = lesson_slot(blocker) else {
                continue;
            };
            for blocker_target_slot in usable_slots_for_class(&blocker_class_id, off_slots) {
                if same_slot(&current_blocker_slot, &blocker_target_slot)
                    || same_slot(slot, &blocker_target_slot)
                {
                    continue;
                }
                let Some(occupant_index) =
                    class_slot_occupant(lessons, &blocker_class_id, &blocker_target_slot)
                else {
                    continue;
                };
                if occupant_index == blocker_index || lesson_fixed(&lessons[occupant_index]) {
                    continue;
                }

                let mut candidate = lessons.to_vec();
                set_lesson_slot(&mut candidate[blocker_index], &blocker_target_slot);
                set_lesson_slot(&mut candidate[occupant_index], &current_blocker_slot);
                candidate.push(lesson_json(
                    &class_id,
                    &class_name,
                    &subject,
                    &teacher,
                    &room,
                    slot,
                    false,
                ));
                if !repair_candidate_hard_ok(
                    &candidate,
                    off_slots,
                    subject_limits,
                    quick_authored_assignments,
                ) {
                    continue;
                }
                if first_fit {
                    return Some((unassigned_index, candidate));
                }
                let score = repair_candidate_score(&candidate, 3, item, slot, run_seed)
                    + move_jitter(blocker, &blocker_target_slot, run_seed)
                    + move_jitter(&lessons[occupant_index], &current_blocker_slot, run_seed);
                match &best {
                    Some((best_score, _, _)) if *best_score <= score => {}
                    _ => best = Some((score, unassigned_index, candidate)),
                }
            }

            if allow_expensive_cycles && (best.is_none() || unassigned.len() <= 16) {
                let blocker_slots = usable_slots_for_class(&blocker_class_id, off_slots);
                let mut checked_cycles = 0_i64;
                for first_slot in &blocker_slots {
                    if clock.deadline_hit() {
                        break;
                    }
                    if same_slot(&current_blocker_slot, first_slot) || same_slot(slot, first_slot) {
                        continue;
                    }
                    let Some(first_occupant) =
                        class_slot_occupant(lessons, &blocker_class_id, first_slot)
                    else {
                        continue;
                    };
                    if first_occupant == blocker_index || lesson_fixed(&lessons[first_occupant]) {
                        continue;
                    }
                    for second_slot in &blocker_slots {
                        if clock.deadline_hit() {
                            break;
                        }
                        checked_cycles += 1;
                        if checked_cycles > 320 {
                            break;
                        }
                        if same_slot(second_slot, first_slot)
                            || same_slot(second_slot, &current_blocker_slot)
                            || same_slot(second_slot, slot)
                        {
                            continue;
                        }
                        let Some(second_occupant) =
                            class_slot_occupant(lessons, &blocker_class_id, second_slot)
                        else {
                            continue;
                        };
                        if second_occupant == blocker_index
                            || second_occupant == first_occupant
                            || lesson_fixed(&lessons[second_occupant])
                        {
                            continue;
                        }

                        let mut candidate = lessons.to_vec();
                        set_lesson_slot(&mut candidate[blocker_index], first_slot);
                        set_lesson_slot(&mut candidate[first_occupant], second_slot);
                        set_lesson_slot(&mut candidate[second_occupant], &current_blocker_slot);
                        candidate.push(lesson_json(
                            &class_id,
                            &class_name,
                            &subject,
                            &teacher,
                            &room,
                            slot,
                            false,
                        ));
                        if !repair_candidate_hard_ok(
                            &candidate,
                            off_slots,
                            subject_limits,
                            quick_authored_assignments,
                        ) {
                            continue;
                        }
                        if first_fit {
                            return Some((unassigned_index, candidate));
                        }
                        let score = repair_candidate_score(&candidate, 4, item, slot, run_seed)
                            + move_jitter(blocker, first_slot, run_seed)
                            + move_jitter(&lessons[first_occupant], second_slot, run_seed)
                            + move_jitter(
                                &lessons[second_occupant],
                                &current_blocker_slot,
                                run_seed,
                            );
                        match &best {
                            Some((best_score, _, _)) if *best_score <= score => {}
                            _ => best = Some((score, unassigned_index, candidate)),
                        }
                    }
                    if checked_cycles > 320 {
                        break;
                    }
                }
            }
        }

        for (blocker_index, blocker) in lessons.iter().enumerate() {
            if clock.deadline_hit() {
                break;
            }
            if lesson_fixed(blocker) || lesson_class_id(blocker) != class_id {
                continue;
            }
            let Some(target_slot) = lesson_slot(blocker) else {
                continue;
            };
            for empty_slot in &empty_slots {
                if clock.deadline_hit() {
                    break;
                }
                if same_slot(&target_slot, empty_slot) {
                    continue;
                }
                let mut candidate = lessons.to_vec();
                set_lesson_slot(&mut candidate[blocker_index], empty_slot);
                candidate.push(lesson_json(
                    &class_id,
                    &class_name,
                    &subject,
                    &teacher,
                    &room,
                    &target_slot,
                    false,
                ));
                if !repair_candidate_hard_ok(
                    &candidate,
                    off_slots,
                    subject_limits,
                    quick_authored_assignments,
                ) {
                    continue;
                }
                if first_fit {
                    return Some((unassigned_index, candidate));
                }
                let score = repair_candidate_score(&candidate, 2, item, &target_slot, run_seed)
                    + move_jitter(blocker, empty_slot, run_seed);
                match &best {
                    Some((best_score, _, _)) if *best_score <= score => {}
                    _ => best = Some((score, unassigned_index, candidate)),
                }
            }
        }
    }
    best.map(|(_, index, candidate)| (index, candidate))
}

fn repair_candidate_hard_ok(
    lessons: &[Value],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    quick_authored_assignments: Option<&[Assignment]>,
) -> bool {
    schedule_hard_ok(lessons, off_slots, subject_limits)
        && quick_authored_assignments
            .is_none_or(|assignments| quick_authored_subject_rules_ok(lessons, assignments))
}

fn quick_authored_subject_rules_ok(lessons: &[Value], assignments: &[Assignment]) -> bool {
    let mut subject_sessions: HashMap<(String, String, i64, String), u8> = HashMap::new();
    let mut subject_counts: HashMap<(String, String), i64> = HashMap::new();
    for lesson in lessons {
        let class_id = lesson_class_id(lesson);
        let subject = norm(&lesson_subject(lesson));
        let Some(slot) = lesson_slot(lesson) else {
            return false;
        };
        if class_id.is_empty() || subject.is_empty() {
            return false;
        }
        *subject_counts
            .entry((class_id.clone(), subject.clone()))
            .or_insert(0) += 1;
        *subject_sessions
            .entry((class_id, subject, slot.day, slot.session_key))
            .or_insert(0) |= 1_u8 << slot.period_index.clamp(0, 4);
    }

    for assignment in assignments {
        if assignment.quick_min_two_blocks <= 0
            && !assignment.quick_avoid_pair23_morning
            && !assignment.quick_avoid_pair23_afternoon
        {
            continue;
        }
        let key = (assignment.class_id.clone(), norm(&assignment.subject));
        let observed = subject_counts.get(&key).copied().unwrap_or(0);
        let mut two_blocks = 0_i64;
        for ((class_id, subject, _, session), mask) in &subject_sessions {
            if class_id != &key.0 || subject != &key.1 {
                continue;
            }
            if (*mask & 0b0_0110) == 0b0_0110
                && ((session == "sang" && assignment.quick_avoid_pair23_morning)
                    || (session == "chieu" && assignment.quick_avoid_pair23_afternoon))
            {
                return false;
            }
            if (*mask & (*mask >> 1)) != 0 {
                two_blocks += 1;
            }
        }
        if observed >= assignment.periods && two_blocks < assignment.quick_min_two_blocks {
            return false;
        }
    }
    true
}

fn usable_slots_for_class(class_id: &str, off_slots: &HashSet<String>) -> Vec<Slot> {
    let mut out = Vec::new();
    for (_, day_num) in DAYS {
        for (session_key, _) in SESSIONS {
            for period_index in 0..PERIODS_PER_SESSION {
                let slot = make_slot(day_num, session_key, period_index);
                if off_slots.contains(&slot_key(class_id, &slot)) {
                    continue;
                }
                out.push(slot);
            }
        }
    }
    out
}

fn resource_blockers_for_lesson_at_slot(
    lessons: &[Value],
    lesson: &Value,
    target_slot: &Slot,
) -> Vec<usize> {
    let teacher = lesson_teacher_key(lesson);
    let room = norm(&lesson_room(lesson));
    let mut blockers = Vec::new();
    let mut seen = HashSet::new();
    for (index, other) in lessons.iter().enumerate() {
        let Some(other_slot) = lesson_slot(other) else {
            continue;
        };
        if !same_slot(&other_slot, target_slot) {
            continue;
        }
        let teacher_conflict = !teacher.is_empty() && lesson_teacher_key(other) == teacher;
        let room_conflict = !room.is_empty() && norm(&lesson_room(other)) == room;
        if (teacher_conflict || room_conflict) && seen.insert(index) {
            blockers.push(index);
        }
    }
    blockers
}

fn repair_candidate_score(
    lessons: &[Value],
    move_count: i64,
    lesson: &Value,
    slot: &Slot,
    run_seed: u64,
) -> i64 {
    let gap_metrics = teacher_gap_metrics(lessons);
    count_one_period_teacher_sessions(lessons) * 1_000_000
        + count_teacher_sessions(lessons) * 10_000
        + gap_metrics.gap2_plus_sessions * 1_000
        + gap_metrics.total_gap * 100
        + move_count * 10
        + move_jitter(lesson, slot, run_seed)
}

fn empty_slots_for_class(
    lessons: &[Value],
    class_id: &str,
    off_slots: &HashSet<String>,
) -> Vec<Slot> {
    let occupied = lessons
        .iter()
        .filter(|lesson| lesson_class_id(lesson) == class_id)
        .filter_map(|lesson| lesson_slot(lesson).map(|slot| slot_key(class_id, &slot)))
        .collect::<HashSet<_>>();
    let mut out = Vec::new();
    for (_, day_num) in DAYS {
        for (session_key, _) in SESSIONS {
            for period_index in 0..PERIODS_PER_SESSION {
                let slot = make_slot(day_num, session_key, period_index);
                let key = slot_key(class_id, &slot);
                if off_slots.contains(&key) || occupied.contains(&key) {
                    continue;
                }
                out.push(slot);
            }
        }
    }
    out
}

fn try_move_singleton_out(
    lessons: &mut Vec<Value>,
    lesson_index: usize,
    singleton_session_key: &str,
    session_index: &HashMap<String, Vec<usize>>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
) -> bool {
    if lesson_fixed(&lessons[lesson_index]) {
        return false;
    }
    let teacher = lesson_teacher_key(&lessons[lesson_index]);
    if teacher.is_empty() {
        return false;
    }

    let mut best: Option<(i64, Slot)> = None;
    for (target_session_key, indices) in session_index {
        if target_session_key == singleton_session_key || indices.is_empty() {
            continue;
        }
        let Some((target_teacher, day, session_key)) =
            parse_teacher_session_key(target_session_key)
        else {
            continue;
        };
        if target_teacher != teacher {
            continue;
        }
        for period_index in 0..PERIODS_PER_SESSION {
            let slot = make_slot(day, &session_key, period_index);
            if !can_move_lesson_to_slot(lessons, lesson_index, &slot, off_slots, subject_limits) {
                continue;
            }
            let target_count = indices.len() as i64;
            let score = if target_count == 1 { 0 } else { 250 }
                + period_index
                + move_jitter(&lessons[lesson_index], &slot, run_seed);
            match &best {
                Some((best_score, _)) if *best_score <= score => {}
                _ => best = Some((score, slot)),
            }
        }
    }

    if let Some((_, slot)) = best {
        set_lesson_slot(&mut lessons[lesson_index], &slot);
        return true;
    }
    false
}

fn try_swap_singleton_out(
    lessons: &mut Vec<Value>,
    lesson_index: usize,
    singleton_session_key: &str,
    session_index: &HashMap<String, Vec<usize>>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
) -> bool {
    if lesson_fixed(&lessons[lesson_index]) {
        return false;
    }
    let source_teacher = lesson_teacher_key(&lessons[lesson_index]);
    if source_teacher.is_empty() {
        return false;
    }
    let source_class = lesson_class_id(&lessons[lesson_index]);
    let Some(source_slot) = lesson_slot(&lessons[lesson_index]) else {
        return false;
    };
    let before_sessions = count_teacher_sessions(lessons);
    let before_one_period = count_one_period_teacher_sessions(lessons);

    let mut best: Option<(i64, usize, Slot, Slot)> = None;
    let mut checked = 0_i64;
    for (target_index, target_lesson) in lessons.iter().enumerate() {
        if target_index == lesson_index || lesson_fixed(target_lesson) {
            continue;
        }
        if lesson_class_id(target_lesson) != source_class {
            continue;
        }
        checked += 1;
        if checked > 240 {
            break;
        }
        let Some(target_slot) = lesson_slot(target_lesson) else {
            continue;
        };
        if same_slot(&source_slot, &target_slot) {
            continue;
        }

        let source_teacher_target_session =
            teacher_session_key(&source_teacher, target_slot.day, &target_slot.session_key);
        if source_teacher_target_session == singleton_session_key
            || !session_index.contains_key(&source_teacher_target_session)
        {
            continue;
        }

        let mut candidate = lessons.clone();
        set_lesson_slot(&mut candidate[lesson_index], &target_slot);
        set_lesson_slot(&mut candidate[target_index], &source_slot);
        if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
            continue;
        }
        let after_sessions = count_teacher_sessions(&candidate);
        let after_one_period = count_one_period_teacher_sessions(&candidate);
        if after_sessions > before_sessions || after_one_period >= before_one_period {
            continue;
        }

        let target_count = session_index
            .get(&source_teacher_target_session)
            .map(|items| items.len() as i64)
            .unwrap_or(0);
        let score = after_one_period * 10_000
            + after_sessions * 100
            + if target_count == 1 { 0 } else { 50 }
            + move_jitter(&lessons[lesson_index], &target_slot, run_seed)
            + move_jitter(target_lesson, &source_slot, run_seed);
        match &best {
            Some((best_score, _, _, _)) if *best_score <= score => {}
            _ => best = Some((score, target_index, target_slot, source_slot.clone())),
        }
    }

    if let Some((_, target_index, target_slot, source_slot)) = best {
        set_lesson_slot(&mut lessons[lesson_index], &target_slot);
        set_lesson_slot(&mut lessons[target_index], &source_slot);
        return true;
    }
    false
}

fn try_move_singleton_into_teacher_session_by_relaxed_class_swap(
    lessons: &mut Vec<Value>,
    lesson_index: usize,
    singleton_session_key: &str,
    session_index: &HashMap<String, Vec<usize>>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
) -> bool {
    if lesson_index >= lessons.len() || lesson_fixed(&lessons[lesson_index]) {
        return false;
    }
    let teacher = lesson_teacher_key(&lessons[lesson_index]);
    let class_id = lesson_class_id(&lessons[lesson_index]);
    if teacher.is_empty() || class_id.is_empty() {
        return false;
    }
    let Some(source_slot) = lesson_slot(&lessons[lesson_index]) else {
        return false;
    };
    let before = teacher_optimization_quality(lessons);

    let mut target_sessions = session_index
        .keys()
        .filter_map(|key| {
            let (session_teacher, _, _) = parse_teacher_session_key(key)?;
            (session_teacher == teacher && key != singleton_session_key).then(|| key.clone())
        })
        .collect::<Vec<_>>();
    target_sessions.sort_by(|left, right| {
        let left_len = session_index
            .get(left)
            .map(|items| items.len())
            .unwrap_or(0);
        let right_len = session_index
            .get(right)
            .map(|items| items.len())
            .unwrap_or(0);
        let left_singleton = i64::from(left_len != 1);
        let right_singleton = i64::from(right_len != 1);
        left_singleton
            .cmp(&right_singleton)
            .then_with(|| right_len.cmp(&left_len))
            .then_with(|| {
                teacher_session_jitter(left, run_seed).cmp(&teacher_session_jitter(right, run_seed))
            })
            .then_with(|| left.cmp(right))
    });
    target_sessions.truncate(12);

    let mut best: Option<(i64, usize, Slot, Slot)> = None;
    for target_session_key in target_sessions {
        let Some((_, day, session_key)) = parse_teacher_session_key(&target_session_key) else {
            continue;
        };
        for period_index in 0..PERIODS_PER_SESSION {
            let target_slot = make_slot(day, &session_key, period_index);
            if same_slot(&source_slot, &target_slot) {
                continue;
            }
            let Some(blocker_index) = class_slot_occupant(lessons, &class_id, &target_slot) else {
                continue;
            };
            if blocker_index == lesson_index || lesson_fixed(&lessons[blocker_index]) {
                continue;
            }

            let mut candidate = lessons.clone();
            set_lesson_slot(&mut candidate[lesson_index], &target_slot);
            set_lesson_slot(&mut candidate[blocker_index], &source_slot);
            if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                continue;
            }
            let after = teacher_optimization_quality(&candidate);
            if after.one_period_sessions >= before.one_period_sessions
                || after.gap2_plus_sessions > before.gap2_plus_sessions
                || after.teacher_sessions > before.teacher_sessions + 1
            {
                continue;
            }
            let score = after.one_period_sessions * 1_000_000
                + after.gap2_plus_sessions * 100_000
                + after.teacher_sessions * 1_000
                + after.gap1_sessions * 20
                + move_jitter(&lessons[lesson_index], &target_slot, run_seed)
                + move_jitter(&lessons[blocker_index], &source_slot, run_seed);
            match &best {
                Some((best_score, _, _, _)) if *best_score <= score => {}
                _ => best = Some((score, blocker_index, target_slot, source_slot.clone())),
            }
        }
    }

    if let Some((_, blocker_index, target_slot, source_slot)) = best {
        set_lesson_slot(&mut lessons[lesson_index], &target_slot);
        set_lesson_slot(&mut lessons[blocker_index], &source_slot);
        return true;
    }
    false
}

fn try_pair_singleton_session(
    lessons: &mut Vec<Value>,
    singleton_session_key: &str,
    session_index: &HashMap<String, Vec<usize>>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
) -> bool {
    let Some((target_teacher, target_day, target_session)) =
        parse_teacher_session_key(singleton_session_key)
    else {
        return false;
    };

    let mut best: Option<(i64, usize, Slot)> = None;
    for (source_index, lesson) in lessons.iter().enumerate() {
        if lesson_fixed(lesson) || lesson_teacher_key(lesson) != target_teacher {
            continue;
        }
        let Some(source_slot) = lesson_slot(lesson) else {
            continue;
        };
        let source_session_key =
            teacher_session_key(&target_teacher, source_slot.day, &source_slot.session_key);
        if source_session_key == singleton_session_key {
            continue;
        }
        let source_count = session_index
            .get(&source_session_key)
            .map(|items| items.len())
            .unwrap_or(0);
        if source_count == 2 || source_count == 0 {
            continue;
        }
        for period_index in 0..PERIODS_PER_SESSION {
            let slot = make_slot(target_day, &target_session, period_index);
            if !can_move_lesson_to_slot(lessons, source_index, &slot, off_slots, subject_limits) {
                continue;
            }
            let score = if source_count == 1 { 0 } else { 1000 }
                + period_index
                + move_jitter(lesson, &slot, run_seed);
            match &best {
                Some((best_score, _, _)) if *best_score <= score => {}
                _ => best = Some((score, source_index, slot)),
            }
        }
    }

    if let Some((_, source_index, slot)) = best {
        set_lesson_slot(&mut lessons[source_index], &slot);
        return true;
    }
    false
}

fn try_pair_singleton_session_by_class_swap(
    lessons: &mut Vec<Value>,
    singleton_session_key: &str,
    session_index: &HashMap<String, Vec<usize>>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
) -> bool {
    let Some((target_teacher, target_day, target_session)) =
        parse_teacher_session_key(singleton_session_key)
    else {
        return false;
    };
    let before_sessions = count_teacher_sessions(lessons);
    let before_one_period = count_one_period_teacher_sessions(lessons);

    let mut best: Option<(i64, usize, usize, Slot, Slot)> = None;
    for (source_index, source_lesson) in lessons.iter().enumerate() {
        if lesson_fixed(source_lesson) || lesson_teacher_key(source_lesson) != target_teacher {
            continue;
        }
        let source_class = lesson_class_id(source_lesson);
        if source_class.is_empty() {
            continue;
        }
        let Some(source_slot) = lesson_slot(source_lesson) else {
            continue;
        };
        let source_session_key =
            teacher_session_key(&target_teacher, source_slot.day, &source_slot.session_key);
        if source_session_key == singleton_session_key {
            continue;
        }
        let source_count = session_index
            .get(&source_session_key)
            .map(|items| items.len())
            .unwrap_or(0);
        if source_count == 0 || source_count == 2 {
            continue;
        }

        for period_index in 0..PERIODS_PER_SESSION {
            let target_slot = make_slot(target_day, &target_session, period_index);
            if same_slot(&source_slot, &target_slot) {
                continue;
            }
            let Some(blocker_index) = lessons.iter().enumerate().find_map(|(index, lesson)| {
                if index == source_index || lesson_class_id(lesson) != source_class {
                    return None;
                }
                let slot = lesson_slot(lesson)?;
                same_slot(&slot, &target_slot).then_some(index)
            }) else {
                continue;
            };
            let blocker = &lessons[blocker_index];
            if lesson_fixed(blocker) {
                continue;
            }

            let mut candidate = lessons.clone();
            set_lesson_slot(&mut candidate[source_index], &target_slot);
            set_lesson_slot(&mut candidate[blocker_index], &source_slot);
            if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                continue;
            }
            let after_sessions = count_teacher_sessions(&candidate);
            let after_one_period = count_one_period_teacher_sessions(&candidate);
            if after_sessions > before_sessions || after_one_period >= before_one_period {
                continue;
            }

            let score = after_one_period * 10_000
                + after_sessions * 100
                + if source_count == 1 { 0 } else { 30 }
                + move_jitter(source_lesson, &target_slot, run_seed)
                + move_jitter(blocker, &source_slot, run_seed);
            match &best {
                Some((best_score, _, _, _, _)) if *best_score <= score => {}
                _ => {
                    best = Some((
                        score,
                        source_index,
                        blocker_index,
                        target_slot,
                        source_slot.clone(),
                    ))
                }
            }
        }
    }

    if let Some((_, source_index, blocker_index, target_slot, source_slot)) = best {
        set_lesson_slot(&mut lessons[source_index], &target_slot);
        set_lesson_slot(&mut lessons[blocker_index], &source_slot);
        return true;
    }
    false
}

fn try_pair_singleton_session_by_class_rehome(
    lessons: &mut Vec<Value>,
    singleton_session_key: &str,
    session_index: &HashMap<String, Vec<usize>>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
) -> bool {
    let Some((target_teacher, target_day, target_session)) =
        parse_teacher_session_key(singleton_session_key)
    else {
        return false;
    };
    let before = teacher_optimization_quality(lessons);
    let mut best: Option<(i64, Vec<(usize, Slot)>)> = None;
    let mut checked = 0_i64;

    for source_index in 0..lessons.len() {
        let source_lesson = &lessons[source_index];
        if lesson_fixed(source_lesson) || lesson_teacher_key(source_lesson) != target_teacher {
            continue;
        }
        let source_class = lesson_class_id(source_lesson);
        if source_class.is_empty() {
            continue;
        }
        let Some(source_slot) = lesson_slot(source_lesson) else {
            continue;
        };
        let source_session_key =
            teacher_session_key(&target_teacher, source_slot.day, &source_slot.session_key);
        if source_session_key == singleton_session_key {
            continue;
        }
        let source_count = session_index
            .get(&source_session_key)
            .map(|items| items.len())
            .unwrap_or(0);
        if source_count == 0 || source_count == 2 {
            continue;
        }

        let mut empty_slots = empty_slots_for_class(lessons, &source_class, off_slots);
        empty_slots.sort_by(|left, right| {
            let left_distance = (left.day - source_slot.day).abs() * 10
                + if left.session_key == source_slot.session_key {
                    0
                } else {
                    5
                }
                + (left.period_index - source_slot.period_index).abs();
            let right_distance = (right.day - source_slot.day).abs() * 10
                + if right.session_key == source_slot.session_key {
                    0
                } else {
                    5
                }
                + (right.period_index - source_slot.period_index).abs();
            left_distance.cmp(&right_distance).then_with(|| {
                move_jitter(source_lesson, left, run_seed).cmp(&move_jitter(
                    source_lesson,
                    right,
                    run_seed,
                ))
            })
        });
        empty_slots.truncate(56);

        for period_index in 0..PERIODS_PER_SESSION {
            checked += 1;
            if checked > 1_200 {
                break;
            }
            let target_slot = make_slot(target_day, &target_session, period_index);
            if same_slot(&source_slot, &target_slot) {
                continue;
            }
            let Some(blocker_index) = class_slot_occupant(lessons, &source_class, &target_slot)
            else {
                continue;
            };
            if blocker_index == source_index || lesson_fixed(&lessons[blocker_index]) {
                continue;
            }

            for empty_slot in &empty_slots {
                if same_slot(empty_slot, &target_slot) {
                    continue;
                }
                let moves_candidate = vec![
                    (source_index, target_slot.clone()),
                    (blocker_index, empty_slot.clone()),
                ];
                let mut candidate = lessons.clone();
                for (index, slot) in &moves_candidate {
                    set_lesson_slot(&mut candidate[*index], slot);
                }
                if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                    continue;
                }
                let after = teacher_optimization_quality(&candidate);
                if after.one_period_sessions >= before.one_period_sessions
                    || after.teacher_sessions > before.teacher_sessions
                    || after.gap2_plus_sessions > before.gap2_plus_sessions
                {
                    continue;
                }
                let blocker = &lessons[blocker_index];
                let score = after.one_period_sessions * 1_000_000
                    + after.gap2_plus_sessions * 100_000
                    + after.teacher_sessions * 1_000
                    + after.gap1_sessions * 20
                    + after.total_gap
                    + if source_count == 1 { 0 } else { 30 }
                    + move_jitter(source_lesson, &target_slot, run_seed)
                    + move_jitter(blocker, empty_slot, run_seed);
                match &best {
                    Some((best_score, _)) if *best_score <= score => {}
                    _ => best = Some((score, moves_candidate)),
                }
            }
        }
        if checked > 1_200 {
            break;
        }
    }

    if let Some((_, best_moves)) = best {
        for (index, slot) in best_moves {
            set_lesson_slot(&mut lessons[index], &slot);
        }
        return true;
    }
    false
}

fn try_pair_singleton_session_by_relaxed_class_swap(
    lessons: &mut Vec<Value>,
    singleton_session_key: &str,
    session_index: &HashMap<String, Vec<usize>>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
) -> bool {
    let Some((target_teacher, target_day, target_session)) =
        parse_teacher_session_key(singleton_session_key)
    else {
        return false;
    };
    let before = teacher_optimization_quality(lessons);

    let mut best: Option<(i64, usize, usize, Slot, Slot)> = None;
    let mut checked = 0_i64;
    for (source_index, source_lesson) in lessons.iter().enumerate() {
        if lesson_fixed(source_lesson) || lesson_teacher_key(source_lesson) != target_teacher {
            continue;
        }
        let source_class = lesson_class_id(source_lesson);
        if source_class.is_empty() {
            continue;
        }
        let Some(source_slot) = lesson_slot(source_lesson) else {
            continue;
        };
        let source_session_key =
            teacher_session_key(&target_teacher, source_slot.day, &source_slot.session_key);
        if source_session_key == singleton_session_key {
            continue;
        }
        if !session_index.contains_key(&source_session_key) {
            continue;
        }

        for period_index in 0..PERIODS_PER_SESSION {
            checked += 1;
            if checked > 600 {
                break;
            }
            let target_slot = make_slot(target_day, &target_session, period_index);
            if same_slot(&source_slot, &target_slot) {
                continue;
            }
            let Some(blocker_index) = class_slot_occupant(lessons, &source_class, &target_slot)
            else {
                continue;
            };
            if blocker_index == source_index || lesson_fixed(&lessons[blocker_index]) {
                continue;
            }

            let mut candidate = lessons.clone();
            set_lesson_slot(&mut candidate[source_index], &target_slot);
            set_lesson_slot(&mut candidate[blocker_index], &source_slot);
            if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                continue;
            }
            let after = teacher_optimization_quality(&candidate);
            if after.one_period_sessions >= before.one_period_sessions
                || after.gap2_plus_sessions > before.gap2_plus_sessions
                || after.teacher_sessions > before.teacher_sessions + 1
            {
                continue;
            }
            let score = after.one_period_sessions * 1_000_000
                + after.gap2_plus_sessions * 100_000
                + after.teacher_sessions * 1_000
                + after.gap1_sessions * 20
                + move_jitter(source_lesson, &target_slot, run_seed)
                + move_jitter(&lessons[blocker_index], &source_slot, run_seed);
            match &best {
                Some((best_score, _, _, _, _)) if *best_score <= score => {}
                _ => {
                    best = Some((
                        score,
                        source_index,
                        blocker_index,
                        target_slot,
                        source_slot.clone(),
                    ))
                }
            }
        }
        if checked > 600 {
            break;
        }
    }

    if let Some((_, source_index, blocker_index, target_slot, source_slot)) = best {
        set_lesson_slot(&mut lessons[source_index], &target_slot);
        set_lesson_slot(&mut lessons[blocker_index], &source_slot);
        return true;
    }
    false
}

fn optimize_teacher_large_gaps(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    deep_gap_repair: bool,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    let max_moves = (lessons.len() * 2).clamp(1, 180);
    for _ in 0..max_moves {
        if clock.should_stop_quality() {
            break;
        }
        let mut sessions = teacher_gap_sessions(lessons)
            .into_iter()
            .filter(|session| session.gaps >= 2)
            .collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            b.gaps
                .cmp(&a.gaps)
                .then_with(|| {
                    teacher_session_jitter(&a.key, run_seed)
                        .cmp(&teacher_session_jitter(&b.key, run_seed))
                })
                .then_with(|| a.key.cmp(&b.key))
        });

        let mut moved = false;
        for session in sessions {
            if clock.should_stop_quality() {
                break;
            }
            if try_compact_teacher_gap_session_by_class_swap(
                lessons,
                &session,
                off_slots,
                subject_limits,
                run_seed,
                clock,
            ) {
                moves += 1;
                moved = true;
                break;
            }
        }
        if !moved
            && !clock.should_stop_quality()
            && try_compact_teacher_gap_by_same_class_pair_swap(
                lessons,
                off_slots,
                subject_limits,
                run_seed,
                2,
                clock,
            )
        {
            moves += 1;
            moved = true;
        }
        if deep_gap_repair
            && !moved
            && !clock.should_stop_quality()
            && try_compact_teacher_gap_by_class_chain(
                lessons,
                off_slots,
                subject_limits,
                run_seed,
                2,
                clock,
            )
        {
            moves += 1;
            moved = true;
        }
        if !moved {
            break;
        }
    }
    moves
}

fn optimize_teacher_single_gaps(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    clock: &SolveClock,
) -> i64 {
    let mut moves = 0_i64;
    let max_moves = (lessons.len() * 2).clamp(1, 180);
    for _ in 0..max_moves {
        if clock.should_stop_quality() {
            break;
        }
        let mut sessions = teacher_gap_sessions(lessons)
            .into_iter()
            .filter(|session| session.gaps == 1)
            .collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            teacher_session_jitter(&a.key, run_seed)
                .cmp(&teacher_session_jitter(&b.key, run_seed))
                .then_with(|| a.key.cmp(&b.key))
        });

        let mut moved = false;
        for session in sessions {
            if clock.should_stop_quality() {
                break;
            }
            if try_compact_teacher_gap_session_by_class_swap(
                lessons,
                &session,
                off_slots,
                subject_limits,
                run_seed,
                clock,
            ) {
                moves += 1;
                moved = true;
                break;
            }
        }
        if !moved
            && !clock.should_stop_quality()
            && try_compact_teacher_gap_by_class_chain(
                lessons,
                off_slots,
                subject_limits,
                run_seed,
                1,
                clock,
            )
        {
            moves += 1;
            moved = true;
        }
        if !moved
            && !clock.should_stop_quality()
            && try_compact_teacher_gap_by_same_class_pair_swap(
                lessons,
                off_slots,
                subject_limits,
                run_seed,
                1,
                clock,
            )
        {
            moves += 1;
            moved = true;
        }
        if !moved {
            break;
        }
    }
    moves
}

fn try_compact_teacher_gap_session_by_class_swap(
    lessons: &mut Vec<Value>,
    gap_session: &TeacherGapSession,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    clock: &SolveClock,
) -> bool {
    if clock.should_stop_quality() {
        return false;
    }
    let Some((target_teacher, _, _)) = parse_teacher_session_key(&gap_session.key) else {
        return false;
    };
    let before_gap = teacher_gap_metrics(lessons);
    let before_sessions = count_teacher_sessions(lessons);
    let before_one_period = count_one_period_teacher_sessions(lessons);
    let allowed_sessions = teacher_session_key_set(lessons);
    let mut best: Option<(i64, usize, usize, Slot, Slot)> = None;
    let mut best_move: Option<(i64, usize, Slot)> = None;
    let mut deadline_reached = false;

    'focused_sources: for source_index in &gap_session.indices {
        if clock.should_stop_quality() {
            deadline_reached = true;
            break;
        }
        let source_index = *source_index;
        if source_index >= lessons.len() || lesson_fixed(&lessons[source_index]) {
            continue;
        }
        let source_class = lesson_class_id(&lessons[source_index]);
        if source_class.is_empty() {
            continue;
        }
        let Some(source_slot) = lesson_slot(&lessons[source_index]) else {
            continue;
        };

        for target_period in &gap_session.gap_slots {
            if clock.should_stop_quality() {
                deadline_reached = true;
                break 'focused_sources;
            }
            let target_slot = make_slot(gap_session.day, &gap_session.session_key, *target_period);
            if same_slot(&source_slot, &target_slot) {
                continue;
            }
            if can_move_lesson_to_slot(
                lessons,
                source_index,
                &target_slot,
                off_slots,
                subject_limits,
            ) {
                let mut candidate = lessons.clone();
                set_lesson_slot(&mut candidate[source_index], &target_slot);
                if schedule_hard_ok(&candidate, off_slots, subject_limits) {
                    if !teacher_sessions_subset(&candidate, &allowed_sessions) {
                        continue;
                    }
                    let after_gap = teacher_gap_metrics(&candidate);
                    let after_sessions = count_teacher_sessions(&candidate);
                    let after_one_period = count_one_period_teacher_sessions(&candidate);
                    if after_sessions <= before_sessions
                        && after_one_period <= before_one_period
                        && gap_improved(&before_gap, &after_gap)
                    {
                        let score = after_gap.gap2_plus_sessions * 100_000
                            + after_gap.total_gap * 1_000
                            + after_one_period * 100
                            + after_sessions
                            + move_jitter(&lessons[source_index], &target_slot, run_seed);
                        match &best_move {
                            Some((best_score, _, _)) if *best_score <= score => {}
                            _ => best_move = Some((score, source_index, target_slot.clone())),
                        }
                    }
                }
            }
            if clock.should_stop_quality() {
                deadline_reached = true;
                break 'focused_sources;
            }
            let Some(blocker_index) = lessons.iter().enumerate().find_map(|(index, lesson)| {
                if index == source_index || lesson_class_id(lesson) != source_class {
                    return None;
                }
                let slot = lesson_slot(lesson)?;
                same_slot(&slot, &target_slot).then_some(index)
            }) else {
                continue;
            };
            if lesson_fixed(&lessons[blocker_index]) {
                continue;
            }

            let mut candidate = lessons.clone();
            set_lesson_slot(&mut candidate[source_index], &target_slot);
            set_lesson_slot(&mut candidate[blocker_index], &source_slot);
            if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                continue;
            }
            if !teacher_sessions_subset(&candidate, &allowed_sessions) {
                continue;
            }

            let after_gap = teacher_gap_metrics(&candidate);
            let after_sessions = count_teacher_sessions(&candidate);
            let after_one_period = count_one_period_teacher_sessions(&candidate);
            if after_sessions > before_sessions || after_one_period > before_one_period {
                continue;
            }
            if !gap_improved(&before_gap, &after_gap) {
                continue;
            }

            let score = after_gap.gap2_plus_sessions * 100_000
                + after_gap.total_gap * 1_000
                + after_one_period * 100
                + after_sessions
                + move_jitter(&lessons[source_index], &target_slot, run_seed)
                + move_jitter(&lessons[blocker_index], &source_slot, run_seed);
            match &best {
                Some((best_score, _, _, _, _)) if *best_score <= score => {}
                _ => {
                    best = Some((
                        score,
                        source_index,
                        blocker_index,
                        target_slot,
                        source_slot.clone(),
                    ))
                }
            }
        }
    }

    'teacher_sources: for source_index in 0..lessons.len() {
        if deadline_reached || clock.should_stop_quality() {
            break;
        }
        if gap_session.indices.contains(&source_index)
            || lesson_fixed(&lessons[source_index])
            || lesson_teacher_key(&lessons[source_index]) != target_teacher
        {
            continue;
        }
        let source_class = lesson_class_id(&lessons[source_index]);
        if source_class.is_empty() {
            continue;
        }
        let Some(source_slot) = lesson_slot(&lessons[source_index]) else {
            continue;
        };
        for target_period in &gap_session.gap_slots {
            if clock.should_stop_quality() {
                break 'teacher_sources;
            }
            let target_slot = make_slot(gap_session.day, &gap_session.session_key, *target_period);
            if same_slot(&source_slot, &target_slot) {
                continue;
            }
            if can_move_lesson_to_slot(
                lessons,
                source_index,
                &target_slot,
                off_slots,
                subject_limits,
            ) {
                let mut candidate = lessons.clone();
                set_lesson_slot(&mut candidate[source_index], &target_slot);
                if schedule_hard_ok(&candidate, off_slots, subject_limits) {
                    if !teacher_sessions_subset(&candidate, &allowed_sessions) {
                        continue;
                    }
                    let after_gap = teacher_gap_metrics(&candidate);
                    let after_sessions = count_teacher_sessions(&candidate);
                    let after_one_period = count_one_period_teacher_sessions(&candidate);
                    if after_sessions <= before_sessions
                        && after_one_period <= before_one_period
                        && gap_improved(&before_gap, &after_gap)
                    {
                        let score = after_gap.gap2_plus_sessions * 100_000
                            + after_gap.total_gap * 1_000
                            + after_one_period * 100
                            + after_sessions
                            + move_jitter(&lessons[source_index], &target_slot, run_seed);
                        match &best_move {
                            Some((best_score, _, _)) if *best_score <= score => {}
                            _ => best_move = Some((score, source_index, target_slot.clone())),
                        }
                    }
                }
            }

            if clock.should_stop_quality() {
                break 'teacher_sources;
            }

            let Some(blocker_index) = lessons.iter().enumerate().find_map(|(index, lesson)| {
                if index == source_index || lesson_class_id(lesson) != source_class {
                    return None;
                }
                let slot = lesson_slot(lesson)?;
                same_slot(&slot, &target_slot).then_some(index)
            }) else {
                continue;
            };
            if lesson_fixed(&lessons[blocker_index]) {
                continue;
            }
            let mut candidate = lessons.clone();
            set_lesson_slot(&mut candidate[source_index], &target_slot);
            set_lesson_slot(&mut candidate[blocker_index], &source_slot);
            if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                continue;
            }
            if !teacher_sessions_subset(&candidate, &allowed_sessions) {
                continue;
            }
            let after_gap = teacher_gap_metrics(&candidate);
            let after_sessions = count_teacher_sessions(&candidate);
            let after_one_period = count_one_period_teacher_sessions(&candidate);
            if after_sessions > before_sessions || after_one_period > before_one_period {
                continue;
            }
            if !gap_improved(&before_gap, &after_gap) {
                continue;
            }
            let score = after_gap.gap2_plus_sessions * 100_000
                + after_gap.total_gap * 1_000
                + after_one_period * 100
                + after_sessions
                + move_jitter(&lessons[source_index], &target_slot, run_seed)
                + move_jitter(&lessons[blocker_index], &source_slot, run_seed);
            match &best {
                Some((best_score, _, _, _, _)) if *best_score <= score => {}
                _ => {
                    best = Some((
                        score,
                        source_index,
                        blocker_index,
                        target_slot,
                        source_slot.clone(),
                    ))
                }
            }
        }
    }

    match (best_move, best) {
        (
            Some((move_score, source_index, target_slot)),
            Some((swap_score, swap_source, blocker_index, swap_target, source_slot)),
        ) => {
            if move_score <= swap_score {
                set_lesson_slot(&mut lessons[source_index], &target_slot);
            } else {
                set_lesson_slot(&mut lessons[swap_source], &swap_target);
                set_lesson_slot(&mut lessons[blocker_index], &source_slot);
            }
            return true;
        }
        (Some((_, source_index, target_slot)), None) => {
            set_lesson_slot(&mut lessons[source_index], &target_slot);
            return true;
        }
        (None, Some((_, source_index, blocker_index, target_slot, source_slot))) => {
            set_lesson_slot(&mut lessons[source_index], &target_slot);
            set_lesson_slot(&mut lessons[blocker_index], &source_slot);
            return true;
        }
        (None, None) => {}
    }
    false
}

fn gap_improved(before: &TeacherGapMetrics, after: &TeacherGapMetrics) -> bool {
    after.gap2_plus_sessions < before.gap2_plus_sessions
        || (after.gap2_plus_sessions == before.gap2_plus_sessions
            && after.total_gap < before.total_gap)
}

fn try_compact_teacher_gap_by_same_class_pair_swap(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    min_gap: i64,
    clock: &SolveClock,
) -> bool {
    if clock.should_stop_quality() {
        return false;
    }
    let before_gap = teacher_gap_metrics(lessons);
    if before_gap.total_gap <= 0 {
        return false;
    }
    let before_sessions = count_teacher_sessions(lessons);
    let before_one_period = count_one_period_teacher_sessions(lessons);
    let allowed_sessions = teacher_session_key_set(lessons);
    let gap_sessions = teacher_gap_sessions(lessons)
        .into_iter()
        .filter(|session| session.gaps >= min_gap)
        .collect::<Vec<_>>();
    if gap_sessions.is_empty() {
        return false;
    }
    let mut focus_indices = HashSet::new();
    let mut focus_classes = HashSet::new();
    for session in &gap_sessions {
        for index in &session.indices {
            focus_indices.insert(*index);
            if let Some(lesson) = lessons.get(*index) {
                let class_id = lesson_class_id(lesson);
                if !class_id.is_empty() {
                    focus_classes.insert(class_id);
                }
            }
        }
    }
    let mut by_class: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, lesson) in lessons.iter().enumerate() {
        if lesson_fixed(lesson) {
            continue;
        }
        let class_id = lesson_class_id(lesson);
        if class_id.is_empty() || !focus_classes.contains(&class_id) {
            continue;
        }
        by_class.entry(class_id).or_default().push(index);
    }

    let mut best: Option<(i64, usize, usize, Slot, Slot)> = None;
    let mut checked = 0_i64;
    let check_limit = (focus_indices.len() as i64 * 240).clamp(2_000, 14_000);
    'class_pairs: for indices in by_class.values() {
        for left_pos in 0..indices.len() {
            for right_pos in (left_pos + 1)..indices.len() {
                if clock.should_stop_quality() {
                    break 'class_pairs;
                }
                checked += 1;
                if checked > check_limit {
                    break;
                }
                let left = indices[left_pos];
                let right = indices[right_pos];
                if !focus_indices.contains(&left) && !focus_indices.contains(&right) {
                    continue;
                }
                let Some(left_slot) = lesson_slot(&lessons[left]) else {
                    continue;
                };
                let Some(right_slot) = lesson_slot(&lessons[right]) else {
                    continue;
                };
                if same_slot(&left_slot, &right_slot) {
                    continue;
                }
                let mut candidate = lessons.clone();
                set_lesson_slot(&mut candidate[left], &right_slot);
                set_lesson_slot(&mut candidate[right], &left_slot);
                if !schedule_hard_ok(&candidate, off_slots, subject_limits) {
                    continue;
                }
                if !teacher_sessions_subset(&candidate, &allowed_sessions) {
                    continue;
                }
                let after_gap = teacher_gap_metrics(&candidate);
                if !gap_improved(&before_gap, &after_gap) {
                    continue;
                }
                let after_sessions = count_teacher_sessions(&candidate);
                let after_one_period = count_one_period_teacher_sessions(&candidate);
                if after_sessions > before_sessions || after_one_period > before_one_period {
                    continue;
                }
                let score = after_gap.gap2_plus_sessions * 100_000
                    + after_gap.total_gap * 1_000
                    + after_one_period * 100
                    + after_sessions
                    + move_jitter(&lessons[left], &right_slot, run_seed)
                    + move_jitter(&lessons[right], &left_slot, run_seed);
                match &best {
                    Some((best_score, _, _, _, _)) if *best_score <= score => {}
                    _ => best = Some((score, left, right, right_slot, left_slot)),
                }
            }
            if checked > check_limit {
                break;
            }
        }
        if checked > check_limit {
            break;
        }
    }

    if let Some((_, left, right, left_target, right_target)) = best {
        set_lesson_slot(&mut lessons[left], &left_target);
        set_lesson_slot(&mut lessons[right], &right_target);
        return true;
    }
    false
}

fn try_compact_teacher_gap_by_class_chain(
    lessons: &mut Vec<Value>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    run_seed: u64,
    minimum_gap: i64,
    clock: &SolveClock,
) -> bool {
    if clock.should_stop_quality() {
        return false;
    }
    let before_gap = teacher_gap_metrics(lessons);
    let minimum_gap = minimum_gap.clamp(1, 2);
    if (minimum_gap >= 2 && before_gap.gap2_plus_sessions <= 0)
        || (minimum_gap == 1 && before_gap.total_gap <= 0)
    {
        return false;
    }

    let before_sessions = count_teacher_sessions(lessons);
    let before_one_period = count_one_period_teacher_sessions(lessons);
    let allowed_sessions = teacher_session_key_set(lessons);
    let mut best: Option<(i64, Vec<(usize, Slot)>)> = None;
    let mut checked = 0_i64;
    let check_limit = (lessons.len() as i64 * 4).clamp(1_200, 8_000);
    let mut gap_sessions = teacher_gap_sessions(lessons)
        .into_iter()
        .filter(|session| session.gaps >= minimum_gap)
        .collect::<Vec<_>>();
    gap_sessions.sort_by(|a, b| {
        b.gaps
            .cmp(&a.gaps)
            .then_with(|| {
                teacher_session_jitter(&a.key, run_seed)
                    .cmp(&teacher_session_jitter(&b.key, run_seed))
            })
            .then_with(|| a.key.cmp(&b.key))
    });

    'gap_sessions: for gap_session in gap_sessions {
        if clock.should_stop_quality() || checked >= check_limit {
            break;
        }
        let Some((target_teacher, _, _)) = parse_teacher_session_key(&gap_session.key) else {
            continue;
        };
        let mut source_indices = gap_session.indices.clone();
        for (index, lesson) in lessons.iter().enumerate() {
            if clock.should_stop_quality() {
                break 'gap_sessions;
            }
            if gap_session.indices.contains(&index)
                || lesson_fixed(lesson)
                || lesson_teacher_key(lesson) != target_teacher
            {
                continue;
            }
            source_indices.push(index);
        }
        source_indices.sort_by(|left, right| {
            let left_focus = !gap_session.indices.contains(left);
            let right_focus = !gap_session.indices.contains(right);
            left_focus
                .cmp(&right_focus)
                .then_with(|| {
                    let left_score = lesson_slot(&lessons[*left])
                        .map(|slot| move_jitter(&lessons[*left], &slot, run_seed))
                        .unwrap_or(0);
                    let right_score = lesson_slot(&lessons[*right])
                        .map(|slot| move_jitter(&lessons[*right], &slot, run_seed))
                        .unwrap_or(0);
                    left_score.cmp(&right_score)
                })
                .then_with(|| left.cmp(right))
        });
        source_indices.dedup();
        source_indices.truncate(12);

        for source_index in source_indices {
            if clock.should_stop_quality() || checked >= check_limit {
                break 'gap_sessions;
            }
            if source_index >= lessons.len() || lesson_fixed(&lessons[source_index]) {
                continue;
            }
            let source_class = lesson_class_id(&lessons[source_index]);
            if source_class.is_empty() {
                continue;
            }
            let Some(source_slot) = lesson_slot(&lessons[source_index]) else {
                continue;
            };
            for target_period in &gap_session.gap_slots {
                if clock.should_stop_quality() || checked >= check_limit {
                    break 'gap_sessions;
                }
                let target_slot =
                    make_slot(gap_session.day, &gap_session.session_key, *target_period);
                if same_slot(&source_slot, &target_slot)
                    || !chain_lesson_can_target(
                        lessons,
                        source_index,
                        &source_class,
                        &target_slot,
                        off_slots,
                        &allowed_sessions,
                    )
                {
                    continue;
                }

                let mut moves = vec![(source_index, target_slot.clone())];
                let mut used_indices = HashSet::new();
                used_indices.insert(source_index);
                let Some(blocker_index) = class_slot_occupant(lessons, &source_class, &target_slot)
                else {
                    consider_gap_chain_candidate(
                        lessons,
                        &moves,
                        off_slots,
                        subject_limits,
                        &allowed_sessions,
                        &before_gap,
                        before_sessions,
                        before_one_period,
                        run_seed,
                        &mut best,
                        &mut checked,
                        check_limit,
                        clock,
                    );
                    continue;
                };
                if lesson_fixed(&lessons[blocker_index]) {
                    continue;
                }
                used_indices.insert(blocker_index);
                let Some(blocker_slot) = lesson_slot(&lessons[blocker_index]) else {
                    continue;
                };
                search_gap_chain_repair(
                    lessons,
                    &source_class,
                    &source_slot,
                    blocker_index,
                    &blocker_slot,
                    2,
                    &mut moves,
                    &mut used_indices,
                    off_slots,
                    subject_limits,
                    &allowed_sessions,
                    &before_gap,
                    before_sessions,
                    before_one_period,
                    run_seed,
                    &mut best,
                    &mut checked,
                    check_limit,
                    clock,
                );
            }
        }
    }

    if let Some((_, moves)) = best {
        for (index, slot) in moves {
            set_lesson_slot(&mut lessons[index], &slot);
        }
        return true;
    }
    false
}

fn search_gap_chain_repair(
    lessons: &[Value],
    class_id: &str,
    source_slot: &Slot,
    current_index: usize,
    current_slot: &Slot,
    depth_remaining: usize,
    moves: &mut Vec<(usize, Slot)>,
    used_indices: &mut HashSet<usize>,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    allowed_sessions: &HashSet<String>,
    before_gap: &TeacherGapMetrics,
    before_sessions: i64,
    before_one_period: i64,
    run_seed: u64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
    checked: &mut i64,
    check_limit: i64,
    clock: &SolveClock,
) {
    if clock.should_stop_quality() || *checked >= check_limit {
        return;
    }
    if !same_slot(current_slot, source_slot)
        && !chain_target_slot_used(moves, source_slot)
        && chain_lesson_can_target(
            lessons,
            current_index,
            class_id,
            source_slot,
            off_slots,
            allowed_sessions,
        )
    {
        moves.push((current_index, source_slot.clone()));
        consider_gap_chain_candidate(
            lessons,
            moves,
            off_slots,
            subject_limits,
            allowed_sessions,
            before_gap,
            before_sessions,
            before_one_period,
            run_seed,
            best,
            checked,
            check_limit,
            clock,
        );
        moves.pop();
    }

    if depth_remaining == 0 || clock.should_stop_quality() || *checked >= check_limit {
        return;
    }

    let candidate_slots = chain_candidate_slots(
        lessons,
        class_id,
        current_index,
        current_slot,
        off_slots,
        allowed_sessions,
        run_seed,
        clock,
    );
    for next_slot in candidate_slots {
        if clock.should_stop_quality() || *checked >= check_limit {
            break;
        }
        if same_slot(&next_slot, source_slot)
            || same_slot(&next_slot, current_slot)
            || chain_target_slot_used(moves, &next_slot)
        {
            continue;
        }
        let occupant = class_slot_occupant(lessons, class_id, &next_slot);
        moves.push((current_index, next_slot.clone()));
        match occupant {
            Some(next_index) => {
                if !used_indices.contains(&next_index) && !lesson_fixed(&lessons[next_index]) {
                    if let Some(next_current_slot) = lesson_slot(&lessons[next_index]) {
                        used_indices.insert(next_index);
                        search_gap_chain_repair(
                            lessons,
                            class_id,
                            source_slot,
                            next_index,
                            &next_current_slot,
                            depth_remaining.saturating_sub(1),
                            moves,
                            used_indices,
                            off_slots,
                            subject_limits,
                            allowed_sessions,
                            before_gap,
                            before_sessions,
                            before_one_period,
                            run_seed,
                            best,
                            checked,
                            check_limit,
                            clock,
                        );
                        used_indices.remove(&next_index);
                    }
                }
            }
            None => {
                consider_gap_chain_candidate(
                    lessons,
                    moves,
                    off_slots,
                    subject_limits,
                    allowed_sessions,
                    before_gap,
                    before_sessions,
                    before_one_period,
                    run_seed,
                    best,
                    checked,
                    check_limit,
                    clock,
                );
            }
        }
        moves.pop();
    }
}

fn consider_gap_chain_candidate(
    lessons: &[Value],
    moves: &[(usize, Slot)],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
    allowed_sessions: &HashSet<String>,
    before_gap: &TeacherGapMetrics,
    before_sessions: i64,
    before_one_period: i64,
    run_seed: u64,
    best: &mut Option<(i64, Vec<(usize, Slot)>)>,
    checked: &mut i64,
    check_limit: i64,
    clock: &SolveClock,
) {
    if clock.should_stop_quality() || *checked >= check_limit {
        return;
    }
    *checked += 1;
    let mut candidate = lessons.to_vec();
    for (index, slot) in moves {
        if *index >= candidate.len() {
            return;
        }
        set_lesson_slot(&mut candidate[*index], slot);
    }
    if !schedule_hard_ok(&candidate, off_slots, subject_limits)
        || !teacher_sessions_subset(&candidate, allowed_sessions)
    {
        return;
    }
    let after_gap = teacher_gap_metrics(&candidate);
    if !gap_improved(before_gap, &after_gap) {
        return;
    }
    let after_sessions = count_teacher_sessions(&candidate);
    let after_one_period = count_one_period_teacher_sessions(&candidate);
    if after_sessions > before_sessions || after_one_period > before_one_period {
        return;
    }
    let jitter = moves
        .iter()
        .map(|(index, slot)| move_jitter(&lessons[*index], slot, run_seed))
        .sum::<i64>();
    let score = after_gap.gap2_plus_sessions * 1_000_000
        + after_gap.total_gap * 10_000
        + after_one_period * 500
        + after_sessions * 20
        + moves.len() as i64 * 7
        + jitter;
    match best {
        Some((best_score, _)) if *best_score <= score => {}
        _ => *best = Some((score, moves.to_vec())),
    }
}

fn chain_candidate_slots(
    lessons: &[Value],
    class_id: &str,
    lesson_index: usize,
    current_slot: &Slot,
    off_slots: &HashSet<String>,
    allowed_sessions: &HashSet<String>,
    run_seed: u64,
    clock: &SolveClock,
) -> Vec<Slot> {
    let mut slots = Vec::new();
    let mut seen = HashSet::new();
    for lesson in lessons {
        if clock.should_stop_quality() {
            break;
        }
        if lesson_class_id(lesson) != class_id {
            continue;
        }
        if let Some(slot) = lesson_slot(lesson) {
            let key = slot_key(class_id, &slot);
            if seen.insert(key)
                && chain_lesson_can_target(
                    lessons,
                    lesson_index,
                    class_id,
                    &slot,
                    off_slots,
                    allowed_sessions,
                )
            {
                slots.push(slot);
            }
        }
    }
    'calendar_slots: for (_, day_num) in DAYS {
        for (session_key, _) in SESSIONS {
            for period_index in 0..PERIODS_PER_SESSION {
                if clock.should_stop_quality() {
                    break 'calendar_slots;
                }
                let slot = make_slot(day_num, session_key, period_index);
                let key = slot_key(class_id, &slot);
                if seen.insert(key)
                    && chain_lesson_can_target(
                        lessons,
                        lesson_index,
                        class_id,
                        &slot,
                        off_slots,
                        allowed_sessions,
                    )
                {
                    slots.push(slot);
                }
            }
        }
    }
    slots.sort_by(|left, right| {
        let left_empty = class_slot_occupant(lessons, class_id, left).is_none();
        let right_empty = class_slot_occupant(lessons, class_id, right).is_none();
        left_empty
            .cmp(&right_empty)
            .then_with(|| {
                let left_distance = (left.day - current_slot.day).abs() * 10
                    + if left.session_key == current_slot.session_key {
                        0
                    } else {
                        5
                    }
                    + (left.period_index - current_slot.period_index).abs();
                let right_distance = (right.day - current_slot.day).abs() * 10
                    + if right.session_key == current_slot.session_key {
                        0
                    } else {
                        5
                    }
                    + (right.period_index - current_slot.period_index).abs();
                left_distance.cmp(&right_distance)
            })
            .then_with(|| {
                move_jitter(&lessons[lesson_index], left, run_seed).cmp(&move_jitter(
                    &lessons[lesson_index],
                    right,
                    run_seed,
                ))
            })
    });
    slots.truncate(14);
    slots
}

fn chain_lesson_can_target(
    lessons: &[Value],
    lesson_index: usize,
    class_id: &str,
    target_slot: &Slot,
    off_slots: &HashSet<String>,
    allowed_sessions: &HashSet<String>,
) -> bool {
    if lesson_index >= lessons.len()
        || lesson_fixed(&lessons[lesson_index])
        || off_slots.contains(&slot_key(class_id, target_slot))
    {
        return false;
    }
    let teacher = lesson_teacher_key(&lessons[lesson_index]);
    teacher.is_empty()
        || allowed_sessions.contains(&teacher_session_key(
            &teacher,
            target_slot.day,
            &target_slot.session_key,
        ))
}

fn class_slot_occupant(lessons: &[Value], class_id: &str, slot: &Slot) -> Option<usize> {
    lessons.iter().enumerate().find_map(|(index, lesson)| {
        if lesson_class_id(lesson) != class_id {
            return None;
        }
        let lesson_slot = lesson_slot(lesson)?;
        same_slot(&lesson_slot, slot).then_some(index)
    })
}

fn chain_target_slot_used(moves: &[(usize, Slot)], slot: &Slot) -> bool {
    moves
        .iter()
        .any(|(_, target_slot)| same_slot(target_slot, slot))
}

fn schedule_hard_ok(
    lessons: &[Value],
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
) -> bool {
    let mut class_slots = HashSet::new();
    let mut teacher_slots = HashSet::new();
    let mut room_slots = HashSet::new();
    let mut subject_session_positions: HashMap<(String, String, i64, String), Vec<i64>> =
        HashMap::new();
    let mut subject_day_counts: HashMap<(String, String, i64), i64> = HashMap::new();

    for lesson in lessons {
        let class_id = lesson_class_id(lesson);
        let subject = lesson_subject(lesson);
        let Some(slot) = lesson_slot(lesson) else {
            return false;
        };
        if class_id.is_empty() || subject.is_empty() {
            return false;
        }
        if off_slots.contains(&slot_key(&class_id, &slot)) {
            return false;
        }
        let class_slot = slot_key(&class_id, &slot);
        if !class_slots.insert(class_slot) {
            return false;
        }
        let teacher = lesson_teacher_key(lesson);
        if !teacher.is_empty() && !teacher_slots.insert(resource_slot_key(&teacher, &slot)) {
            return false;
        }
        let room = norm(&lesson_room(lesson));
        if !room.is_empty() && !room_slots.insert(resource_slot_key(&room, &slot)) {
            return false;
        }
        let subject_key = norm(&subject);
        subject_session_positions
            .entry((
                class_id.clone(),
                subject_key.clone(),
                slot.day,
                slot.session_key,
            ))
            .or_default()
            .push(slot.period_index);
        *subject_day_counts
            .entry((class_id, subject_key, slot.day))
            .or_insert(0) += 1;
    }

    for ((class_id, subject_key, _, _), periods) in subject_session_positions {
        let limit = subject_limits
            .get(&(class_id, subject_key))
            .map(|rule| rule.per_session)
            .unwrap_or(1)
            .max(1);
        if periods.len() as i64 > limit {
            return false;
        }
        if periods.len() > 1 && !consecutive_periods(&periods) {
            return false;
        }
    }
    for ((class_id, subject_key, day), count) in subject_day_counts {
        if subject_limits
            .get(&(class_id, subject_key))
            .and_then(|rule| rule.per_day.get(&day))
            .is_some_and(|limit| count > *limit)
        {
            return false;
        }
    }
    true
}

fn can_move_lesson_to_slot(
    lessons: &[Value],
    lesson_index: usize,
    target_slot: &Slot,
    off_slots: &HashSet<String>,
    subject_limits: &SubjectLimitMap,
) -> bool {
    let lesson = &lessons[lesson_index];
    if lesson_fixed(lesson) {
        return false;
    }
    let class_id = lesson_class_id(lesson);
    let subject = lesson_subject(lesson);
    if class_id.is_empty() || subject.is_empty() {
        return false;
    }
    let Some(source_slot) = lesson_slot(lesson) else {
        return false;
    };
    if same_slot(&source_slot, target_slot) {
        return false;
    }
    if off_slots.contains(&slot_key(&class_id, target_slot)) {
        return false;
    }

    let teacher = lesson_teacher_key(lesson);
    let room = norm(&lesson_room(lesson));
    for (index, other) in lessons.iter().enumerate() {
        if index == lesson_index {
            continue;
        }
        let Some(other_slot) = lesson_slot(other) else {
            continue;
        };
        if same_slot(&other_slot, target_slot) {
            if lesson_class_id(other) == class_id {
                return false;
            }
            if !teacher.is_empty() && lesson_teacher_key(other) == teacher {
                return false;
            }
            if !room.is_empty() && norm(&lesson_room(other)) == room {
                return false;
            }
        }
    }

    let mut days = vec![source_slot.day, target_slot.day];
    days.sort();
    days.dedup();
    days.into_iter().all(|day| {
        class_subject_limits_ok_after_move(
            lessons,
            lesson_index,
            target_slot,
            &class_id,
            &subject,
            day,
            subject_limits,
        )
    })
}

fn class_subject_limits_ok_after_move(
    lessons: &[Value],
    moving_index: usize,
    target_slot: &Slot,
    class_id: &str,
    subject: &str,
    day: i64,
    subject_limits: &SubjectLimitMap,
) -> bool {
    let subject_key = norm(subject);
    let mut positions_by_session: HashMap<String, Vec<i64>> = HashMap::new();
    for (index, lesson) in lessons.iter().enumerate() {
        if lesson_class_id(lesson) != class_id || norm(&lesson_subject(lesson)) != subject_key {
            continue;
        }
        let slot = if index == moving_index {
            target_slot.clone()
        } else {
            let Some(slot) = lesson_slot(lesson) else {
                continue;
            };
            slot
        };
        if slot.day == day {
            positions_by_session
                .entry(slot.session_key)
                .or_default()
                .push(slot.period_index);
        }
    }
    let rule = subject_limits.get(&(class_id.to_string(), subject_key));
    let session_limit = rule.map(|item| item.per_session).unwrap_or(1).max(1);
    let day_count = positions_by_session
        .values()
        .map(|periods| periods.len() as i64)
        .sum::<i64>();
    if rule
        .and_then(|item| item.per_day.get(&day))
        .is_some_and(|limit| day_count > *limit)
    {
        return false;
    }
    positions_by_session.values().all(|periods| {
        periods.len() as i64 <= session_limit
            && (periods.len() <= 1 || consecutive_periods(periods))
    })
}

fn teacher_session_index(lessons: &[Value]) -> HashMap<String, Vec<usize>> {
    let mut out: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, lesson) in lessons.iter().enumerate() {
        let teacher = lesson_teacher_key(lesson);
        if teacher.is_empty() {
            continue;
        }
        let Some(slot) = lesson_slot(lesson) else {
            continue;
        };
        out.entry(teacher_session_key(&teacher, slot.day, &slot.session_key))
            .or_default()
            .push(index);
    }
    out
}

fn teacher_session_key_set(lessons: &[Value]) -> HashSet<String> {
    teacher_session_index(lessons).into_keys().collect()
}

fn teacher_sessions_subset(lessons: &[Value], allowed: &HashSet<String>) -> bool {
    teacher_session_key_set(lessons)
        .iter()
        .all(|key| allowed.contains(key))
}

fn teacher_gap_metrics(lessons: &[Value]) -> TeacherGapMetrics {
    let mut metrics = TeacherGapMetrics::default();
    for session in teacher_gap_sessions(lessons) {
        if session.gaps <= 0 {
            continue;
        }
        metrics.total_gap += session.gaps;
        *metrics
            .distribution
            .entry(session.gaps.to_string())
            .or_insert(0) += 1;
        if session.gaps >= 2 {
            metrics.gap2_plus_sessions += 1;
        }
    }
    metrics
}

fn teacher_gap_sessions(lessons: &[Value]) -> Vec<TeacherGapSession> {
    teacher_session_index(lessons)
        .into_iter()
        .filter_map(|(key, indices)| {
            let (teacher, day, session_key) = parse_teacher_session_key(&key)?;
            if teacher.is_empty() {
                return None;
            }
            let mut periods = indices
                .iter()
                .filter_map(|index| lesson_slot(lessons.get(*index)?).map(|slot| slot.period_index))
                .collect::<Vec<_>>();
            periods.sort();
            periods.dedup();
            let gaps = teacher_gap_count(&periods);
            let min_period = periods.first().copied().unwrap_or(0);
            let max_period = periods.last().copied().unwrap_or(-1);
            let gap_slots = if gaps > 0 {
                (min_period..=max_period)
                    .filter(|period| !periods.contains(period))
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            Some(TeacherGapSession {
                key,
                day,
                session_key,
                indices,
                gap_slots,
                gaps,
            })
        })
        .collect()
}

fn teacher_session_key(teacher_key: &str, day: i64, session_key: &str) -> String {
    format!("{}|{}|{}", teacher_key, day, session_key)
}

fn parse_teacher_session_key(value: &str) -> Option<(String, i64, String)> {
    let mut parts = value.split('|');
    let teacher = parts.next()?.to_string();
    let day = parts.next()?.parse::<i64>().ok()?;
    let session = parts.next()?.to_string();
    if parts.next().is_some() {
        return None;
    }
    Some((teacher, day, session))
}

fn lesson_string(lesson: &Value, key: &str) -> String {
    lesson
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn lesson_class_id(lesson: &Value) -> String {
    lesson_string(lesson, "classId")
}

fn lesson_subject(lesson: &Value) -> String {
    lesson_string(lesson, "subject")
}

fn lesson_room(lesson: &Value) -> String {
    lesson_string(lesson, "room")
}

fn lesson_teacher_key(lesson: &Value) -> String {
    norm(&lesson_string(lesson, "teacher"))
}

fn lesson_fixed(lesson: &Value) -> bool {
    lesson
        .get("fixed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn lesson_slot(lesson: &Value) -> Option<Slot> {
    let day = lesson.get("day").and_then(Value::as_i64)?;
    let session_raw = lesson.get("session").and_then(Value::as_str)?;
    let period_index = lesson.get("period").and_then(Value::as_i64)? - 1;
    if !(0..PERIODS_PER_SESSION).contains(&period_index) {
        return None;
    }
    let session_key = session_key_from_label(session_raw).to_string();
    Some(make_slot(day, &session_key, period_index))
}

fn make_slot(day: i64, session_key: &str, period_index: i64) -> Slot {
    Slot {
        day_key: day_key_from_number(day),
        day,
        session_key: session_key.to_string(),
        session: session_label_from_key(session_key),
        period_index,
    }
}

fn day_key_from_number(day: i64) -> String {
    DAYS.iter()
        .find_map(|(key, number)| (*number == day).then(|| (*key).to_string()))
        .unwrap_or_else(|| format!("thu{day}"))
}

fn session_label_from_key(session_key: &str) -> &'static str {
    match session_key {
        "sang" => "AM",
        "chieu" => "PM",
        _ => "AM",
    }
}

fn same_slot(a: &Slot, b: &Slot) -> bool {
    a.day == b.day && a.session_key == b.session_key && a.period_index == b.period_index
}

fn set_lesson_slot(lesson: &mut Value, slot: &Slot) {
    if let Value::Object(map) = lesson {
        map.insert("day".to_string(), json!(slot.day));
        map.insert("session".to_string(), json!(slot.session));
        map.insert("period".to_string(), json!(slot.period_index + 1));
    }
}

fn teacher_session_jitter(key: &str, run_seed: u64) -> i64 {
    let mut hash = run_seed ^ 0x517cc1b727220a95_u64;
    hash_part(&mut hash, key);
    (hash % 997) as i64
}

fn class_jitter(class_id: &str, run_seed: u64) -> i64 {
    let mut hash = run_seed ^ 0x7f4a7c15d3b5e9d1_u64;
    hash_part(&mut hash, class_id);
    (hash % 997) as i64
}

fn lesson_jitter(lesson: &Value, run_seed: u64) -> i64 {
    let mut hash = run_seed ^ 0x68143d7b9a2f04c3_u64;
    hash_part(&mut hash, &lesson_class_id(lesson));
    hash_part(&mut hash, &lesson_subject(lesson));
    hash_part(&mut hash, &lesson_teacher_key(lesson));
    (hash % 997) as i64
}

fn move_jitter(lesson: &Value, slot: &Slot, run_seed: u64) -> i64 {
    let mut hash = run_seed ^ 0x94d049bb133111eb_u64;
    hash_part(&mut hash, &lesson_class_id(lesson));
    hash_part(&mut hash, &lesson_subject(lesson));
    hash_part(&mut hash, &slot.day_key);
    hash_part(&mut hash, &slot.session_key);
    hash_part(&mut hash, &slot.period_index.to_string());
    (hash % 313) as i64
}

fn parse_slot_key(value: &str) -> Option<(&str, &str, i64)> {
    let mut parts = value.split('|');
    let day = parts.next()?;
    let session = parts.next()?;
    let period = parts.next()?.parse::<i64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if !DAYS.iter().any(|(key, _)| *key == day) {
        return None;
    }
    if !SESSIONS.iter().any(|(key, _)| *key == session) {
        return None;
    }
    if !(0..PERIODS_PER_SESSION).contains(&period) {
        return None;
    }
    Some((day, session, period))
}

fn numeric_matrix(value: Option<&Value>) -> HashMap<String, i64> {
    value
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    let number = int_value(Some(value), 0);
                    (number > 0).then(|| (key.clone(), number))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn string_matrix(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    let text = string_value(value);
                    (!text.is_empty()).then(|| (key.clone(), text))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn value_array(value: Option<&Value>) -> &[Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn get_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn int_value(value: Option<&Value>, default: i64) -> i64 {
    match value {
        Some(Value::Number(value)) => value.as_i64().unwrap_or(default),
        Some(Value::String(value)) => value
            .trim()
            .parse::<f64>()
            .map(|v| v as i64)
            .unwrap_or(default),
        Some(Value::Bool(value)) => i64::from(*value),
        _ => default,
    }
}

fn string_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

fn teacher_value(value: &Value) -> String {
    string_value(value)
        .split([',', ';', '\n', '\r'])
        .map(str::trim)
        .find(|item| !item.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn canonical_subject(value: &str, subject_alias: &HashMap<String, String>) -> String {
    let trimmed = value.trim();
    subject_alias
        .get(&norm(trimmed))
        .cloned()
        .unwrap_or_else(|| trimmed.to_string())
}

fn cell_subject(value: &Value) -> String {
    match value {
        Value::String(value) => {
            if value == "OFF" {
                String::new()
            } else {
                value.trim().to_string()
            }
        }
        Value::Object(_) => get_str(value, "mon")
            .or_else(|| get_str(value, "subject"))
            .or_else(|| get_str(value, "ten"))
            .unwrap_or_default()
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

fn lookup_lesson_resource(
    data: &Map<String, Value>,
    matrix: &str,
    class_id: &str,
    subject: &str,
) -> String {
    let Some(root) = data.get(matrix).and_then(Value::as_object) else {
        return String::new();
    };
    root.get(&format!("{class_id}|{subject}"))
        .map(string_value)
        .unwrap_or_default()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_i64().unwrap_or(0) != 0,
        Value::String(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        _ => false,
    }
}

fn norm(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

fn count_teacher_sessions(lessons: &[Value]) -> i64 {
    let mut sessions = HashSet::new();
    for lesson in lessons {
        let teacher = lesson
            .get("teacher")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if teacher.trim().is_empty() {
            continue;
        }
        let day = lesson.get("day").and_then(Value::as_i64).unwrap_or(0);
        let session = lesson
            .get("session")
            .and_then(Value::as_str)
            .unwrap_or_default();
        sessions.insert(format!("{}|{}|{}", norm(teacher), day, session));
    }
    sessions.len() as i64
}

fn count_one_period_teacher_sessions(lessons: &[Value]) -> i64 {
    teacher_session_index(lessons)
        .values()
        .filter(|indices| indices.len() == 1)
        .count() as i64
}

fn current_timestamp_string() -> String {
    format!("{}", wall_clock_ms() / 1_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject_test_lesson(session_key: &str, session: &'static str, period_index: i64) -> Value {
        lesson_json(
            "6A",
            "6A",
            "Toán",
            "GV01",
            "",
            &Slot {
                day_key: "thu2".to_string(),
                day: 2,
                session_key: session_key.to_string(),
                session,
                period_index,
            },
            false,
        )
    }

    fn subject_test_limits(per_session: i64, per_day: Option<i64>) -> SubjectLimitMap {
        let mut day_limits = HashMap::new();
        if let Some(limit) = per_day {
            day_limits.insert(2, limit);
        }
        HashMap::from([(
            ("6A".to_string(), norm("Toán")),
            SubjectLimit {
                per_session,
                per_day: day_limits,
            },
        )])
    }

    fn teacher_quality_test_lesson(
        class_id: &str,
        teacher: &str,
        day: i64,
        period_index: i64,
    ) -> Value {
        let subject = format!("Subject {class_id}");
        lesson_json(
            class_id,
            class_id,
            &subject,
            teacher,
            "",
            &make_slot(day, "sang", period_index),
            false,
        )
    }

    fn off_except(open_slots: &[(&str, &str, i64)]) -> Vec<String> {
        let open_slots = open_slots.iter().copied().collect::<HashSet<_>>();
        let mut off_slots = Vec::new();
        for (day_key, _) in DAYS {
            for (session_key, _) in SESSIONS {
                for period in 0..PERIODS_PER_SESSION {
                    if !open_slots.contains(&(day_key, session_key, period)) {
                        off_slots.push(format!("{day_key}|{session_key}|{period}"));
                    }
                }
            }
        }
        off_slots
    }

    fn config(require_complete_schedule: bool, best_effort_on_timeout: bool) -> SolverConfig {
        SolverConfig {
            backend_deadline_ms: DEFAULT_SOLVER_DEADLINE_MS,
            native_global_deadline_ms: DEFAULT_SOLVER_DEADLINE_MS,
            native_deadline_reserve_ms: DEFAULT_SOLVER_RESERVE_MS,
            require_complete_schedule,
            best_effort_on_timeout,
            skip_teacher_optimization: false,
            two_stage_teacher_quality: false,
            optimization_focus: OptimizationFocus::Automatic,
            random_seed: 1,
        }
    }

    fn agent_candidate_request() -> Value {
        json!({
            "data": {
                "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
                "monhoc": [
                    {"id":"math", "ten":"Math"},
                    {"id":"literature", "ten":"Literature"}
                ],
                "mon": [
                    {"khoi":"6", "ten":"Math", "sotiet":1, "gioihan":1},
                    {"khoi":"6", "ten":"Literature", "sotiet":1, "gioihan":1}
                ],
                "pccmMatrix": {
                    "6A|Math":"Teacher 1",
                    "6A|Literature":"Teacher 2"
                },
                "pccmTietMatrix": {
                    "6A|Math":1,
                    "6A|Literature":1
                },
                "pccmRoomMatrix": {
                    "6A|Math":"Room 1",
                    "6A|Literature":"Room 2"
                },
                "tkbLessonTeachers": {"6A|Math":"Teacher 1"},
                "tkbLessonRooms": {"6A|Math":"Room 1"},
                "tkb": {
                    "6A": {
                        "thu2": {
                            "sang": [
                                {"mon":"Math", "fixed":true},
                                null,
                                null,
                                null,
                                null
                            ]
                        }
                    }
                }
            },
            "settings": {"require_complete_schedule":true}
        })
    }

    fn agent_candidate_payload() -> Value {
        json!({
            "ok": true,
            "lessons": [
                {
                    "classId":"6A",
                    "className":"forged display name",
                    "subject":"Math",
                    "teacher":"Teacher 1",
                    "room":"Room 1",
                    "day":2,
                    "session":"AM",
                    "period":1,
                    "fixed":false
                },
                {
                    "classId":"6A",
                    "subject":"Literature",
                    "teacher":"Teacher 2",
                    "room":"Room 2",
                    "day":2,
                    "session":"AM",
                    "period":2,
                    "fixed":true
                }
            ],
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods":2,
                "expected_periods":2,
                "unassigned_periods":0,
                "app_constraint_violation_count":0,
                "hard_ok":true,
                "teacher_sessions":999
            },
            "validation":{"hard_ok":true, "violations":[]}
        })
    }

    #[test]
    fn agent_candidate_is_revalidated_and_normalized_by_the_vps() {
        let request = serde_json::to_vec(&agent_candidate_request()).unwrap();
        let validated = validate_agent_candidate(&request, &agent_candidate_payload())
            .expect("valid candidate");

        assert_eq!(validated.quality, [2, 0, 2, 0]);
        assert_eq!(validated.payload["metrics"]["teacher_sessions"], json!(2));
        assert_eq!(validated.payload["metrics"]["hard_ok"], json!(true));
        assert_eq!(
            validated.payload["metrics"]["quality_priority_order"],
            json!(QUALITY_PRIORITY_BALANCED)
        );
        assert_eq!(
            validated.payload["validation"]["agent_helper_vps_validated"],
            json!(true)
        );
        assert_eq!(validated.payload["lessons"][0]["className"], json!("6A"));
        assert_eq!(validated.payload["lessons"][0]["fixed"], json!(true));
        assert_eq!(validated.payload["lessons"][1]["fixed"], json!(false));
    }

    #[test]
    fn agent_candidate_uses_and_propagates_two_stage_quality_order() {
        let mut request = agent_candidate_request();
        request["settings"] = json!({
            "require_complete_schedule": true,
            "optimization_two_stage_teacher_quality": true,
            "quality_priority_order": QUALITY_PRIORITY_TWO_STAGE,
            "optimization_focus": "sessions"
        });
        let request = serde_json::to_vec(&request).unwrap();
        let validated = validate_agent_candidate(&request, &agent_candidate_payload())
            .expect("valid two-stage candidate");

        assert_eq!(validated.quality, [2, 2, 0, 0]);
        assert_eq!(
            validated.payload["metrics"]["quality_priority_order"],
            json!(QUALITY_PRIORITY_TWO_STAGE)
        );
        assert_eq!(
            validated.payload["solver"]["runtime_settings"]["quality_priority_order"],
            json!(QUALITY_PRIORITY_TWO_STAGE)
        );
        assert_eq!(
            validated.payload["metrics"]["optimization_focus"],
            json!("sessions")
        );
        assert_eq!(
            validated.payload["solver"]["runtime_settings"]["optimization_focus"],
            json!("sessions")
        );
    }

    #[test]
    fn agent_candidate_rejects_automatic_gap2_regression_from_a_clean_incumbent() {
        let mut request = agent_candidate_request();
        request["data"]["pccmMatrix"]["6A|Literature"] = json!("Teacher 1");
        let mut incumbent = agent_candidate_payload();
        incumbent["lessons"][1]["teacher"] = json!("Teacher 1");
        incumbent["lessons"][1]["period"] = json!(2);
        request["data"]["tkbSolverResult"] = incumbent;
        request["settings"] = json!({
            "require_complete_schedule": true,
            "optimization_two_stage_teacher_quality": true,
            "quality_priority_order": QUALITY_PRIORITY_TWO_STAGE,
            "optimization_focus": "automatic"
        });

        let mut candidate = agent_candidate_payload();
        candidate["lessons"][1]["teacher"] = json!("Teacher 1");
        candidate["lessons"][1]["period"] = json!(4);
        let request = serde_json::to_vec(&request).unwrap();
        let error = validate_agent_candidate(&request, &candidate).unwrap_err();

        assert!(error.contains("optimization-focus envelope"));
    }

    #[test]
    fn optimization_focus_parses_all_canonical_modes() {
        for (raw, expected) in [
            ("automatic", OptimizationFocus::Automatic),
            ("quick_complete", OptimizationFocus::QuickComplete),
            ("singletons", OptimizationFocus::Singletons),
            ("sessions", OptimizationFocus::Sessions),
            ("gaps", OptimizationFocus::Gaps),
        ] {
            let request = json!({"settings": {"optimization_focus": raw}});
            assert_eq!(
                SolverConfig::from_request(&request, 1).optimization_focus,
                expected
            );
        }
    }

    #[test]
    fn quick_focus_skips_teacher_quality_work() {
        let request = json!({
            "settings": {
                "optimization_focus": "quick_complete",
                "native_skip_teacher_optimization": false
            }
        });
        let parsed = SolverConfig::from_request(&request, 1);
        assert!(parsed.skip_teacher_optimization);

        let mut lessons = vec![teacher_quality_test_lesson("6A", "GV01", 2, 0)];
        let before = lessons.clone();
        let mut solver_config = config(true, false);
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);
        let stats = optimize_teacher_single_sessions(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            31,
            true,
            true,
            OptimizationFocus::QuickComplete,
            &clock,
        );

        assert_eq!(lessons, before);
        assert_eq!(stats.moves, 0);
        assert_eq!(stats.initial_one_period_sessions, 1);
        assert_eq!(stats.final_one_period_sessions, 1);
    }

    #[test]
    fn quick_mrv_preserves_a_teacher_singleton_with_one_available_slot() {
        let class_a_off = off_except(&[
            ("thu2", "sang", 0),
            ("thu2", "sang", 1),
            ("thu3", "sang", 0),
            ("thu3", "sang", 1),
        ]);
        let class_b_off = off_except(&[("thu2", "sang", 0)]);
        let root = json!({
            "lop": [
                {"id":"6A", "ten":"6A", "khoi":"6"},
                {"id":"7A", "ten":"7A", "khoi":"7"}
            ],
            "monhoc": [{"id":"math", "ten":"Math"}],
            "mon": [
                {"khoi":"6", "ten":"Math", "sotiet":2, "gioihan":2},
                {"khoi":"7", "ten":"Math", "sotiet":1, "gioihan":1}
            ],
            "pccmMatrix": {
                "6A|Math":"Teacher 1",
                "7A|Math":"Teacher 1"
            },
            "tkbUserOff": {
                "6A":class_a_off,
                "7A":class_b_off
            }
        });
        let data = root.as_object().expect("test data object");
        let mut solver_config = config(true, false);
        solver_config.optimization_focus = OptimizationFocus::QuickComplete;
        solver_config.skip_teacher_optimization = true;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        let result = solve_simple(data, 19, solver_config, &clock).expect("native quick solve");
        let payload: Value = serde_json::from_str(&result.payload).expect("solver payload");

        assert_eq!(result.status, 200);
        assert_eq!(payload["metrics"]["scheduled_periods"], json!(3));
        assert_eq!(payload["metrics"]["unassigned_periods"], json!(0));
        assert_eq!(payload["metrics"]["hard_ok"], json!(true));
        let singleton = payload["lessons"]
            .as_array()
            .unwrap()
            .iter()
            .find(|lesson| lesson["classId"] == json!("7A"))
            .expect("singleton lesson");
        assert_eq!(singleton["day"], json!(2));
        assert_eq!(singleton["period"], json!(1));
    }

    #[test]
    fn quick_authored_min_block_avoids_the_forbidden_period_two_three_pair() {
        let class_off = off_except(&[
            ("thu2", "sang", 1),
            ("thu2", "sang", 2),
            ("thu3", "sang", 0),
            ("thu3", "sang", 1),
        ]);
        let root = json!({
            "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
            "monhoc": [{"id":"pe", "ten":"PE"}],
            "mon": [{"khoi":"6", "ten":"PE", "sotiet":2, "gioihan":2}],
            "pccmMatrix": {"6A|PE":"Teacher 1"},
            "tkbUserOff": {"6A":class_off},
            "tkbConstraints": {
                "subject": {
                    "PE": {
                        "byClass": {
                            "6A": {
                                "avoidBreakPair23": {"morning":true, "afternoon":false},
                                "lessonBlocks": {"2":{"min":1}}
                            }
                        }
                    }
                }
            }
        });
        let data = root.as_object().expect("test data object");
        let mut solver_config = config(true, false);
        solver_config.optimization_focus = OptimizationFocus::QuickComplete;
        solver_config.skip_teacher_optimization = true;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        let result = solve_simple(data, 29, solver_config, &clock).expect("native quick solve");
        let payload: Value = serde_json::from_str(&result.payload).expect("solver payload");
        let lessons = payload["lessons"].as_array().expect("lessons array");
        let mut periods = lessons
            .iter()
            .map(|lesson| lesson["period"].as_i64().unwrap())
            .collect::<Vec<_>>();
        periods.sort_unstable();

        assert_eq!(result.status, 200);
        assert_eq!(payload["metrics"]["hard_ok"], json!(true));
        assert_eq!(lessons.len(), 2);
        assert!(lessons.iter().all(|lesson| lesson["day"] == json!(3)));
        assert_eq!(periods, vec![1, 2]);
    }

    #[test]
    fn quick_min_two_counts_one_four_period_run_as_one_block() {
        let assignment = Assignment {
            class_id: "6A".to_string(),
            class_name: "6A".to_string(),
            subject: "Math".to_string(),
            teacher: "Teacher 1".to_string(),
            room: String::new(),
            periods: 4,
            session_limit: 4,
            day_limits: HashMap::new(),
            quick_min_two_blocks: 2,
            quick_avoid_pair23_morning: false,
            quick_avoid_pair23_afternoon: false,
        };
        let lessons = (0..4)
            .map(|period| {
                lesson_json(
                    "6A",
                    "6A",
                    "Math",
                    "Teacher 1",
                    "",
                    &make_slot(2, "sang", period),
                    false,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(quick_subject_two_block_count(&lessons, "6A", "Math"), 1);
        assert!(!quick_authored_subject_rules_ok(&lessons, &[assignment]));
    }

    #[test]
    fn quick_min_block_extends_one_fixed_period_instead_of_exhausting_domain() {
        let class_off = off_except(&[("thu2", "sang", 0), ("thu2", "sang", 1)]);
        let root = json!({
            "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
            "monhoc": [{"id":"math", "ten":"Math"}],
            "mon": [{"khoi":"6", "ten":"Math", "sotiet":2, "gioihan":2}],
            "pccmMatrix": {"6A|Math":"Teacher 1"},
            "tkbUserOff": {"6A":class_off},
            "tkb": {
                "6A": {
                    "thu2": {
                        "sang": [
                            {"mon":"Math", "fixed":true},
                            null,
                            null,
                            null,
                            null
                        ]
                    }
                }
            },
            "tkbConstraints": {
                "subject": {
                    "Math": {
                        "byClass": {
                            "6A": {"lessonBlocks":{"2":{"min":1}}}
                        }
                    }
                }
            }
        });
        let data = root.as_object().expect("test data object");
        let mut solver_config = config(true, false);
        solver_config.optimization_focus = OptimizationFocus::QuickComplete;
        solver_config.skip_teacher_optimization = true;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        let result = solve_simple(data, 31, solver_config, &clock).expect("native quick solve");
        let payload: Value = serde_json::from_str(&result.payload).expect("solver payload");
        let lessons = payload["lessons"].as_array().expect("lessons array");
        let mut periods = lessons
            .iter()
            .map(|lesson| lesson["period"].as_i64().unwrap())
            .collect::<Vec<_>>();
        periods.sort_unstable();

        assert_eq!(result.status, 200);
        assert_eq!(payload["metrics"]["hard_ok"], json!(true));
        assert_eq!(periods, vec![1, 2]);
        assert!(lessons
            .iter()
            .all(|lesson| lesson["teacher"] == json!("Teacher 1")));
    }

    #[test]
    fn quick_fixed_lesson_inherits_assignment_teacher_when_legacy_maps_are_absent() {
        let root = json!({
            "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
            "monhoc": [{"id":"math", "ten":"Math"}],
            "mon": [{"khoi":"6", "ten":"Math", "sotiet":1, "gioihan":1}],
            "pccmMatrix": {"6A|Math":"Teacher 1"},
            "tkb": {
                "6A": {
                    "thu2": {
                        "sang": [
                            {"mon":"Math", "fixed":true},
                            null,
                            null,
                            null,
                            null
                        ]
                    }
                }
            }
        });
        let data = root.as_object().expect("test data object");
        let mut solver_config = config(true, false);
        solver_config.optimization_focus = OptimizationFocus::QuickComplete;
        solver_config.skip_teacher_optimization = true;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        let result = solve_simple(data, 37, solver_config, &clock).expect("native quick solve");
        let payload: Value = serde_json::from_str(&result.payload).expect("solver payload");
        let lessons = payload["lessons"].as_array().expect("lessons array");

        assert_eq!(result.status, 200);
        assert_eq!(payload["metrics"]["hard_ok"], json!(true));
        assert_eq!(lessons.len(), 1);
        assert_eq!(lessons[0]["teacher"], json!("Teacher 1"));
        assert_eq!(lessons[0]["fixed"], json!(true));
    }

    #[test]
    fn quick_first_fit_repair_uses_a_same_class_blocker_swap() {
        let source = make_slot(2, "sang", 0);
        let target = make_slot(2, "sang", 1);
        let mut lessons = vec![
            lesson_json("7A", "7A", "Blocker", "Teacher 1", "", &source, false),
            lesson_json("7A", "7A", "Occupant", "Teacher 2", "", &target, false),
        ];
        let mut unassigned = vec![json!({
            "classId":"6A",
            "className":"6A",
            "subject":"Missing",
            "teacher":"Teacher 1",
            "room":"",
            "sessionLimit":1,
            "index":1
        })];
        let mut off_slots = HashSet::new();
        for slot in off_except(&[("thu2", "sang", 0)]) {
            off_slots.insert(format!("6A|{slot}"));
        }
        for slot in off_except(&[("thu2", "sang", 0), ("thu2", "sang", 1)]) {
            off_slots.insert(format!("7A|{slot}"));
        }
        let subject_limits = HashMap::from([
            (
                ("6A".to_string(), norm("Missing")),
                SubjectLimit {
                    per_session: 1,
                    per_day: HashMap::new(),
                },
            ),
            (
                ("7A".to_string(), norm("Blocker")),
                SubjectLimit {
                    per_session: 1,
                    per_day: HashMap::new(),
                },
            ),
            (
                ("7A".to_string(), norm("Occupant")),
                SubjectLimit {
                    per_session: 1,
                    per_day: HashMap::new(),
                },
            ),
        ]);
        let mut solver_config = config(true, false);
        solver_config.optimization_focus = OptimizationFocus::QuickComplete;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        let moves = repair_quick_unassigned_lessons_first_fit(
            &mut lessons,
            &mut unassigned,
            &off_slots,
            &subject_limits,
            &[],
            23,
            &clock,
        );

        assert_eq!(moves, 1);
        assert!(unassigned.is_empty());
        assert_eq!(lessons.len(), 3);
        assert!(schedule_hard_ok(&lessons, &off_slots, &subject_limits));
    }

    #[test]
    fn two_stage_session_priority_accepts_a_strict_reduction_with_gap_debt() {
        let before = TeacherOptimizationQuality {
            one_period_sessions: 0,
            teacher_sessions: 10,
            gap2_plus_sessions: 0,
            gap1_sessions: 1,
            total_gap: 1,
        };
        let after = TeacherOptimizationQuality {
            one_period_sessions: 0,
            teacher_sessions: 9,
            gap2_plus_sessions: 2,
            gap1_sessions: 3,
            total_gap: 7,
        };

        assert!(two_stage_session_phase_acceptable(&before, &after));
        assert!(two_stage_quality_key(&after) < two_stage_quality_key(&before));
        assert!(!automatic_two_stage_final_acceptable(&before, &after));
        assert!(focused_agent_candidate_acceptable(
            OptimizationFocus::Sessions,
            true,
            &before,
            &after
        ));
        assert!(!focused_agent_candidate_acceptable(
            OptimizationFocus::Automatic,
            true,
            &before,
            &after
        ));
    }

    #[test]
    fn automatic_two_stage_final_guard_preserves_the_initial_gap2_envelope() {
        let before = TeacherOptimizationQuality {
            one_period_sessions: 0,
            teacher_sessions: 10,
            gap2_plus_sessions: 2,
            gap1_sessions: 4,
            total_gap: 8,
        };
        let inside_envelope = TeacherOptimizationQuality {
            one_period_sessions: 0,
            teacher_sessions: 9,
            gap2_plus_sessions: 2,
            gap1_sessions: 6,
            total_gap: 10,
        };
        let outside_envelope = TeacherOptimizationQuality {
            gap2_plus_sessions: 3,
            ..inside_envelope
        };

        assert!(automatic_two_stage_final_acceptable(
            &before,
            &inside_envelope
        ));
        assert!(!automatic_two_stage_final_acceptable(
            &before,
            &outside_envelope
        ));
        assert!(focused_agent_candidate_acceptable(
            OptimizationFocus::Automatic,
            true,
            &before,
            &inside_envelope
        ));
        assert!(!focused_agent_candidate_acceptable(
            OptimizationFocus::Automatic,
            true,
            &before,
            &outside_envelope
        ));
    }

    #[test]
    fn gap_focus_accepts_fewer_sessions_but_rejects_an_increase() {
        let before = TeacherOptimizationQuality {
            one_period_sessions: 0,
            teacher_sessions: 10,
            gap2_plus_sessions: 2,
            gap1_sessions: 4,
            total_gap: 8,
        };
        let fewer_sessions = TeacherOptimizationQuality {
            one_period_sessions: 0,
            teacher_sessions: 9,
            gap2_plus_sessions: 0,
            gap1_sessions: 1,
            total_gap: 1,
        };
        let more_sessions = TeacherOptimizationQuality {
            teacher_sessions: 11,
            ..fewer_sessions
        };

        assert!(focused_gap_candidate_acceptable(&before, &fewer_sessions));
        assert!(focused_agent_candidate_acceptable(
            OptimizationFocus::Gaps,
            true,
            &before,
            &fewer_sessions
        ));
        assert!(!focused_gap_candidate_acceptable(&before, &more_sessions));
        assert!(!focused_agent_candidate_acceptable(
            OptimizationFocus::Gaps,
            true,
            &before,
            &more_sessions
        ));
    }

    #[test]
    fn session_phase_keeps_searching_through_gap2_debt() {
        let before = TeacherOptimizationQuality {
            one_period_sessions: 0,
            teacher_sessions: 10,
            gap2_plus_sessions: 2,
            gap1_sessions: 4,
            total_gap: 8,
        };
        let fewer_sessions_with_more_gap2 = TeacherOptimizationQuality {
            one_period_sessions: 0,
            teacher_sessions: 9,
            gap2_plus_sessions: 3,
            gap1_sessions: 5,
            total_gap: 10,
        };

        assert!(!teacher_phase_done(
            TeacherOptimizationPhase::TeacherSessions,
            &before
        ));
        assert!(teacher_phase_improved(
            TeacherOptimizationPhase::TeacherSessions,
            &before,
            &fewer_sessions_with_more_gap2
        ));
    }

    #[test]
    fn two_stage_optimizer_reduces_teacher_sessions_without_singletons() {
        let mut lessons = vec![
            teacher_quality_test_lesson("6A", "GV01", 2, 0),
            teacher_quality_test_lesson("6B", "GV01", 2, 1),
            teacher_quality_test_lesson("6C", "GV01", 3, 0),
            teacher_quality_test_lesson("6D", "GV01", 3, 1),
        ];
        let before = teacher_optimization_quality(&lessons);
        let mut solver_config = config(true, false);
        solver_config.two_stage_teacher_quality = true;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        let stats = optimize_teacher_single_sessions(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            17,
            true,
            true,
            OptimizationFocus::Automatic,
            &clock,
        );
        let after = teacher_optimization_quality(&lessons);

        assert_eq!(before.one_period_sessions, 0);
        assert_eq!(before.teacher_sessions, 2);
        assert_eq!(before.gap2_plus_sessions, 0);
        assert_eq!(after.one_period_sessions, 0);
        assert_eq!(after.teacher_sessions, 1);
        assert_eq!(after.gap2_plus_sessions, 0);
        assert_eq!(stats.initial_teacher_sessions, 2);
        assert_eq!(stats.final_teacher_sessions, 1);
        assert!(schedule_hard_ok(&lessons, &HashSet::new(), &HashMap::new()));
    }

    #[test]
    fn singleton_focus_does_not_run_session_reduction_on_a_clean_schedule() {
        let mut lessons = vec![
            teacher_quality_test_lesson("6A", "GV01", 2, 0),
            teacher_quality_test_lesson("6B", "GV01", 2, 1),
            teacher_quality_test_lesson("6C", "GV01", 3, 0),
            teacher_quality_test_lesson("6D", "GV01", 3, 1),
        ];
        let mut solver_config = config(true, false);
        solver_config.optimization_focus = OptimizationFocus::Singletons;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        optimize_teacher_single_sessions(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            29,
            true,
            true,
            OptimizationFocus::Singletons,
            &clock,
        );

        assert_eq!(count_one_period_teacher_sessions(&lessons), 0);
        assert_eq!(count_teacher_sessions(&lessons), 2);
    }

    #[test]
    fn session_focus_runs_session_reduction_without_the_gap_phase() {
        let mut lessons = vec![
            teacher_quality_test_lesson("6A", "GV01", 2, 0),
            teacher_quality_test_lesson("6B", "GV01", 2, 1),
            teacher_quality_test_lesson("6C", "GV01", 3, 0),
            teacher_quality_test_lesson("6D", "GV01", 3, 1),
        ];
        let mut solver_config = config(true, false);
        solver_config.optimization_focus = OptimizationFocus::Sessions;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        optimize_teacher_single_sessions(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            31,
            true,
            true,
            OptimizationFocus::Sessions,
            &clock,
        );

        assert_eq!(count_one_period_teacher_sessions(&lessons), 0);
        assert_eq!(count_teacher_sessions(&lessons), 1);
    }

    #[test]
    fn two_stage_gap_cleanup_compacts_within_the_same_teacher_session() {
        let mut lessons = vec![
            teacher_quality_test_lesson("6A", "GV01", 2, 0),
            teacher_quality_test_lesson("6B", "GV01", 2, 2),
        ];
        let before = teacher_optimization_quality(&lessons);
        let mut solver_config = config(true, false);
        solver_config.two_stage_teacher_quality = true;
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        optimize_teacher_single_sessions(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            23,
            true,
            true,
            OptimizationFocus::Gaps,
            &clock,
        );
        let after = teacher_optimization_quality(&lessons);

        assert_eq!(before.teacher_sessions, 1);
        assert_eq!(before.total_gap, 1);
        assert_eq!(after.teacher_sessions, 1);
        assert_eq!(after.one_period_sessions, 0);
        assert_eq!(after.total_gap, 0);
        assert!(two_stage_cleanup_acceptable(&before, &after));
    }

    #[test]
    fn gap1_chain_moves_a_blocker_without_changing_teacher_sessions() {
        let mut lessons = vec![
            lesson_json(
                "6A",
                "6A",
                "Target",
                "GV01",
                "",
                &make_slot(2, "sang", 0),
                false,
            ),
            lesson_json(
                "6B",
                "6B",
                "Target",
                "GV01",
                "",
                &make_slot(2, "sang", 2),
                false,
            ),
            lesson_json(
                "6A",
                "6A",
                "Blocker",
                "GV02",
                "",
                &make_slot(2, "sang", 1),
                false,
            ),
            lesson_json(
                "6C",
                "6C",
                "Anchor A",
                "GV02",
                "",
                &make_slot(2, "sang", 0),
                false,
            ),
            lesson_json(
                "6D",
                "6D",
                "Anchor B",
                "GV02",
                "",
                &make_slot(2, "sang", 3),
                false,
            ),
        ];
        let before = teacher_optimization_quality(&lessons);
        let mut solver_config = config(true, false);
        solver_config.native_deadline_reserve_ms = 0;
        let clock = SolveClock::new(solver_config, None);

        assert!(try_compact_teacher_gap_by_class_chain(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            41,
            1,
            &clock,
        ));

        let after = teacher_optimization_quality(&lessons);
        assert_eq!(before.one_period_sessions, 0);
        assert_eq!(before.gap2_plus_sessions, 0);
        assert!(after.gap1_sessions < before.gap1_sessions);
        assert_eq!(after.gap2_plus_sessions, 0);
        assert_eq!(after.teacher_sessions, before.teacher_sessions);
        assert_eq!(after.one_period_sessions, 0);
        assert!(schedule_hard_ok(&lessons, &HashSet::new(), &HashMap::new()));
    }

    #[test]
    fn expired_gap_clock_skips_inner_search_without_mutating_the_incumbent() {
        let mut lessons = vec![
            teacher_quality_test_lesson("6A", "GV01", 2, 0),
            teacher_quality_test_lesson("6B", "GV01", 2, 2),
            teacher_quality_test_lesson("6A", "GV02", 2, 1),
            teacher_quality_test_lesson("6C", "GV02", 2, 0),
            teacher_quality_test_lesson("6D", "GV02", 2, 3),
        ];
        let before = lessons.clone();
        let gap_session = teacher_gap_sessions(&lessons)
            .into_iter()
            .find(|session| session.gaps > 0)
            .expect("test schedule contains a teacher gap");
        let now = wall_clock_ms();
        let clock = SolveClock {
            started_at_ms: now.saturating_sub(10),
            deadline_at_ms: now.saturating_sub(1),
            reserve_ms: 0,
            cancel_requested: None,
        };
        let started = std::time::Instant::now();

        assert!(!try_compact_teacher_gap_session_by_class_swap(
            &mut lessons,
            &gap_session,
            &HashSet::new(),
            &HashMap::new(),
            43,
            &clock,
        ));
        assert!(!try_compact_teacher_gap_by_same_class_pair_swap(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            43,
            1,
            &clock,
        ));
        assert!(!try_compact_teacher_gap_by_class_chain(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            43,
            1,
            &clock,
        ));

        assert_eq!(lessons, before);
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
    }

    #[test]
    fn expired_session_clock_skips_merge_neighborhood_without_mutating_the_incumbent() {
        let mut lessons = vec![
            teacher_quality_test_lesson("6A", "GV01", 2, 0),
            teacher_quality_test_lesson("6B", "GV01", 2, 1),
            teacher_quality_test_lesson("6C", "GV01", 3, 0),
            teacher_quality_test_lesson("6D", "GV01", 3, 1),
        ];
        let before = lessons.clone();
        let now = wall_clock_ms();
        let clock = SolveClock {
            started_at_ms: now.saturating_sub(10),
            deadline_at_ms: now.saturating_sub(1),
            reserve_ms: 0,
            cancel_requested: None,
        };

        assert!(!try_merge_small_teacher_session(
            &mut lessons,
            &HashSet::new(),
            &HashMap::new(),
            47,
            &clock,
        ));
        assert_eq!(lessons, before);
    }

    #[test]
    fn agent_candidate_cannot_move_fixed_lessons_or_change_resources() {
        let request = serde_json::to_vec(&agent_candidate_request()).unwrap();
        let mut moved = agent_candidate_payload();
        moved["lessons"][0]["period"] = json!(3);
        assert!(validate_agent_candidate(&request, &moved)
            .unwrap_err()
            .contains("fixed lesson"));

        let mut changed_teacher = agent_candidate_payload();
        changed_teacher["lessons"][1]["teacher"] = json!("Teacher 1");
        assert!(validate_agent_candidate(&request, &changed_teacher)
            .unwrap_err()
            .contains("teacher or room"));
    }

    #[test]
    fn agent_candidate_cannot_forge_completeness_or_assignment_demand() {
        let request = serde_json::to_vec(&agent_candidate_request()).unwrap();
        let mut forged_metrics = agent_candidate_payload();
        forged_metrics["metrics"]["hard_ok"] = json!(false);
        assert!(validate_agent_candidate(&request, &forged_metrics).is_err());

        let mut duplicated_subject = agent_candidate_payload();
        duplicated_subject["lessons"][1]["subject"] = json!("Math");
        duplicated_subject["lessons"][1]["teacher"] = json!("Teacher 1");
        duplicated_subject["lessons"][1]["room"] = json!("Room 1");
        assert!(validate_agent_candidate(&request, &duplicated_subject).is_err());
    }

    #[test]
    fn agent_quality_targets_do_not_reject_a_hard_valid_complete_candidate() {
        let mut strict_one_request = agent_candidate_request();
        strict_one_request["settings"] = json!({
            "require_complete_schedule": true,
            "max_one_period_sessions": 0,
            "strict_one_period_sessions_cap": true,
            "enforce_max_one_period_sessions": true,
            "period_max_teacher_gap": 1
        });
        let strict_one_request = serde_json::to_vec(&strict_one_request).unwrap();
        let strict_validated =
            validate_agent_candidate(&strict_one_request, &agent_candidate_payload())
                .expect("quality goals must not replace authored hard constraints");
        assert_eq!(strict_validated.quality[0], 2);

        let mut gap_request = agent_candidate_request();
        gap_request["data"]["pccmMatrix"]["6A|Literature"] = json!("Teacher 1");
        gap_request["settings"] = json!({
            "require_complete_schedule": true,
            "max_one_period_sessions": 0,
            "strict_one_period_sessions_cap": true,
            "period_max_teacher_gap": 0
        });
        let mut gap_candidate = agent_candidate_payload();
        gap_candidate["lessons"][1]["teacher"] = json!("Teacher 1");
        gap_candidate["lessons"][1]["period"] = json!(3);
        let gap_request = serde_json::to_vec(&gap_request).unwrap();
        let gap_validated = validate_agent_candidate(&gap_request, &gap_candidate)
            .expect("an unavoidable teacher gap must remain publishable");
        assert!(gap_validated.quality[3] > 0);
    }

    #[test]
    fn quick_agent_accepts_hard_valid_gap_and_singleton_debt() {
        let mut request = agent_candidate_request();
        request["data"]["pccmMatrix"]["6A|Literature"] = json!("Teacher 1");
        request["settings"] = json!({
            "optimization_focus": "quick_complete",
            "require_complete_schedule": true,
            "max_one_period_sessions": 0,
            "strict_one_period_sessions_cap": true,
            "enforce_max_one_period_sessions": true,
            "period_max_teacher_gap": "off"
        });
        let request = serde_json::to_vec(&request).unwrap();

        let mut gap2_candidate = agent_candidate_payload();
        gap2_candidate["lessons"][1]["teacher"] = json!("Teacher 1");
        gap2_candidate["lessons"][1]["period"] = json!(4);
        let validated = validate_agent_candidate(&request, &gap2_candidate)
            .expect("quick must allow temporary gap-2 after singleton cleanup");
        assert_eq!(validated.quality[0], 0);
        assert_eq!(validated.quality[1], 1);

        let mut singleton_candidate = gap2_candidate;
        singleton_candidate["lessons"][1]["day"] = json!(3);
        singleton_candidate["lessons"][1]["period"] = json!(1);
        let singleton_validated = validate_agent_candidate(&request, &singleton_candidate)
            .expect("quick must return a complete hard-valid timetable before quality polish");
        assert!(singleton_validated.quality[0] > 0);
    }

    #[test]
    fn structurally_valid_agent_candidate_with_teacher_constraints_reaches_reference_gate() {
        let mut request = agent_candidate_request();
        request["data"]["tkbConstraints"] = json!({
            "teacher": {
                "Teacher 1": {
                    "maxDaysSessions": {"maxDays": 1}
                }
            }
        });
        let request = serde_json::to_vec(&request).unwrap();
        let validated = validate_agent_candidate(&request, &agent_candidate_payload())
            .expect("native structure gate must not reject all teacher constraints");

        assert_eq!(validated.payload["metrics"]["hard_ok"], json!(true));
    }

    #[test]
    fn best_effort_requires_an_actual_timeout() {
        let config = config(true, true);
        assert_eq!(solve_response_status(config, false, true, false), 422);
        assert_eq!(solve_response_status(config, false, true, true), 200);
    }

    #[test]
    fn empty_schedule_is_never_best_effort_success() {
        assert_eq!(
            solve_response_status(config(false, true), false, false, true),
            422
        );
        assert_eq!(
            solve_response_status(config(true, true), false, false, true),
            422
        );
    }

    #[test]
    fn complete_schedule_is_success() {
        assert_eq!(
            solve_response_status(config(true, false), true, true, false),
            200
        );
    }

    #[test]
    fn native_deadlines_are_clamped_and_zero_reserve_is_honored() {
        let request = json!({
            "settings": {
                "backend_deadline_ms": "999999999999999999",
                "native_global_deadline_ms": "999999999999999999",
                "native_deadline_reserve_ms": 0
            }
        });
        let config = SolverConfig::from_request(&request, 1);
        assert_eq!(config.backend_deadline_ms, MAX_SOLVER_DEADLINE_MS);
        assert_eq!(config.native_global_deadline_ms, MAX_SOLVER_DEADLINE_MS);
        assert_eq!(config.native_deadline_reserve_ms, 0);
    }

    #[test]
    fn positive_numeric_seed_contributes_entropy_once() {
        let base = 0xcbf29ce484222325_u64;
        let seed_17 = solve_seed(&json!({"settings":{"random_seed":17}}));
        let seed_18 = solve_seed(&json!({"settings":{"random_seed":18}}));

        assert_eq!(seed_17, base ^ 17);
        assert_eq!(seed_18, base ^ 18);
        assert_ne!(seed_17, seed_18);
    }

    #[test]
    fn gioihan_two_allows_two_morning_and_two_afternoon_periods_on_one_day() {
        let lessons = vec![
            subject_test_lesson("sang", "AM", 0),
            subject_test_lesson("sang", "AM", 1),
            subject_test_lesson("chieu", "PM", 0),
            subject_test_lesson("chieu", "PM", 1),
        ];
        let limits = subject_test_limits(2, None);

        assert!(schedule_hard_ok(&lessons, &HashSet::new(), &limits));
        assert!(subject_limit_violations(&lessons, &limits).is_empty());
    }

    #[test]
    fn solver_can_fill_two_morning_and_two_afternoon_periods_on_the_only_open_day() {
        let off_slots = off_except(&[
            ("thu2", "sang", 0),
            ("thu2", "sang", 1),
            ("thu2", "chieu", 0),
            ("thu2", "chieu", 1),
        ]);
        let root = json!({
            "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
            "monhoc": [{"id":"toan", "ten":"Toán"}],
            "mon": [{"khoi":"6", "ten":"Toán", "sotiet":4, "gioihan":2}],
            "pccmMatrix": {"6A|Toán":"GV01"},
            "tkbUserOff": {"6A":off_slots}
        });
        let data = root.as_object().expect("test data object");
        let mut solver_config = config(true, false);
        solver_config.skip_teacher_optimization = true;
        let clock = SolveClock::new(solver_config, None);

        let result = solve_simple(data, 7, solver_config, &clock).expect("native solve");
        let payload: Value = serde_json::from_str(&result.payload).expect("solver payload");
        let lessons = payload
            .get("lessons")
            .and_then(Value::as_array)
            .expect("lessons array");

        assert_eq!(result.status, 200);
        assert_eq!(lessons.len(), 4);
        assert!(lessons
            .iter()
            .all(|lesson| lesson.get("day").and_then(Value::as_i64) == Some(2)));
        for session in ["AM", "PM"] {
            let mut periods = lessons
                .iter()
                .filter(|lesson| lesson.get("session").and_then(Value::as_str) == Some(session))
                .filter_map(|lesson| lesson.get("period").and_then(Value::as_i64))
                .collect::<Vec<_>>();
            periods.sort();
            assert_eq!(periods, vec![1, 2]);
        }
    }

    #[test]
    fn solver_falls_back_to_valid_singletons_when_no_two_period_block_is_open() {
        let off_slots = off_except(&[("thu2", "sang", 0), ("thu2", "chieu", 0)]);
        let root = json!({
            "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
            "monhoc": [{"id":"toan", "ten":"Toán"}],
            "mon": [{"khoi":"6", "ten":"Toán", "sotiet":2, "gioihan":2}],
            "pccmMatrix": {"6A|Toán":"GV01"},
            "tkbUserOff": {"6A":off_slots}
        });
        let data = root.as_object().expect("test data object");
        let mut solver_config = config(true, false);
        solver_config.skip_teacher_optimization = true;
        let clock = SolveClock::new(solver_config, None);

        let result = solve_simple(data, 11, solver_config, &clock).expect("native solve");
        let payload: Value = serde_json::from_str(&result.payload).expect("solver payload");
        let lessons = payload
            .get("lessons")
            .and_then(Value::as_array)
            .expect("lessons array");

        assert_eq!(result.status, 200);
        assert_eq!(lessons.len(), 2);
        assert_eq!(
            lessons
                .iter()
                .map(|lesson| lesson
                    .get("session")
                    .and_then(Value::as_str)
                    .unwrap_or_default())
                .collect::<HashSet<_>>(),
            HashSet::from(["AM", "PM"])
        );
    }

    #[test]
    fn gioihan_two_rejects_three_periods_in_one_session() {
        let lessons = vec![
            subject_test_lesson("sang", "AM", 0),
            subject_test_lesson("sang", "AM", 1),
            subject_test_lesson("sang", "AM", 2),
        ];
        let limits = subject_test_limits(2, None);

        assert!(!schedule_hard_ok(&lessons, &HashSet::new(), &limits));
        assert!(subject_limit_violations(&lessons, &limits)
            .iter()
            .any(|item| item.get("kind").and_then(Value::as_str) == Some("subject_session_limit")));
    }

    #[test]
    fn gioihan_one_rejects_two_periods_in_one_session() {
        let lessons = vec![
            subject_test_lesson("sang", "AM", 0),
            subject_test_lesson("sang", "AM", 1),
        ];
        let limits = subject_test_limits(1, None);

        assert!(!schedule_hard_ok(&lessons, &HashSet::new(), &limits));
    }

    #[test]
    fn gioihan_one_allows_one_period_in_each_session_on_the_same_day() {
        let lessons = vec![
            subject_test_lesson("sang", "AM", 0),
            subject_test_lesson("chieu", "PM", 0),
        ];
        let limits = subject_test_limits(1, None);

        assert!(schedule_hard_ok(&lessons, &HashSet::new(), &limits));
        assert!(subject_limit_violations(&lessons, &limits).is_empty());
    }

    #[test]
    fn gioihan_rejects_nonconsecutive_periods_within_one_session() {
        let lessons = vec![
            subject_test_lesson("sang", "AM", 0),
            subject_test_lesson("sang", "AM", 2),
        ];
        let limits = subject_test_limits(2, None);

        assert!(!schedule_hard_ok(&lessons, &HashSet::new(), &limits));
        assert!(subject_limit_violations(&lessons, &limits)
            .iter()
            .any(|item| item.get("kind").and_then(Value::as_str) == Some("subject_session_block")));
    }

    #[test]
    fn gioihan_one_or_two_allows_a_singleton_session() {
        let lessons = vec![subject_test_lesson("sang", "AM", 3)];
        for session_limit in [1, 2] {
            let limits = subject_test_limits(session_limit, None);
            assert!(schedule_hard_ok(&lessons, &HashSet::new(), &limits));
            assert!(subject_limit_violations(&lessons, &limits).is_empty());
        }
    }

    #[test]
    fn explicit_subject_day_limit_remains_a_separate_constraint() {
        let lessons = vec![
            subject_test_lesson("sang", "AM", 0),
            subject_test_lesson("sang", "AM", 1),
            subject_test_lesson("chieu", "PM", 0),
            subject_test_lesson("chieu", "PM", 1),
        ];
        let limits = subject_test_limits(2, Some(3));

        assert!(!schedule_hard_ok(&lessons, &HashSet::new(), &limits));
        assert!(subject_limit_violations(&lessons, &limits)
            .iter()
            .any(|item| item.get("kind").and_then(Value::as_str) == Some("subject_day_limit")));
    }

    #[test]
    fn parses_gioihan_as_session_limit_and_tkb_constraint_as_day_limit() {
        let root = json!({
            "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
            "monhoc": [{"id":"toan", "ma":"T", "ten":"Toán"}],
            "mon": [{"khoi":"6", "ten":"Toán", "sotiet":4, "gioihan":2}],
            "pccmMatrix": {"6A|Toán":"GV01"},
            "tkbConstraints": {
                "subject": {
                    "toan": {
                        "byClass": {
                            "6A": {"maxPeriods":{"day":{"thu2":3}}}
                        }
                    }
                }
            }
        });
        let data = root.as_object().expect("test data object");
        let classes = parse_classes(data);
        let subjects = parse_subjects(data);
        let class_alias = class_alias_map(&classes);
        let subject_alias = subject_alias_map(&subjects);
        let periods = period_map(data, &subject_alias);
        let session_limits = session_limit_map(data, &subject_alias);
        let day_limits = constraint_subject_day_limit_map(data, &class_alias, &subject_alias);
        let assignments = parse_assignments(
            data,
            &classes,
            &class_alias,
            &subject_alias,
            &periods,
            &session_limits,
            &day_limits,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert_eq!(assignments.len(), 1);
        assert_eq!(assignments[0].session_limit, 2);
        assert_eq!(assignments[0].day_limits.get(&2), Some(&3));
        assert_eq!(assignments[0].day_limits.get(&3), None);
    }

    #[test]
    fn fixed_and_existing_lessons_use_the_canonical_subject_for_limits() {
        let root = json!({
            "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
            "monhoc": [{"id":"toan", "ma":"T", "ten":"Toán"}],
            "tkb": {
                "6A": {
                    "thu2": {
                        "sang": [{"mon":"toan", "fixed":true}]
                    }
                }
            },
            "tkbSolverResult": {
                "lessons": [{
                    "classId":"6A",
                    "className":"6A",
                    "subject":"T",
                    "teacher":"GV01",
                    "day":2,
                    "session":"AM",
                    "period":1,
                    "fixed":false
                }]
            }
        });
        let data = root.as_object().expect("test data object");
        let classes = parse_classes(data);
        let subjects = parse_subjects(data);
        let class_alias = class_alias_map(&classes);
        let subject_alias = subject_alias_map(&subjects);

        let fixed = collect_fixed_lessons(data, &class_alias, &subject_alias);
        let existing = collect_existing_schedule_lessons(data, &class_alias, &subject_alias);

        assert_eq!(fixed.len(), 1);
        assert_eq!(fixed[0].subject, "Toán");
        assert_eq!(existing.len(), 1);
        assert_eq!(lesson_subject(&existing[0]), "Toán");
    }
}
