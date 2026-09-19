# Mục lục code — 6 file nguồn khổng lồ
> **File này do máy sinh ra.** Đừng sửa tay — chạy `python tools/make-code-map.py`
> để cập nhật sau khi đổi code. Kiểm tra lỗi thời: `python tools/make-code-map.py --check`.

## Vì sao chưa tách nhỏ 6 file này

`web/pages/tkb-rust-bridge.js` nằm trọn trong **một IIFE duy nhất**
(`(function(){ "use strict"; ... })()`) — hàng trăm hàm dùng chung một phạm vi
đóng, nên không thể cắt thành nhiều thẻ `<script>`; muốn tách phải chuyển sang
ES module hoặc nâng toàn bộ trạng thái lên một namespace. Với số test đang fail
sẵn (xem `docs/test-baseline.json`), chưa có lưới an toàn để làm việc đó.

`web/pages/phanmon.js` thì **không** bọc IIFE — đây là ứng viên tách an toàn nhất
khi nào muốn bắt đầu.

Mục lục dưới đây là giải pháp tạm: không đổi một dòng code nào, nhưng cho biết
logic nằm ở đâu để nhảy thẳng tới.

## Tổng quan

| File | Số dòng | Ký hiệu | Nội dung |
|---|---:|---:|---|
| [`solver_runtime/src/tkb_new/adapter.py`](#solver-runtimesrctkb-newadapterpy) | 27,044 | 229 | Cau noi giua du lieu UI va cac bo giai; chua phan lon logic dieu phoi. |
| [`rust_api/src/main.rs`](#rust-apisrcmainrs) | 25,072 | 334 | Toan bo HTTP API cua backend Rust: dinh tuyen, phien, kho SQLite, hang doi giai. |
| [`web/pages/tkb-rust-bridge.js`](#webpagestkb-rust-bridgejs) | 22,552 | 743 | Cau noi trinh duyet -> backend: nut Cherry / Toi uu v3, ngan sach thoi gian, cong chat luong. |
| [`rust_api/src/native_solver.rs`](#rust-apisrcnative-solverrs) | 17,512 | 261 | Bo giai native trong Rust (duong nhanh, khong qua Python). |
| [`web/pages/phanmon.js`](#webpagesphanmonjs) | 15,302 | 802 | Man hinh Phan cong + Xep TKB: bang, thao tac o, thong ke, xuat file. |
| [`web/pages/tkb-fet-engine.js`](#webpagestkb-fet-enginejs) | 9,485 | 117 | Engine FET thuan JS chay trong trinh duyet (nut ▶). |
| | **116,967** | | |

---

## `solver_runtime/src/tkb_new/adapter.py`

Cau noi giua du lieu UI va cac bo giai; chua phan lon logic dieu phoi.

**27,044 dòng · 229 ký hiệu cấp cao nhất**

| Cụm | Số hàm | Vùng dòng | Vài ký hiệu tiêu biểu |
|---|---:|---|---|
| **teacher** | 29 | 1,099–9,547 | `_teacher_sessions`, `_teacher_session_count_for_allocations`, `_teacher_session_count_for_lessons`, `_teacher_session_opt_quality`, … |
| **automatic** | 12 | 2,795–13,490 | `_automatic_session_exploration_candidate_better`, `_automatic_safe_stage_common`, `_automatic_quality_repair_problem_fingerprint`, `_automatic_quality_repair_session_headroom`, … |
| **session** | 9 | 164–5,044 | `_session_key`, `_session_index_for_cuts`, `_session_vectors_for_cuts`, `_session_priority_metrics_acceptable`, … |
| **solve** | 8 | 9,928–23,045 | `_solve_teacher_session_benders_candidate`, `_solve_fast_tight_fixed_off_benders`, `_solve_browser_external_cpsat_lns`, `_solve_cloud_run_quality_lexicographic_tail_v1`, … |
| **refinement** | 7 | 8,445–9,216 | `_refinement_request_seed`, `_refinement_school_signature`, `_refinement_learning_from_payload`, `_refinement_operator_priorities`, … |
| **cut** | 6 | 1,256–1,366 | `_cut_for_session_indexes`, `_cut_for_period_error_sparse`, `_cut_for_gap_sessions`, `_cut_for_one_period_teacher_sessions`, … |
| **build** | 5 | 266–7,951 | `_build_subject_aliases`, `_build_ghep_rule_aliases`, `_build_classes`, `build_school_data_from_ui`, … |
| **lesson** | 4 | 716–9,580 | `_lesson_block_min_required_length`, `_lesson_resource_conflict_details`, `_lesson_matches_violation`, `_lesson_identity` |
| **repair** | 4 | 3,897–6,836 | `_repair_one_period_affected_class_cluster`, `_repair_period_hint_for_class_fixed_off`, `_repair_period_hint_for_teacher_max_periods`, `_repair_period_hint_fixed_off_with_swaps` |
| **constraints** | 4 | 8,152–8,334 | `_constraints_allow_session_cp_sat_fast_path`, `_constraints_need_lesson_block_feasibility_ceiling`, `_constraints_have_subject_period_requirements`, `_constraints_need_period_feasibility_bridge` |
| **canonical** | 3 | 168–298 | `_canonical_grade`, `_canonical_teacher_value`, `_canonical_subject` |
| **assignment** | 3 | 730–1,227 | `_assignment_lesson_block_min_required_length`, `_assignment_lesson_block_minimum_periods`, `_assignment_index_for_cuts` |
| **school** | 3 | 793–8,422 | `_school_data_with_lesson_block_caps`, `_school_seed_sequence`, `_school_refinement_seed_sequence` |
| **period** | 3 | 1,452–9,907 | `_period_retry_error_from_best_effort`, `_period_hint_variant`, `_period_max_teacher_gap_setting` |
| **merge** | 3 | 1,479–8,778 | `_merge_existing_lessons_with_hint`, `_merge_fixed_lessons_into_solution`, `_merge_refinement_learning` |
| **complete** | 3 | 1,749–9,086 | `_complete_schedule_metrics_acceptable`, `_complete_payload_metrics_acceptable`, `_complete_first_teacher_session_cap` |
| **normalized** | 3 | 1,864–8,370 | `_normalized_optimization_focus`, `_normalized_gap_optimization_target`, `_normalized_auto_sort_mode` |
| **incremental** | 3 | 2,749–8,625 | `_incremental_refinement_gap1_cap`, `_incremental_refinement_candidate_better`, `_incremental_lns_profile` |
| **focused** | 3 | 2,774–3,370 | `_focused_session_merge_candidate_better`, `_focused_singleton_candidate_better`, `_focused_gap_candidate_better` |
| **singleton** | 3 | 2,916–3,415 | `_singleton_repair_session_headroom`, `_singleton_repair_exploration_headroom`, `_singleton_structural_lower_bound` |
| **fast** | 3 | 9,530–11,356 | `_fast_quality_warmup_direct_settings`, `_fast_benders_tight_fixed_off_profile`, `_fast_benders_failure_summary` |
| **payload** | 3 | 9,593–13,326 | `_payload_lessons_to_lessons`, `_payload_lessons_to_allocations`, `_payload_preserves_required_lessons` |

<details><summary>Lẻ tẻ — 105 ký hiệu không thuộc cụm nào</summary>

- `_setting_truthy` *(def)* — dòng 66
- `_legacy_solver_hints_enabled` *(def)* — dòng 75
- `ClassEntry` *(class)* — dòng 82
- `UiDataContext` *(class)* — dòng 92
- `_text` *(def)* — dòng 100
- `_cell_subject_text` *(def)* — dòng 104
- `_norm` *(def)* — dòng 114
- `_to_int` *(def)* — dòng 118
- `_to_float` *(def)* — dòng 127
- `_get_path` *(def)* — dòng 136
- `_truthy` *(def)* — dòng 145
- `_linked_day_avoided` *(def)* — dòng 149
- `_day_key` *(def)* — dòng 160
- `_app_class_alias` *(def)* — dòng 174
- `_compact_class_alias` *(def)* — dòng 189
- `_unique` *(def)* — dòng 193
- `_resolve_teacher_map` *(def)* — dòng 208
- `_ghep_row_list` *(def)* — dòng 334
- `_iter_no_teacher_ghep_rows` *(def)* — dòng 340
- `_subject_aliases` *(def)* — dòng 363
- `_lookup_matrix_number` *(def)* — dòng 403
- `_lookup_matrix_text` *(def)* — dòng 421
- `_slot_from_ui_key` *(def)* — dòng 438
- `_clone_jsonable` *(def)* — dòng 452
- `_map_rule_by_class_keys` *(def)* — dòng 459
- `_strip_removed_ui_rules` *(def)* — dòng 473
- `_normalize_constraints` *(def)* — dòng 483
- `_sanitize_impossible_lesson_block_mins` *(def)* — dòng 822
- `_allocations_from_lessons` *(def)* — dòng 1,119
- `SolverDeadline` *(class)* — dòng 1,155
- `_forbidden_session_vector_from_period_error` *(def)* — dòng 1,193
- `_new_cuts_for_period_metrics` *(def)* — dòng 1,407
- `_append_unique_session_cuts` *(def)* — dòng 1,433
- `_bounded_hint_lessons_for_school_data` *(def)* — dòng 1,514
- `_gap_total` *(def)* — dòng 1,538
- `_max_gap_size` *(def)* — dòng 1,542
- `_metric_int` *(def)* — dòng 1,547
- `_verified_one_period_floor_setting` *(def)* — dòng 1,557
- `_verified_one_period_floor_evidence_setting` *(def)* — dòng 1,574
- `_one_period_teacher_session_floor` *(def)* — dòng 1,585
- `_with_one_period_teacher_session_floor_metrics` *(def)* — dòng 1,608
- `_with_one_period_teacher_session_floor` *(def)* — dòng 1,626
- `_gap0_metrics_clean` *(def)* — dòng 1,706
- `_gap1_metrics_clean` *(def)* — dòng 1,717
- `_cloud_run_gap2_zero_stop_requested` *(def)* — dòng 1,878
- `_cloud_run_quality_lexicographic_v1_enabled` *(def)* — dòng 1,896
- `_settings_for_optimization_focus` *(def)* — dòng 1,916
- `_clamped_percent` *(def)* — dòng 2,143
- `_optimization_metric_payload` *(def)* — dòng 2,149
- `_capacity_partial_payload_metrics_acceptable` *(def)* — dòng 2,360
- `_positive_setting` *(def)* — dòng 2,449
- `_nonnegative_setting` *(def)* — dòng 2,456
- `_optimization_focus_goal_status` *(def)* — dòng 2,497
- `_attach_automatic_quality_repair_baseline` *(def)* — dòng 3,136
- `_safe_stage_gap_headroom` *(def)* — dòng 3,280
- `_probe_reduces_one_period` *(def)* — dòng 3,536
- `_should_attempt_session_priority_rescue` *(def)* — dòng 3,567
- `_local_one_period_cleanup` *(def)* — dòng 3,617
- `_add_at_most_one_internal_gap_constraints` *(def)* — dòng 3,861
- `_add_gap2_plus_indicator` *(def)* — dòng 3,872
- `_truthy_setting` *(def)* — dòng 5,022
- `_solver_worker_count` *(def)* — dòng 5,026
- `_relaxed_teacher_session_cap` *(def)* — dòng 5,052
- `_one_period_zero_probe_proved_infeasible` *(def)* — dòng 5,061
- `_no_teacher_assignment_keys` *(def)* — dòng 5,067
- `_extract_fixed_lessons_from_tkb` *(def)* — dòng 5,077
- `_fixed_only_tkb` *(def)* — dòng 5,193
- `_extract_hard_fixed_lessons_from_tkb` *(def)* — dòng 5,228
- `_strip_schedule_artifacts_for_fresh_solve` *(def)* — dòng 5,244
- `_rule_set_with_fixed_lesson_slots` *(def)* — dòng 5,263
- `_anchor_teacher_must_teach_lessons` *(def)* — dòng 5,298
- `_relax_unanchored_must_teach_for_capacity` *(def)* — dòng 5,439
- `_must_teach_slot_capacity_upper_bound` *(def)* — dòng 5,480
- `_preflight_teacher_constraint_feasibility` *(def)* — dòng 5,674
- `_rule_set_for_residual_fixed_lesson_validation` *(def)* — dòng 5,779
- `_context_without_fixed_lesson_demand` *(def)* — dòng 5,810
- `_aggregate_teacher_release_indexes` *(def)* — dòng 5,972
- `shared_fixed_teacher_slots` *(def)* — dòng 6,040
- `_release_invalid_fixed_lessons` *(def)* — dòng 6,061
- `_load_base_period_hint` *(def)* — dòng 6,169
- `_load_base_session_hint` *(def)* — dòng 7,116
- `_allowed_slots` *(def)* — dòng 7,183
- `_available_slot_count` *(def)* — dòng 7,196
- `_trim_context_to_available_slots` *(def)* — dòng 7,204
- `_adjust_base_hint_for_class_fixed_off` *(def)* — dòng 7,745
- `_placement_hard_ok_for_partial` *(def)* — dòng 7,892
- `_unassigned_from_shortfall` *(def)* — dòng 7,918
- `_subject_like_rule_needs_period_bridge` *(def)* — dòng 8,296
- `_ceil_div` *(def)* — dòng 8,390
- `_empty_refinement_learning` *(def)* — dòng 8,719
- `_attach_refinement_learning` *(def)* — dòng 8,844
- `_select_refinement_operator` *(def)* — dòng 8,876
- `_record_refinement_operator_attempt` *(def)* — dòng 9,027
- `validate_candidate_payload` *(def)* — dòng 9,630
- `_validated_client_fast_seed_lessons` *(def)* — dòng 9,698
- `_lessons_without_fixed_instances` *(def)* — dòng 9,887
- `_validated_existing_soft_incumbent_payload` *(def)* — dòng 11,959
- `_bounded_soft_incumbent_residual_completion` *(def)* — dòng 12,080
- `_polish_complete_incumbent_with_local_lns` *(def)* — dòng 12,365
- `_clean_quality_cycle_candidate` *(def)* — dòng 13,341
- `_unified_first_click_candidate_acceptable` *(def)* — dòng 13,464
- `_first_click_request_portfolio_seed` *(def)* — dòng 13,584
- `_two_stage_refinement_summary` *(def)* — dòng 16,587
- `_two_stage_refinement_candidate_usable` *(def)* — dòng 16,605
- `_repack_periods_for_fixed_sessions` *(def)* — dòng 16,639

</details>

---

## `rust_api/src/main.rs`

Toan bo HTTP API cua backend Rust: dinh tuyen, phien, kho SQLite, hang doi giai.

**25,072 dòng · 334 ký hiệu cấp cao nhất**

| Cụm | Số hàm | Vùng dòng | Vài ký hiệu tiêu biểu |
|---|---:|---|---|
| **agent** | 32 | 2,164–10,344 | `AgentHelperContext`, `agent_helper_context`, `agent_helper_bootstrap_json`, `agent_helper_status_json`, … |
| **reference** | 30 | 99–10,249 | `reference_helper_process_limit`, `reference_helper_process_limit`, `ReferenceHelperKind`, `ReferenceHelperProcessSnapshot`, … |
| **external** | 24 | 263–9,751 | `ExternalCpSatStreamInput`, `ExternalCpSatStream`, `ExternalCpSatStream`, `ExternalCpSatStreamEntry`, … |
| **solver** | 16 | 1,073–10,287 | `solver_owner_from_session`, `solver_request_owner`, `SolverPlanPolicy`, `solver_plan_policy_for_school`, … |
| **server** | 13 | 5,688–10,495 | `server_watchdog_remaining_from_snapshot`, `server_job_started_at_ms`, `server_job_started_at_for_owner`, `server_owned_watchdog_budget_ms`, … |
| **solve** | 11 | 1,572–13,028 | `SolvePlanClaimGuard`, `SolvePlanClaimGuard`, `SolvePlanClaimGuard`, `solve_result_json`, … |
| **cloud** | 8 | 780–7,164 | `CloudStopProbeRegistration`, `CloudStopProbeGuard`, `cloud_stop_probes`, `CloudStopProbeGuard`, … |
| **request** | 7 | 770–8,540 | `Request`, `request_client_ip`, `request_settings`, `request_policy_expected_periods`, … |
| **parse** | 7 | 990–9,897 | `parse_content_length`, `parse_auth_token`, `parse_header_ip`, `parse_request`, … |
| **native** | 6 | 6,219–12,062 | `native_solve_precheck`, `native_agent_required_for_request`, `native_agent_required_for_job`, `native_agent_required_response`, … |
| **school** | 5 | 1,290–5,609 | `school_plan_expired`, `school_plan_unavailable_response`, `new_school_user_record`, `school_store_get_json`, … |
| **fresh** | 5 | 2,829–8,999 | `fresh_automatic_no_checkpoint_rescue_eligible`, `fresh_automatic_no_checkpoint_rescue_body_eligible`, `fresh_automatic_quality_gate_required`, `fresh_automatic_quality_gate_met`, … |
| **merge** | 5 | 5,054–5,411 | `merge_school_admin_registry`, `merge_auth_registry`, `merge_union_object`, `merge_entity_object`, … |
| **browser** | 5 | 8,936–12,080 | `browser_mobile_checkpoint_vps_refine`, `browser_mobile_local_quality_terminal`, `browser_agent_required_for_request`, `browser_agent_required_for_job`, … |
| **managed** | 4 | 259–735 | `ManagedChild`, `ManagedStopFile`, `ManagedStopFile`, `ManagedChild` |
| **claim** | 4 | 1,400–1,547 | `claim_free_solve`, `claim_trial_solve`, `claim_plus_solve`, `claim_plan_solve` |
| **serverless** | 4 | 1,736–1,825 | `serverless_infrastructure_get_json`, `serverless_infrastructure_write_json`, `serverless_usage_get_json`, `serverless_usage_refresh_json` |
| **setting** | 4 | 6,251–6,466 | `setting_bool`, `setting_string`, `setting_u64`, `setting_u64_allow_zero` |
| **automatic** | 4 | 6,660–8,926 | `automatic_large_fresh_budget_floor_ms`, `automatic_best_effort_stop_quality_gate_required`, `automatic_best_effort_stop_quality_gate_met`, `automatic_best_effort_stop_quality_unmet` |
| **payload** | 4 | 7,528–8,232 | `payload_metric_i64`, `payload_metric_bool`, `payload_period_sum`, `payload_artifact_summary` |
| **auth** | 3 | 4,748–4,772 | `auth_registry_get_json`, `auth_session_get_json`, `auth_registry_post_json` |
| **registration** | 3 | 5,447–5,500 | `registration_ips_from_registry`, `registration_ip_owner_exists`, `registration_ip_from_school` |
| **normalize** | 3 | 7,970–13,334 | `normalize_reference_payload`, `normalize_export_date`, `normalize_export_file_prefix` |
| **run** | 3 | 9,268–9,990 | `run_external_cp_sat_step`, `run_reference_candidate_validator`, `run_reference_solver` |
| **export** | 3 | 13,232–13,240 | `export_tkb_class_docx_json`, `export_tkb_class_xlsx_json`, `export_tkb_class_file_json` |
| **static** | 3 | 13,427–13,566 | `static_file`, `static_resource_requires_cross_origin_isolation`, `static_http_response` |

<details><summary>Lẻ tẻ — 118 ký hiệu không thuộc cụm nào</summary>

- `std` *(impl)* — dòng 721
- `std` *(impl)* — dòng 729
- `App` *(struct)* — dòng 760
- `register_cloud_stop_probe` *(fn)* — dòng 796
- `main` *(fn)* — dòng 836
- `env_flag` *(fn)* — dòng 889
- `quiet_logs` *(fn)* — dòng 897
- `resolve_app_root` *(fn)* — dòng 901
- `handle_stream` *(fn)* — dòng 923
- `find_header_end` *(fn)* — dòng 986
- `registry_school_by_id` *(fn)* — dòng 1,112
- `plus_quota_cycle_id` *(fn)* — dòng 1,130
- `legacy_max_is_max1` *(fn)* — dòng 1,151
- `ascii_decimal` *(fn)* — dòng 1,170
- `days_in_month` *(fn)* — dòng 1,181
- `civil_days_since_unix_epoch` *(fn)* — dòng 1,191
- `plan_expiry_millis` *(fn)* — dòng 1,209
- `accept_solve_plan_claim` *(fn)* — dòng 1,638
- `class_count_from_school_data` *(fn)* — dòng 1,644
- `class_count_from_solve_request` *(fn)* — dòng 1,651
- `max1_class_limit_response` *(fn)* — dòng 1,655
- `with_solver_owner` *(fn)* — dòng 1,698
- `require_infrastructure_admin` *(fn)* — dòng 1,708
- `scoped_google_cloud_usage` *(fn)* — dòng 1,722
- `fet_solver_telemetry_post_json` *(fn)* — dòng 1,887
- `route` *(fn)* — dòng 2,016
- `trusted_agent_token_digest` *(fn)* — dòng 2,170
- `constant_time_ascii_equal` *(fn)* — dòng 2,181
- `trusted_agent_token_matches` *(fn)* — dòng 2,194
- `session_can_manage_agent` *(fn)* — dòng 2,212
- `adaptive_agent_worker_count` *(fn)* — dòng 2,719
- `try_trusted_queue_handoff` *(fn)* — dòng 3,340
- `load_auth_registry_value` *(fn)* — dòng 4,815
- `scoped_auth_registry` *(fn)* — dòng 4,824
- `copy_string_field` *(fn)* — dòng 4,898
- `valid_password_hash` *(fn)* — dòng 4,908
- `sanitized_school_schedules` *(fn)* — dòng 4,914
- `update_school_admin_school` *(fn)* — dòng 4,949
- `update_school_user_record` *(fn)* — dòng 4,985
- `valid_new_school_user_id` *(fn)* — dòng 5,016
- `duplicate_registration_ip` *(fn)* — dòng 5,227
- `preserve_monotonic_verification` *(fn)* — dòng 5,294
- `prune_deleted_school_ip_blocks` *(fn)* — dòng 5,325
- `count_new_keys` *(fn)* — dòng 5,347
- `object_key_set` *(fn)* — dòng 5,359
- `canonical_store_identity` *(fn)* — dòng 5,548
- `registry_school_for_store` *(fn)* — dòng 5,555
- `now_millis` *(fn)* — dòng 5,681
- `health_json` *(fn)* — dòng 6,157
- `sample_data_json` *(fn)* — dòng 6,206
- `value_truthy` *(fn)* — dòng 6,233
- `hybrid_cloud_run_requested` *(fn)* — dòng 6,293
- `clamp_hybrid_cloud_run_request` *(fn)* — dòng 6,303
- `clamped_solver_deadline_ms` *(fn)* — dòng 6,481
- `uses_unified_reference_compute_budget` *(fn)* — dòng 6,506
- `constraint_value_is_enabled` *(fn)* — dòng 6,520
- `has_subject_period_requirement` *(fn)* — dòng 6,531
- `collect_class_off_slots` *(fn)* — dòng 6,549
- `value_as_positive_u64` *(fn)* — dòng 6,795
- `cap_seconds_setting` *(fn)* — dòng 6,802
- `should_use_reference_solver` *(fn)* — dòng 6,820
- `expected_periods_from_request` *(fn)* — dòng 7,194
- `metrics_i64` *(fn)* — dòng 7,300
- `metrics_bool` *(fn)* — dòng 7,313
- `norm_key` *(fn)* — dòng 7,322
- `count_fixed_tkb_cells` *(fn)* — dòng 7,331
- `array_len` *(fn)* — dòng 7,355
- `object_len` *(fn)* — dòng 7,361
- `keyed_counts` *(fn)* — dòng 7,406
- `preserve_complete_hybrid_existing_payload` *(fn)* — dòng 7,726
- `unified_complete_refinement_requested` *(fn)* — dòng 7,808
- `existing_incumbent_payload` *(fn)* — dòng 7,819
- `complete_existing_incumbent_is_safe` *(fn)* — dòng 7,826
- `complete_existing_incumbent_payload` *(fn)* — dòng 7,845
- `ensure_object_child` *(fn)* — dòng 7,958
- `save_solve_artifacts` *(fn)* — dòng 8,302
- `last_valid_reference_wrapper` *(fn)* — dòng 8,459
- `constraint_value_active` *(fn)* — dòng 8,523
- `nonnegative_metric_value` *(fn)* — dòng 8,559
- `teacher_gap2_plus_metric` *(fn)* — dòng 8,572
- `strict_teacher_gap2_plus_metric` *(fn)* — dòng 8,589
- `strict_one_period_teacher_session_floor` *(fn)* — dòng 8,607
- `completion_first_fallback_terminal_allowed` *(fn)* — dòng 8,719
- `zero_slack_large_fresh_quality_debt_terminal_allowed` *(fn)* — dòng 8,790
- `mark_zero_slack_quality_debt_terminal` *(fn)* — dòng 8,860
- `spawn_external_cp_sat_stream` *(fn)* — dòng 9,337
- `append_external_cp_sat_stderr_tail` *(fn)* — dòng 9,497
- `advance_external_cp_sat_stream` *(fn)* — dòng 9,510
- `write_external_cp_sat_stream_input` *(fn)* — dòng 9,528
- `prepare_external_cp_sat_stream_response` *(fn)* — dòng 9,579
- `read_external_cp_sat_stream_output` *(fn)* — dòng 9,655
- `decode_reference_solver_stdout` *(fn)* — dòng 9,934
- `validate_cloud_solver_result` *(fn)* — dòng 9,955
- `response_json_payload` *(fn)* — dòng 10,257
- `stop_agent_best_effort_if_requested` *(fn)* — dòng 10,354
- `cleanup_server_owned_job` *(fn)* — dòng 10,463
- `start_server_solver_telemetry` *(fn)* — dòng 10,471
- `telemetry_outcome_from_reservation` *(fn)* — dòng 10,486
- `apply_agent_checkpoint_to_server_request` *(fn)* — dòng 10,732
- `spawn_server_owned_solver` *(fn)* — dòng 10,752
- `handoff_online_agent_before_vps_start` *(fn)* — dòng 11,991
- `required_agent_failure_response` *(fn)* — dòng 12,096
- `e2e_removed_json` *(fn)* — dòng 13,221
- `query_param` *(fn)* — dòng 13,295
- `looks_like_yyyymmdd` *(fn)* — dòng 13,321
- `tkb_export_dir` *(fn)* — dòng 13,342
- `next_tkb_export_path` *(fn)* — dòng 13,372
- `resolve_static_path` *(fn)* — dòng 13,465
- `clean_page_file` *(fn)* — dòng 13,482
- `canonical_page_redirect` *(fn)* — dòng 13,493
- `is_public_static_file` *(fn)* — dòng 13,509
- `content_type` *(fn)* — dòng 13,531
- `json_response` *(fn)* — dòng 13,556
- `http_response` *(fn)* — dòng 13,562
- `http_response_with_extra_headers` *(fn)* — dòng 13,580
- `redirect_response` *(fn)* — dòng 13,615
- `hex_nibble` *(fn)* — dòng 13,627
- `percent_decode` *(fn)* — dòng 13,636

</details>

---

## `web/pages/tkb-rust-bridge.js`

Cau noi trinh duyet -> backend: nut Cherry / Toi uu v3, ngan sach thoi gian, cong chat luong.

**22,552 dòng · 743 ký hiệu cấp cao nhất**

| Cụm | Số hàm | Vùng dòng | Vài ký hiệu tiêu biểu |
|---|---:|---|---|
| **tkb** | 68 | 768–22,508 | `__TKB_AUTO_SORT_PREFLIGHT_ACTIVE`, `__TKB_AUTO_SORT_PREFLIGHT_ACTIVE`, `__TKB_AUTO_SORT_CONTINUATION_QUEUED`, `__TKB_AUTO_SORT_CONTINUATION_QUEUED`, … |
| **apply** | 30 | 232–20,741 | `applySolverPresetQualityPolicy`, `applyDefaultFreshSortSettings`, `applyCustomSolveDurationSettings`, `applyHybridCloudRunBudget`, … |
| **teacher** | 20 | 5,884–15,084 | `isTeacherSessionOptSettings`, `teacherMustTeachSlotHasClassRoom`, `teacherSessionSignatureFromLessons`, `teacherCapacityPrecheckWarnings`, … |
| **should** | 19 | 361–14,140 | `shouldRequireCompletePresetResult`, `shouldRejectIncompletePresetPayload`, `shouldUseLegacyFallback`, `shouldAutoPlaceUnassignedFromUi`, … |
| **clear** | 17 | 699–22,518 | `clearCurrentSolveExecutorState`, `clearPostRollbackSettings`, `clearExistingRepairSettings`, `clearManualFreshRetryBudget`, … |
| **auto** | 15 | 746–21,944 | `autoSortPreflightTokenIsStale`, `autoSortPreflightActive`, `__AUTO_SORT_STOP_REQUESTED`, `__AUTO_SORT_STOP_REQUESTED`, … |
| **payload** | 15 | 7,571–15,028 | `payloadCompletion`, `payloadHasUsableSchedule`, `payloadIsMobileLocalQualityTerminal`, `payloadUnassignedPeriods`, … |
| **fixed** | 14 | 7,008–14,868 | `fixedLessonSubjectIds`, `fixedOnlyTkbForSolverRequest`, `hasFixedOffPressure`, `fixedLessonPortfolioProfile`, … |
| **solve** | 12 | 930–21,818 | `solveRequestModeAllowedForCurrentUser`, `solveDiagnosticText`, `solveTimingProfileKey`, `solveRequestModeForOptimizationContract`, … |
| **normalize** | 12 | 1,083–15,044 | `normalizeOverallTimeLimit`, `normalizeCustomSolveDurationSeconds`, `normalizeSolverPreset`, `normalizeBackendStartedAtMs`, … |
| **schedule** | 10 | 802–21,961 | `scheduleQueuedAutoSortContinuation`, `scheduleMutationTombstone`, `scheduleUiRefresh`, `schedulePostSolveUi`, … |
| **remember** | 10 | 1,202–17,840 | `rememberManualFreshRetryFailure`, `rememberPersistentAutoResumeSuppression`, `rememberServerCancellationIntent`, `rememberSettledBackendJob`, … |
| **current** | 9 | 917–22,512 | `currentUserIsSuperadmin`, `currentScheduleLessonsFromData`, `currentSolveClassLabel`, `isCurrentSolveRun`, … |
| **backend** | 9 | 1,945–6,038 | `backendSolverState`, `backendSolverAtCapacity`, `backendJobOwnerScope`, `backendJobStorageScope`, … |
| **add** | 9 | 4,778–15,088 | `add`, `addMustTeachAnchorsToFixedOnlyTkb`, `add`, `add`, … |
| **visible** | 8 | 6,031–18,061 | `visibleProgressLimit`, `visibleScheduleLessonsFromData`, `visibleLocationRuleDebt`, `hasVisibleTeacherQualityMetrics`, … |
| **class** | 8 | 6,961–14,709 | `classAliasIdsForFixedOff`, `classOffIdsForMustTeach`, `classSlotOffForMustTeach`, `classOffLocksForFingerprint`, … |
| **active** | 7 | 838–14,033 | `activeAutoSortPlanningMemo`, `setActiveBackendJobId`, `activeFocusedOptimizationSupportsBestStop`, `setActiveSolveRunningStatus`, … |
| **read** | 7 | 1,132–12,485 | `readCustomSolveDurationSeconds`, `readSolverPreset`, `readServerCancellationIntent`, `readPendingBackendJob`, … |
| **build** | 7 | 6,920–21,059 | `buildClientFastSeed`, `buildCompletionMessage`, `buildTeacherReleaseCellIndex`, `buildTeacherReleaseCellIndexAsync`, … |
| **release** | 6 | 772–15,256 | `releaseAutoSortPreflight`, `releaseAutoSortButtonSoon`, `release`, `releaseConstraintViolatingLessons`, … |
| **local** | 6 | 896–21,999 | `localAgentRoleAllowed`, `isLocalPageOrigin`, `localRequiredVpsError`, `localOffRestorePayload`, … |
| **sync** | 6 | 1,234–17,787 | `syncSolveDurationPreview`, `syncSolverPresetUi`, `syncBestEffortStopButton`, `syncVisibleCompletionMetrics`, … |
| **wait** | 6 | 1,440–4,633 | `waitForUiPaint`, `waitForServerOwnedSolverResult`, `waitForBackendSolverIdle`, `waitForBackendSolverTurn`, … |
| **ensure** | 6 | 3,105–14,785 | `ensureBackendReadyForNewSolve`, `ensureSolverPanel`, `ensureUnassignedPeriodsMetric`, `ensureLimitConflictStyles`, … |
| **mark** | 6 | 3,345–11,411 | `markScheduleMutationTombstone`, `markBackendJobQueued`, `markDeferredBackendSavePending`, `markStagedExistingPayload`, … |
| **progress** | 6 | 4,857–6,194 | `setProgress`, `progressBudgetSeconds`, `progressPhase`, `progressUsesWorkMetrics`, … |
| **settings** | 6 | 5,951–17,934 | `settingsForSolveRequestMode`, `settingsForPersistedOptimizationContract`, `settingsForAutoSort`, `settingsForTeacherSessionOpt`, … |
| **normalized** | 5 | 603–12,613 | `normalizedSolveExecutor`, `normalizedUsageExecutor`, `normalizedAutoSortMode`, `normalizedGapOptimizationTarget`, … |
| **write** | 5 | 1,112–6,623 | `writeCustomSolveDurationSeconds`, `writeSolverPreset`, `writePendingBackendJob`, `writeStatus`, … |
| **fast** | 5 | 1,500–13,624 | `fastPresetDeadlineSeconds`, `fastTeacherSessionPortfolioPlan`, `fastTeacherSessionPortfolioSatisfied`, `fastTeacherSessionPortfolioCap`, … |
| **deferred** | 5 | 4,208–12,667 | `deferredBackendJobIdForPayload`, `deferredBackendSavePendingFor`, `isDeferredIncompleteLessonBlockMinimumViolation`, `isDeferredIncompleteMustTeachViolation`, … |
| **rescue** | 5 | 4,733–4,827 | `rescueTeacherList`, `rescueClassCanon`, `rescueSubjectList`, `rescueTeacherFor`, … |
| **one** | 5 | 9,780–9,876 | `onePeriodTeacherSessionCount`, `onePeriodTeacherSessionLowerBound`, `onePeriodTeacherSessionTarget`, `onePeriodTeacherSessionFloorReached`, … |
| **cherry** | 5 | 10,125–10,469 | `isCherryEngineName`, `isCherryEngineRun`, `cherryIncompleteCandidatePreferred`, `cherryFocusMetricKey`, … |
| **automatic** | 5 | 17,565–21,909 | `automaticSortRefinementRound`, `automaticSortCycleState`, `automaticSortCycleIntentFromSettings`, `automaticSolverCeilingSeconds`, … |
| **enforce** | 4 | 173–998 | `enforceCompleteScheduleForUi`, `enforceCompletePresetSolveSettings`, `enforceRustRuntimeSafetySettings`, `enforceNoHintFreshSolveSettings` |
| **maybe** | 4 | 1,726–18,224 | `maybeRunBackendPrecheck`, `maybeScheduleAutoRefine`, `maybeFinishLocalUnassignedRepairSolve`, `maybeFinishFastOffRestoreSolve` |
| **server** | 4 | 2,132–4,580 | `serverJobAuthRequiredError`, `serverPayloadIsVpsOwned`, `serverOwnedResultWaitMs`, `serverJobIdsForCurrentSchedule` |
| **cancel** | 4 | 3,041–21,915 | `cancelBackendSolver`, `cancelBusyBackendAndWait`, `cancelBestEffortStopEscalationTimer`, `cancelPendingBackendResume` |
| **remove** | 4 | 3,978–12,256 | `removePendingBackendJob`, `removeFixedOffSlotForIds`, `removeLimitConflictPanel`, `removeConstraintViolationPanel` |
| **settle** | 4 | 4,311–5,014 | `settleDeferredBackendResult`, `settleDeferredBackendResultForPayload`, `settleStoppedSolveUi`, `settleAuthoritativeIdleSolveUi` |
| **best** | 4 | 4,382–4,462 | `bestEffortStopPendingFor`, `bestEffortStopStatusActive`, `bestEffortStopEscalationDue`, `setBestEffortStopPending` |
| **initial** | 4 | 5,129–19,966 | `initialVisibleProgressSettings`, `initialFastDraftSettings`, `initialFastDraftOptimizeSettings`, `initialAutomaticSolverCeilingSeconds` |
| **start** | 4 | 5,238–22,524 | `startInstantProgressTicker`, `startProgressTicker`, `startStatusDots`, `start` |
| **constraint** | 4 | 5,728–15,188 | `constraintProfile`, `constraintViolationFixHint`, `constraintAwareFastQualityBudgets`, `getConstraintModel` |
| **metric** | 4 | 6,648–11,800 | `metricNumber`, `metricProgressPercent`, `metricProgressCurrentLabel`, `metricGapTotal` |
| **compact** | 4 | 6,775–14,078 | `compactSolverResultForSnapshot`, `compactClientFastSeed`, `compactFingerprintHash`, `compactPortfolioSeedSequence` |
| **staged** | 4 | 10,783–10,903 | `stagedExistingRepairSettings`, `stagedExistingNeedsFreshRetry`, `stagedExistingErrorAllowsFreshRetry`, `stagedExistingFreshRetrySettings` |
| **bridge** | 4 | 11,828–21,817 | `bridgeStats`, `bridgeSapXepTuDongAll`, `bridgeSapXepTuDongAll`, `bridgeSapXepTuDongAll` |
| **subject** | 4 | 12,588–14,715 | `hasSubjectPeriodRequirements`, `isSubjectPeriodConstraintViolation`, `subjectAliasGroups`, `subjectKey` |
| **solver** | 3 | 104–8,390 | `solverRequestHeaders`, `solverPresetForSettings`, `solverFailureSummary` |
| **capacity** | 3 | 218–11,201 | `isCapacityShortageAccepted`, `capacityPrecheckPopupMessage`, `capacitySafeFreshProbeSettings` |
| **publish** | 3 | 667–17,332 | `publishCurrentSolveExecutorState`, `publishLiveStatsProgress`, `publishE2EState` |
| **begin** | 3 | 844–4,593 | `beginAutoSortPlanningMemo`, `beginServerJobReattachLease`, `beginScheduleMutationCancellation` |
| **no** | 3 | 1,054–13,498 | `isNoHintSmartFreshSettings`, `noBetterScheduleStatus`, `noTeacherGhepDemand` |
| **custom** | 3 | 1,108–1,151 | `customSolveDurationInput`, `customSolveDurationOverrideActive`, `customSolveDurationFromSettings` |
| **data** | 3 | 1,374–6,804 | `getData`, `dataForBackendPrecheck`, `dataForSolverRequest` |
| **reattach** | 3 | 2,628–2,660 | `reattachTerminalPayloadFromResponse`, `reattachTerminalPayloadError`, `reattachExistingServerJobPollOnly` |
| **stop** | 3 | 3,121–6,481 | `isStopRequested`, `stopProgressTicker`, `stopStatusDots` |
| **report** | 3 | 3,969–21,251 | `reportSkippedDiscoveredBackendJob`, `reportDeferredBackendSaveFailure`, `reportAutoSortPreparationChanged` |
| **record** | 3 | 4,064–6,509 | `recordBackendJobStarted`, `recordBackendLiveProgress`, `recordSolveStatusLog` |
| **hard** | 3 | 4,905–13,231 | `hardFinishProgressDom`, `hardQualityViolationMessage`, `hasHardFixedLessons` |
| **refresh** | 3 | 5,347–11,720 | `refresh`, `refreshStatsPopoverIfOpen`, `refreshGapProgressBaselineFromRemote` |
| **optimization** | 3 | 5,913–17,766 | `optimizationFocusForSolveRequestMode`, `optimizationPlateauState`, `setOptimizationLockedUi` |
| **gap** | 3 | 5,926–11,663 | `gapOptimizationTargetForSolveRequestMode`, `gapExactCount`, `gapProgressCountsFromMetrics` |
| **render** | 3 | 6,619–12,293 | `renderSolverPanel`, `renderLimitConflictPanel`, `renderConstraintViolationPanel` |
| **restore** | 3 | 7,225–7,245 | `restoreScheduleData`, `restoreUnimprovedRefinementSnapshot`, `restoreFailedConstraintRepairSnapshot` |
| **durable** | 3 | 7,433–7,470 | `durableScheduleFingerprint`, `durableScheduleFingerprintMatches`, `durableScheduleFingerprintMatcher` |
| **strict** | 3 | 7,819–7,909 | `strictBrowserAutomaticRequired`, `strictBrowserAutomaticQualityState`, `strictBrowserAutomaticQualityMessage` |
| **quality** | 3 | 8,022–10,406 | `qualityDebtParts`, `qualityDebtMessage`, `qualityEjectedPeriods` |
| **expected** | 3 | 8,262–13,456 | `expected`, `expectedLessonCount`, `expectedLessonCountUncached` |
| **complete** | 3 | 8,816–17,895 | `completeScheduleSeedRetrySettings`, `completeScheduleNeedsFreshQualityRebuild`, `completeScheduleStateForExistingOptimize` |
| **needs** | 3 | 9,905–13,166 | `needsTeacherQualityCleanup`, `needsStrictTeacherQualityCleanup`, `needsAfternoonFillPass` |
| **ui** | 3 | 11,806–17,994 | `uiSchoolCompletionStats`, `makeUiSubjectResolver`, `uiTeacherQualityMetrics` |
| **count** | 3 | 13,116–13,214 | `countScheduledLessons`, `countSessionScheduledInPayload`, `countFixedScheduledLessons` |
| **adaptive** | 3 | 13,521–13,560 | `adaptiveTeacherSessionStartCap`, `adaptiveTeacherSessionFastCap`, `adaptiveTeacherSessionSpeedCap` |

<details><summary>Lẻ tẻ — 211 ký hiệu không thuộc cụm nào</summary>

- `isInternalIncompleteSolve` *(function)* — dòng 342
- `forcedEngineBestEffortActive` *(function)* — dòng 357
- `dispatchCurrentSolveExecutorState` *(function)* — dòng 617
- `announceSolverUsageRoute` *(function)* — dòng 638
- `acquireAutoSortPreflight` *(function)* — dòng 756
- `queueAutoSortContinuationAfterSettlement` *(function)* — dòng 784
- `endAutoSortPlanningMemo` *(function)* — dòng 856
- `hardwareWorkerCount` *(function)* — dòng 862
- `isMobileBrowserAgentNavigator` *(function)* — dòng 870
- `isWindowsNativeAgentNavigator` *(function)* — dòng 883
- `isFalseSetting` *(function)* — dòng 949
- `isTruthySetting` *(function)* — dòng 953
- `positiveNumberSetting` *(function)* — dòng 958
- `nonnegativeNumberSetting` *(function)* — dòng 963
- `manualFreshRetryRecord` *(function)* — dòng 1,155
- `manualFreshRetryBudgetSeconds` *(function)* — dòng 1,175
- `retryableManualFreshSolveFailure` *(function)* — dòng 1,179
- `hybridCloudRunInvocationSettings` *(function)* — dòng 1,360
- `plannerDataReady` *(function)* — dòng 1,388
- `sleep` *(function)* — dòng 1,432
- `yieldResponsiveUi` *(function)* — dòng 1,465
- `isSpeedFirstSettings` *(function)* — dòng 1,495
- `initSolverPresetUi` *(function)* — dòng 1,667
- `initCustomSolveDurationUi` *(function)* — dòng 1,678
- `commit` *(function)* — dòng 1,699
- `probeRustApiBase` *(function)* — dòng 1,835
- `rustApiBase` *(function)* — dòng 1,865
- `classifyBackendJobState` *(function)* — dòng 1,899
- `liveBackendJobForScheduleScope` *(function)* — dòng 2,034
- `inspectExistingBackendJobForManualSolve` *(function)* — dòng 2,054
- `detachedServerJobError` *(function)* — dòng 2,122
- `suspendBackendResumeForAuth` *(function)* — dòng 2,139
- `transientServerJobStatus` *(function)* — dòng 2,179
- `terminalServerJobFailure` *(function)* — dòng 2,190
- `trialBackendJobCanResume` *(function)* — dòng 2,231
- `discardTrialBackendJob` *(function)* — dòng 2,257
- `trialRejectExistingBackendJob` *(function)* — dòng 2,266
- `observeBackendJob` *(function)* — dòng 2,532
- `makeUserCancelError` *(function)* — dòng 3,125
- `throwIfStopRequested` *(function)* — dòng 3,132
- `rethrowCancelledSolve` *(function)* — dòng 3,137
- `rethrowAuthRequiredSolve` *(function)* — dòng 3,142
- `bindActiveSolveAbortController` *(function)* — dòng 3,219
- `legacyBackendJobStorageScope` *(function)* — dòng 3,227
- `ownerBackendJobDiscoveryAllowed` *(function)* — dòng 3,272
- `persistentAutoResumeSuppressionForScope` *(function)* — dòng 3,294
- `retryServerCancellationIntent` *(function)* — dòng 3,427
- `settledBackendJobsForScope` *(function)* — dòng 3,439
- `isSettledBackendJob` *(function)* — dòng 3,484
- `forgetSettledBackendJob` *(function)* — dòng 3,489
- `epochMillisFromBackend` *(function)* — dòng 3,517
- `resetPendingBackendJobForReplay` *(function)* — dòng 3,788
- `discoveredBackendJobTime` *(function)* — dòng 3,828
- `discoverableBackendJobCandidate` *(function)* — dòng 3,836
- `selectDiscoverableBackendJob` *(function)* — dòng 3,909
- `persistPendingProgressState` *(function)* — dòng 4,014
- `endServerJobReattachLease` *(function)* — dòng 4,152
- `consumeActiveBackendResumeTarget` *(function)* — dòng 4,161
- `deferBackendResultSettlement` *(function)* — dòng 4,190
- `terminalApplySaveWatchdogMs` *(function)* — dòng 4,198
- `awaitTrustedSolverApplySave` *(function)* — dòng 4,267
- `armBestEffortStopEscalationTimer` *(function)* — dòng 4,450
- `requestStopActiveSolve` *(function)* — dòng 4,485
- `run` *(function)* — dòng 4,596
- `invalidatePendingSolveForScheduleMutation` *(function)* — dòng 4,645
- `khoiNum` *(function)* — dòng 4,757
- `callMaybe` *(function)* — dòng 4,840
- `finishProgress` *(function)* — dòng 4,960
- `hideAutoSortProgressDom` *(function)* — dòng 4,978
- `primeAutoSortStartUi` *(function)* — dòng 5,315
- `acquireSolveKeepalive` *(function)* — dòng 5,463
- `forceFinishSolveUi` *(function)* — dòng 5,665
- `installFinishWatchdog` *(function)* — dòng 5,674
- `formatDuration` *(function)* — dòng 5,712
- `formatLiveDuration` *(function)* — dòng 5,720
- `persistedSolveTimings` *(function)* — dòng 5,762
- `newestSolveTimingItem` *(function)* — dòng 5,770
- `estimateSolveSeconds` *(function)* — dòng 5,822
- `isFreshVisibleProgressSettings` *(function)* — dòng 6,022
- `tickEstimatedProgress` *(function)* — dòng 6,229
- `tick` *(function)* — dòng 6,498
- `setStatus` *(function)* — dòng 6,531
- `dismissCompletionPopup` *(function)* — dòng 6,574
- `showCompletionPopup` *(function)* — dòng 6,590
- `clonePlain` *(function)* — dòng 6,653
- `refinementLearningCandidate` *(function)* — dòng 6,661
- `sanitizeRefinementLearning` *(function)* — dòng 6,677
- `mergeRefinementLearning` *(function)* — dòng 6,710
- `traceSolveStep` *(function)* — dòng 6,753
- `stripFixedLessonOffForSolver` *(function)* — dòng 7,026
- `slotOffForAnyId` *(function)* — dòng 7,080
- `classesForTeacherMustTeach` *(function)* — dòng 7,096
- `sanitizeTeacherMustTeachForSolverRequest` *(function)* — dòng 7,124
- `sameTeacherCode` *(function)* — dòng 7,168
- `snapshotScheduleData` *(function)* — dòng 7,210
- `snapshotScheduledLessonCount` *(function)* — dòng 7,220
- `cellFingerprintValue` *(function)* — dòng 7,252
- `stableFingerprintClone` *(function)* — dòng 7,303
- `constraintsForDurableFingerprint` *(function)* — dòng 7,379
- `legacyV2ScheduleFingerprint` *(function)* — dòng 7,407
- `lessonSessionValue` *(function)* — dòng 7,488
- `lessonAssignmentSignatureFromLessons` *(function)* — dòng 7,558
- `unassignedReasonBreakdown` *(function)* — dòng 7,756
- `setStatusHint` *(function)* — dòng 7,790
- `synchronizeBrowserSettlementSettings` *(function)* — dòng 7,933
- `hasCompletedSolverSchedule` *(function)* — dòng 8,066
- `showCapacityPrecheckDialog` *(function)* — dòng 8,149
- `shortageTotal` *(function)* — dòng 8,272
- `confirmCapacityPrecheckBeforeSolve` *(function)* — dòng 8,324
- `incompleteSolveMessage` *(function)* — dòng 8,376
- `unassignedLessonSummary` *(function)* — dòng 8,404
- `friendlySolveError` *(function)* — dòng 8,441
- `robustRetrySettings` *(function)* — dòng 8,756
- `incompleteScheduleQuality` *(function)* — dòng 8,793
- `postRobustFirstCompleteRetry` *(function)* — dòng 8,863
- `requestedTeacherSessionCap` *(function)* — dòng 8,910
- `lowerBoundTeacherSessionQualityTarget` *(function)* — dòng 8,958
- `zeroOneQualityRetrySettings` *(function)* — dòng 9,098
- `candidateWorsensLocationRuleDebt` *(function)* — dòng 9,562
- `inheritRefinementRound` *(function)* — dòng 9,585
- `completionQualityStatus` *(function)* — dòng 9,621
- `usesTwoStageTeacherQuality` *(function)* — dòng 9,965
- `candidateWithinVisibleQualityEnvelope` *(function)* — dòng 10,183
- `incumbentQualityGuardState` *(function)* — dòng 10,660
- `disableStagedExistingRepairForThisRun` *(function)* — dòng 11,025
- `optimizeExistingPayloadForTeacherGaps` *(function)* — dòng 11,487
- `restartProgressForRetry` *(function)* — dòng 11,567
- `gap2PlusCount` *(function)* — dòng 11,625
- `quickGapMetrics` *(function)* — dòng 11,682
- `canonicalizeGapProgressSnapshot` *(function)* — dòng 11,757
- `cheapSchoolCompletionStats` *(function)* — dòng 11,827
- `engineFallbackNotice` *(function)* — dòng 11,953
- `businessReason` *(function)* — dòng 12,074
- `thuLabel` *(function)* — dòng 12,145
- `toggleLimitConflictPanel` *(function)* — dòng 12,241
- `toggleConstraintViolationPanel` *(function)* — dòng 12,327
- `reconcileStatusWithVisibleSchedule` *(function)* — dòng 12,379
- `notifyCompletion` *(function)* — dòng 12,418
- `escapeHtml` *(function)* — dòng 12,475
- `hasTruthyOffMap` *(function)* — dòng 12,531
- `heavySubjectBlockSessionCapFloor` *(function)* — dòng 12,561
- `effectiveSettingsForSolve` *(function)* — dòng 12,672
- `saveSettings` *(function)* — dòng 13,017
- `promptSettings` *(function)* — dòng 13,023
- `makeEmptyTKB` *(function)* — dòng 13,060
- `dayKey` *(function)* — dòng 13,074
- `sessionKey` *(function)* — dòng 13,081
- `cellSubjectText` *(function)* — dòng 13,088
- `isScheduledCell` *(function)* — dòng 13,107
- `afternoonFillRetrySettings` *(function)* — dòng 13,177
- `collectFixedLessonLocks` *(function)* — dòng 13,257
- `orderPayloadLessonsFixedFirst` *(function)* — dòng 13,301
- `gradeToken` *(function)* — dòng 13,330
- `expandSubjectAliases` *(function)* — dòng 13,360
- `periodLookupByGradeSubject` *(function)* — dòng 13,382
- `fallbackUiSubjectPeriods` *(function)* — dòng 13,420
- `practicalTeacherQualityTargets` *(function)* — dòng 13,576
- `speedFirstBudgets` *(function)* — dòng 13,613
- `alignNativeFreshToBackendDeadline` *(function)* — dòng 13,714
- `setMin` *(function)* — dòng 13,782
- `splitTeacherNames` *(function)* — dòng 13,815
- `tightClassFixedOffProfile` *(function)* — dòng 13,889
- `makeRandomSeed` *(function)* — dòng 13,919
- `disableScheduleDiversitySettings` *(function)* — dòng 14,012
- `stableSeedText` *(function)* — dòng 14,039
- `hashSeedText` *(function)* — dòng 14,054
- `schoolSeedSequence` *(function)* — dòng 14,064
- `preserveExistingMinRatio` *(function)* — dòng 14,091
- `repairFillFirstMaxMissing` *(function)* — dòng 14,149
- `partialExistingRepairState` *(function)* — dòng 14,155
- `parseOffKey` *(function)* — dòng 14,775
- `preSolveFullConstraintValidationNeeded` *(function)* — dòng 14,802
- `collectOffLocks` *(function)* — dòng 14,815
- `rejectedTeacherFixedOffUnassignedItem` *(function)* — dòng 14,917
- `filterTeacherFixedOffPayloadLessons` *(function)* — dòng 14,934
- `boundedDiagnosticScalars` *(function)* — dòng 15,065
- `now` *(function)* — dòng 15,130
- `chooseAndReleaseTeacherGroups` *(function)* — dòng 15,221
- `isQuickCompleteResult` *(function)* — dòng 15,361
- `consumeFixedSubject` *(function)* — dòng 15,440
- `postSolve` *(function)* — dòng 15,796
- `prepMark` *(function)* — dòng 15,891
- `disarmClientTimeout` *(function)* — dòng 16,343
- `armClientTimeout` *(function)* — dòng 16,348
- `shuffleOnlySettings` *(function)* — dòng 17,463
- `recentOffRestoreFlag` *(function)* — dòng 17,509
- `embeddedAutomaticSortCycleState` *(function)* — dòng 17,577
- `attachAutomaticSortCycleToPayload` *(function)* — dòng 17,595
- `ordinaryAutomaticSortLimitReached` *(function)* — dòng 17,673
- `persistAutomaticSortSuccess` *(function)* — dòng 17,724
- `installOptimizationLockSaveHook` *(function)* — dòng 17,804
- `hasComparableOptimizationStats` *(function)* — dòng 17,866
- `refinementStatisticsImproved` *(function)* — dòng 17,877
- `finishLocalUnassignedRepairPayload` *(function)* — dòng 18,139
- `TKBRustAPI` *(window)* — dòng 19,796
- `browserAgentEnabledForAutomaticBudget` *(function)* — dòng 19,956
- `incrementalRefineCeilingSeconds` *(function)* — dòng 19,989
- `configurePlanMetricProgress` *(function)* — dòng 20,557
- `focusedOptimizationCeilingSeconds` *(function)* — dòng 20,614
- `sapXepTuDongAll` *(window)* — dòng 21,820
- `xepLaiLop` *(window)* — dòng 21,864
- `openTuyChinh` *(window)* — dòng 21,870
- `runOptimizeFromPanel` *(window)* — dòng 21,876
- `continueOptimizeFromPanel` *(window)* — dòng 21,881
- `xepTheoTuyChinh` *(window)* — dòng 21,886
- `updateBackendStatusBanner` *(function)* — dòng 21,896
- `prepareManualSolveIntent` *(function)* — dòng 21,927
- `pendingBackendResumeBlocked` *(function)* — dòng 21,949
- `resumePendingBackendJobOnLoad` *(function)* — dòng 22,008
- `resumePendingBackendJobOnce` *(function)* — dòng 22,040
- `requestStopAutoSort` *(window)* — dòng 22,468

</details>

---

## `rust_api/src/native_solver.rs`

Bo giai native trong Rust (duong nhanh, khong qua Python).

**17,512 dòng · 261 ký hiệu cấp cao nhất**

| Cụm | Số hàm | Vùng dòng | Vài ký hiệu tiêu biểu |
|---|---:|---|---|
| **teacher** | 38 | 3,783–14,653 | `teacher_gap_count`, `teacher_period_load_map`, `TeacherSessionOptStats`, `teacher_session_opt_snapshot`, … |
| **optimize** | 30 | 4,006–13,092 | `optimize_teacher_single_sessions`, `optimize_teacher_global_session_repack`, `optimize_teacher_session_relay_escape`, `optimize_teacher_session_two_pair_escape`, … |
| **quick** | 14 | 272–11,983 | `QuickPlacementChoice`, `QuickOccupancyIndex`, `QuickOccupancyIndex`, `quick_slot_bit`, … |
| **try** | 12 | 11,216–13,677 | `try_merge_small_teacher_session`, `try_move_singleton_out`, `try_swap_singleton_out`, `try_move_singleton_into_teacher_session_by_relaxed_class_swap`, … |
| **lesson** | 10 | 3,462–14,545 | `lesson_json`, `lesson_string`, `lesson_class_id`, `lesson_subject`, … |
| **solve** | 7 | 185–3,663 | `SolveClock`, `SolveClock`, `solve_native_hint_json`, `solve_existing_schedule`, … |
| **consider** | 7 | 8,650–13,983 | `consider_global_singleton_cleanup_candidate`, `consider_singleton_chain_candidate`, `consider_focused_three_cycle`, `consider_focused_move_candidate`, … |
| **choose** | 6 | 3,039–3,344 | `choose_quick_assignment_slots`, `choose_quick_slot`, `choose_quick_slot_block`, `choose_slot`, … |
| **singleton** | 6 | 8,551–9,455 | `singleton_cleanup_order_key`, `singleton_chain_candidate_slots`, `singleton_chain_lesson_session_allowed`, `SingletonEjectionState`, … |
| **class** | 5 | 235–14,539 | `ClassInfo`, `class_alias_map`, `class_slot_occupant`, `class_subject_limits_ok_after_move`, … |
| **subject** | 5 | 243–3,841 | `SubjectInfo`, `SubjectLimit`, `subject_alias_map`, `subject_limit_map`, … |
| **parse** | 5 | 1,859–14,563 | `parse_classes`, `parse_subjects`, `parse_assignments`, `parse_teacher_session_key`, … |
| **ghep** | 5 | 1,999–2,096 | `ghep_rule_subject_alias`, `ghep_exact_keys`, `GhepNoTeacherRow`, `ghep_row_texts`, … |
| **repair** | 5 | 5,380–12,075 | `repair_session_escape_with_class_three_cycle`, `repair_unassigned_lessons`, `repair_quick_unassigned_lessons_first_fit`, `repair_candidate_hard_ok`, … |
| **slot** | 4 | 415–14,497 | `Slot`, `slot_key`, `slot_jitter`, `make_slot` |
| **two** | 4 | 1,713–10,878 | `two_stage_teacher_quality_requested`, `two_stage_quality_key`, `two_stage_session_phase_acceptable`, `two_stage_cleanup_acceptable` |
| **global** | 4 | 4,508–14,730 | `GlobalSessionRepackPattern`, `global_repack_slot_key`, `global_session_repack_patterns_for_class`, `global_session_repack_safe` |
| **search** | 4 | 4,518–13,851 | `search_global_session_repack_patterns`, `search_singleton_class_chain`, `search_small_session_merge`, `search_gap_chain_repair` |
| **focused** | 4 | 6,610–10,897 | `focused_gap_candidate_acceptable`, `focused_gap_target_envelope_preserved`, `focused_gap_target_improved`, `focused_agent_candidate_acceptable` |
| **validate** | 3 | 618–637 | `validate_agent_candidate`, `validate_agent_resume_checkpoint`, `validate_agent_candidate_mode` |
| **settings** | 3 | 1,706–1,742 | `settings_bool`, `settings_u64`, `settings_u64_allow_zero` |
| **session** | 3 | 1,975–14,513 | `session_limit_map`, `session_key_from_label`, `session_label_from_key` |
| **collect** | 3 | 2,419–2,609 | `collect_fixed_lessons`, `collect_existing_schedule_lessons`, `collect_off_slots` |
| **chain** | 3 | 14,039–14,164 | `chain_candidate_slots`, `chain_lesson_can_target`, `chain_target_slot_used` |

<details><summary>Lẻ tẻ — 71 ký hiệu không thuộc cụm nào</summary>

- `NativeSolveResult` *(struct)* — dòng 30
- `ValidatedAgentCandidate` *(struct)* — dòng 36
- `OptimizationFocus` *(enum)* — dòng 42
- `OptimizationFocus` *(impl)* — dòng 52
- `SolverConfig` *(struct)* — dòng 99
- `SolverConfig` *(impl)* — dòng 111
- `wall_clock_ms` *(fn)* — dòng 164
- `Assignment` *(struct)* — dòng 249
- `PendingQuickAssignment` *(struct)* — dòng 264
- `HeuristicState` *(struct)* — dòng 424
- `HeuristicState` *(impl)* — dòng 435
- `quality_priority_order` *(fn)* — dòng 1,725
- `complete_incumbent` *(fn)* — dòng 1,768
- `runtime_settings_json` *(fn)* — dòng 1,781
- `incomplete_schedule_error` *(fn)* — dòng 1,807
- `push_unassigned_periods` *(fn)* — dòng 1,837
- `period_map` *(fn)* — dòng 1,954
- `assignment_subject_key` *(fn)* — dòng 2,130
- `rule_subject` *(fn)* — dòng 2,142
- `constraint_subject_day_limit_map` *(fn)* — dòng 2,149
- `apply_quick_authored_subject_rules` *(fn)* — dòng 2,205
- `FixedLesson` *(struct)* — dòng 2,410
- `place_quick_assignments_mrv` *(fn)* — dòng 2,691
- `can_place_slot_block` *(fn)* — dòng 3,407
- `fill_missing_existing_lessons` *(fn)* — dòng 3,485
- `resource_slot_key` *(fn)* — dòng 3,653
- `SimpleRng` *(struct)* — dòng 3,706
- `SimpleRng` *(impl)* — dòng 3,710
- `shuffle_slice` *(fn)* — dòng 3,727
- `block_jitter` *(fn)* — dòng 3,748
- `hash_part` *(fn)* — dòng 3,760
- `consecutive_periods` *(fn)* — dòng 3,769
- `evaluate_global_session_repack_combination` *(fn)* — dòng 4,725
- `clean_teacher_session_improvement` *(fn)* — dòng 5,368
- `residual_singleton_cycle_candidate` *(fn)* — dòng 6,053
- `cycle_resource_precheck` *(fn)* — dòng 7,720
- `candidate_move_slots_precheck` *(fn)* — dòng 8,586
- `cycle_contains_singleton` *(fn)* — dòng 9,474
- `run_teacher_optimization_phase` *(fn)* — dòng 9,493
- `cleanup_teacher_phase_large_gaps` *(fn)* — dòng 9,692
- `automatic_two_stage_final_acceptable` *(fn)* — dòng 10,887
- `keep_best_teacher_quality` *(fn)* — dòng 11,047
- `small_session_merge_target_slots` *(fn)* — dòng 11,353
- `target_slot_identity` *(fn)* — dòng 11,595
- `best_unassigned_repair` *(fn)* — dòng 11,672
- `usable_slots_for_class` *(fn)* — dòng 12,034
- `resource_blockers_for_lesson_at_slot` *(fn)* — dòng 12,050
- `empty_slots_for_class` *(fn)* — dòng 12,091
- `unique_session_cell_permutations` *(fn)* — dòng 13,057
- `gap_improved` *(fn)* — dòng 13,548
- `schedule_hard_ok` *(fn)* — dòng 14,170
- `can_move_lesson_to_slot` *(fn)* — dòng 14,246
- `day_key_from_number` *(fn)* — dòng 14,507
- `same_slot` *(fn)* — dòng 14,521
- `move_jitter` *(fn)* — dòng 14,553
- `numeric_matrix` *(fn)* — dòng 14,583
- `string_matrix` *(fn)* — dòng 14,598
- `value_array` *(fn)* — dòng 14,613
- `get_str` *(fn)* — dòng 14,620
- `int_value` *(fn)* — dòng 14,624
- `string_value` *(fn)* — dòng 14,637
- `canonical_subject` *(fn)* — dòng 14,662
- `cell_subject` *(fn)* — dòng 14,670
- `lookup_lesson_resource` *(fn)* — dòng 14,689
- `truthy` *(fn)* — dòng 14,703
- `constraint_tree_enabled` *(fn)* — dòng 14,715
- `grade_key` *(fn)* — dòng 14,759
- `norm` *(fn)* — dòng 14,772
- `count_teacher_sessions` *(fn)* — dòng 14,781
- `count_one_period_teacher_sessions` *(fn)* — dòng 14,801
- `current_timestamp_string` *(fn)* — dòng 14,808

</details>

---

## `web/pages/phanmon.js`

Man hinh Phan cong + Xep TKB: bang, thao tac o, thong ke, xuat file.

**15,302 dòng · 802 ký hiệu cấp cao nhất**

| Cụm | Số hàm | Vùng dòng | Vài ký hiệu tiêu biểu |
|---|---:|---|---|
| **tkb** | 220 | 3–14,886 | `__TKB_PLANNER_DATA_READY`, `__TKB_PLANNER_REMOTE_HYDRATION_PENDING`, `__TKB_MARK_PLANNER_DATA_READY`, `__TKB_PLANNER_DATA_READY`, … |
| **pv** | 40 | 14,241–15,249 | `pvSetButtonText`, `pvClassLabel`, `pvTeacherLabel`, `pvTeachersForClass`, … |
| **auto** | 20 | 13,087–14,011 | `_autoSortProgressYield`, `__AUTO_SORT_STOP_REQUESTED`, `setAutoSortControlLocked`, `setAutoSortHomeHidden`, … |
| **ensure** | 17 | 848–14,105 | `ensureTeacherCodeIndex`, `ensureMonAliasIndex`, `ensureTeacherForClassMonCache`, `ensureRoomForClassMonCache`, … |
| **class** | 16 | 582–12,555 | `classCanonFromLop`, `classRecordOrderValue`, `classOrderIndex`, `classAliasGroupKey`, … |
| **toggle** | 16 | 3,384–15,016 | `toggleRightPanel`, `toggleRightPanel`, `toggleStatsPopover`, `toggleStatsPopover`, … |
| **teacher** | 13 | 887–12,275 | `teacherOrderIndex`, `teacherListFromValue`, `teacherValueFromRaw`, `teacherValueHas`, … |
| **hybrid** | 13 | 8,541–13,587 | `hybridCandidateTkbFromResponse`, `hybridStableJson`, `hybridCandidateScheduledCellCount`, `hybridNonnegativeMetric`, … |
| **cell** | 12 | 1,423–7,144 | `cellMon`, `cellLegacyTeacher`, `cellHTMLTeacher`, `cellHTMLPhong`, … |
| **pair** | 12 | 5,470–15,169 | `setPairNavScope`, `pairNavScopeForElement`, `pairScrollActiveOptionToTop`, `pairCloseSelectMenus`, … |
| **render** | 11 | 2,806–13,171 | `renderCurrentView`, `renderTKBTeacher`, `renderTKBPhong`, `renderStatsBoxLoading`, … |
| **add** | 10 | 561–12,570 | `add`, `add`, `addAliases`, `addSubject`, … |
| **mon** | 10 | 950–7,476 | `monRecordAliases`, `monCanonicalKey`, `monMatches`, `monSortCode`, … |
| **clear** | 10 | 4,220–12,809 | `clearCellSelection`, `clearTeacherLessonsAtSlot`, `clearOffDisplacedLesson`, `clearLessonByKey`, … |
| **sync** | 9 | 50–13,584 | `syncPlannerMobileViewportHeight`, `syncPlannerMobileViewportHeight`, `syncClassFixedOffConstraint`, `syncTeacherFixedOffConstraint`, … |
| **planner** | 9 | 298–13,577 | `plannerDbName`, `plannerClassKeepScore`, `plannerBuildValidClassAliases`, `plannerBuildCanonicalClassAliasMap`, … |
| **update** | 9 | 2,611–12,056 | `updateViewButtonsActive`, `updateRightPanelToggle`, `updateKhoiButtonsActive`, `updatePairNavScopeFromElement`, … |
| **show** | 8 | 293–13,931 | `__showGuard`, `showAllGV`, `showAllPhong`, `showAllLop`, … |
| **build** | 8 | 2,879–11,836 | `buildTeacherSchedule`, `buildRoomSchedule`, `buildMonsForKhoi`, `buildOffPatternFromKeys`, … |
| **close** | 8 | 3,506–15,012 | `closeStatsPopover`, `closeStatsPopover`, `closeUnassignedDropdown`, `closeClassAssignmentStatistics`, … |
| **fet** | 8 | 8,949–9,287 | `fetTargetMetricKeyForMode`, `fetProvenMetricFloorMessage`, `fetHardViolationSignature`, `fetValidatorDiagnostics`, … |
| **student** | 8 | 11,362–12,399 | `isStudentGapSlot`, `studentGapTeacherFreeAtSlot`, `studentGapTargetsFromIssues`, `studentGapTargetKey`, … |
| **find** | 7 | 600–12,567 | `findClassRecordForOrder`, `findMonHoc`, `findTeacherConflictAtSlot`, `findRoomConflictAtSlot`, … |
| **save** | 6 | 302–14,017 | `saveStoreKVDBBackup`, `saveStoreDeferred`, `saveStore`, `saveStore`, … |
| **bind** | 6 | 2,983–5,721 | `bindTeacherCells`, `bindRoomCells`, `bindTouchDoubleAction`, `bindSelectableCell`, … |
| **apply** | 6 | 4,226–9,202 | `applyCellSelectionStyles`, `applyOffPositionsToTkb`, `applyFixedLessonsToTkb`, `_applyFixedAndOff`, … |
| **delete** | 6 | 5,233–13,866 | `deleteActionForClassSlot`, `deleteActionForKey`, `deleteSelectedCells`, `deleteCurrentClassTKB`, … |
| **count** | 6 | 6,315–12,940 | `countMonInTKB`, `countMonFromTkbCountMap`, `countMon`, `countAssigned`, … |
| **unassigned** | 6 | 10,861–12,311 | `unassignedDropdownHTML`, `setUnassignedDropdownOpen`, `unassignedButton`, `getUnassignedIssuesFromStats`, … |
| **focus** | 6 | 12,336–12,759 | `focusUnassignedIssue`, `focusStudentGapIssue`, `focusStudentGapTarget`, `focusTeacherIssueInClassPair`, … |
| **print** | 6 | 14,044–14,157 | `printTKB`, `setPrintTKBMenuOpen`, `__printExportModuleSrc`, `printCurrentClassTKB`, … |
| **compare** | 5 | 627–8,979 | `compareClassByDataOrder`, `compareTeacherCodeByDataOrder`, `compareMonByHiddenCode`, `compareMonByMonHocOrder`, … |
| **invalidate** | 5 | 844–13,745 | `invalidateTeacherCodeIndex`, `invalidateClassKeyCandidatesCache`, `invalidatePccmNumCaches`, `invalidateTeacherListFilterCache`, … |
| **select** | 5 | 2,791–4,257 | `selectGV`, `selectPhong`, `selectLop`, `selectSingleCell`, … |
| **restore** | 5 | 4,719–8,530 | `restoreOffDisplacedLesson`, `restorePendingOffDisplacedLessons`, `restore`, `restoreSnapshot`, … |
| **native** | 5 | 5,713–13,582 | `setNativeDragTransfer`, `nativeAgentStatusSnapshot`, `nativeAgentSortPolicy`, `nativeAgentStatusSnapshot`, … |
| **go** | 5 | 10,750–12,743 | `goToUnassignedItem`, `goToUnassignedIssues`, `goToStudentGapIssues`, `goToTeacherStatIssues`, … |
| **schedule** | 4 | 71–3,818 | `schedulePlannerMobileViewportSync`, `scheduleStatsBoxRender`, `scheduleStatsBoxRender`, `scheduleLoadMonList` |
| **normalize** | 4 | 541–8,702 | `normalizeClassName`, `normalizeClassSubjectMatrixByAliases`, `normalizeUserOffList`, `normalizeHybridCloudRunResult` |
| **run** | 4 | 2,555–14,124 | `run`, `run`, `run`, `runPrintExport` |
| **cancel** | 4 | 3,437–13,857 | `cancelScheduledStatsBoxRender`, `_cancelCellLongPress`, `cancel`, `cancelDeleteMenu` |
| **refresh** | 4 | 3,473–13,578 | `refreshStatsBoxIfOpen`, `refreshStatsBoxIfOpen`, `refreshSolverInfrastructureRouteToggle`, `refreshSolverInfrastructureRouteToggle` |
| **open** | 4 | 3,523–11,838 | `openStatsPopoverDuringSolve`, `openStatsPopoverDuringSolve`, `openClassAssignmentStatistics`, `openClassAssignmentStatistics` |
| **collect** | 4 | 3,749–6,460 | `_collectPCCMSubjectKeysForClass`, `collectOffPositionsForClass`, `collectFixedLessonsForClass`, `collectUnassignedTasks` |
| **clone** | 4 | 3,833–8,519 | `cloneMonsList`, `cloneTkbCellValue`, `_cloneTkbShell`, `cloneHybridScheduleState` |
| **handle** | 4 | 4,487–14,185 | `handleCellDoubleAction`, `handleRightClickUnassign`, `handlePrintTKBOption`, `handlePrintTKBOption` |
| **off** | 4 | 4,501–5,010 | `setOffByKey`, `offRestoreTeacherConflict`, `offRestoreRoomConflict`, `setOffByKeys` |
| **step** | 4 | 5,496–12,780 | `stepSelectByKeyboard`, `step`, `stepTeacherStatIssue`, `stepOnePeriodTeacher` |
| **accepted** | 4 | 7,985–8,285 | `accepted`, `accepted`, `accepted`, `accepted` |
| **calc** | 4 | 10,714–12,829 | `calcClassTKBPeriodStats`, `calcStudentTimetableGapStats`, `calcSchoolTKBStats`, `calcTeacherTKBStats` |
| **highlight** | 4 | 12,367–12,813 | `highlightUnassignedIssue`, `highlightStudentGapIssue`, `highlightTeacherStatIssue`, `highlightOnePeriodTeacherSessions` |
| **active** | 4 | 12,515–13,543 | `getActiveTeacherStatType`, `getActiveTeacherStatIssueForTeacher`, `__ACTIVE_TKB_FET_WORKER_RESOLVE`, `__ACTIVE_TKB_FET_WORKER_STOP` |
| **agent** | 4 | 13,129–13,575 | `isAgentHelperSupportedDevice`, `isAgentHelperVisibleForCurrentUser`, `isAgentHelperSupportedDevice`, `isAgentHelperVisibleForCurrentUser` |
| **stored** | 3 | 110–132 | `getStoredSchoolName`, `storedSchoolDataScore`, `getStoredSchoolListFirst` |
| **init** | 3 | 321–3,583 | `initPlannerKVDBBackup`, `initRightPanelCollapse`, `initKhoiOptions` |
| **norm** | 3 | 824–3,797 | `normText`, `normKey`, `norm` |
| **hide** | 3 | 4,382–13,594 | `hideCellMenu`, `hideAutoSortProgress`, `hideAutoSortProgress` |
| **tao** | 3 | 4,849–4,914 | `taoTKBTrong`, `taoTKBTheoConfig`, `taoTKBBoSungTheoConfig` |
| **maybe** | 3 | 5,949–13,588 | `maybeRaiseSessionLimitForDrop`, `maybeInviteAgentBeforeSort`, `maybeInviteAgentBeforeSort` |
| **replace** | 3 | 11,989–12,002 | `replaceStatCell`, `replaceUnassignedCell`, `replaceStudentGapCell` |
| **solver** | 3 | 13,149–13,254 | `solverInfrastructureRouteMode`, `solverInfrastructureRouteLabel`, `solverInfrastructureToggleConfig` |
| **request** | 3 | 13,204–13,573 | `requestSolverInfrastructure`, `requestStopAutoSort`, `requestStopAutoSort` |

<details><summary>Lẻ tẻ — 139 ký hiệu không thuộc cụm nào</summary>

- `__PHANMON_VERSION` *(window)* — dòng 1
- `standaloneMobileScreenHeight` *(function)* — dòng 19
- `settlePlannerMobileViewportAfterRotation` *(function)* — dòng 76
- `discoverStoredSchoolIds` *(function)* — dòng 127
- `getLastSchoolContext` *(function)* — dòng 156
- `set` *(method)* — dòng 454
- `DATA` *(window)* — dòng 469
- `extractKhoiNumber` *(function)* — dòng 532
- `khoiKey` *(function)* — dòng 536
- `legacyClassNameAliases` *(function)* — dòng 555
- `labelOf` *(function)* — dòng 631
- `pruneRedundantPccmPeriodMatrices` *(function)* — dòng 739
- `remapPlannerClassObjectMap` *(function)* — dòng 746
- `sanitizePlannerDataFromIndex` *(function)* — dòng 781
- `looksLikeCode` *(function)* — dòng 831
- `resolveTeacherCode` *(function)* — dòng 872
- `allMonRecords` *(function)* — dòng 943
- `union` *(function)* — dòng 990
- `pruneLessonTeacherConflicts` *(function)* — dòng 1,226
- `getTeachersForClassMon` *(function)* — dòng 1,267
- `getRoomForClassMon` *(function)* — dòng 1,296
- `_getPccmNum` *(function)* — dòng 1,339
- `getPccmNumCached` *(function)* — dòng 1,375
- `getSoTietForClassMon` *(function)* — dòng 1,389
- `getGioiHanForClassMon` *(function)* — dòng 1,392
- `isFixed` *(function)* — dòng 1,429
- `getLopCanonById` *(function)* — dòng 1,438
- `isChosen` *(function)* — dòng 1,845
- `flushDeferredSaveStore` *(function)* — dòng 2,294
- `flushDeferredSaveStore` *(window)* — dòng 2,420
- `deferInitialHistorySnapshot` *(function)* — dòng 2,554
- `getFilteredLops` *(function)* — dòng 2,631
- `mobileStackCellLineHTML` *(function)* — dòng 2,659
- `setViewMode` *(function)* — dòng 2,839
- `getRoomListForCurrentFilter` *(function)* — dòng 3,097
- `deferInitialSaveStore` *(function)* — dòng 3,307
- `positionStatsPopover` *(function)* — dòng 3,398
- `setStatsPopoverOpen` *(function)* — dòng 3,481
- `setStatsPopoverOpen` *(window)* — dòng 3,518
- `positionStatsPopover` *(window)* — dòng 3,519
- `installRightPanelResize` *(function)* — dòng 3,541
- `onMove` *(function)* — dòng 3,555
- `onUp` *(function)* — dòng 3,567
- `mkBtn` *(function)* — dòng 3,602
- `chonKhoiBtn` *(function)* — dòng 3,622
- `loadLopList` *(function)* — dòng 3,675
- `computeMonsForClass` *(function)* — dòng 3,846
- `escapeHtml` *(function)* — dòng 4,147
- `parseCellKey` *(function)* — dòng 4,161
- `tdToPos` *(function)* — dòng 4,209
- `posToKey` *(function)* — dòng 4,217
- `_startCellLongPress` *(function)* — dòng 4,397
- `usesCoarseCellActions` *(function)* — dòng 4,402
- `touchPointForCellAction` *(function)* — dòng 4,409
- `begin` *(function)* — dòng 4,422
- `move` *(function)* — dòng 4,431
- `end` *(function)* — dòng 4,441
- `userOffLockKey` *(function)* — dòng 4,505
- `parseUserOffLockKey` *(function)* — dòng 4,509
- `removeUserOffLock` *(function)* — dòng 4,630
- `rememberOffDisplacedLesson` *(function)* — dòng 4,662
- `getUserOffPositionsForClass` *(function)* — dòng 4,790
- `makeEmptyTKBPreservingOff` *(function)* — dòng 4,918
- `detectStoredPartialSolverSchedule` *(function)* — dòng 4,930
- `migrateInvalidPartialSchedule` *(function)* — dòng 4,988
- `reapplyAllUserOffLocks` *(function)* — dòng 4,992
- `keyFromCellPos` *(function)* — dòng 5,127
- `selectedKeysForClipboard` *(function)* — dòng 5,137
- `topLeftKeyFromKeys` *(function)* — dòng 5,141
- `keysFromOffPatternAt` *(function)* — dòng 5,177
- `confirmDeleteProtectedActions` *(function)* — dòng 5,266
- `selectedClassCellKeysForFixedLesson` *(function)* — dòng 5,351
- `tryApplyFixedLessonFromUnassigned` *(function)* — dòng 5,386
- `navigatePairScopeByKeyboard` *(function)* — dòng 5,524
- `navigateCurrentListByKeyboard` *(function)* — dòng 5,532
- `installTKBHotkeysOnce` *(function)* — dòng 5,555
- `fixedLessonKeyForTd` *(function)* — dòng 5,683
- `flashInvalid` *(function)* — dòng 5,851
- `flashLopItemConflict` *(function)* — dòng 5,904
- `onDrop` *(function)* — dòng 6,027
- `setDropHint` *(function)* — dòng 6,064
- `paintDropTargets` *(function)* — dòng 6,087
- `paint` *(function)* — dòng 6,089
- `releaseDragOver` *(function)* — dòng 6,136
- `validateDrop` *(function)* — dòng 6,150
- `requiredSubjectsForClass` *(function)* — dòng 6,361
- `contains` *(method)* — dòng 6,561
- `remember` *(function)* — dòng 6,972
- `rollback` *(function)* — dòng 7,151
- `allSlots` *(function)* — dòng 7,483
- `firstMetric` *(function)* — dòng 8,607
- `gap2FromDistribution` *(function)* — dòng 8,614
- `offerHybridFailureChoice` *(function)* — dòng 8,795
- `choose` *(function)* — dòng 8,843
- `inspectFetCandidateHardConstraints` *(function)* — dòng 9,036
- `validateFetCandidateHardConstraints` *(function)* — dòng 9,068
- `nextPlannerPaint` *(function)* — dòng 9,121
- `auditCandidateHardConflicts` *(function)* — dòng 9,150
- `postFetTerminalTelemetry` *(function)* — dòng 9,302
- `executeDirectFastSchedule` *(function)* — dòng 9,390
- `__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL` *(window)* — dòng 9,506
- `executeDirectFastSchedule` *(window)* — dòng 10,692
- `sapXepTuDongAll` *(window)* — dòng 10,693
- `sapXepTuDongAll` *(function)* — dòng 10,705
- `currentClassUnassignedFallback` *(function)* — dòng 10,911
- `loadMonList` *(function)* — dòng 10,949
- `inferTeacherForStudentGapSlot` *(function)* — dòng 11,462
- `n` *(function)* — dòng 11,869
- `stat` *(function)* — dòng 11,874
- `drillButton` *(function)* — dòng 11,953
- `schoolStatsObjectSignature` *(function)* — dòng 12,061
- `schoolStatsTkbSignature` *(function)* — dòng 12,066
- `_getAssignedTeacherCodes` *(function)* — dòng 12,226
- `getOnePeriodIssueForTeacher` *(function)* — dòng 12,245
- `getOnePeriodIssuesFromStats` *(function)* — dòng 12,254
- `statEmptyMessage` *(function)* — dòng 12,290
- `checkCell` *(function)* — dòng 12,533
- `markTeacherStatIssueList` *(function)* — dòng 12,676
- `markOnePeriodTeacherList` *(function)* — dòng 12,789
- `_pushTeacherIssue` *(function)* — dòng 12,930
- `sortTeacherIssues` *(function)* — dòng 13,000
- `fitPlannerMobileStatusMessage` *(function)* — dòng 13,027
- `fitPlannerMobileStatusMessage` *(window)* — dòng 13,046
- `_setStatus` *(function)* — dòng 13,052
- `isWindowsNativeAgentDevice` *(function)* — dòng 13,130
- `resetAutoSortStopRequest` *(function)* — dòng 13,497
- `__LATEST_OPTIMIZE_TKB` *(window)* — dòng 13,541
- `__LATEST_OPTIMIZE_CHECKPOINT` *(window)* — dòng 13,542
- `resetAutoSortStopRequest` *(window)* — dòng 13,572
- `isWindowsNativeAgentDevice` *(window)* — dòng 13,580
- `checkNativeAgentNow` *(window)* — dòng 13,583
- `finishAutoSortProgress` *(window)* — dòng 13,591
- `isSystemNoise` *(function)* — dòng 13,695
- `finishAutoSortProgress` *(function)* — dòng 13,741
- `persistScheduleDelete` *(function)* — dòng 13,775
- `confirmDeleteMenu` *(function)* — dòng 13,883
- `exportExcel` *(function)* — dòng 13,969
- `mainUrlWithSchoolContext` *(function)* — dòng 14,206
- `backToMain` *(function)* — dòng 14,218

</details>

---

## `web/pages/tkb-fet-engine.js`

Engine FET thuan JS chay trong trinh duyet (nut ▶).

**9,485 dòng · 117 ký hiệu cấp cao nhất**

| Cụm | Số hàm | Vùng dòng | Vài ký hiệu tiêu biểu |
|---|---:|---|---|
| **try** | 35 | 1,850–7,988 | `tryEjectionChain`, `tryVacateTeacherDay`, `tryVacateTeacherSession`, `tryFastSingletonRepair`, … |
| **evaluate** | 4 | 244–7,513 | `evaluateLessonBlockViolations`, `evaluateMetrics`, `evaluateTeacherLocalStats`, `evaluateTeacherMetrics` |
| **extract** | 4 | 563–659 | `extractTeacher`, `extractRoom`, `extractMon`, `extractKhoiNumber` |
| **compute** | 4 | 1,301–9,155 | `computeDifficultiesAndSort`, `computeClassCapacityReport`, `computeTeacherCapacityReport`, `computeTeacherWeeklyLoad` |
| **jrn** | 3 | 1,684–1,698 | `jrnUnplace`, `jrnPlace`, `jrnRollback` |
| **optimize** | 3 | 8,076–9,302 | `optimize`, `optimizeGap2WithBorrow`, `optimizeAll` |

<details><summary>Lẻ tẻ — 64 ký hiệu không thuộc cụm nào</summary>

- `FetPRNG` *(class)* — dòng 29
- `constructor` *(method)* — dòng 30
- `next` *(method)* — dòng 35
- `nextInt` *(method)* — dòng 42
- `shuffle` *(method)* — dòng 46
- `slotToDetails` *(function)* — dòng 57
- `detailsToSlot` *(function)* — dòng 71
- `buildTeacherCanonMap` *(function)* — dòng 81
- `parseTeacherList` *(function)* — dòng 131
- `FetTimetableEngine` *(class)* — dòng 155
- `initLessonBlockRules` *(method)* — dòng 157
- `isLessonBlockSafe` *(method)* — dòng 195
- `constructor` *(method)* — dòng 289
- `init` *(method)* — dòng 320
- `clampLessonBlockRules` *(method)* — dòng 518
- `isCellOff` *(method)* — dòng 545
- `isCellFixed` *(method)* — dòng 553
- `normalizeMonName` *(method)* — dòng 598
- `getTeacherForClassMon` *(method)* — dòng 609
- `getRoomForClassMon` *(method)* — dòng 636
- `getRequiredPeriods` *(method)* — dòng 665
- `getSubjectSessionLimit` *(method)* — dòng 739
- `removeDiacritics` *(method)* — dòng 792
- `ensureMonAliasIndex` *(method)* — dòng 811
- `isNoTeacherGhepSubject` *(method)* — dòng 881
- `getCanonMonKey` *(method)* — dòng 909
- `getCanonMonKeyBuiltin` *(method)* — dòng 920
- `isChaoCo` *(method)* — dòng 968
- `isSinhHoatLop` *(method)* — dòng 973
- `resolveFixedSubjectToPccm` *(method)* — dòng 978
- `getShiftBlock` *(method)* — dòng 1,014
- `classifySingleton` *(method)* — dòng 1,038
- `classifyAllSingletons` *(method)* — dòng 1,091
- `getResidual2PeriodSessions` *(method)* — dòng 1,131
- `buildActivities` *(method)* — dòng 1,163
- `placeActivityDirect` *(method)* — dòng 1,362
- `unplaceActivity` *(method)* — dòng 1,389
- `getConflictsForSlot` *(method)* — dòng 1,423
- `getPlacementPenalty` *(method)* — dòng 1,582
- `randomSwap` *(method)* — dòng 1,711
- `solve` *(method)* — dòng 2,087
- `lastMileEjectionRepair` *(method)* — dòng 2,220
- `applyToDataTKB` *(method)* — dòng 2,256
- `getSnapshotTKB` *(method)* — dòng 2,334
- `loadExistingSchedule` *(method)* — dòng 2,403
- `canLoadPlacement` *(method)* — dòng 2,498
- `obliterateAllTeacherSingletons` *(method)* — dòng 3,636
- `obliterateAllThinTeacherSessions` *(method)* — dòng 4,049
- `fixDaySingletons` *(method)* — dòng 4,093
- `getResidualGap2Sessions` *(method)* — dòng 4,945
- `getMaxDailyPeriodsForSubject` *(method)* — dòng 6,621
- `isDailySubjectLimitSafe` *(method)* — dòng 6,639
- `compareMetrics` *(method)* — dòng 7,439
- `isScoredTeacher` *(method)* — dòng 7,509
- `getResidualSingletons` *(method)* — dòng 7,555
- `repairHardConflicts` *(method)* — dòng 8,988
- `perturbForRestart` *(method)* — dòng 9,107
- `captureStateSnapshot` *(method)* — dòng 9,133
- `restoreStateSnapshot` *(method)* — dòng 9,142
- `teacherSessionRequirement` *(method)* — dòng 9,172
- `countStudentHoles` *(method)* — dòng 9,192
- `verifyPlacementIntegrity` *(method)* — dòng 9,213
- `lockViolations` *(method)* — dòng 9,279
- `compareTuple` *(method)* — dòng 9,288

</details>
