from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path

from google.protobuf import text_format
from ortools.sat import cp_model_pb2, sat_parameters_pb2
from ortools.sat.python import cp_model


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))

from tkb_optimizer_ref.external_cp_sat import (  # noqa: E402
    ExternalCpSatLnsPolicy,
    ExternalCpSatPending,
    ExternalCpSatProtocolError,
    ExternalCpSatUnusableResponse,
    external_cp_sat_lns_policy_from_request,
    external_model_digest,
    external_solver_scope,
    install_solver_response,
    prepare_external_cp_sat_lns_model,
    serialize_cp_model,
    serialize_sat_parameters,
    solve_with_external_runtime,
)
from tkb_optimizer_ref.models import Assignment, ClassInfo, SchoolData  # noqa: E402
from tkb_optimizer_ref.session_cp_sat import solve_session_allocation_cp_sat  # noqa: E402


def _native_wire_solver(model_bytes: bytes, parameter_bytes: bytes) -> bytes:
    model_wire = cp_model_pb2.CpModelProto.FromString(model_bytes)
    parameters_wire = sat_parameters_pb2.SatParameters.FromString(parameter_bytes)

    model = cp_model.CpModel()
    model.proto.parse_text_format(text_format.MessageToString(model_wire))
    solver = cp_model.CpSolver()
    solver.parameters.parse_text_format(text_format.MessageToString(parameters_wire))
    solver.solve(model)

    response = cp_model_pb2.CpSolverResponse()
    text_format.Parse(str(solver.response_proto), response)
    return response.SerializeToString()


