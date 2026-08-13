from __future__ import annotations

import base64
import copy
import json
import sys
import unittest
from pathlib import Path

from google.protobuf import text_format
from ortools.sat import cp_model_pb2, sat_parameters_pb2
from ortools.sat.python import cp_model


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = RUNTIME_ROOT.parent
FIXTURE_ROOT = RUNTIME_ROOT / "fixtures" / "model_plan_v1"
sys.path.insert(0, str(RUNTIME_ROOT / "src"))
sys.path.insert(0, str(RUNTIME_ROOT))

from scripts.verify_model_plan_golden import (  # noqa: E402
    _cp_sat_statistics,
    _wrapper_payload,
)
from tkb_optimizer_ref.model_plan import (  # noqa: E402
    MODEL_PLAN_DIGEST_PROTOCOL,
    MODEL_PLAN_PROTOCOL,
    MODEL_PLAN_SCHEMA_VERSION,
    ModelPlanContractError,
    canonical_json_bytes,
    model_plan_digest,
    validate_model_plan,
    verify_fixture_bundle,
    verify_model_plan_artifacts,
)


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class ModelPlanContractTests(unittest.TestCase):
    def test_schema_and_golden_index_are_version_locked(self) -> None:
        schema = _json(RUNTIME_ROOT / "contracts" / "tkb-model-plan-v1.schema.json")
        self.assertEqual(schema["properties"]["protocol"]["const"], MODEL_PLAN_PROTOCOL)
        self.assertEqual(
            schema["properties"]["schemaVersion"]["const"],
            MODEL_PLAN_SCHEMA_VERSION,
        )
        self.assertFalse(schema["additionalProperties"])

        index = _json(FIXTURE_ROOT / "golden-index.json")
        self.assertEqual(index["protocol"], "tkb-model-plan-golden-index-v1")
        self.assertEqual(index["digestProtocol"], MODEL_PLAN_DIGEST_PROTOCOL)
        self.assertEqual(
            [item["fixtureId"] for item in index["fixtures"]],
            ["small-cp-sat-v1", "automatic-refinement-1566-v1"],
        )
        for item in index["fixtures"]:
            value = _json(FIXTURE_ROOT / item["path"])
            plan = value["plan"] if item["artifactsCommitted"] else value
            self.assertEqual(validate_model_plan(plan)["fixtureId"], item["fixtureId"])
            self.assertEqual(model_plan_digest(plan), item["planSha256"])

    def test_small_bundle_freezes_request_model_map_and_result(self) -> None:
        bundle = _json(FIXTURE_ROOT / "small-cp-sat.bundle.json")
        verify_fixture_bundle(bundle)
        plan = bundle["plan"]
        artifacts = bundle["artifacts"]
        model_bytes = base64.b64decode(artifacts["modelBase64"], validate=True)
        parameter_bytes = base64.b64decode(
            artifacts["parameterBase64"], validate=True
        )
        statistics, _variable_map = _cp_sat_statistics(model_bytes)
        self.assertEqual(statistics, plan["model"]["statistics"])

        model_wire = cp_model_pb2.CpModelProto.FromString(model_bytes)
        parameters_wire = sat_parameters_pb2.SatParameters.FromString(parameter_bytes)
        model = cp_model.CpModel()
        model.proto.parse_text_format(text_format.MessageToString(model_wire))
        solver = cp_model.CpSolver()
        solver.parameters.parse_text_format(
            text_format.MessageToString(parameters_wire)
        )
        status = solver.solve(model)
        self.assertEqual(solver.status_name(status), "OPTIMAL")
        self.assertEqual(list(solver.response_proto.solution), [1, 0])

    def test_unknown_schema_field_is_rejected(self) -> None:
        plan = _json(FIXTURE_ROOT / "automatic-1566.plan.json")
        plan["model"]["silentNewField"] = True
        with self.assertRaisesRegex(ModelPlanContractError, "schema drift"):
            validate_model_plan(plan)

    def test_1566_quality_regression_is_rejected(self) -> None:
        plan = _json(FIXTURE_ROOT / "automatic-1566.plan.json")
        for field, value in (("teacherSessions", 489), ("gap1", 51), ("gap2", 1)):
            with self.subTest(field=field):
                regressed = copy.deepcopy(plan)
                regressed["result"]["quality"][field] = value
                with self.assertRaisesRegex(
                    ModelPlanContractError, "quality envelope"
                ):
                    validate_model_plan(regressed)

    def test_private_1566_capture_matches_committed_manifest_when_available(self) -> None:
        request_path = REPO_ROOT / ".codex_tmp" / "parity-1566-normalized-request.json"
        model_path = REPO_ROOT / ".codex_tmp" / "model-plan-1566-step0-wrapper.json"
        result_path = REPO_ROOT / ".codex_tmp" / "parity-1566-agent-result.json"
        if not all(path.is_file() for path in (request_path, model_path, result_path)):
            self.skipTest("private 1,566-period capture is not present")

        plan = _json(FIXTURE_ROOT / "automatic-1566.plan.json")
        request = _json(request_path)
        result = _json(result_path)
        payload, model_bytes, parameter_bytes = _wrapper_payload(model_path)
        statistics, variable_map = _cp_sat_statistics(model_bytes)
        self.assertEqual(payload["modelDigest"], plan["model"]["digest"])
        self.assertEqual(statistics, plan["model"]["statistics"])
        self.assertEqual(
            len(canonical_json_bytes(variable_map)), plan["variableMap"]["bytes"]
        )
        verify_model_plan_artifacts(
            plan,
            request=request,
            model_bytes=model_bytes,
            parameter_bytes=parameter_bytes,
            variable_map=variable_map,
            result=result,
        )


if __name__ == "__main__":
    unittest.main()
