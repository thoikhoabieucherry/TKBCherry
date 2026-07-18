use std::collections::{HashMap, HashSet};

use crate::jsonlite::{parse_json, JsonValue};

pub fn solve_precheck_json(body: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(body).map_err(|err| format!("request is not utf-8: {err}"))?;
    let root = parse_json(text)?;
    let data = root.get("data").ok_or_else(|| "missing data".to_string())?;
    let settings = root.get("settings");

    let classes = data.get("lop").and_then(JsonValue::as_array).unwrap_or(&[]);
    let teachers = data
        .get("giaovien")
        .or_else(|| data.get("giaoVien"))
        .and_then(JsonValue::as_array)
        .unwrap_or(&[]);
    let subject_meta = data
        .get("monhoc")
        .or_else(|| data.get("monHoc"))
        .and_then(JsonValue::as_array)
        .unwrap_or(&[]);
    let periods = data.get("mon").and_then(JsonValue::as_array).unwrap_or(&[]);
    let pccm = data
        .get("pccmMatrix")
        .and_then(JsonValue::as_object)
        .unwrap_or(&[]);

    let class_grade = class_grade_map(classes);
    let subject_alias = subject_alias_map(subject_meta);
    let periods_by_grade_subject = periods_by_grade_subject(periods, &subject_alias);

    let mut assignment_count = 0_usize;
    let mut expected_periods = 0_i64;
    let mut skipped_no_period = 0_usize;
    let mut skipped_unknown_class = 0_usize;
    let mut unique_teachers = HashSet::new();
    let mut unique_subjects = HashSet::new();

    for (raw_key, raw_teacher) in pccm {
        let Some(teacher) = raw_teacher
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let Some((class_key, subject_key)) = raw_key.split_once('|') else {
            continue;
        };
        let Some(grade) = class_grade.get(&norm(class_key)) else {
            skipped_unknown_class += 1;
            continue;
        };
        let subject = canonical_subject(subject_key, &subject_alias);
        let period_count = periods_by_grade_subject
            .get(&(grade.clone(), subject.clone()))
            .copied()
            .unwrap_or(0);
        if period_count <= 0 {
            skipped_no_period += 1;
            continue;
        }
        assignment_count += 1;
        expected_periods += period_count;
        unique_teachers.insert(teacher.to_string());
        unique_subjects.insert(subject);
    }

    let active = constraint_summary(data);
    let ui_expected = settings
        .and_then(|value| value.get("expected_scheduled_periods"))
        .and_then(JsonValue::as_i64)
        .unwrap_or(0);

    Ok(format!(
        concat!(
            r#"{{"ok":true,"api":"rust","nativePrecheck":true"#,
            r#","classes":{},"teachers":{},"subjectMeta":{}"#,
            r#","assignments":{},"expectedPeriods":{},"uiExpectedPeriods":{}"#,
            r#","uniqueTeachers":{},"uniqueSubjects":{}"#,
            r#","skippedUnknownClass":{},"skippedNoPeriod":{}"#,
            r#","activeConstraints":{}"#,
            r#","fixedOffSlotCount":{},"userOffSlotCount":{}"#,
            r#","warning":"precheck only; /api/solve-data uses the restored hybrid reference optimizer when available, with Rust fallback"}}"#
        ),
        classes.len(),
        teachers.len(),
        subject_meta.len(),
        assignment_count,
        expected_periods,
        ui_expected,
        unique_teachers.len(),
        unique_subjects.len(),
        skipped_unknown_class,
        skipped_no_period,
        json_string_array(&active.active_kinds),
        active.fixed_off_slots,
        active.user_off_slots,
    ))
}

fn class_grade_map(classes: &[JsonValue]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (index, item) in classes.iter().enumerate() {
        let id = get_str(item, "id")
            .or_else(|| get_str(item, "ten"))
            .unwrap_or_default();
        let name = get_str(item, "ten").unwrap_or(id);
        let alt = get_str(item, "ten2").unwrap_or("");
        let grade = get_str(item, "khoi").unwrap_or("");
        if grade.is_empty() {
            continue;
        }
        for alias in [id, name, alt, &format!("L{:03}", index + 1)] {
            let key = norm(alias);
            if !key.is_empty() {
                out.entry(key).or_insert_with(|| grade.to_string());
            }
        }
    }
    out
}