class ExternalCpSatTests(unittest.TestCase):
    @staticmethod
    def _synthetic_lns_model() -> tuple[bytes, bytes]:
        model = cp_model.CpModel()
        n_vars = {}
        z_vars = {}
        for assignment in range(3):
            teacher = f"T{assignment}"
            class_name = f"C{assignment}"
            for session in range(2):
                n_var = model.new_int_var(0, 2, f"n_{assignment}_{session}")
                z_var = model.new_bool_var(f"z_{teacher}_{session}")
                c_var = model.new_bool_var(f"c_{class_name}_{session}")
                period_var = model.new_bool_var(
                    f"period_block_{assignment}_{session}_2_1"
                )
                n_vars[(assignment, session)] = n_var
                z_vars[(teacher, session)] = z_var
                model.add(n_var == 2 * period_var)
                model.add(n_var <= 2 * z_var)
                model.add(n_var >= z_var)
                model.add(n_var <= 2 * c_var)
                model.add(n_var >= c_var)
                model.add_hint(n_var, 2)
                model.add_hint(z_var, 1)
                model.add_hint(c_var, 1)
                model.add_hint(period_var, 1)
            model.add(
                n_vars[(assignment, 0)] + n_vars[(assignment, 1)] == 4
            )
        model.minimize(sum(z_vars.values()))
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 5
        solver.parameters.num_search_workers = 1
        return serialize_cp_model(model), serialize_sat_parameters(solver.parameters)

    def test_wire_runtime_materializes_with_regular_solver_api(self) -> None:
        model = cp_model.CpModel()
        first = model.new_bool_var("first")
        second = model.new_bool_var("second")
        model.add(first + second >= 1)
        model.minimize(first + 2 * second)

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 5
        status = solve_with_external_runtime(model, solver, _native_wire_solver)

        self.assertEqual(solver.status_name(status), "OPTIMAL")
        self.assertEqual(solver.value(first), 1)
        self.assertEqual(solver.value(second), 0)
        self.assertEqual(solver.objective_value, 1)

    def test_invalid_solution_vector_is_rejected(self) -> None:
        response = cp_model_pb2.CpSolverResponse(
            status=cp_model_pb2.CpSolverStatus.FEASIBLE,
            solution=[1],
        )
        with self.assertRaisesRegex(
            ExternalCpSatProtocolError,
            "solution vector does not match",
        ):
            install_solver_response(
                cp_model.CpSolver(),
                response.SerializeToString(),
                expected_variables=2,
            )

    def test_unknown_response_is_rejected_before_materialization(self) -> None:
        response = cp_model_pb2.CpSolverResponse(
            status=cp_model_pb2.CpSolverStatus.UNKNOWN,
            wall_time=0.1,
        )
        with self.assertRaisesRegex(
            ExternalCpSatUnusableResponse,
            "non-feasible status: UNKNOWN",
        ):
            install_solver_response(
                cp_model.CpSolver(),
                response.SerializeToString(),
                expected_variables=2,
            )
        self.assertFalse(issubclass(ExternalCpSatUnusableResponse, Exception))

    def test_browser_lns_policy_accepts_complete_incumbent_with_quality_debt(self) -> None:
        request_data = {
            "tkbSolverResult": {
                "lessons": [
                    {
                        "teacher": "T1",
                        "day": 2,
                        "session": "AM",
                        "period": 1,
                        "fixed": True,
                    }
                ],
                "metrics": {
                    "hard_ok": True,
                    "expected_periods": 1,
                    "scheduled_periods": 1,
                    "unassigned_periods": 0,
                    "teacher_sessions": 1,
                    "one_period_teacher_sessions": 0,
                    "teacher_gap2_sessions": 0,
                },
            }
        }
        policy = external_cp_sat_lns_policy_from_request(
            request_data,
            {
                "browser_wasm_external_cp_sat": True,
                "optimization_focus": "automatic",
                "random_seed": 17,
            },
        )
        self.assertTrue(policy.enabled)
        self.assertFalse(policy.already_scoped)
        self.assertEqual(policy.random_seed, 17)
        self.assertEqual(policy.fixed_teacher_periods, (("T1", 0, (1,)),))

        request_data["tkbSolverResult"]["metrics"]["one_period_teacher_sessions"] = 3
        request_data["tkbSolverResult"]["metrics"]["teacher_gap2_sessions"] = 1
        debt_policy = external_cp_sat_lns_policy_from_request(
            request_data,
            {
                "browser_wasm_external_cp_sat": True,
                "optimization_focus": "automatic",
            },
        )
        self.assertTrue(debt_policy.enabled)
        self.assertEqual(debt_policy.max_one_period_sessions, 3)
        self.assertEqual(debt_policy.max_gap2_sessions, 1)

        scoped_policy = external_cp_sat_lns_policy_from_request(
            request_data,
            {
                "browser_wasm_external_cp_sat": True,
                "optimization_focus": "automatic",
                "ui_use_existing_complete_incumbent": True,
                "ui_existing_incumbent_revalidated": True,
            },
        )
        self.assertTrue(scoped_policy.enabled)
        self.assertTrue(scoped_policy.already_scoped)

    def test_browser_lns_freezes_primary_incumbent_outside_connected_neighborhood(self) -> None:
        model_bytes, parameter_bytes = self._synthetic_lns_model()
        original = cp_model_pb2.CpModelProto.FromString(model_bytes)
        policy = ExternalCpSatLnsPolicy(
            enabled=True,
            random_seed=17,
            max_teacher_sessions=6,
            max_one_period_sessions=0,
            max_gap2_sessions=0,
        )
        prepared = prepare_external_cp_sat_lns_model(
            model_bytes,
            parameter_bytes,
            policy,
        )
        self.assertTrue(prepared.applied)
        self.assertEqual(prepared.released_assignments, 2)
        self.assertEqual(prepared.target_teachers, 2)
        self.assertEqual(prepared.fixed_primary_variables, 4)

        transformed = cp_model_pb2.CpModelProto.FromString(prepared.model_bytes)
        self.assertEqual(len(transformed.variables), len(original.variables))
        retained_names = {
            transformed.variables[index].name
            for index in transformed.solution_hint.vars
        }
        self.assertTrue(retained_names)
        self.assertTrue(
            all(
                name.startswith("n_") or name.startswith("period_block_")
                for name in retained_names
            )
        )
        self.assertGreater(len(transformed.constraints), len(original.constraints))
        transformed_parameters = sat_parameters_pb2.SatParameters.FromString(
            prepared.parameter_bytes
        )
        self.assertEqual(transformed_parameters.max_time_in_seconds, 5)
        self.assertEqual(
            prepared.model_bytes,
            prepare_external_cp_sat_lns_model(
                model_bytes,
                parameter_bytes,
                policy,
            ).model_bytes,
        )
        self.assertEqual(
            hashlib.sha256(prepared.model_bytes).hexdigest(),
            "b28f6d94b4b9771d846116cbc28de57a9bdab7d3a3eaa7b09eb191ca0999fe2c",
        )

    def test_browser_already_scoped_lns_is_not_frozen_again(self) -> None:
        model_bytes, parameter_bytes = self._synthetic_lns_model()
        prepared = prepare_external_cp_sat_lns_model(
            model_bytes,
            parameter_bytes,
            ExternalCpSatLnsPolicy(enabled=True, already_scoped=True),
        )

        self.assertFalse(prepared.applied)
        self.assertEqual(prepared.model_bytes, model_bytes)
        self.assertEqual(prepared.parameter_bytes, parameter_bytes)

    def test_session_model_can_be_solved_outside_python_materializer(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6A1", grade="6")],
            assignments=[
                Assignment(
                    class_name="6A1",
                    grade="6",
                    subject="Math",
                    teacher="T1",
                    periods_per_week=2,
                    max_periods_per_session=2,
                )
            ],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={("6", "Math"): 2},
            limits_by_grade_subject={("6", "Math"): 2},
        )

        allocations, metrics = solve_session_allocation_cp_sat(
            data,
            max_teacher_sessions=1,
            max_one_period_sessions=0,
            time_limit_seconds=5,
            num_workers=1,
            external_solver=_native_wire_solver,
        )

        self.assertEqual(sum(item.count for item in allocations), 2)
        self.assertEqual(metrics["teacher_sessions"], 1)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["execution_runtime"], "external_cp_sat")

    def test_request_scope_externalizes_nested_session_solve(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6A1", grade="6")],
            assignments=[
                Assignment(
                    class_name="6A1",
                    grade="6",
                    subject="Math",
                    teacher="T1",
                    periods_per_week=2,
                    max_periods_per_session=2,
                )
            ],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={("6", "Math"): 2},
            limits_by_grade_subject={("6", "Math"): 2},
        )

        with external_solver_scope(_native_wire_solver):
            allocations, metrics = solve_session_allocation_cp_sat(
                data,
                max_teacher_sessions=1,
                max_one_period_sessions=0,
                time_limit_seconds=5,
                num_workers=1,
            )

        self.assertEqual(sum(item.count for item in allocations), 2)
        self.assertEqual(metrics["execution_runtime"], "external_cp_sat")

    def test_binary_model_export_and_digest_bind_the_variable_model(self) -> None:
        model = cp_model.CpModel()
        first = model.new_bool_var("first")
        model.add(first == 1)
        raw = serialize_cp_model(model)

        parsed = cp_model_pb2.CpModelProto.FromString(raw)
        self.assertEqual(len(parsed.variables), 1)
        self.assertEqual(
            external_model_digest(raw, b"first parameters"),
            external_model_digest(raw, b"shorter watchdog parameters"),
        )
        second_model = cp_model.CpModel()
        second_model.new_bool_var("different")
        self.assertNotEqual(
            external_model_digest(raw, b""),
            external_model_digest(serialize_cp_model(second_model), b""),
        )
        self.assertFalse(issubclass(ExternalCpSatPending, Exception))


if __name__ == "__main__":
    unittest.main()
