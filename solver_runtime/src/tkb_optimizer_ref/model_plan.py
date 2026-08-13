from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from typing import Any, Mapping


MODEL_PLAN_PROTOCOL = "tkb-model-plan-v1"
MODEL_PLAN_SCHEMA_VERSION = 1
MODEL_PLAN_DIGEST_PROTOCOL = "tkb-model-plan-sha256-v1"
CANONICAL_JSON_ENCODING = "canonical-json-v1"
VARIABLE_MAP_ENCODING = "tkb-variable-map-json-v1"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PHASES = {"completion_seed", "quality", "sessions", "gap2", "gap1"}
_MODEL_KINDS = {"external_cp_sat_model", "external_highs_model"}


class ModelPlanContractError(ValueError):
    pass


def canonical_json_bytes(value: Any) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as exc:
        raise ModelPlanContractError("value is not canonical JSON") from exc
    return encoded.encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json_digest(value: Any) -> str:
    return sha256_hex(canonical_json_bytes(value))


def wire_model_digest(model_bytes: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(b"tkb-external-cp-sat-model-v1\0")
    digest.update(len(model_bytes).to_bytes(8, "big"))
    digest.update(model_bytes)
    return digest.hexdigest()


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ModelPlanContractError(f"{name} must be an object")
    return value


def _exact_keys(value: Mapping[str, Any], expected: set[str], name: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ModelPlanContractError(
            f"{name} schema drift: missing={missing}, extra={extra}"
        )


def _sha256(value: Any, name: str) -> str:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise ModelPlanContractError(f"{name} must be a lowercase SHA-256")
    return value


def _integer(value: Any, name: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ModelPlanContractError(f"{name} must be an integer >= {minimum}")
    return value


def _artifact(value: Any, name: str) -> Mapping[str, Any]:
    artifact = _mapping(value, name)
    _exact_keys(artifact, {"encoding", "sha256", "bytes"}, name)
    if not isinstance(artifact["encoding"], str) or not artifact["encoding"]:
        raise ModelPlanContractError(f"{name}.encoding must be non-empty")
    _sha256(artifact["sha256"], f"{name}.sha256")
    _integer(artifact["bytes"], f"{name}.bytes", minimum=1)
    return artifact


def quality_from_result(result: Mapping[str, Any]) -> dict[str, Any]:
    payload: Mapping[str, Any] = result
    nested = result.get("payload")
    if isinstance(nested, Mapping):
        payload = nested
    metrics = _mapping(payload.get("metrics"), "result.metrics")
    validation = payload.get("validation")
    validation = validation if isinstance(validation, Mapping) else {}
    gaps = metrics.get("gap_distribution")
    gaps = gaps if isinstance(gaps, Mapping) else {}

    gap2 = metrics.get("teacher_gap2_sessions")
    if not isinstance(gap2, int) or isinstance(gap2, bool):
        gap2 = sum(
            int(count)
            for gap, count in gaps.items()
            if str(gap).isdigit()
            and int(gap) >= 2
            and isinstance(count, int)
            and not isinstance(count, bool)
            and count > 0
        )
    violations = validation.get("violations")
    if isinstance(violations, list):
        violation_count = len(violations)
    else:
        violation_count = metrics.get("app_constraint_violation_count", 0)

    quality = {
        "hardValid": validation.get("hard_ok") is True
        or metrics.get("hard_ok") is True,
        "violations": violation_count,
        "expectedPeriods": metrics.get("expected_periods"),
        "scheduledPeriods": metrics.get("scheduled_periods"),
        "unassignedPeriods": metrics.get("unassigned_periods"),
        "teacherSessions": metrics.get("teacher_sessions"),
        "onePeriodTeacherSessions": metrics.get("one_period_teacher_sessions"),
        "gap1": gaps.get("1", gaps.get(1, 0)),
        "gap2": gap2,
    }
    for key in quality.keys() - {"hardValid"}:
        _integer(quality[key], f"result.quality.{key}")
    return quality


def quality_meets_envelope(
    quality: Mapping[str, Any], envelope: Mapping[str, Any]
) -> bool:
    if envelope.get("requireHardValid") is True and quality.get("hardValid") is not True:
        return False
    checks = (
        ("violations", "maximumViolations"),
        ("unassignedPeriods", "maximumUnassignedPeriods"),
        ("teacherSessions", "maximumTeacherSessions"),
        ("onePeriodTeacherSessions", "maximumOnePeriodTeacherSessions"),
        ("gap1", "maximumGap1"),
        ("gap2", "maximumGap2"),
    )
    if quality.get("scheduledPeriods", -1) < envelope.get("minimumScheduledPeriods", 0):
        return False
    return all(quality.get(metric, 10**18) <= envelope.get(limit, -1) for metric, limit in checks)


def validate_model_plan(value: Any) -> Mapping[str, Any]:
    plan = _mapping(value, "modelPlan")
    _exact_keys(
        plan,
        {
            "protocol",
            "schemaVersion",
            "fixtureId",
            "phase",
            "request",
            "model",
            "variableMap",
            "result",
        },
        "modelPlan",
    )
    if plan["protocol"] != MODEL_PLAN_PROTOCOL:
        raise ModelPlanContractError("modelPlan.protocol is unsupported")
    if plan["schemaVersion"] != MODEL_PLAN_SCHEMA_VERSION:
        raise ModelPlanContractError("modelPlan.schemaVersion is unsupported")
    if not isinstance(plan["fixtureId"], str) or not plan["fixtureId"]:
        raise ModelPlanContractError("modelPlan.fixtureId must be non-empty")
    if plan["phase"] not in _PHASES:
        raise ModelPlanContractError("modelPlan.phase is unsupported")

    request = _artifact(plan["request"], "modelPlan.request")
    if request["encoding"] != CANONICAL_JSON_ENCODING:
        raise ModelPlanContractError("modelPlan.request encoding is unsupported")

    model = _mapping(plan["model"], "modelPlan.model")
    _exact_keys(
        model,
        {
            "kind",
            "runtime",
            "encoding",
            "digest",
            "sha256",
            "bytes",
            "parameters",
            "statistics",
        },
        "modelPlan.model",
    )
    if model["kind"] not in _MODEL_KINDS:
        raise ModelPlanContractError("modelPlan.model.kind is unsupported")
    for key in ("runtime", "encoding"):
        if not isinstance(model[key], str) or not model[key]:
            raise ModelPlanContractError(f"modelPlan.model.{key} must be non-empty")
    _sha256(model["digest"], "modelPlan.model.digest")
    _sha256(model["sha256"], "modelPlan.model.sha256")
    _integer(model["bytes"], "modelPlan.model.bytes", minimum=1)
    _artifact(model["parameters"], "modelPlan.model.parameters")
    statistics = _mapping(model["statistics"], "modelPlan.model.statistics")
    _exact_keys(
        statistics,
        {"variables", "constraints", "objectiveVariables", "hintVariables"},
        "modelPlan.model.statistics",
    )
    for key, item in statistics.items():
        _integer(item, f"modelPlan.model.statistics.{key}")

    variable_map = _mapping(plan["variableMap"], "modelPlan.variableMap")
    _exact_keys(
        variable_map,
        {"encoding", "sha256", "bytes", "entries"},
        "modelPlan.variableMap",
    )
    if variable_map["encoding"] != VARIABLE_MAP_ENCODING:
        raise ModelPlanContractError("modelPlan.variableMap encoding is unsupported")
    _sha256(variable_map["sha256"], "modelPlan.variableMap.sha256")
    _integer(variable_map["bytes"], "modelPlan.variableMap.bytes", minimum=1)
    entries = _integer(variable_map["entries"], "modelPlan.variableMap.entries")
    if entries != statistics["variables"]:
        raise ModelPlanContractError("variable map must cover every model variable")

    result = _mapping(plan["result"], "modelPlan.result")
    _exact_keys(
        result,
        {"encoding", "sha256", "bytes", "quality", "qualityEnvelope"},
        "modelPlan.result",
    )
    if result["encoding"] != CANONICAL_JSON_ENCODING:
        raise ModelPlanContractError("modelPlan.result encoding is unsupported")
    _sha256(result["sha256"], "modelPlan.result.sha256")
    _integer(result["bytes"], "modelPlan.result.bytes", minimum=1)

    quality = _mapping(result["quality"], "modelPlan.result.quality")
    quality_keys = {
        "hardValid",
        "violations",
        "expectedPeriods",
        "scheduledPeriods",
        "unassignedPeriods",
        "teacherSessions",
        "onePeriodTeacherSessions",
        "gap1",
        "gap2",
    }
    _exact_keys(quality, quality_keys, "modelPlan.result.quality")
    if not isinstance(quality["hardValid"], bool):
        raise ModelPlanContractError("modelPlan.result.quality.hardValid must be boolean")
    for key in quality_keys - {"hardValid"}:
        _integer(quality[key], f"modelPlan.result.quality.{key}")
    if quality["scheduledPeriods"] > quality["expectedPeriods"]:
        raise ModelPlanContractError("scheduled periods exceed expected periods")

    envelope = _mapping(result["qualityEnvelope"], "modelPlan.result.qualityEnvelope")
    envelope_keys = {
        "requireHardValid",
        "maximumViolations",
        "minimumScheduledPeriods",
        "maximumUnassignedPeriods",
        "maximumTeacherSessions",
        "maximumOnePeriodTeacherSessions",
        "maximumGap1",
        "maximumGap2",
    }
    _exact_keys(envelope, envelope_keys, "modelPlan.result.qualityEnvelope")
    if not isinstance(envelope["requireHardValid"], bool):
        raise ModelPlanContractError("quality envelope hard-valid flag must be boolean")
    for key in envelope_keys - {"requireHardValid"}:
        _integer(envelope[key], f"modelPlan.result.qualityEnvelope.{key}")
    if not quality_meets_envelope(quality, envelope):
        raise ModelPlanContractError("golden result violates its quality envelope")
    return plan


def model_plan_digest(value: Any) -> str:
    validate_model_plan(value)
    digest = hashlib.sha256()
    digest.update((MODEL_PLAN_DIGEST_PROTOCOL + "\0").encode("ascii"))
    digest.update(canonical_json_bytes(value))
    return digest.hexdigest()


def _verify_artifact(descriptor: Mapping[str, Any], raw: bytes, name: str) -> None:
    if descriptor["bytes"] != len(raw):
        raise ModelPlanContractError(f"{name} byte length drifted")
    if descriptor["sha256"] != sha256_hex(raw):
        raise ModelPlanContractError(f"{name} digest drifted")


def validate_variable_map(
    value: Any, *, expected_entries: int | None = None
) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        raise ModelPlanContractError("variable map must be an array")
    if expected_entries is not None and len(value) != expected_entries:
        raise ModelPlanContractError("variable map entry count drifted")
    for expected_index, raw_entry in enumerate(value):
        entry = _mapping(raw_entry, f"variableMap[{expected_index}]")
        _exact_keys(entry, {"index", "key", "role"}, f"variableMap[{expected_index}]")
        if entry["index"] != expected_index:
            raise ModelPlanContractError("variable map indices must be contiguous")
        if not isinstance(entry["key"], str) or not entry["key"]:
            raise ModelPlanContractError("variable map key must be non-empty")
        if not isinstance(entry["role"], str) or not entry["role"]:
            raise ModelPlanContractError("variable map role must be non-empty")
    return value


def verify_model_plan_artifacts(
    plan_value: Any,
    *,
    request: Any,
    model_bytes: bytes,
    parameter_bytes: bytes,
    variable_map: Any,
    result: Mapping[str, Any],
) -> None:
    plan = validate_model_plan(plan_value)
    _verify_artifact(plan["request"], canonical_json_bytes(request), "request")
    _verify_artifact(plan["model"], bytes(model_bytes), "model")
    if plan["model"]["digest"] != wire_model_digest(bytes(model_bytes)):
        raise ModelPlanContractError("model wire digest drifted")
    _verify_artifact(
        plan["model"]["parameters"], bytes(parameter_bytes), "model parameters"
    )
    _verify_artifact(
        plan["variableMap"], canonical_json_bytes(variable_map), "variable map"
    )
    validate_variable_map(
        variable_map,
        expected_entries=plan["variableMap"]["entries"],
    )
    _verify_artifact(plan["result"], canonical_json_bytes(result), "result")
    if quality_from_result(result) != plan["result"]["quality"]:
        raise ModelPlanContractError("result quality drifted")


def verify_fixture_bundle(value: Any) -> Mapping[str, Any]:
    bundle = _mapping(value, "fixtureBundle")
    _exact_keys(bundle, {"plan", "artifacts"}, "fixtureBundle")
    artifacts = _mapping(bundle["artifacts"], "fixtureBundle.artifacts")
    _exact_keys(
        artifacts,
        {"request", "modelBase64", "parameterBase64", "variableMap", "result"},
        "fixtureBundle.artifacts",
    )
    try:
        model_bytes = base64.b64decode(artifacts["modelBase64"], validate=True)
        parameter_bytes = base64.b64decode(
            artifacts["parameterBase64"], validate=True
        )
    except (binascii.Error, TypeError, ValueError) as exc:
        raise ModelPlanContractError("fixture model base64 is invalid") from exc
    verify_model_plan_artifacts(
        bundle["plan"],
        request=artifacts["request"],
        model_bytes=model_bytes,
        parameter_bytes=parameter_bytes,
        variable_map=artifacts["variableMap"],
        result=_mapping(artifacts["result"], "fixtureBundle.artifacts.result"),
    )
    return bundle