fn subject_alias_map(subjects: &[JsonValue]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for item in subjects {
        let canonical = get_str(item, "ten").unwrap_or("").trim();
        if canonical.is_empty() {
            continue;
        }
        for alias in [
            canonical,
            get_str(item, "ma").unwrap_or(""),
            get_str(item, "ma2").unwrap_or(""),
        ] {
            let key = norm(alias);
            if !key.is_empty() {
                out.entry(key).or_insert_with(|| canonical.to_string());
            }
        }
    }
    out
}

fn periods_by_grade_subject(
    rows: &[JsonValue],
    subject_alias: &HashMap<String, String>,
) -> HashMap<(String, String), i64> {
    let mut out = HashMap::new();
    for row in rows {
        let grade = get_str(row, "khoi").unwrap_or("").trim();
        let subject = get_str(row, "ten")
            .or_else(|| get_str(row, "mon"))
            .map(|value| canonical_subject(value, subject_alias))
            .unwrap_or_default();
        let periods = int_value(row.get("sotiet"), 0);
        if !grade.is_empty() && !subject.is_empty() && periods > 0 {
            out.insert((grade.to_string(), subject), periods);
        }
    }
    out
}

struct ConstraintSummary {
    active_kinds: Vec<String>,
    fixed_off_slots: usize,
    user_off_slots: usize,
}

fn constraint_summary(data: &JsonValue) -> ConstraintSummary {
    let mut active = Vec::new();
    let mut fixed_off_slots = 0_usize;
    let mut user_off_slots = 0_usize;
    let constraints = data.get("tkbConstraints");
    if let Some(c) = constraints {
        for key in [
            "teacher",
            "subject",
            "subjectGroup",
            "subjectNoSameSession",
            "timeLimit",
        ] {
            if json_has_entries(c.get(key)) {
                active.push(key.to_string());
            }
        }
        if let Some(fixed) = c.get("fixedOff") {
            for kind in ["class", "teacher", "subject", "room", "subjectGroup"] {
                let count = count_slot_map(fixed.get(kind));
                if count > 0 {
                    active.push(format!("fixedOff.{kind}"));
                    fixed_off_slots += count;
                }
            }
        }
    }
    if let Some(user_off) = data.get("tkbUserOff") {
        user_off_slots = count_user_off(user_off);
        if user_off_slots > 0 {
            active.push("tkbUserOff".to_string());
        }
    }
    active.sort();
    active.dedup();
    ConstraintSummary {
        active_kinds: active,
        fixed_off_slots,
        user_off_slots,
    }
}

fn json_has_entries(value: Option<&JsonValue>) -> bool {
    match value {
        Some(JsonValue::Object(items)) => !items.is_empty(),
        Some(JsonValue::Array(items)) => !items.is_empty(),
        _ => false,
    }
}

fn count_slot_map(value: Option<&JsonValue>) -> usize {
    let Some(JsonValue::Object(items)) = value else {
        return 0;
    };
    items
        .iter()
        .map(|(_, slots)| match slots {
            JsonValue::Object(slot_items) => slot_items
                .iter()
                .filter(|(_, enabled)| enabled.truthy())
                .count(),
            JsonValue::Array(slot_items) => slot_items.len(),
            _ => 0,
        })
        .sum()
}

fn count_user_off(value: &JsonValue) -> usize {
    let JsonValue::Object(items) = value else {
        return 0;
    };
    items
        .iter()
        .map(|(_, slots)| match slots {
            JsonValue::Object(slot_items) => slot_items
                .iter()
                .filter(|(_, enabled)| enabled.truthy())
                .count(),
            JsonValue::Array(slot_items) => slot_items.len(),
            _ => 0,
        })
        .sum()
}

fn get_str<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    value.get(key).and_then(JsonValue::as_str)
}

fn int_value(value: Option<&JsonValue>, default: i64) -> i64 {
    match value {
        Some(JsonValue::Number(value)) if value.is_finite() => *value as i64,
        Some(JsonValue::String(value)) => value
            .trim()
            .parse::<f64>()
            .map(|v| v as i64)
            .unwrap_or(default),
        Some(JsonValue::Bool(value)) => i64::from(*value),
        _ => default,
    }
}

fn canonical_subject(value: &str, subject_alias: &HashMap<String, String>) -> String {
    subject_alias
        .get(&norm(value))
        .cloned()
        .unwrap_or_else(|| value.trim().to_string())
}

fn norm(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

fn json_string_array(items: &[String]) -> String {
    let body = items
        .iter()
        .map(|item| format!(r#""{}""#, escape_json(item)))
        .collect::<Vec<_>>()
        .join(",");
    format!("[{body}]")
}

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}
