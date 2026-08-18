(function(){
  "use strict";

  const VERSION = "tkb-rust-api-v348-holistic-hard-debt-270-v1";
    const SOLVER_PRESET_KEY = "TKB_SOLVER_PRESET";
    const CUSTOM_SOLVE_DURATION_KEY = "TKB_SOLVE_DURATION_SECONDS_V2";
    const INITIAL_AUTO_DURATION_SECONDS = 60;
    const FIRST_QUALITY_GATE_CEILING_SECONDS = 130;
    const ROBUST_AUTO_DURATION_SECONDS = 180;
    const DEEP_AUTO_DURATION_SECONDS = 180;
    const REFINEMENT_AUTO_DURATION_SECONDS = 60;
    const HARD_DEBT_REFINEMENT_DURATION_SECONDS = 270;
    // Fresh merged timetables keep one uninterrupted completeness + quality
    // ceiling. Each later Auto click gets a bounded quality-only burst
    // from the complete incumbent. These are ceilings only; proven/accepted
    // results still return earlier, and the incumbent guard rejects regressions.
    const MEDIUM_AUTOMATIC_LESSON_THRESHOLD = 900;
    const LARGE_AUTOMATIC_LESSON_THRESHOLD = 2000;
    const MEDIUM_AUTOMATIC_DURATION_SECONDS = 180;
    const LARGE_AUTOMATIC_DURATION_SECONDS = 270;
    const DESKTOP_FULL_REFERENCE_REFINE_SECONDS = 270;
    const FOCUSED_OPTIMIZATION_CEILING_SECONDS = 180;
    const MANUAL_FRESH_RETRY_STEP_SECONDS = 5;
    const MANUAL_FRESH_RETRY_DATA_KEY = "tkbManualFreshRetryBudget";
    const REFINEMENT_LEARNING_DATA_KEY = "tkbRefinementLearning";
    const AUTO_SORT_CYCLE_DATA_KEY = "tkbAutoSortCycle";
    const REFINEMENT_OPERATOR_NAMES = [
      "one_period",
      "gap2",
      "session_merge",
      "gap1",
      "mixed",
      "diversify"
    ];
    const MIN_CUSTOM_SOLVE_DURATION_SECONDS = 10;
    const MIN_FRESH_SOLVE_DURATION_SECONDS = 30;
    const MAX_CUSTOM_SOLVE_DURATION_SECONDS = 1800;
    const SOLVE_COMPLETE_MESSAGE = "Đã xếp xong!";
    const NO_BETTER_SCHEDULE_MESSAGE = SOLVE_COMPLETE_MESSAGE;
    const SOLVE_REQUEST_MODES = Object.freeze({
      automatic: "automatic",
      autoMin2: "auto_min2",
      quickComplete: "quick_complete",
      singletons: "optimize_singletons",
      sessions: "optimize_sessions",
      gap2: "optimize_gap2",
      gap1: "optimize_gap1",
      gaps: "optimize_gaps"
    });
    const GAP_PROGRESS_BASELINE_DATA_KEY = "tkbGapProgressBaseline";
    const GAP_PROGRESS_BASELINE_VERSION = 1;
    const SOLVER_PRESETS = {
      fast: { label: "Nhanh", bolts: 1 },
      balanced: { label: "Max", bolts: 2 }
    };
    const CLIENT_TIMEOUT_BACKEND_RESERVE_MS = 90_000;
    const BACKEND_STATE_TIMEOUT_MS = 2_500;
    const BACKEND_RESULT_POLL_TIMEOUT_MS = 8_000;
    // A terminal result must not leave the Play lifecycle held forever while
    // the remote timetable persistence request is suspended (for example when
    // the in-app browser tab is backgrounded).  The candidate is already
    // materialized in DATA before this wait, so after this bounded reserve we
    // let the UI finish and keep the durable server result recoverable until
    // the save promise settles.
    const TERMINAL_APPLY_SAVE_WATCHDOG_MS = 45_000;
    const DEFAULT_SOLVER_QUEUE_TIMEOUT_MS = 180_000;
    const SERVER_SOLVER_JOB_STORAGE_KEY = "TKB_SERVER_SOLVER_JOB_V1";
    const SERVER_SOLVER_JOB_SETTLED_KEY = "TKB_SERVER_SOLVER_JOB_SETTLED_V1";
    const SERVER_SOLVER_AUTO_RESUME_SUPPRESSED_KEY = "TKB_SERVER_SOLVER_AUTO_RESUME_SUPPRESSED_V1";
    const SERVER_SOLVER_SCHEDULE_TOMBSTONE_KEY = "TKB_SERVER_SOLVER_SCHEDULE_TOMBSTONE_V1";
    const SERVER_SOLVER_CANCEL_INTENT_KEY = "TKB_SERVER_SOLVER_CANCEL_INTENT_V1";
    // A queued job and an active solver have different clocks. The browser may
    // wait up to three minutes for admission, then must still give the solver's
    // advertised budget its full bounded reserve to publish and validate the
    // response. The 30-minute maximum remains available only for an explicit
    // legacy cached custom duration; current UI always uses automatic budgets.
    const SERVER_SOLVER_ACTIVE_WAIT_MAX_MS = (
      MAX_CUSTOM_SOLVE_DURATION_SECONDS * 1000
      + CLIENT_TIMEOUT_BACKEND_RESERVE_MS
    );
    const SERVER_SOLVER_JOB_MAX_AGE_MS = (
      DEFAULT_SOLVER_QUEUE_TIMEOUT_MS
      + SERVER_SOLVER_ACTIVE_WAIT_MAX_MS
      + 30_000
    );
    // Completed VPS results live longer than an active progress clock so a user
    // can close the browser overnight without accepting implausibly old running
    // timestamps as a live timer.
    const SERVER_SOLVER_RESULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    // A browser can be suspended for longer than the active solve clock while
    // the API still retains the completed result. Keep the durable id for the
    // same retention window so iOS can recover that result instead of turning
    // a legitimate resume into `solver_resume_missing`.
    const SERVER_SOLVER_JOB_RETENTION_MAX_AGE_MS = SERVER_SOLVER_RESULT_MAX_AGE_MS;
    const SERVER_SOLVER_JOB_UNKNOWN_RETRIES = 3;
    const SERVER_SOLVER_JOB_DISCOVERY_RETRY_MS = 2_000;
    const SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS = 15_000;
    const SERVER_SOLVER_AUTH_READY_RETRIES = 12;

    function solverRequestHeaders(extra){
      const fallback = Object.assign({"Accept": "application/json"}, extra || {});
      try{
        if(window.TKBAuthApi && typeof window.TKBAuthApi.getAuthHeaders === "function"){
          return window.TKBAuthApi.getAuthHeaders(extra || {});
        }
      }catch(_){}
      return fallback;
    }
    const DEFAULT_SETTINGS = {
      auto_sort_mode: "fast",
      max_teacher_sessions: 190,
      target_teacher_sessions: null,
      target_gap1_sessions: null,
      optimization_time_limit_seconds: 270,
      optimization_accept_teacher_sessions: null,
      optimization_accept_gap1_sessions: null,
      optimization_first_cap_time_limit_seconds: 210,
      optimization_session_time_limit: 180,
      optimization_period_retry_time_limit: 45,
      session_time_limit: 12,
      period_time_limit: 30,
      integrated_time_limit: 240,
      solver_mode: "auto",
      exact_teacher_sessions: false,
      search_teacher_sessions: true,
      minimize_sessions: true,
      allow_one_period_gaps: true,
      minimize_one_period_sessions: true,
      max_one_period_sessions: 0,
      strict_one_period_sessions_cap: true,
      one_period_priority_absolute: true,
      minimize_teacher_gaps: true,
      period_max_teacher_gap: 1,
      aggressive_fast_mode: true,
      overall_time_limit_seconds: 120,
      require_complete_schedule: true,
      best_effort_on_timeout: false,
      allow_quality_debt: true,
      allow_zero_one_quality_retry: true,
      allow_teacher_session_deep_retry: true,
      allow_legacy_solver_hints: false,
      allow_strict_quality_solution_bank: false,
      relax_period_teacher_gap_on_failure: false,
      deep_session_rescue: false,
      period_fast_time_limit: 4,
      period_retry_time_limit: 10,
      allow_backend_cache: false,
      disable_native_hint_solver: true,
      disable_solver_hints: true,
      allow_solver_warm_start: false,
      native_disable_cached_hint_candidate: true,
      native_disable_static_hint_candidate: true,
      native_hint_bank_max_entries: 0,
      native_hint_bank_time_limit_ms: 0,
      native_hint_bank_cleanup_validation_limit: 0,
      native_hint_bank_candidate_cleanup_time_ms: 0,
      native_hint_bank_hard_repair_violation_cap: 0,
      native_overlay_hard_repair_time_ms: 1500,
      native_teacher_session_compact_time_limit_ms: 2500,
      schedule_diversity: true,
      native_quality_variant_gap_slack: 4,
      native_quality_variant_one_period_slack: 0,
      native_quality_variant_session_slack: 4,
      num_workers: "auto",
      preserve_existing_min_ratio: 0.85,
      randomize_search: false,
      fresh_randomize_strategy: "solver_random"
    };
    function enforceCompleteScheduleForUi(settings){
      if(!settings || typeof settings !== "object") return settings;
      if(settings.ui_capacity_safe_fresh_probe === true) return settings;
      const requirePresetComplete = shouldRequireCompletePresetResult(settings);
      if(settings.ui_capacity_shortage_accepted === true && !requirePresetComplete){
        settings.ui_capacity_shortage_confirmed = true;
        settings.ui_accept_incomplete_best_effort = true;
        delete settings.ui_capacity_shortage_accepted;
      }
      settings.require_complete_schedule = true;
      settings.best_effort_on_timeout = false;
      if(requirePresetComplete){
        enforceCompletePresetSolveSettings(settings);
      }
      const mode = String(settings.solver_mode || "auto").trim().toLowerCase().replace(/-/g, "_");
      const explicitNative = settings.native_force_rust_solver === true
        || String(settings.native_force_rust_solver || "").toLowerCase() === "true";
      if(!explicitNative && ["shuffle_fill", "rust", "native", "native_rust"].includes(mode)){
        settings.solver_mode = "auto";
        if(String(settings.auto_sort_mode || "").trim().toLowerCase().replace(/-/g, "_") === "shuffle_fill"){
          settings.auto_sort_mode = "fast";
        }
        if(String(settings.auto_sort_strategy || "").trim().toLowerCase().replace(/-/g, "_") === "shuffle_fill"){
          settings.auto_sort_strategy = "reference_from_shuffle_fill";
        }
        settings.reference_solver_mode_normalized_from = mode;
      }
      settings.minimize_one_period_sessions = true;
      settings.max_one_period_sessions = 0;
      settings.strict_one_period_sessions_cap = true;
      settings.enforce_max_one_period_sessions = true;
      settings.one_period_priority_absolute = true;
      settings.minimize_teacher_gaps = true;
      settings.period_max_teacher_gap = 1;
      settings.relax_period_teacher_gap_on_failure = false;
      return applySolverPresetQualityPolicy(settings);
    }
    function isCapacityShortageAccepted(settings){
      if(!settings || typeof settings !== "object") return false;
      return settings.ui_capacity_shortage_accepted === true
        || settings.ui_capacity_shortage_confirmed === true
        || settings.ui_accept_incomplete_best_effort === true
        || settings.ui_capacity_shortage_accepted_after_solve === true;
    }
    function solverPresetForSettings(settings){
      try{
        return normalizeSolverPreset(settings?.ui_solver_preset || settings?.solver_preset || readSolverPreset());
      }catch(_){
        return "fast";
      }
    }
    function applySolverPresetQualityPolicy(settings, presetOverride){
      if(!settings || typeof settings !== "object") return settings;
      if(settings.ui_capacity_safe_fresh_probe === true) return settings;
      const preset = presetOverride
        ? normalizeSolverPreset(presetOverride)
        : solverPresetForSettings(settings);
      const optimizationFocus = String(settings.optimization_focus || "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
      if(["singletons", "sessions", "gaps"].includes(optimizationFocus)){
        // Focused commands bypass the generic Fast/Max quality bundle. The
        // plan already carries incumbent-derived safety caps; applying the
        // preset here used to re-enable all three quality objectives after
        // the user selected only one.
        settings.optimization_focused_objective_only = true;
        settings.optimization_two_stage_teacher_quality = false;
        settings.optimization_benders_minimize_hint_distance = false;
        settings.optimization_benders_session_feasibility_only = false;
        settings.optimization_benders_minimize_teacher_sessions = (
          optimizationFocus === "sessions"
        );
        settings.optimization_benders_minimize_one_period_sessions = (
          optimizationFocus === "singletons"
        );
        settings.optimization_benders_minimize_period_gaps = (
          optimizationFocus === "gaps"
        );
        settings.minimize_one_period_sessions = optimizationFocus === "singletons";
        settings.minimize_sessions = optimizationFocus === "sessions";
        settings.minimize_teacher_gaps = optimizationFocus === "gaps";
        settings.one_period_priority_absolute = optimizationFocus === "singletons";
        // Focused gap commands use their explicit Gap1/Gap2 objective.  A
        // generic max-gap=1 policy would turn Gap1 into an implicit Gap2
        // cleanup and would require Gap2=0 before a partial Gap2 improvement
        // can be retained.
        settings.period_max_teacher_gap = "off";
        settings.relax_period_teacher_gap_on_failure = false;
        // This marker belongs to Automatic's coordinated Phase-S/Phase-G
        // policy.  Leaving it on a focused click changes both comparison order
        // and backend orchestration, even when the boolean objective flags are
        // otherwise correct.
        delete settings.quality_priority_order;
        if(optimizationFocus === "singletons"){
          settings.max_one_period_sessions = "off";
          settings.strict_one_period_sessions_cap = false;
          settings.enforce_max_one_period_sessions = false;
          settings.allow_quality_debt = true;
          settings.optimization_benders_allow_one_period_debt = true;
        }else{
          const incumbentSingletonCap = Number(
            settings.optimization_incumbent_one_period_sessions
          );
          if(Number.isFinite(incumbentSingletonCap) && incumbentSingletonCap >= 0){
            settings.max_one_period_sessions = Math.round(incumbentSingletonCap);
            settings.session_early_stop_max_one_period_sessions = Math.round(
              incumbentSingletonCap
            );
          }
          settings.strict_one_period_sessions_cap = true;
          settings.enforce_max_one_period_sessions = true;
          settings.allow_quality_debt = Number.isFinite(incumbentSingletonCap)
            && incumbentSingletonCap > 0;
        }
        return settings;
      }
      settings.minimize_one_period_sessions = true;
      const boundedFreshDebt = settings.ui_bounded_fresh_accept_quality_debt === true;
      const unifiedResidualDebt = settings.ui_unified_partial_repair === true || boundedFreshDebt;
      if(preset === "fast" || unifiedResidualDebt){
        // The backend treats a missing/null cap as zero while minimization is on.
        // Use its explicit "off" sentinel so Fast can return a complete timetable
        // with quality debt, while still minimizing one-period teacher sessions.
        settings.max_one_period_sessions = "off";
        settings.strict_one_period_sessions_cap = false;
        settings.enforce_max_one_period_sessions = false;
        settings.one_period_priority_absolute = false;
        settings.allow_quality_debt = true;
        if(boundedFreshDebt){
          settings.period_max_teacher_gap = "off";
          settings.relax_period_teacher_gap_on_failure = true;
        }
      }else{
        settings.max_one_period_sessions = 0;
        settings.strict_one_period_sessions_cap = true;
        settings.enforce_max_one_period_sessions = true;
        settings.one_period_priority_absolute = true;
        settings.allow_quality_debt = false;
      }
      if(optimizationFocus === "quick_complete"){
        // Quick owns completeness only. Keep this final override after the
        // generic preset policy so no preset can silently re-enable teacher
        // quality objectives before the explicit optimization actions.
        settings.minimize_one_period_sessions = false;
        settings.minimize_sessions = false;
        settings.max_one_period_sessions = "off";
        settings.strict_one_period_sessions_cap = false;
        settings.enforce_max_one_period_sessions = false;
        settings.one_period_priority_absolute = false;
        settings.allow_quality_debt = true;
        settings.minimize_teacher_gaps = false;
        settings.period_max_teacher_gap = "off";
        settings.relax_period_teacher_gap_on_failure = true;
        settings.optimization_benders_session_feasibility_only = true;
        settings.optimization_benders_minimize_one_period_sessions = false;
        settings.optimization_benders_minimize_period_gaps = false;
        settings.native_skip_teacher_optimization = true;
      }
      return settings;
    }
    function isInternalIncompleteSolve(settings){
      if(!settings || typeof settings !== "object") return false;
      return settings.ui_internal_allow_incomplete === true
        || settings.ui_staged_existing_repair === true
        || settings.ui_afternoon_fill_pass === true
        || settings.ui_local_repair_pass === true
        || settings.ui_accept_incomplete_internal === true;
    }
    function shouldRequireCompletePresetResult(settings){
      const preset = solverPresetForSettings(settings);
      // A capacity preflight is a proof that the requested workload cannot fit
      // in the user's allowed cells.  Keep the schedulable portion instead of
      // applying the normal all-or-nothing preset contract; ordinary feasible
      // requests still require a complete result.
      return (preset === "fast" || preset === "balanced")
        && !isInternalIncompleteSolve(settings)
        && !isCapacityShortageAccepted(settings);
    }
    function enforceCompletePresetSolveSettings(settings){
      if(!settings || typeof settings !== "object") return settings;
      if(settings.ui_capacity_safe_fresh_probe === true) return settings;
      if(!shouldRequireCompletePresetResult(settings)) return settings;
      settings.require_complete_schedule = true;
      settings.best_effort_on_timeout = false;
      settings.ui_allow_best_effort_on_timeout = false;
      settings.ui_accept_incomplete_best_effort = false;
      const incrementalRefine = String(settings.ui_unified_solve_kind || "")
        .trim()
        .toLowerCase() === "refine_complete";
      const unifiedTimeboxed = settings.ui_unified_auto_sort === true;
      if(settings.ui_unified_partial_repair !== true && !incrementalRefine && !unifiedTimeboxed){
        settings.ui_allow_short_backend_deadline = false;
      }
      delete settings.ui_capacity_shortage_accepted;
      delete settings.ui_capacity_shortage_confirmed;
      delete settings.ui_capacity_shortage_accepted_after_solve;
      delete settings.capacity_limited_fast_lane;
      return settings;
    }
    function shouldRejectIncompletePresetPayload(settings, payload){
      if(!shouldRequireCompletePresetResult(settings)) return false;
      return !payloadCompletion(payload).complete;
    }
    function enforceRustRuntimeSafetySettings(settings){
      if(!settings || typeof settings !== "object") return settings;
      if(settings.ui_capacity_safe_fresh_probe === true) return settings;
      const allowValidatedQualityBank = false;
      settings.allow_validated_quality_bank = false;
      settings.allow_solver_warm_start = false;
      settings.allow_strict_quality_solution_bank = allowValidatedQualityBank;
      settings.disable_native_hint_solver = !allowValidatedQualityBank;
      settings.disable_solver_hints = !allowValidatedQualityBank;
      settings.native_disable_cached_hint_candidate = !allowValidatedQualityBank;
      settings.native_disable_static_hint_candidate = true;
      settings.native_hint_bank_max_entries = allowValidatedQualityBank
        ? Math.max(200, Number(settings.native_hint_bank_max_entries || 0) || 0)
        : 0;
      settings.native_hint_bank_time_limit_ms = allowValidatedQualityBank
        ? Math.max(20000, Number(settings.native_hint_bank_time_limit_ms || 0) || 0)
        : 0;
      settings.native_hint_bank_cleanup_validation_limit = allowValidatedQualityBank
        ? Math.max(30, Number(settings.native_hint_bank_cleanup_validation_limit || 0) || 0)
        : 0;
      settings.native_hint_bank_candidate_cleanup_time_ms = allowValidatedQualityBank
        ? Math.max(4000, Number(settings.native_hint_bank_candidate_cleanup_time_ms || 0) || 0)
        : 0;
      settings.native_hint_bank_hard_repair_violation_cap = allowValidatedQualityBank
        ? Math.max(64, Number(settings.native_hint_bank_hard_repair_violation_cap || 0) || 0)
        : 0;
      if(allowValidatedQualityBank && hasFixedOffPressure(getData())){
        settings.native_hint_bank_min_stored_teacher_sessions = Math.max(
          180,
          Number(settings.native_hint_bank_min_stored_teacher_sessions || 0) || 0
        );
        settings.schedule_diversity = false;
        settings.reclick_schedule_diversity = false;
        settings.native_quality_variant_gap_slack = 0;
        settings.native_quality_variant_one_period_slack = 0;
        settings.native_quality_variant_session_slack = 0;
        delete settings.quality_variant_seed;
      }else{
        delete settings.native_hint_bank_min_stored_teacher_sessions;
      }
      const allowCpsatQuality = settings.allow_cpsat_quality_improvement === true;
      settings.fast_repair_period_hint = false;
      settings.fast_validated_period_hint = false;
      settings.allow_cpsat_strict_fallback = false;
      settings.disable_cpsat_strict_fallback = true;
      settings.disable_cpsat_load2_lns = true;
      settings.disable_cpsat_quality_improvement = !allowCpsatQuality;
      settings.native_cpsat_quality_time_limit_seconds = allowCpsatQuality
        ? Math.max(60, Number(settings.native_cpsat_quality_time_limit_seconds || 0) || 0)
        : 0;
      settings.native_cpsat_time_limit_seconds = allowCpsatQuality
        ? Math.max(settings.native_cpsat_quality_time_limit_seconds, Number(settings.native_cpsat_time_limit_seconds || 0) || 0)
        : 0;
      settings.native_cpsat_lns_time_limit_seconds = 0;
      settings.native_cpsat_relaxed_hint_time_limit_ms = 0;
      settings.native_cpsat_relaxed_hint_cleanup_ms = 0;
      if(!allowCpsatQuality) delete settings.native_cpsat_teacher_session_cap;
      delete settings.native_cpsat_lns_teacher_session_cap;
      settings.native_fresh_empty_moves = true;
      settings.native_fresh_hard_repair_hard_cap = Math.max(
        800,
        Number(settings.native_fresh_hard_repair_hard_cap || 0) || 0
      );
      settings.native_overlay_hard_repair_time_ms = Math.max(
        2500,
        Number(settings.native_overlay_hard_repair_time_ms || 0) || 0
      );
      settings.native_overlay_hard_repair_max_iters = Math.max(
        12000,
        Number(settings.native_overlay_hard_repair_max_iters || 0) || 0
      );
      settings.native_fresh_attempts = Math.max(
        24,
        Number(settings.native_fresh_attempts || 0) || 0
      );
      settings.native_fresh_max_iters = Math.max(
        80000,
        Number(settings.native_fresh_max_iters || 0) || 0
      );
      settings.native_enable_session_beam_initial = true;
      settings.native_session_beam_width = Math.max(
        768,
        Math.min(2048, Number(settings.native_session_beam_width || 0) || 0)
      );
      settings.native_session_beam_branch_limit = Math.max(
        28,
        Math.min(40, Number(settings.native_session_beam_branch_limit || 0) || 0)
      );
      settings.native_session_beam_final_limit = Math.max(
        120,
        Math.min(320, Number(settings.native_session_beam_final_limit || 0) || 0)
      );
      const overallMs = Math.max(0, Number(settings.overall_time_limit_seconds || 0) || 0) * 1000;
      const freshCeil = overallMs > 0
        ? Math.max(35000, Math.min(180000, Math.round(overallMs * 0.82)))
        : 90000;
      const freshFloor = overallMs >= 90000 ? 70000 : 55000;
      settings.native_fresh_time_limit_ms = Math.max(
        freshFloor,
        Math.min(
          freshCeil,
          Number(settings.native_fresh_time_limit_ms || freshCeil) || freshCeil
        )
      );
      settings.native_fresh_per_attempt_time_limit_ms = Math.min(
        25000,
        Math.max(7000, Number(settings.native_fresh_per_attempt_time_limit_ms || 25000) || 25000)
      );
      const cleanupDefault = overallMs >= 100000 ? 26000 : 18000;
      settings.native_fresh_cleanup_time_limit_ms = Math.max(
        cleanupDefault,
        Math.min(60000, Number(settings.native_fresh_cleanup_time_limit_ms || 0) || 0)
      );
      settings.native_quality_cleanup_max_iters = Math.max(
        96,
        Number(settings.native_quality_cleanup_max_iters || 0) || 0
      );
      settings.native_cross_class_swap_time_limit_ms = Math.max(
        16000,
        Math.min(45000, Number(settings.native_cross_class_swap_time_limit_ms || 0) || 0)
      );
      settings.native_global_session_permutation_time_limit_ms = Math.max(
        6000,
        Math.min(18000, Number(settings.native_global_session_permutation_time_limit_ms || 0) || 0)
      );
      settings.native_global_session_permutation_check_limit = Math.max(
        3000,
        Math.min(30000, Number(settings.native_global_session_permutation_check_limit || 0) || 0)
      );
      settings.native_day_session_period_anneal_time_limit_ms = Math.max(
        10000,
        Math.min(36000, Number(settings.native_day_session_period_anneal_time_limit_ms || 0) || 0)
      );
      settings.native_day_session_period_anneal_max_iters = Math.max(
        220000,
        Math.min(700000, Number(settings.native_day_session_period_anneal_max_iters || 0) || 0)
      );
      settings.native_strict_one_period_pair_check_limit = Math.max(
        90000,
        Math.min(240000, Number(settings.native_strict_one_period_pair_check_limit || 0) || 0)
      );
      settings.native_strict_one_period_pair_target_limit = Math.max(
        160,
        Math.min(360, Number(settings.native_strict_one_period_pair_target_limit || 0) || 0)
      );
      settings.native_one_period_3cycle_time_limit_ms = Math.max(
        10000,
        Math.min(30000, Number(settings.native_one_period_3cycle_time_limit_ms || 0) || 0)
      );
      settings.native_one_period_3cycle_check_limit = Math.max(
        120000,
        Math.min(360000, Number(settings.native_one_period_3cycle_check_limit || 0) || 0)
      );
      settings.native_one_period_random_walk_time_limit_ms = Math.max(
        14000,
        Math.min(42000, Number(settings.native_one_period_random_walk_time_limit_ms || 0) || 0)
      );
      settings.native_one_period_random_walk_max_iters = Math.max(
        260000,
        Math.min(700000, Number(settings.native_one_period_random_walk_max_iters || 0) || 0)
      );
      settings.native_hint_quality_cleanup_time_limit_ms = 0;
      settings.production_rust_only = true;
      return settings;
    }
    // Canonical VPS progress consumes the whole visible range smoothly. 100%
    // remains reserved for a real result, so a slow response cannot look done.
    const PRE_ADMISSION_PROGRESS_CAP = 12;
    const PRE_ADMISSION_PROGRESS_SECONDS = 8;
    const SERVER_WAIT_PROGRESS_CAP = 99;
    const RESULT_APPLY_PROGRESS_CAP = 99;
    const FIRST_PROGRESS_PAINT_DELAY_MS = 1000;
    let progressTimer = 0;
    let progressFirstPaintTimer = 0;
    let progressState = null;
    const parsedSolverResponsePayloads = new WeakMap();
    const deferredBackendResultPayloads = new WeakMap();
    const deferredBackendSavePromises = new WeakMap();
    let activeSolveAbortController = null;
    let activeBackendJobId = "";
    let deferredBackendResultJobId = "";
    let deferredBackendSavePendingJobId = "";
    let pendingBackendResumeTimer = 0;
    let pendingBackendResumeDueAt = 0;
  let pendingBackendResumeTimerGeneration = 0;
  let pendingBackendResumeInFlight = null;
  let pendingBackendWakeRequested = false;
  let pendingBackendWakeNeedsEmptyProbe = false;
  let bestEffortStopJobId = "";
    let backendResumeEpoch = 0;
    let backendAuthRequired = false;
    let backendAuthFlowStarted = false;
    const CURRENT_SOLVE_EXECUTOR_EVENT = "tkb:solver-executor-state";
    const SOLVER_USAGE_ROUTE_EVENT = "tkb:solver-usage-route";
    const SOLVER_USAGE_ROUTE_STORAGE_KEY = "TKB_SOLVER_USAGE_ROUTE_V1";
    const announcedSolverUsageRoutes = new Set();

    function normalizedSolveExecutor(value, executionPhase){
      const phase = String(executionPhase || "").trim().toLowerCase();
      // Handoff is still VPS-owned until the Agent reaches its waiting/running
      // phase. Showing green during the stop boundary made mobile users think
      // local CPU had already taken over while the VPS child was still being
      // fenced.
      if(phase === "handoff_to_agent") return "vps";
      if(phase.startsWith("agent_")) return "agent";
      if(phase.startsWith("vps_")) return "vps";
      const raw = String(value || "").trim().toLowerCase();
      if(raw === "agent" || raw === "vps") return raw;
      return "";
    }

    function dispatchCurrentSolveExecutorState(detail){
      try{
        if(
          typeof window.dispatchEvent === "function"
          && typeof window.CustomEvent === "function"
        ){
          window.dispatchEvent(new window.CustomEvent(CURRENT_SOLVE_EXECUTOR_EVENT, {detail}));
        }
      }catch(_){ }
    }

    function normalizedUsageExecutor(payload, executionPhase){
      const phase = String(executionPhase || "").trim().toLowerCase();
      const raw = String(payload?.executor || "").trim().toLowerCase();
      if(phase.startsWith("serverless_") || ["serverless", "cloud_run", "cloud"].includes(raw)){
        return "cloud_run";
      }
      if(phase.startsWith("vps_") || raw === "vps") return "vps";
      return "";
    }

    function announceSolverUsageRoute(payload, jobId, executionPhase){
      const executor = normalizedUsageExecutor(payload, executionPhase);
      if(!executor || !jobId) return false;
      const routeKey = `${jobId}|${executor}`;
      if(announcedSolverUsageRoutes.has(routeKey)) return false;
      announcedSolverUsageRoutes.add(routeKey);
      const detail = {
        jobId,
        executor,
        executionPhase:String(executionPhase || ""),
        updatedAt:Date.now()
      };
      try{
        if(
          typeof window.dispatchEvent === "function"
          && typeof window.CustomEvent === "function"
        ){
          window.dispatchEvent(new window.CustomEvent(SOLVER_USAGE_ROUTE_EVENT, {detail}));
        }
      }catch(_){ }
      try{
        window.localStorage?.setItem?.(
          SOLVER_USAGE_ROUTE_STORAGE_KEY,
          JSON.stringify(detail)
        );
      }catch(_){ }
      return true;
    }

    function publishCurrentSolveExecutorState(payload, fallbackJobId){
      if(!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const jobId = String(payload.jobId || fallbackJobId || "").trim();
      if(!jobId) return null;
      const previous = window.__TKB_CURRENT_SOLVE_EXECUTOR;
      const samePrevious = previous && String(previous.jobId || "") === jobId
        ? previous
        : null;
      const executionPhase = String(
        payload.executionPhase
        || samePrevious?.executionPhase
        || ""
      ).trim();
      const executor = normalizedSolveExecutor(
        payload.executor || samePrevious?.executor,
        executionPhase
      );
      const serverExecutor = normalizedUsageExecutor(payload, executionPhase);
      const detail = {
        jobId,
        executor,
        serverExecutor,
        executionPhase,
        active:true,
        updatedAt:Date.now()
      };
      window.__TKB_CURRENT_SOLVE_EXECUTOR = detail;
      dispatchCurrentSolveExecutorState(detail);
      announceSolverUsageRoute(payload, jobId, executionPhase);
      return detail;
    }

    function clearCurrentSolveExecutorState(jobId){
      const current = window.__TKB_CURRENT_SOLVE_EXECUTOR;
      const expectedJobId = String(jobId || "").trim();
      if(!current) return false;
      if(
        expectedJobId
        && String(current.jobId || "") !== expectedJobId
      ) return false;
      const detail = {
        jobId:String(current?.jobId || expectedJobId || ""),
        executor:String(current?.executor || ""),
        executionPhase:String(current?.executionPhase || ""),
        active:false,
        updatedAt:Date.now()
      };
      window.__TKB_CURRENT_SOLVE_EXECUTOR = null;
      dispatchCurrentSolveExecutorState(detail);
      return true;
    }
    let scheduleMutationCancellationInFlight = null;
    let activeBackendResumeTarget = null;
    // A foreground wakeup can overlap the previous page's terminal callback.
    // Keep the canonical id leased until the reattached payload has been
    // validated and applied; a late callback must not consume the id first.
    let activeServerJobReattachLeaseId = "";
    let completionPopupTimer = 0;
    let solveRunCounter = 0;
    let statusDotsTimer = 0;
    let statusDotsFrame = 0;
    let statusDotsBase = "";
    let statusDotsType = "";
    let autoSortPlanningMemo = null;
    let autoSortPreflightToken = null;
    let autoSortPreflightCounter = 0;
    let autoSortTerminalSettlementActive = false;
    let queuedAutoSortContinuation = null;
    let queuedAutoSortContinuationTimer = 0;
    const SOLVE_TIMING_KEY = "TKB_RUST_SOLVE_TIMING_V1";

  function acquireAutoSortPreflight(){
    if(autoSortPreflightToken) return null;
    const token = {
      id:++autoSortPreflightCounter,
      startedAt:Date.now()
    };
    autoSortPreflightToken = token;
    window.__TKB_AUTO_SORT_PREFLIGHT_ACTIVE = true;
    return token;
  }

  function releaseAutoSortPreflight(token){
    if(!token || autoSortPreflightToken !== token) return false;
    autoSortPreflightToken = null;
    window.__TKB_AUTO_SORT_PREFLIGHT_ACTIVE = false;
    scheduleQueuedAutoSortContinuation();
    return true;
  }

  function autoSortPreflightActive(){
    return !!autoSortPreflightToken;
  }

  function queueAutoSortContinuationAfterSettlement(options){
    if(autoSortTerminalSettlementActive !== true) return false;
    const source = options && typeof options === "object" ? options : {};
    queuedAutoSortContinuation = {
      options:{
        mode:normalizeSolveRequestMode(source.mode),
        manualAgentInvite:source.manualAgentInvite === true
      },
      queuedAt:Date.now()
    };
    window.__TKB_AUTO_SORT_CONTINUATION_QUEUED = true;
    setStatus(
      "Đã nhận lệnh tối ưu tiếp; sẽ chạy ngay sau khi lưu TKB hiện tại.",
      "info"
    );
    return true;
  }

  function scheduleQueuedAutoSortContinuation(){
    if(!queuedAutoSortContinuation) return false;
    if(autoSortTerminalSettlementActive === true || autoSortPreflightToken) return false;
    if(window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true) return false;
    if(window.__TKB_SOLVER_SAVE_PENDING === true) return false;
    if(queuedAutoSortContinuationTimer) return true;
    const queued = queuedAutoSortContinuation;
    queuedAutoSortContinuation = null;
    window.__TKB_AUTO_SORT_CONTINUATION_QUEUED = false;
    queuedAutoSortContinuationTimer = window.setTimeout(() => {
      queuedAutoSortContinuationTimer = 0;
      if(
        autoSortTerminalSettlementActive === true
        || autoSortPreflightToken
        || window.__TKB_RUST_SOLVER_RUNNING === true
        || window.__TKB_SOLVE_UI_BUSY === true
        || window.__TKB_SOLVER_SAVE_PENDING === true
      ){
        queuedAutoSortContinuation = queued;
        window.__TKB_AUTO_SORT_CONTINUATION_QUEUED = true;
        return;
      }
      try{
        const replay = window.sapXepTuDongAll?.(queued.options);
        if(replay && typeof replay.catch === "function"){
          replay.catch(err => {
            try{ console.warn(`[${VERSION}] queued refinement failed`, err); }catch(_){ }
          });
        }
      }catch(err){
        try{ console.warn(`[${VERSION}] queued refinement failed`, err); }catch(_){ }
      }
    }, 0);
    return true;
  }

  function activeAutoSortPlanningMemo(data){
    return autoSortPlanningMemo && autoSortPlanningMemo.data === data
      ? autoSortPlanningMemo
      : null;
  }

  function beginAutoSortPlanningMemo(data, expected){
    const previous = autoSortPlanningMemo;
    const knownExpected = Number(expected);
    const memo = {
      data,
      expected:Number.isFinite(knownExpected) && knownExpected >= 0 ? Math.round(knownExpected) : null,
      aliasesByKey:new Map()
    };
    autoSortPlanningMemo = memo;
    return {memo, previous};
  }

  function endAutoSortPlanningMemo(token){
    if(token?.memo && autoSortPlanningMemo === token.memo){
      autoSortPlanningMemo = token.previous || null;
    }
  }

  function hardwareWorkerCount(){
    let cores = 0;
    try{ cores = Number(window.navigator && window.navigator.hardwareConcurrency); }catch(_){}
    return Number.isFinite(cores) && cores > 0
      ? Math.max(1, Math.floor(cores))
      : 1;
  }

  function isMobileBrowserAgentNavigator(deviceNavigator){
    const nav = deviceNavigator || window.navigator || {};
    try{
      if(typeof window.TKBBrowserWasmExecutor?.isMobileNavigator === "function"){
        return window.TKBBrowserWasmExecutor.isMobileNavigator(nav) === true;
      }
    }catch(_){ }
    const platform = String(nav.userAgentData?.platform || nav.platform || "");
    const userAgent = String(nav.userAgent || "");
    return /iPhone|iPad|iPod|Android|Mobile/i.test(`${platform} ${userAgent}`)
      || (/MacIntel/i.test(platform) && Number(nav.maxTouchPoints || 0) > 1);
  }

  function isWindowsNativeAgentNavigator(deviceNavigator){
    if(window.__TKB_WINDOWS_WEB_AGENT_TRIAL === true) return false;
    const nav = deviceNavigator || window.navigator || {};
    try{
      if(typeof window.isWindowsNativeAgentDevice === "function"){
        if(window.isWindowsNativeAgentDevice(nav) === true) return true;
      }
    }catch(_){ }
    const platform = String(nav.userAgentData?.platform || nav.platform || "");
    const userAgent = String(nav.userAgent || "");
    return /Windows/i.test(platform) || /Windows NT/i.test(userAgent);
  }

  function localAgentRoleAllowed(){
    // Temporary Cloud Run acceptance switch.  The planner owns this explicit
    // flag so Agent Web/EXE source can stay intact for rollback while every
    // current click remains server-owned.
    if(window.__TKB_CLIENT_AGENT_LANES_ENABLED === false) return false;
    if(window.__TKB_AGENT_ROLE_GATE_ENFORCED === true){
      return window.__TKB_AGENT_ROLE_ALLOWED === true;
    }
    try{
      if(window.TKBAuth && typeof window.TKBAuth.currentUser === "function"){
        const role = String(window.TKBAuth.currentUser()?.user?.role || "")
          .trim()
          .toLowerCase();
        return role === "school_admin" || role === "superadmin";
      }
    }catch(_){ }
    // sapxep.html always publishes the explicit gate before this bridge. The
    // fallback preserves compatibility for isolated tests and older embeds.
    return true;
  }

  function currentUserIsSuperadmin(){
    try{
      if(window.TKBAuth && typeof window.TKBAuth.currentUser === "function"){
        return String(window.TKBAuth.currentUser()?.user?.role || "")
          .trim()
          .toLowerCase() === "superadmin";
      }
    }catch(_){ }
    // The authenticated planner always provides TKBAuth. Preserve compatibility
    // for isolated bridge tests/legacy embeds that intentionally omit auth.
    return window.__TKB_E2E_EXPOSE_TEST_HOOKS === true && !window.TKBAuth;
  }

  function solveRequestModeAllowedForCurrentUser(mode){
    if(currentUserIsSuperadmin()) return true;
    const normalized = normalizeSolveRequestMode(mode);
    // Ordinary users get Automatic plus the four visible focused actions.
    // Keep quick_complete available as an internal incomplete-timetable
    // fallback. The legacy combined-gaps alias remains operations-only so a
    // browser action always maps to one explicit objective.
    return [
      SOLVE_REQUEST_MODES.automatic,
      SOLVE_REQUEST_MODES.autoMin2,
      SOLVE_REQUEST_MODES.quickComplete,
      SOLVE_REQUEST_MODES.singletons,
      SOLVE_REQUEST_MODES.sessions,
      SOLVE_REQUEST_MODES.gap1,
      SOLVE_REQUEST_MODES.gap2
    ].includes(normalized);
  }


  function isFalseSetting(value){
    return String(value == null ? "" : value).trim().toLowerCase() === "false" || String(value).trim() === "0";
  }

  function isTruthySetting(value){
    const normalized = String(value == null ? "" : value).trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }

  function positiveNumberSetting(value){
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  function nonnegativeNumberSetting(value){
    if(value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  function clearPostRollbackSettings(settings){
    delete settings.force_preserve_partial_existing;
    const unifiedExistingSolve = settings.ui_unified_auto_sort === true
      && (settings.ui_unified_partial_repair === true || settings.ui_use_existing_complete_incumbent === true);
    if(!unifiedExistingSolve) delete settings.preserve_fixed_lessons_only;
    delete settings.optimization_fast_profile;
    delete settings.existing_fixed_scheduled_periods;
  }

  function clearExistingRepairSettings(settings){
    if(!settings || typeof settings !== "object") return settings;
    settings.optimize_existing_schedule = false;
    settings.existing_fill_missing_schedule = false;
    settings.preserve_existing_tkb = false;
    settings.force_preserve_partial_existing = false;
    settings.partial_existing_rebuild = false;
    settings.repair_fill_first = false;
    settings.repair_partial_existing = false;
    settings.allow_solver_warm_start = false;
    settings.force_fresh_backend_solve = true;
    settings.allow_backend_cache = false;
    delete settings.repair_partial_existing_reason;
    delete settings.repair_existing_missing_periods;
    delete settings.repair_fill_first_max_missing;
    delete settings.existing_scheduled_periods;
    delete settings.existing_flexible_scheduled_periods;
    return settings;
  }

  function enforceNoHintFreshSolveSettings(settings){
    if(!settings || typeof settings !== "object") return settings;
    const fixedOnly = settings.preserve_fixed_lessons_only === true
      || positiveNumberSetting(settings.existing_fixed_scheduled_periods) > 0;
    settings.allow_backend_cache = false;
    settings.force_fresh_backend_solve = true;
    settings.ui_no_hint_fresh_solve = true;
    settings.allow_solver_warm_start = false;
    settings.preserve_existing_tkb = false;
    settings.optimize_existing_schedule = false;
    settings.existing_fill_missing_schedule = false;
    settings.allow_legacy_solver_hints = false;
    settings.allow_validated_quality_bank = false;
    settings.allow_strict_quality_solution_bank = false;
    settings.disable_native_hint_solver = true;
    settings.disable_solver_hints = true;
    settings.native_disable_cached_hint_candidate = true;
    settings.native_disable_static_hint_candidate = true;
    settings.native_hint_bank_max_entries = 0;
    settings.native_hint_bank_time_limit_ms = 0;
    settings.native_hint_bank_validation_limit = 0;
    settings.native_hint_bank_cleanup_validation_limit = 0;
    settings.native_hint_bank_candidate_cleanup_time_ms = 0;
    settings.native_hint_bank_hard_repair_violation_cap = 0;
    settings.native_hint_quality_cleanup_time_limit_ms = 0;
    settings.native_cpsat_relaxed_hint_time_limit_ms = 0;
    settings.native_cpsat_relaxed_hint_cleanup_ms = 0;
    settings.fast_repair_period_hint = false;
    settings.fast_validated_period_hint = false;
    settings.ui_allow_auto_existing_optimize = false;
    settings.ui_allow_staged_existing_on_fresh_sort = false;
    settings.ui_allow_presolve_local_fast_finish = false;
    // A quality-debt rebuild deliberately solves without a warm-start hint,
    // but it is still a refinement transaction: the visible complete
    // incumbent must win when the rebuilt candidate is not Pareto-better.
    // Preserve this through every no-hint normalization pass so iOS reattach
    // applies the same incumbent-quality guard as the foreground lifecycle.
    settings.ui_keep_better_existing_on_resort =
      settings.ui_quality_debt_fresh_rebuild === true;
    settings.ui_disable_staged_existing_repair = true;
    settings.ui_disable_partial_existing_repair = true;
    if(!fixedOnly){
      settings.force_preserve_partial_existing = false;
      settings.partial_existing_rebuild = false;
      settings.repair_fill_first = false;
      settings.repair_partial_existing = false;
      delete settings.repair_partial_existing_reason;
      delete settings.repair_existing_missing_periods;
      delete settings.repair_fill_first_max_missing;
      delete settings.existing_scheduled_periods;
      delete settings.existing_flexible_scheduled_periods;
    }
    delete settings.native_hint_bank_min_stored_teacher_sessions;
    return settings;
  }

  function isNoHintSmartFreshSettings(settings){
    if(!settings || typeof settings !== "object") return false;
    const strategy = String(settings.auto_sort_strategy || "").trim().toLowerCase();
    return settings.ui_smart_fast_default === true
      || settings.ui_no_hint_fresh_solve === true
      || settings.ui_default_fresh_sort === true
      || strategy.startsWith("fresh_")
      || strategy === "fresh_fast_quality_compact_first"
      || strategy === "fresh_fast_quality_default_sort";
  }

  function applyDefaultFreshSortSettings(settings){
    if(!settings || typeof settings !== "object") return settings;
    settings.ui_default_fresh_sort = true;
    settings.ui_force_initial_fast_draft = true;
    settings.ui_disable_staged_existing_repair = true;
    settings.ui_disable_partial_existing_repair = true;
    delete settings.ui_capacity_shortage_accepted;
    delete settings.ui_capacity_shortage_accepted_after_solve;
    clearExistingRepairSettings(settings);
    settings.auto_sort_mode = "fast";
    const strategy = String(settings.auto_sort_strategy || "");
    if(!strategy.startsWith("fresh_fast_quality") && !strategy.startsWith("fresh_speed_first")){
      settings.auto_sort_strategy = "fresh_fast_quality_default_sort";
    }
    enforceNoHintFreshSolveSettings(settings);
    return settings;
  }

  function normalizeOverallTimeLimit(value){
    const n = Number(value);
    if(!Number.isFinite(n) || n <= 0) return 0;
    // 600 seconds was the old default 10:00 cap; treat it as stale saved config.
    if(Math.round(n) === 600) return 0;
    return Math.round(n);
  }

  function normalizeCustomSolveDurationSeconds(value, fallback = 0){
    const raw = typeof value === "string" ? value.trim() : value;
    const number = raw === "" || raw == null ? NaN : Number(raw);
    if(Number.isFinite(number) && number > 0){
      return Math.max(
        MIN_CUSTOM_SOLVE_DURATION_SECONDS,
        Math.min(MAX_CUSTOM_SOLVE_DURATION_SECONDS, Math.round(number))
      );
    }
    const fallbackNumber = Number(fallback);
    if(!Number.isFinite(fallbackNumber) || fallbackNumber <= 0) return 0;
    return Math.max(
      MIN_CUSTOM_SOLVE_DURATION_SECONDS,
      Math.min(MAX_CUSTOM_SOLVE_DURATION_SECONDS, Math.round(fallbackNumber))
    );
  }

  function customSolveDurationInput(){
    try{ return document.getElementById("solveDurationSeconds"); }catch(_){ return null; }
  }

  function writeCustomSolveDurationSeconds(value){
    const raw = value == null ? "" : String(value).trim();
    const seconds = normalizeCustomSolveDurationSeconds(raw, 0);
    const input = customSolveDurationInput();
    if(seconds <= 0){
      try{ localStorage.removeItem(CUSTOM_SOLVE_DURATION_KEY); }catch(_){}
      if(input){
        input.dataset.durationMode = "auto";
        input.value = "";
      }
      return 0;
    }
    try{ localStorage.setItem(CUSTOM_SOLVE_DURATION_KEY, String(seconds)); }catch(_){}
    if(input){
      input.dataset.durationMode = "custom";
      if(String(input.value || "") !== String(seconds)) input.value = String(seconds);
    }
    return seconds;
  }

  function readCustomSolveDurationSeconds(){
    const input = customSolveDurationInput();
    if(input){
      if(input.dataset.durationMode === "auto") return 0;
      return writeCustomSolveDurationSeconds(input.value);
    }
    try{ localStorage.removeItem(CUSTOM_SOLVE_DURATION_KEY); }catch(_){}
    return 0;
  }

  function customSolveDurationOverrideActive(){
    const input = customSolveDurationInput();
    if(input){
      if(input.dataset.durationMode === "auto") return false;
      return normalizeCustomSolveDurationSeconds(input.value, 0) > 0;
    }
    return false;
  }

  function customSolveDurationFromSettings(settings){
    return normalizeCustomSolveDurationSeconds(settings?.ui_custom_solve_duration_seconds, 0);
  }

  function manualFreshRetryRecord(data){
    const value = data?.[MANUAL_FRESH_RETRY_DATA_KEY];
    if(!value || typeof value !== "object") return null;
    const fingerprint = String(value.fingerprint || "");
    if(!fingerprint || !durableScheduleFingerprintMatches(fingerprint, data)) return null;
    const nextSeconds = Math.max(
      INITIAL_AUTO_DURATION_SECONDS,
      Math.min(
        ROBUST_AUTO_DURATION_SECONDS,
        Math.round(Number(value.nextSeconds || 0) || 0)
      )
    );
    if(nextSeconds <= INITIAL_AUTO_DURATION_SECONDS) return null;
    return {
      fingerprint,
      nextSeconds,
      failures:Math.max(1, Math.round(Number(value.failures || 1) || 1))
    };
  }

  function manualFreshRetryBudgetSeconds(data){
    return manualFreshRetryRecord(data)?.nextSeconds || INITIAL_AUTO_DURATION_SECONDS;
  }

  function retryableManualFreshSolveFailure(settings, err){
    const solveKind = String(settings?.ui_unified_solve_kind || "").trim().toLowerCase();
    if(!["fresh_complete_first", "repair_constraints", "repair_partial"].includes(solveKind)){
      return false;
    }
    if(customSolveDurationFromSettings(settings) > 0 || settings?.ui_custom_solve_duration_override === true){
      return false;
    }
    const kind = String(err?.kind || err?.payload?.kind || "").trim().toLowerCase();
    if(kind === "no_complete_schedule_before_deadline") return true;
    const raw = String(
      err?.message
      || err?.payload?.error
      || err?.payload?.message
      || ""
    ).toLowerCase();
    return raw.includes("benders teacher-session cap search failed")
      || raw.includes("global solver deadline exhausted")
      || raw.includes("deadline before complete schedule")
      || raw.includes("first-click feasibility phase did not produce")
      || raw.includes("constraint-change feasibility phase did not produce");
  }

  function rememberManualFreshRetryFailure(data, settings, err){
    if(!data || !retryableManualFreshSolveFailure(settings, err)) return 0;
    if(INITIAL_AUTO_DURATION_SECONDS >= ROBUST_AUTO_DURATION_SECONDS) return 0;
    const attemptedSeconds = Math.max(
      INITIAL_AUTO_DURATION_SECONDS,
      Math.round(Number(settings?.backend_deadline_ms || 0) / 1000) || 0
    );
    const previous = manualFreshRetryRecord(data);
    const nextSeconds = Math.min(
      ROBUST_AUTO_DURATION_SECONDS,
      Math.max(attemptedSeconds, previous?.nextSeconds || 0) + MANUAL_FRESH_RETRY_STEP_SECONDS
    );
    data[MANUAL_FRESH_RETRY_DATA_KEY] = {
      version:1,
      fingerprint:durableScheduleFingerprint(data),
      nextSeconds,
      failures:Math.max(0, Number(previous?.failures || 0) || 0) + 1,
      updatedAt:Date.now()
    };
    try{ callMaybe("saveStore", [{force:true, suppressHistory:true}]); }catch(_){}
    return nextSeconds;
  }

  function clearManualFreshRetryBudget(data, persist = false){
    if(!data || !Object.prototype.hasOwnProperty.call(data, MANUAL_FRESH_RETRY_DATA_KEY)) return false;
    delete data[MANUAL_FRESH_RETRY_DATA_KEY];
    if(persist){
      try{ callMaybe("saveStore", [{force:true, suppressHistory:true}]); }catch(_){}
    }
    return true;
  }

  function syncSolveDurationPreview(settings, customSeconds){
    const input = customSolveDurationInput();
    if(!input) return;
    const custom = normalizeCustomSolveDurationSeconds(customSeconds, 0);
    if(custom > 0){
      input.dataset.durationMode = "custom";
      input.value = String(custom);
      return;
    }
    if(input.dataset.durationMode !== "auto") return;
    // Keep the override field visually empty until the user types. Blank runs
    // Automatic fresh and refinement lanes both have a 180-second safety cap.
    // Their quality gates normally stop substantially earlier.
    void settings;
    input.value = "";
  }

  function applyCustomSolveDurationSettings(settings, requestedSeconds){
    if(!settings || typeof settings !== "object") return settings;
    const seconds = normalizeCustomSolveDurationSeconds(
      requestedSeconds == null ? settings.ui_custom_solve_duration_seconds : requestedSeconds,
      0
    );
    if(seconds <= 0) return settings;

    settings.ui_custom_solve_duration_seconds = seconds;
    settings.ui_custom_solve_duration_override = true;
    settings.ui_allow_short_backend_deadline = true;
    settings.optimization_time_limit_seconds = seconds;
    settings.optimization_adaptive_time_limit_seconds = seconds;
    settings.overall_time_limit_seconds = seconds;
    settings.integrated_time_limit = seconds;
    settings.backend_deadline_ms = seconds * 1000;
    settings.native_global_deadline_ms = seconds * 1000;
    settings.progress_estimate_seconds = seconds;

    const unifiedKind = String(settings.ui_unified_solve_kind || "").trim().toLowerCase();
    if(unifiedKind === "refine_complete"){
      settings.ui_unified_refine_ceiling_seconds = seconds;
      settings.ui_incremental_progress_estimate_seconds = seconds;
    }else if(unifiedKind === "repair_partial"){
      settings.ui_unified_repair_ceiling_seconds = seconds;
    }else if(settings.ui_unified_initial_fast_stage === true){
      settings.ui_unified_initial_ceiling_seconds = seconds;
    }

    if(unifiedKind === "fresh_complete_first"){
      settings.optimization_first_click_feasibility_time_limit_seconds = Math.min(70, seconds);
      settings.optimization_first_click_quality_time_limit_seconds = Math.min(
        seconds,
        Math.max(
          12,
          seconds
            - settings.optimization_first_click_feasibility_time_limit_seconds
            - 10
        )
      );
      settings.optimization_first_click_quality_minimum_seconds = Math.min(24, seconds);
      settings.optimization_first_click_quality_session_time_limit_seconds = Math.min(
        40,
        settings.optimization_first_click_quality_time_limit_seconds
      );
      settings.optimization_first_click_local_lns_time_limit_seconds = Math.min(
        seconds,
        settings.ui_unified_initial_fast_stage === true && seconds <= 120
          ? 12
          : (seconds >= 150 ? 45 : 10)
      );
    }

    const capSeconds = key => {
      const current = Number(settings[key]);
      if(Number.isFinite(current) && current > 0){
        settings[key] = Math.max(1, Math.min(seconds, Math.round(current)));
      }
    };
    [
      "optimization_first_cap_time_limit_seconds",
      "optimization_session_time_limit",
      "optimization_period_retry_time_limit",
      "optimization_first_click_feasibility_time_limit_seconds",
      "optimization_first_click_quality_time_limit_seconds",
      "optimization_first_click_quality_minimum_seconds",
      "optimization_first_click_quality_session_time_limit_seconds",
      "optimization_first_click_target_probe_time_limit_seconds",
      "optimization_first_click_target_probe_convergence_ceiling_seconds",
      "optimization_first_click_local_lns_time_limit_seconds",
      "session_time_limit",
      "period_time_limit",
      "period_fast_time_limit",
      "period_retry_time_limit",
      "fast_quality_retry_time_limit_seconds",
      "native_cpsat_quality_time_limit_seconds",
      "native_cpsat_time_limit_seconds",
      "native_cpsat_lns_time_limit_seconds"
    ].forEach(capSeconds);

    const capMilliseconds = key => {
      const current = Number(settings[key]);
      if(Number.isFinite(current) && current > 0){
        settings[key] = Math.max(1, Math.min(seconds * 1000, Math.round(current)));
      }
    };
    [
      "native_fresh_time_limit_ms",
      "native_fresh_cleanup_time_limit_ms",
      "native_cpsat_relaxed_hint_time_limit_ms",
      "native_cpsat_relaxed_hint_cleanup_ms"
    ].forEach(capMilliseconds);
    return settings;
  }

  function applyHybridCloudRunBudget(settings){
    if(!settings || typeof settings !== "object") return settings;
    if(settings.ui_hybrid_executor !== "cloud_run" && settings.ui_hybrid_cloud_run_requested !== true) return settings;
    const deep = settings.ui_hybrid_deep_optimize === true;
    const budget = deep ? 180 : 60;
    settings.ui_hybrid_cloud_run_budget_seconds = budget;
    settings.optimization_time_limit_seconds = budget;
    settings.backend_deadline_ms = budget * 1000;
    return settings;
  }

  // Hybrid optimization is an explicit executor request. Keep only the
  // canonical four focused modes and the two budget choices at this boundary;
  // aliases from older pages must never leak into the solver request.
  function hybridCloudRunInvocationSettings(options){
    if(!options || typeof options !== "object") return null;
    if(options.fromHybridCaller !== true) return null;
    const requestedMode = normalizeSolveRequestMode(options.mode);
    if(requestedMode === SOLVE_REQUEST_MODES.automatic || requestedMode === SOLVE_REQUEST_MODES.autoMin2) return null;
    const deep = options?.settings?.ui_hybrid_deep_optimize === true || options?.deepOptimize === true;
    return {
      routing_mode: "serverless_only",
      ui_hybrid_executor: "cloud_run",
      ui_hybrid_deep_optimize: deep,
      ui_hybrid_cloud_run_requested: true
    };
  }

  function getData(){
    try{
      if(window.DATA && typeof window.DATA === "object"){
        return window.DATA;
      }
    }catch(_){}
    try{
      if(typeof DATA !== "undefined" && DATA && typeof DATA === "object"){
        return DATA;
      }
    }catch(_){}
    return null;
  }

  function plannerDataReady(){
    // phanmon.js explicitly holds this at false until its remote store and
    // load-time normalization have completed. Tests and older pages that do
    // not publish the marker retain the historical ready-by-default behavior.
    return window.__TKB_PLANNER_DATA_READY !== false;
  }

  let rustApiBaseCache = "";

  async function sleep(ms){
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  async function waitForUiPaint(){
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if(done) return;
        done = true;
        resolve();
      };
      try{
        if(typeof window.requestAnimationFrame === "function"){
          window.requestAnimationFrame(() => window.setTimeout(finish, 0));
        }else{
          window.setTimeout(finish, 0);
        }
      }catch(_){
        window.setTimeout(finish, 0);
      }
      window.setTimeout(finish, 80);
    });
  }

  async function yieldResponsiveUi(){
    return new Promise(resolve => {
      try{ window.setTimeout(resolve, 0); }catch(_){ resolve(); }
    });
  }

  function normalizeSolverPreset(preset){
    const key = String(preset || "").trim().toLowerCase();
    if(key === "quality" || key === "max" || key === "strong" || key === "manh" || key === "mạnh"){
      return "balanced";
    }
    if(SOLVER_PRESETS[key]) return key;
    return "balanced";
  }

  function readSolverPreset(){
    return "balanced";
  }

  function writeSolverPreset(_preset){
    try{ localStorage.removeItem(SOLVER_PRESET_KEY); }catch(_){}
    syncSolverPresetUi("balanced");
    return "balanced";
  }

  function isSpeedFirstSettings(settings){
    const strategy = String(settings?.auto_sort_strategy || "").trim().toLowerCase();
    return strategy.startsWith("fresh_speed_first") || settings?.ui_solver_preset === "fast";
  }

  function fastPresetDeadlineSeconds(expected, data){
    const count = Math.max(0, Number(expected || 0) || 0);
    const fixedPressure = isFixedOffPressureProfile(data);
    if(count >= 1500) return fixedPressure ? 210 : 180;
    if(count >= 1200) return fixedPressure ? 180 : 150;
    if(count >= 900) return fixedPressure ? 150 : 120;
    if(count >= 600) return fixedPressure ? 105 : 90;
    return fixedPressure ? 75 : 60;
  }

  function applySolverPresetToSettings(settings, preset, data, expected){
    const key = normalizeSolverPreset(preset);
    const safeData = data || getData();
    const expectedCount = Math.max(0, Number(expected ?? expectedLessonCount(safeData)) || 0);
    const budgets = constraintAwareFastQualityBudgets(expectedCount, safeData);
    settings.ui_solver_preset = key;

    if(key === "fast"){
      const fixedPressure = isFixedOffPressureProfile(safeData);
      const overall = fastPresetDeadlineSeconds(expectedCount, safeData);
      const nativeFreshMs = Math.max(
        9000,
        Math.round(overall * 1000 * (fixedPressure ? 0.62 : 0.58))
      );
      const nativeCleanupMs = Math.max(
        2500,
        Math.min(
          fixedPressure ? 9000 : 6500,
          Math.round(overall * 1000 * 0.16)
        )
      );
      Object.assign(settings, {
        auto_sort_mode: "fast",
        solver_mode: "auto",
        auto_sort_strategy: "fresh_speed_first",
        overall_time_limit_seconds: overall,
        integrated_time_limit: overall,
        optimization_time_limit_seconds: overall,
        session_time_limit: Math.min(fixedPressure ? 18 : 14, budgets.session),
        period_time_limit: Math.min(fixedPressure ? 22 : 16, budgets.period),
        period_fast_time_limit: Math.min(fixedPressure ? 14 : 10, budgets.periodFast || budgets.period),
        period_retry_time_limit: Math.min(fixedPressure ? 16 : 12, budgets.period),
        progress_estimate_seconds: overall,
        backend_deadline_ms: overall * 1000,
        native_global_deadline_ms: overall * 1000,
        native_deadline_reserve_ms: 750,
        ui_client_timeout_reserve_ms: 3000,
        ui_allow_short_backend_deadline: false,
        ui_allow_best_effort_on_timeout: false,
        ui_accept_incomplete_best_effort: false,
        ui_allow_quality_after_single_pass: false,
        ui_allow_incomplete_retry_after_single_pass: true,
        ui_skip_capacity_precheck: true,
        ui_fast_auto_sort_no_capacity_precheck: true,
        ui_skip_final_existing_teacher_gap_optimize: true,
        allow_zero_one_quality_retry: false,
        allow_teacher_session_deep_retry: false,
        allow_teacher_session_fast_portfolio: false,
        teacher_session_quality_retry_attempts: 0,
        gap_existing_optimize_attempts: 0,
        complete_schedule_seed_retry: true,
        complete_schedule_seed_retry_max_runs: expectedCount >= 1200 ? 2 : 1,
        fast_quality_retry_time_limit_seconds: Math.min(20, Math.max(6, Number(budgets.qualityRetry || 12) || 12)),
        native_fresh_time_limit_ms: nativeFreshMs,
        native_fresh_cleanup_time_limit_ms: nativeCleanupMs,
        deep_session_rescue: false,
        aggressive_fast_mode: false
      });
      if(fixedPressure){
        settings.fresh_randomize = true;
        settings.randomize_search = true;
        settings.fresh_randomize_strategy = settings.fresh_randomize_strategy || DEFAULT_SETTINGS.fresh_randomize_strategy;
        settings.random_seed = makeRandomSeed();
        delete settings.quality_variant_seed;
      }
      return applySolverPresetQualityPolicy(settings, key);
    }

    if(key === "quality"){
      const overall = Math.max(240, budgets.overall + 120);
      const optimization = overall + 120;
      Object.assign(settings, {
        auto_sort_mode: "teacher_session_opt",
        solver_mode: "auto",
        auto_sort_strategy: "fresh_quality_deep",
        overall_time_limit_seconds: overall,
        integrated_time_limit: overall,
        optimization_time_limit_seconds: optimization,
        optimization_session_time_limit: Math.max(180, budgets.session * 4),
        session_time_limit: Math.max(budgets.session, 24),
        period_time_limit: Math.max(budgets.period, 36),
        progress_estimate_seconds: Math.min(360, overall),
        backend_deadline_ms: optimization * 1000,
        ui_allow_short_backend_deadline: false,
        ui_allow_quality_after_single_pass: true,
        ui_allow_best_effort_on_timeout: false,
        ui_accept_incomplete_best_effort: false,
        ui_skip_capacity_precheck: true,
        ui_fast_auto_sort_no_capacity_precheck: true,
        allow_zero_one_quality_retry: true,
        allow_teacher_session_deep_retry: true,
        allow_teacher_session_fast_portfolio: true,
        teacher_session_quality_retry_attempts: 2,
        gap_existing_optimize_attempts: expectedCount >= 900 ? 5 : 3,
        complete_schedule_seed_retry: true,
        complete_schedule_seed_retry_max_runs: expectedCount >= 900 ? 4 : 3,
        fast_quality_retry_time_limit_seconds: Math.max(90, budgets.qualityRetry || 90),
        deep_session_rescue: true,
        allow_quality_debt: false
      });
      return applySolverPresetQualityPolicy(settings, key);
    }

    // balanced (Max): chế độ chất lượng đầy đủ, chấp nhận chờ lâu hơn để ép buổi/tiết trống tốt.
    const overall = Math.max(240, budgets.overall + 120);
    const optimization = overall + 120;
    Object.assign(settings, {
      auto_sort_mode: "teacher_session_opt",
      solver_mode: "auto",
      auto_sort_strategy: "fresh_quality_deep",
      overall_time_limit_seconds: overall,
      integrated_time_limit: overall,
      optimization_time_limit_seconds: optimization,
      optimization_session_time_limit: Math.max(180, budgets.session * 4),
      optimization_period_retry_time_limit: Math.max(45, Math.min(90, budgets.period * 2)),
      session_time_limit: Math.max(budgets.session, 24),
      period_time_limit: Math.max(budgets.period, 36),
      period_fast_time_limit: Math.max(budgets.periodFast || budgets.period, 30),
      period_retry_time_limit: Math.max(budgets.period, 36),
      progress_estimate_seconds: Math.min(360, optimization),
      backend_deadline_ms: optimization * 1000,
      ui_allow_short_backend_deadline: false,
      ui_allow_quality_after_single_pass: true,
      ui_allow_best_effort_on_timeout: false,
      ui_accept_incomplete_best_effort: false,
      ui_skip_capacity_precheck: true,
      ui_fast_auto_sort_no_capacity_precheck: true,
      allow_zero_one_quality_retry: true,
      allow_teacher_session_deep_retry: true,
      allow_teacher_session_fast_portfolio: true,
      teacher_session_quality_retry_attempts: 2,
      gap_existing_optimize_attempts: expectedCount >= 900 ? 5 : 3,
      complete_schedule_seed_retry: true,
      complete_schedule_seed_retry_max_runs: expectedCount >= 900 ? 4 : 3,
      fast_quality_retry_time_limit_seconds: Math.max(90, budgets.qualityRetry || 90),
      deep_session_rescue: true,
      allow_quality_debt: false
    });
    return applySolverPresetQualityPolicy(settings, key);
  }

  function syncSolverPresetUi(preset){
    const key = preset ? normalizeSolverPreset(preset) : readSolverPreset();
    const hidden = document.getElementById("solverPreset");
    if(hidden) hidden.value = key;
    document.querySelectorAll(".solver-preset-btn[data-preset]").forEach((btn) => {
      const active = btn.dataset.preset === key;
      const presetCfg = SOLVER_PRESETS[btn.dataset.preset] || null;
      const label = btn.querySelector(".solver-preset-label");
      const bolts = btn.querySelector(".solver-preset-bolts");
      if(label && presetCfg?.label) label.textContent = presetCfg.label;
      if(bolts && presetCfg?.bolts) bolts.textContent = "⚡".repeat(Math.max(1, Number(presetCfg.bolts || 1) || 1));
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function initSolverPresetUi(){
    const group = document.getElementById("solverPresetGroup");
    if(!group) return;
    syncSolverPresetUi(readSolverPreset());
    if(group.dataset.bound === "1") return;
    group.dataset.bound = "1";
    group.querySelectorAll(".solver-preset-btn[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => writeSolverPreset(btn.dataset.preset || "fast"));
    });
  }

  function initCustomSolveDurationUi(){
    const input = customSolveDurationInput();
    if(!input){
      try{ localStorage.removeItem(CUSTOM_SOLVE_DURATION_KEY); }catch(_){}
      return;
    }
    let stored = null;
    try{ stored = localStorage.getItem(CUSTOM_SOLVE_DURATION_KEY); }catch(_){}
    if(stored == null){
      input.dataset.durationMode = "auto";
      input.value = "";
    }else{
      input.dataset.durationMode = "custom";
      writeCustomSolveDurationSeconds(stored);
    }
    if(input.dataset.durationBound === "1") return;
    input.dataset.durationBound = "1";
    input.addEventListener("input", () => {
      input.dataset.durationMode = String(input.value || "").trim() ? "custom" : "auto";
      syncOptimizationLockState();
    });
    const commit = () => {
      writeCustomSolveDurationSeconds(input.value);
      syncOptimizationLockState();
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
  }

  function dataForBackendPrecheck(data){
    const source = data && typeof data === "object" ? data : {};
    const out = {};
    [
      "lop",
      "giaovien",
      "giaoVien",
      "monhoc",
      "monHoc",
      "mon",
      "pccmMatrix",
      "tkbConstraints",
      "tkbUserOff"
    ].forEach(key => {
      if(Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
    });
    return out;
  }

  async function maybeRunBackendPrecheck(data, preset){
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    bindActiveSolveAbortController(controller);
    window.__TKB_BACKEND_PRECHECK_BLOCK_MESSAGE = "";
    try{
      const apiBase = await rustApiBase();
      if(!apiBase) return true;
      if(isStopRequested()) return false;
      const presetKey = normalizeSolverPreset(preset);
      const expected = expectedLessonCount(data);
      const precheckData = dataForBackendPrecheck(data);
      const precheckBody = JSON.stringify({
        data: precheckData,
        settings: {
          solver_mode: "auto",
          auto_sort_mode: presetKey === "fast" ? "fast" : "teacher_session_opt",
          ui_solver_preset: presetKey,
          expected_scheduled_periods: expected
        }
      });
      window.__TKB_BACKEND_PRECHECK_REQUEST_DEBUG = {
        requestBytes:precheckBody.length,
        dataKeys:Object.keys(precheckData)
      };
      const response = await fetch(`${apiBase}/api/solve-precheck`, {
        method: "POST",
        headers: solverRequestHeaders({"Content-Type": "application/json"}),
        body: precheckBody,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      window.__TKB_BACKEND_PRECHECK_RESULT = {
        status: response.status,
        ok: response.ok && payload?.ok !== false,
        payload
      };
      if(!response.ok || !payload || payload.ok === false){
        window.__TKB_BACKEND_PRECHECK_WARNING = [{
          code: "PRECHECK_UNAVAILABLE",
          message: payload?.error || `HTTP ${response.status}`
        }];
        setStatus("Không hoàn tất được bước kiểm tra dữ liệu; bộ xếp chính sẽ kiểm tra lại.", "warning");
        return true;
      }

      const classes = metricNumber(payload.classes, 0);
      const assignments = metricNumber(payload.assignments, 0);
      const backendExpected = metricNumber(payload.expectedPeriods, 0);
      const skippedUnknownClass = metricNumber(payload.skippedUnknownClass, 0);
      const skippedNoPeriod = metricNumber(payload.skippedNoPeriod, 0);
      const blocking = [];
      if(classes <= 0) blocking.push("chưa có dữ liệu lớp học");
      if(assignments <= 0) blocking.push("chưa có phân công chuyên môn hợp lệ");
      if(backendExpected <= 0) blocking.push("chưa xác định được số tiết cần xếp");
      if(blocking.length){
        const message = `Chưa thể sắp xếp: ${blocking.join("; ")}.`;
        window.__TKB_BACKEND_PRECHECK_BLOCK_MESSAGE = message;
        window.__TKB_BACKEND_PRECHECK_WARNING = blocking.slice();
        setStatus(message, "warning");
        return false;
      }

      const warnings = []
        .concat(Array.isArray(payload.warnings) ? payload.warnings : [])
        .concat(Array.isArray(payload.issues) ? payload.issues : []);
      if(skippedUnknownClass > 0){
        warnings.push({
          code: "UNKNOWN_CLASS_ASSIGNMENTS",
          message: `${skippedUnknownClass} phân công không khớp lớp học.`
        });
      }
      if(skippedNoPeriod > 0){
        warnings.push({
          code: "MISSING_SUBJECT_PERIODS",
          message: `${skippedNoPeriod} phân công chưa có số tiết chuẩn.`
        });
      }
      if(expected > 0 && backendExpected !== expected){
        warnings.push({
          code: "EXPECTED_PERIOD_MISMATCH",
          message: `Giao diện tính ${expected} tiết, bước kiểm tra backend tính ${backendExpected} tiết.`
        });
      }
      window.__TKB_BACKEND_PRECHECK_WARNING = warnings;
      if(isStopRequested()) return false;
      return true;
    }catch(err){
      if(isStopRequested()) return false;
      if(err?.name === "AbortError"){
        window.__TKB_BACKEND_PRECHECK_WARNING = [{
          code: "PRECHECK_TIMEOUT",
          message: "Bước kiểm tra dữ liệu quá thời gian; bộ xếp chính sẽ kiểm tra lại."
        }];
        setStatus("Bước kiểm tra dữ liệu phản hồi chậm; đang chuyển sang bộ xếp chính.", "warning");
        return true;
      }
      window.__TKB_BACKEND_PRECHECK_WARNING = [{
        code: "PRECHECK_ERROR",
        message: String(err && (err.message || err) || err)
      }];
      setStatus("Không hoàn tất được bước kiểm tra dữ liệu; bộ xếp chính sẽ kiểm tra lại.", "warning");
      return true;
    }finally{
      window.clearTimeout(timer);
      clearActiveSolveAbortController(controller);
    }
  }

  async function probeRustApiBase(base, timeoutMs){
    const normalized = String(base || "").replace(/\/+$/, "");
    if(!normalized) return "";
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), Math.max(1500, Number(timeoutMs || 5000)));
    try{
      const response = await fetch(`${normalized}/api/health`, {cache:"no-store", signal:controller.signal});
      const payload = await response.json().catch(() => null);
      if(response.ok && payload && payload.api === "rust") return normalized;
    }catch(_){
    }finally{
      window.clearTimeout(timer);
    }
    return "";
  }

  function isLocalPageOrigin(){
    try{
      const loc = window.location || {};
      const host = String(loc.hostname || "").toLowerCase();
      const protocol = String(loc.protocol || "").toLowerCase();
      if(protocol === "file:") return true;
      return host === "localhost" || host === "127.0.0.1" || host === "::1";
    }catch(_){
      return false;
    }
  }

  let rustApiBaseProbePromise = null;

  async function rustApiBase(){
    if(rustApiBaseCache) return rustApiBaseCache;
    if(rustApiBaseProbePromise) return rustApiBaseProbePromise;
    rustApiBaseProbePromise = (async () => {
      const candidates = [];
      try{
        if(window.location && /^https?:$/i.test(window.location.protocol)){
          const origin = window.location.origin.replace(/\/+$/, "");
          if(origin) candidates.push(origin);
        }
      }catch(_){}
      if(isLocalPageOrigin()) candidates.push("http://127.0.0.1:1010");
      const seen = new Set();
      for(let attempt = 0; attempt < 2; attempt++){
        for(const candidate of candidates){
          if(!candidate || (attempt === 0 && seen.has(candidate))) continue;
          if(attempt === 0) seen.add(candidate);
          const ok = await probeRustApiBase(candidate, attempt === 0 ? 1200 : 1800);
          if(ok){
            rustApiBaseCache = ok;
            return ok;
          }
        }
        if(attempt === 0) await sleep(150);
      }
      return "";
    })();
    try{
      return await rustApiBaseProbePromise;
    }finally{
      rustApiBaseProbePromise = null;
    }
  }

  function classifyBackendJobState(payload, jobId){
    const trackedJobId = String(jobId || "").trim();
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const queue = Array.isArray(payload?.queue) ? payload.queue : [];
    const completedJobs = Array.isArray(payload?.completedJobs) ? payload.completedJobs : [];
    const matchingJob = jobs.find(item => String(item?.jobId || "") === trackedJobId) || null;
    const matchingQueueItem = queue.find(item => String(item?.jobId || "") === trackedJobId) || null;
    const matchingCompletedJob = completedJobs.find(item => String(item?.jobId || "") === trackedJobId) || null;
    const requestedJobId = String(payload?.requestedJobId || "").trim();
    const exactRequestedJob = requestedJobId === trackedJobId;
    const requestedPhase = exactRequestedJob
      ? String(payload?.requestedJobExecutionPhase || "").trim().toLowerCase()
      : "";
    const itemPhase = String(
      matchingJob?.executionPhase
      || matchingQueueItem?.executionPhase
      || ""
    ).trim().toLowerCase();
    const phase = requestedPhase || itemPhase;
    const terminal = !!matchingCompletedJob
      || (exactRequestedJob && payload?.requestedJobResultReady === true)
      || phase === "completed";
    const queued = !terminal && (
      !!matchingQueueItem
      || (exactRequestedJob && payload?.requestedJobQueued === true)
      || phase === "vps_queued"
    );
    const cancelling = !terminal && !queued && (
      matchingJob?.cancelRequested === true
      || matchingQueueItem?.cancelRequested === true
      || phase === "cancelling"
    );
    const running = !terminal && !queued && !cancelling && (
      !!matchingJob
      || (exactRequestedJob && payload?.requestedJobActive === true)
    );
    return {
      kind:terminal ? "terminal" : queued ? "queued" : cancelling ? "cancelling" : running ? "running" : "unknown",
      matchingJob,
      matchingQueueItem,
      matchingCompletedJob,
      exactRequestedJob,
      phase
    };
  }

  async function backendSolverState(jobId){
    if(backendAuthRequired){
      return {
        ok:false,
        kind:"auth_required",
        authRequired:true,
        status:Number(window.__TKB_SOLVER_AUTH_REQUIRED?.status || 401) || 401
      };
    }
    const apiBase = await rustApiBase();
    if(!apiBase) return null;
    const trackedJobId = String(jobId || "").trim();
    const stateUrl = trackedJobId
      ? `${apiBase}/api/solver-state?jobId=${encodeURIComponent(trackedJobId)}`
      : `${apiBase}/api/solver-state`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), BACKEND_STATE_TIMEOUT_MS);
    try{
      const response = await fetch(stateUrl, {
        headers: solverRequestHeaders(),
        cache:"no-store",
        signal:controller.signal
      });
      const payload = await response.json().catch(() => null);
      if(response.status === 401 || response.status === 403){
        suspendBackendResumeForAuth(response.status, payload, "solver-state");
        return {
          ok:false,
          kind:"auth_required",
          authRequired:true,
          status:Number(response.status || 0) || 0
        };
      }
      if(
        trackedJobId
        && response.ok === true
        && payload?.ok === true
        && payload
        && typeof payload === "object"
      ){
        const lifecycle = classifyBackendJobState(payload, trackedJobId);
        const matchingJob = lifecycle.matchingJob;
        const matchingQueueItem = lifecycle.matchingQueueItem;
        recordBackendLiveProgress(
          payload.requestedJobProgress
          || matchingJob?.progress
          || matchingQueueItem?.progress
        );

        // The tab that created a queued job polls this endpoint while waiting
        // for FIFO admission.  Promote it to the canonical VPS clock as soon
        // as the state response exposes the concrete running item.  Previously
        // only the reattach path did this, so the owner tab could remain capped
        // at the 12% pre-admission band while another device advanced normally.
        const stateProgressMetadata = {
          progressBudgetSeconds:matchingJob?.progressBudgetSeconds
            || matchingQueueItem?.progressBudgetSeconds
            || payload.progressBudgetSeconds
            || payload.requestedJobProgressBudgetSeconds,
          progressRunIndex:matchingJob?.progressRunIndex
            || matchingQueueItem?.progressRunIndex
            || payload.progressRunIndex
            || payload.requestedJobProgressRunIndex
        };
        const trackedJobIsLive = lifecycle.kind === "running";
        const reportedStartedAtMs = trackedJobIsLive
          ? (
            matchingJob?.startedAtMs
            || payload.requestedJobStartedAtMs
            || payload.startedAtMs
          )
          : 0;
        if(trackedJobIsLive){
          recordBackendJobStarted(trackedJobId, reportedStartedAtMs, Object.assign(
            {authoritativeRunning:true},
            stateProgressMetadata
          ));
        }else if(lifecycle.kind === "queued"){
          markBackendJobQueued(trackedJobId, stateProgressMetadata);
        }
      }
      return payload;
    }catch(_){
      return null;
    }finally{
      window.clearTimeout(timer);
    }
  }

  function liveBackendJobForScheduleScope(state){
    if(!state || state.ok !== true) return null;
    const scope = backendScheduleScope();
    const items = [
      ...(Array.isArray(state.jobs) ? state.jobs : []),
      ...(Array.isArray(state.queue) ? state.queue : [])
    ];
    return items
      .filter(item => item?.serverOwned === true && item?.cancelRequested !== true)
      .filter(item => {
        const itemScope = String(item?.scheduleScope || "").trim();
        return itemScope && itemScope === scope;
      })
      .sort((left, right) => {
        const leftTime = Number(left?.startedAtMs || left?.createdAtMs || left?.queuedAtMs || 0) || 0;
        const rightTime = Number(right?.startedAtMs || right?.createdAtMs || right?.queuedAtMs || 0) || 0;
        return leftTime - rightTime;
      })[0] || null;
  }

  async function inspectExistingBackendJobForManualSolve(data){
    if(backendAuthRequired) return {kind:"auth_required"};
    if(!data || window.__TKB_SERVER_JOB_RESUME_STARTED === true) return null;
    if(scheduleMutationTombstone()) return null;
    const pending = readPendingBackendJob();
    if(pending?.jobId){
      if(pending.observeOnly === true) return {kind:"observe", job:pending};
      if(
        !pending.scheduleFingerprint
        || durableScheduleFingerprintMatches(pending.scheduleFingerprint, data)
      ) return {kind:"pending", job:pending};
    }
    const state = await backendSolverState("");
    if(backendAuthRequired || state?.authRequired === true) return {kind:"auth_required"};
    if(!state || state.ok !== true) return null;
    const selected = selectDiscoverableBackendJob(state, data, Date.now());
    if(selected.job){
      const job = selected.job;
      if(job.kind !== "completed") forgetSettledBackendJob(job.jobId);
      const pendingJob = writePendingBackendJob(job.jobId, job.scheduleFingerprint, {
        createdAt:job.createdAtMs,
        solverStartedAtMs:job.startedAtMs,
        progressBudgetSeconds:job.progressBudgetSeconds,
        progressRunIndex:job.progressRunIndex,
        optimizationFocus:job.optimizationFocus,
        optimizationGapTarget:job.optimizationGapTarget,
        solveRequestMode:job.solveRequestMode,
        executor:job.executor,
        executionPhase:job.executionPhase,
        serverOwned:job.serverOwned === true,
        discoveredFromOwnerState:true,
        localClickTimeline:false
      });
      if(pendingJob?.jobId) return {kind:"attached", job};
    }
    if(selected.observerJob){
      const job = selected.observerJob;
      forgetSettledBackendJob(job.jobId);
      const pendingJob = writePendingBackendJob(job.jobId, job.scheduleFingerprint, {
        createdAt:job.createdAtMs,
        solverStartedAtMs:job.startedAtMs,
          progressBudgetSeconds:job.progressBudgetSeconds,
          progressRunIndex:job.progressRunIndex,
          optimizationFocus:job.optimizationFocus,
          optimizationGapTarget:job.optimizationGapTarget,
          solveRequestMode:job.solveRequestMode,
          executor:job.executor,
          executionPhase:job.executionPhase,
          serverOwned:job.serverOwned === true,
          discoveredFromOwnerState:true,
        localClickTimeline:false,
        observeOnly:true
      });
      if(pendingJob?.jobId){
        // Keep the authoritative executor/phase on the immediate manual-Play
        // result. The durable pending record deliberately stays compact, but
        // a Local-only trial must still be able to reject an observed VPS job
        // before entering its result-poll loop.
        return {kind:"observe", job:Object.assign({}, job, pendingJob)};
      }
    }
    const live = liveBackendJobForScheduleScope(state);
    if(live){
      return {kind:"busy", job:live};
    }
    return null;
  }

  function detachedServerJobError(kind, status, payload){
    const err = new Error("Lượt xếp vẫn được giữ trên máy chủ và sẽ tự nối lại khi kết nối ổn định.");
    err.kind = kind || "solver_result_detached";
    err.status = Number(status || 0) || 0;
    err.backendUnavailable = false;
    err.keepPendingServerJob = true;
    if(payload && typeof payload === "object") err.payload = payload;
    return err;
  }

  function serverJobAuthRequiredError(status, payload){
    const err = detachedServerJobError("solver_result_auth_required", status, payload);
    err.message = "Phi\u00ean \u0111\u0103ng nh\u1eadp \u0111\u00e3 h\u1ebft h\u1ea1n. L\u01b0\u1ee3t x\u1ebfp v\u1eabn \u0111\u01b0\u1ee3c gi\u1eef tr\u00ean m\u00e1y ch\u1ee7; \u0111\u0103ng nh\u1eadp l\u1ea1i \u0111\u1ec3 nh\u1eadn k\u1ebft qu\u1ea3.";
    err.authRequired = true;
    return err;
  }

  function suspendBackendResumeForAuth(status, payload, source){
    const value = Number(status || 0) || 0;
    if(value !== 401 && value !== 403) return false;
    backendAuthRequired = true;
    backendResumeEpoch += 1;
    cancelPendingBackendResume();
    stopProgressTicker();
    stopStatusDots();
    setAutoSortButtonBusy(false);
    setAutoSortHomeHiddenState(false);
    window.__TKB_SOLVER_AUTH_REQUIRED = {
      status:value,
      source:String(source || "solver"),
      at:Date.now()
    };
    setStatus("Phi\u00ean \u0111\u0103ng nh\u1eadp \u0111\u00e3 h\u1ebft h\u1ea1n. \u0110ang chuy\u1ec3n \u0111\u1ebfn trang \u0111\u0103ng nh\u1eadp...", "warning");
    if(backendAuthFlowStarted) return true;
    backendAuthFlowStarted = true;
    try{
      const handler = window.TKBRuntime?.handleAuthExpired;
      if(typeof handler === "function"){
        Promise.resolve(handler({
          status:value,
          source:String(source || "solver"),
          payload:payload && typeof payload === "object" ? payload : null,
          returnTo:String(window.location?.pathname || "") + String(window.location?.search || "")
        })).catch(() => {});
      }else if(typeof window.location?.replace === "function"){
        window.location.replace("/");
      }
    }catch(_){ }
    return true;
  }

  function clearBackendAuthRequired(){
    backendAuthRequired = false;
    backendAuthFlowStarted = false;
    try{ window.__TKB_SOLVER_AUTH_REQUIRED = null; }catch(_){ }
  }

  function transientServerJobStatus(status){
    const value = Number(status || 0) || 0;
    return value === 401
      || value === 403
      || value === 404
      || value === 408
      || value === 425
      || value === 429
      || value >= 500;
  }

  function terminalServerJobFailure(status, payload){
    const value = Number(status || 0) || 0;
    const kind = String(payload?.kind || "").trim().toLowerCase();
    if(!kind) return false;
    if(payload?.retryable === false) return true;
    if(value < 500) return false;
    return kind.startsWith("solver_worker_")
      || kind.startsWith("reference_solver_")
      || kind.startsWith("native_solver_")
      || kind === "simple_solver_failed";
  }

  function serverPayloadIsVpsOwned(payload){
    if(!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const phase = String(payload.executionPhase || "").trim().toLowerCase();
    const executor = normalizedSolveExecutor(payload.executor, phase);
    const kind = String(payload.kind || payload.error || "").trim().toLowerCase();
    return executor === "vps"
      || phase === "handoff_to_vps"
      || phase.startsWith("vps_")
      || kind === "vps_queued"
      || kind === "vps_running"
      || kind === "solver_vps_queued"
      || kind === "solver_vps_running";
  }

  // A Windows WebAgent trial is deliberately stricter than the ordinary
  // browser resume path.  A pending row created by an older page can describe
  // a native-Agent or VPS solve (or have no executor metadata at all).  Such a
  // row must never enter an observer/poll loop while the trial is active.  New
  // trial requests mark their own durable row with `trialLocal`; that marker
  // is local, non-secret state and is only an admission hint.  The server
  // executor/phase fence remains authoritative for the actual job.
  function trialBackendJobCanResume(payload){
    if(window.__TKB_WINDOWS_WEB_AGENT_TRIAL !== true) return true;
    if(!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const phase = String(payload.executionPhase || payload.phase || "").trim().toLowerCase();
    const executor = normalizedSolveExecutor(
      payload.executor || payload.executionSource,
      phase
    );
    if(
      executor === "vps"
      || phase === "handoff_to_vps"
      || phase.startsWith("vps_")
    ) return false;
    // A future state endpoint may expose the required-executor flags.  Permit
    // only an explicitly Browser-required row; native/unknown rows fail closed.
    const browserRequired = payload.browserAgentRequired === true
      || payload.browser_agent_required === true
      || payload.ui_browser_agent_required === true;
    const nativeRequired = payload.nativeAgentRequired === true
      || payload.native_agent_required === true
      || payload.ui_native_agent_required === true;
    if(nativeRequired) return false;
    if(payload.trialLocal === true) return true;
    return browserRequired && !nativeRequired;
  }

  function discardTrialBackendJob(job){
    const jobId = String(job?.jobId || "").trim();
    if(jobId){
      rememberSettledBackendJob(jobId);
      removePendingBackendJob(jobId);
    }
    return !!jobId;
  }

  function trialRejectExistingBackendJob(job, message){
    if(window.__TKB_WINDOWS_WEB_AGENT_TRIAL !== true) return false;
    discardTrialBackendJob(job);
    releaseAutoSortButtonSoon();
    setStatus(
      message
        || "Chế độ thử nghiệm chỉ nhận lượt Local mới; lượt cũ không được nhận lại.",
      "info"
    );
    return true;
  }

  function localRequiredVpsError(status, payload){
    const error = new Error(
      "Agent đang bật nhưng máy chủ đã trả quyền chạy VPS cho lượt Local; lượt này đã dừng để không trộn hai chế độ."
    );
    error.kind = "web_agent_required";
    error.status = Number(status || 0) || 0;
    const serverPayload = payload && typeof payload === "object" ? payload : null;
    error.payload = serverPayload
      ? Object.assign({}, serverPayload, {
          serverKind:String(serverPayload.kind || serverPayload.error || ""),
          kind:"web_agent_required"
        })
      : {kind:"web_agent_required"};
    error.backendUnavailable = false;
    error.localModeRequired = true;
    error.executionMode = "local";
    return error;
  }

  function serverOwnedResultWaitMs(timeoutMs, metadata){
    const pending = readPendingBackendJob();
    const reportedBudgetSeconds = normalizePendingProgressSeconds(
      metadata?.progressBudgetSeconds
      || pending?.progressBudgetSeconds
    );
    const reportedTimeoutMs = reportedBudgetSeconds > 0
      ? reportedBudgetSeconds * 1000 + CLIENT_TIMEOUT_BACKEND_RESERVE_MS
      : 0;
    const requestedTimeoutMs = Math.max(0, Number(timeoutMs || 0) || 0);
    // The live request already includes its configured response reserve. Do
    // not silently replace a 180s + 30s automatic ceiling with the generic
    // 180s + 90s reconnect reserve. Reload-only observers have no request
    // timeout, so they still use the wider reported-budget fallback.
    const boundedTimeoutMs = Math.max(
      1_000,
      Math.min(
        SERVER_SOLVER_ACTIVE_WAIT_MAX_MS,
        requestedTimeoutMs || reportedTimeoutMs || SERVER_SOLVER_ACTIVE_WAIT_MAX_MS
      )
    );
    const startedAtMs = epochMillisFromBackend(
      metadata?.startedAtMs
      || pending?.solverStartedAtMs
    );
    const elapsedMs = startedAtMs > 0
      ? Math.max(0, Date.now() - startedAtMs)
      : 0;
    return Math.max(1_000, boundedTimeoutMs - elapsedMs);
  }

  async function waitForServerOwnedSolverResult(
    apiBase,
    jobId,
    runId,
    maxMs,
    retryAfterMs,
    signal,
    options
  ){
    const waitOptions = options && typeof options === "object" ? options : {};
    const localModeRequired = waitOptions.localModeRequired === true;
    let vpsReclaimAttempted = waitOptions.vpsReclaimAttempted === true;
    const pending = readPendingBackendJob();
    const pendingAgeMs = pending?.jobId === String(jobId || "") && pending.createdAt > 0
      ? Math.max(0, Date.now() - pending.createdAt)
      : 0;
    const requestedWaitMs = Math.max(1_000, Number(maxMs || 0) || DEFAULT_SOLVER_QUEUE_TIMEOUT_MS);
    const boundedWaitMs = Math.min(
      SERVER_SOLVER_ACTIVE_WAIT_MAX_MS,
      requestedWaitMs,
      Math.max(1_000, SERVER_SOLVER_JOB_RETENTION_MAX_AGE_MS - pendingAgeMs)
    );
    const waitStartedAtMs = Date.now();
    const retentionDeadline = waitStartedAtMs + Math.max(
      1_000,
      SERVER_SOLVER_JOB_RETENTION_MAX_AGE_MS - pendingAgeMs
    );
    const hardWaitDeadline = Math.min(
      waitStartedAtMs + SERVER_SOLVER_ACTIVE_WAIT_MAX_MS,
      retentionDeadline
    );
    let deadline = waitStartedAtMs + Math.min(
      SERVER_SOLVER_ACTIVE_WAIT_MAX_MS,
      boundedWaitMs
    );
    let observedExecutionStartedAtMs = epochMillisFromBackend(
      pending?.solverStartedAtMs
    );
    const observeExecutionEpoch = payload => {
      const reportedExecutionStartedAtMs = epochMillisFromBackend(
        payload?.startedAtMs
      );
      if(reportedExecutionStartedAtMs <= 0) return false;
      if(observedExecutionStartedAtMs <= 0){
        observedExecutionStartedAtMs = reportedExecutionStartedAtMs;
        return false;
      }
      if(reportedExecutionStartedAtMs <= observedExecutionStartedAtMs) return false;
      // Agent -> VPS rescue creates a new execution epoch on the same job.
      // The first authoritative state can be queued or running depending on
      // VPS capacity, so both phases must rebase the client wait window.
      observedExecutionStartedAtMs = reportedExecutionStartedAtMs;
      const rescuedWaitMs = serverOwnedResultWaitMs(0, payload);
      deadline = Math.min(
        hardWaitDeadline,
        Math.max(deadline, Date.now() + rescuedWaitMs)
      );
      return true;
    };
    let pollMs = Math.max(250, Math.min(2_000, Number(retryAfterMs || 700) || 700));
    let networkFailures = 0;
    while(Date.now() < deadline){
      throwIfStopRequested(runId);
      let response = null;
      const pollController = new AbortController();
      const forwardAbort = () => pollController.abort();
      if(signal?.aborted){
        pollController.abort();
      }else if(signal && typeof signal.addEventListener === "function"){
        signal.addEventListener("abort", forwardAbort, {once:true});
      }
      const pollTimeoutMs = Math.max(
        500,
        Math.min(BACKEND_RESULT_POLL_TIMEOUT_MS, Math.max(500, deadline - Date.now()))
      );
      const pollTimer = window.setTimeout(() => pollController.abort(), pollTimeoutMs);
      try{
        response = await fetch(
          `${apiBase}/api/solve-result?jobId=${encodeURIComponent(jobId)}`,
          {
            headers:solverRequestHeaders(),
            cache:"no-store",
            signal:pollController.signal
          }
        );
      }catch(err){
        if(err?.name === "AbortError"){
          if(signal?.aborted || isStopRequested() || !isCurrentSolveRun(runId)){
            throw makeUserCancelError();
          }
          if(!pollController.signal.aborted){
            throw err;
          }
          networkFailures += 1;
          if(networkFailures >= 5){
            throw detachedServerJobError("solver_result_poll_timeout", 408);
          }
          await sleep(Math.min(2_000, pollMs * Math.max(1, networkFailures)));
          continue;
        }
        networkFailures += 1;
        await sleep(Math.min(2_000, pollMs * Math.max(1, networkFailures)));
        continue;
      }finally{
        window.clearTimeout(pollTimer);
        if(signal && typeof signal.removeEventListener === "function"){
          signal.removeEventListener("abort", forwardAbort);
        }
      }
      const responseStatus = Number(response.status || 0) || 0;
      if(responseStatus !== 202){
        let transportPayload = {};
        try{ transportPayload = await response.clone().json(); }catch(_){ }
        if(transportPayload?.bestEffortStopRequested === true){
          setBestEffortStopPending(jobId, true);
        }
        if(localModeRequired && serverPayloadIsVpsOwned(transportPayload)){
          await cancelBackendSolver(jobId).catch(() => null);
          throw localRequiredVpsError(responseStatus, transportPayload);
        }
        recordBackendLiveProgress(transportPayload?.progress);
        const transportKind = String(transportPayload?.kind || transportPayload?.error || "").toLowerCase();
        if(transientServerJobStatus(responseStatus) && !terminalServerJobFailure(responseStatus, transportPayload)){
          networkFailures += 1;
          if(responseStatus === 401 || responseStatus === 403){
            suspendBackendResumeForAuth(responseStatus, transportPayload, "solve-result");
            throw serverJobAuthRequiredError(responseStatus, transportPayload);
          }
          if(
            responseStatus === 404
            && transportKind === "solver_job_not_found"
            && networkFailures >= SERVER_SOLVER_JOB_UNKNOWN_RETRIES
          ){
            throw detachedServerJobError("solver_result_unknown", responseStatus, transportPayload);
          }
          if(networkFailures >= 5){
            throw detachedServerJobError("solver_result_transport_unavailable", responseStatus, transportPayload);
          }
          await sleep(Math.min(2_000, pollMs * Math.max(1, networkFailures)));
          continue;
        }
        clearCurrentSolveExecutorState(jobId);
        try{ parsedSolverResponsePayloads.set(response, transportPayload); }catch(_){ }
        return response;
      }
      networkFailures = 0;
      let pending = {};
      try{ pending = await response.clone().json(); }catch(_){ }
      if(pending?.bestEffortStopRequested === true){
        setBestEffortStopPending(jobId, true);
      }
      recordBackendLiveProgress(pending?.progress);
      const executorState = publishCurrentSolveExecutorState(pending, jobId);
      const executionPhase = String(
        pending?.executionPhase || executorState?.executionPhase || ""
      ).trim().toLowerCase();
      if(localModeRequired && serverPayloadIsVpsOwned(pending)){
        await cancelBackendSolver(jobId).catch(() => null);
        throw localRequiredVpsError(responseStatus, pending);
      }
      if(executionPhase.startsWith("agent_")){
        // A later lease loss creates a new VPS epoch. Permit exactly one local
        // reclaim attempt for that transition without hammering hello on every
        // result poll.
        vpsReclaimAttempted = false;
      }else if(
        !vpsReclaimAttempted
        && (executionPhase === "vps_queued" || executionPhase === "vps_running")
        && typeof waitOptions.onVpsFallback === "function"
      ){
        vpsReclaimAttempted = true;
        await Promise.resolve(waitOptions.onVpsFallback(pending)).catch(() => false);
      }
      const kind = String(pending?.kind || pending?.error || "").toLowerCase();
      if(!["solver_started", "solver_running", "solver_queued", "solver_cancelling"].includes(kind)){
        clearCurrentSolveExecutorState(jobId);
        try{ parsedSolverResponsePayloads.set(response, pending); }catch(_){ }
        return response;
      }
      if(kind === "solver_started" || kind === "solver_running"){
        recordBackendJobStarted(jobId, pending?.startedAtMs, {
          authoritativeRunning:true,
          progressBudgetSeconds:pending?.progressBudgetSeconds,
          progressRunIndex:pending?.progressRunIndex
        });
        observeExecutionEpoch(pending);
      }else if(kind === "solver_queued"){
        observeExecutionEpoch(pending);
        markBackendJobQueued(jobId, {
          progressBudgetSeconds:pending?.progressBudgetSeconds,
          progressRunIndex:pending?.progressRunIndex
        });
      }
      pollMs = Math.max(250, Math.min(2_000, Number(pending?.retryAfterMs || pollMs) || pollMs));
      setActiveSolveRunningStatus();
      await sleep(pollMs);
    }
    const err = new Error("Lượt xếp vẫn đang chạy trên máy chủ. Hệ thống sẽ tự nối lại để nhận kết quả.");
    err.kind = "solver_result_wait_timeout";
    err.backendUnavailable = false;
    err.keepPendingServerJob = true;
    throw err;
  }

  async function observeBackendJob(jobMetadata){
    const metadata = jobMetadata && typeof jobMetadata === "object" ? jobMetadata : {};
    const jobId = String(metadata.jobId || readPendingBackendJob()?.jobId || "").trim();
    if(!jobId) return false;
    if(window.__TKB_WINDOWS_WEB_AGENT_TRIAL === true){
      // This path is reserved for cross-device/server observation. A Browser
      // trial never observes another executor; doing so would poll a VPS
      // result without the normal Local-required fence.
      trialRejectExistingBackendJob(metadata);
      return false;
    }
    let pending = readPendingBackendJob();
    if(pending?.jobId !== jobId || pending.observeOnly !== true){
      pending = writePendingBackendJob(
        jobId,
        metadata.scheduleFingerprint || pending?.scheduleFingerprint,
        {
          createdAt:metadata.createdAtMs || metadata.createdAt || pending?.createdAt,
          solverStartedAtMs:metadata.startedAtMs || metadata.solverStartedAtMs || pending?.solverStartedAtMs,
          progressBudgetSeconds:metadata.progressBudgetSeconds || pending?.progressBudgetSeconds,
          progressRunIndex:metadata.progressRunIndex || pending?.progressRunIndex,
          discoveredFromOwnerState:true,
          localClickTimeline:false,
          observeOnly:true
        }
      );
    }
    if(!pending?.jobId) return false;

    const observerRunId = `observer:${jobId}:${Date.now()}`;
    const controller = new AbortController();
    window.__TKB_BACKEND_JOB_OBSERVER_ONLY = true;
    window.__TKB_RUST_SOLVER_RUNNING = true;
    window.__TKB_SOLVE_UI_BUSY = true;
    window.__TKB_SOLVE_BACKEND_POSTED = false;
    window.__TKB_ACTIVE_SOLVE_RUN_ID = observerRunId;
    window.__AUTO_SORT_STOP_REQUESTED = false;
    setActiveBackendJobId(jobId, pending.scheduleFingerprint);
    bindActiveSolveAbortController(controller);
    setAutoSortButtonBusy(true);
    hideAutoSortProgressDom();
    callMaybe("hideAutoSortProgress");
    setStatus("\u0110ang s\u1eafp x\u1ebfp...", "info");
    startInstantProgressTicker();
    try{
      const apiBase = await rustApiBase();
      if(!apiBase) throw detachedServerJobError("solver_observer_backend_unavailable", 0);
      const response = await waitForServerOwnedSolverResult(
        apiBase,
        jobId,
        observerRunId,
        serverOwnedResultWaitMs(0, metadata),
        700,
        controller.signal
      );
      const status = Number(response?.status || 0) || 0;
      clearActiveBackendJobId(jobId);
      if(status >= 200 && status < 300 && status !== 202){
        finishProgress("100%", "ok");
        setStatus(
          "L\u01b0\u1ee3t x\u1ebfp tr\u00ean thi\u1ebft b\u1ecb kh\u00e1c \u0111\u00e3 ho\u00e0n t\u1ea5t. T\u1ea3i l\u1ea1i \u0111\u1ec3 nh\u1eadn d\u1eef li\u1ec7u m\u1edbi nh\u1ea5t.",
          "ok"
        );
      }else{
        finishProgress("L\u1ed7i", "error");
        setStatus("L\u01b0\u1ee3t x\u1ebfp tr\u00ean thi\u1ebft b\u1ecb kh\u00e1c \u0111\u00e3 k\u1ebft th\u00fac nh\u01b0ng kh\u00f4ng c\u00f3 k\u1ebft qu\u1ea3 h\u1ee3p l\u1ec7.", "warning");
      }
      return true;
    }catch(err){
      if(err?.kind === "user_cancelled") return false;
      if(err?.keepPendingServerJob === true){
        // The observer still owns the same canonical VPS job. Keep transport
        // recovery internal so the running label cannot flash between states.
        setActiveSolveRunningStatus();
        schedulePendingBackendResume(0, SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
        return false;
      }
      clearActiveBackendJobId(jobId);
      finishProgress("L\u1ed7i", "error");
      setStatus("Kh\u00f4ng theo d\u00f5i \u0111\u01b0\u1ee3c l\u01b0\u1ee3t x\u1ebfp tr\u00ean thi\u1ebft b\u1ecb kh\u00e1c.", "warning");
      return false;
    }finally{
      stopProgressTicker();
      clearActiveSolveAbortController(controller);
      if(window.__TKB_ACTIVE_SOLVE_RUN_ID === observerRunId){
        window.__TKB_ACTIVE_SOLVE_RUN_ID = "";
      }
      activeBackendJobId = "";
      window.__TKB_ACTIVE_BACKEND_JOB_ID = "";
      window.__TKB_RUST_SOLVER_RUNNING = false;
      window.__TKB_SOLVE_UI_BUSY = false;
      window.__TKB_BACKEND_JOB_OBSERVER_ONLY = false;
      releaseAutoSortButtonSoon();
    }
  }

  function reattachTerminalPayloadFromResponse(response, data){
    let rawPayload = null;
    try{
      if(parsedSolverResponsePayloads.has(response)){
        rawPayload = parsedSolverResponsePayloads.get(response);
        parsedSolverResponsePayloads.delete(response);
      }
    }catch(_){ }
    if(!rawPayload || typeof rawPayload !== "object"){
      // `waitForServerOwnedSolverResult` has already consumed every 202
      // response.  The remaining response must be terminal, so reading it is
      // safe and does not create another request or mutate the schedule.
      return Promise.resolve(response?.json?.().catch(() => ({}))).then(payload => {
        const normalized = normalizePayloadForUiConstraints(data, payload);
        return {payload:normalized, status:Number(response?.status || 0) || 0};
      });
    }
    return Promise.resolve({
      payload:normalizePayloadForUiConstraints(data, rawPayload),
      status:Number(response?.status || 0) || 0
    });
  }

  function reattachTerminalPayloadError(message, kind, payload){
    const err = new Error(String(message || "Kết quả từ máy chủ không hợp lệ."));
    err.kind = kind || "solver_resume_terminal_invalid";
    err.backendUnavailable = false;
    err.payload = payload || null;
    err.keepPendingServerJob = false;
    return err;
  }

  async function reattachExistingServerJobPollOnly(jobMetadata){
    const metadata = jobMetadata && typeof jobMetadata === "object" ? jobMetadata : {};
    const jobId = String(metadata.jobId || "").trim();
    const foregroundAgentHandoff = metadata.foregroundAgentHandoff === true;
    const data = getData();
    if(!jobId || !data) return false;
    if(backendAuthRequired) return false;
    if(automaticBackendResumeSuppressed()) return false;

    const scheduleFingerprint = String(
      metadata.scheduleFingerprint || durableScheduleFingerprint(data) || ""
    ).trim();
    if(
      metadata.scheduleFingerprint
      && scheduleFingerprint
      && !durableScheduleFingerprintMatches(scheduleFingerprint, data)
    ){
      const mismatch = reattachTerminalPayloadError(
        "Lịch hiện tại đã thay đổi; kết quả cũ trên máy chủ không được áp dụng.",
        "solver_resume_schedule_changed"
      );
      // A result for a different timetable is never replayed. It is safe to
      // consume this browser's pending row, while the server result remains
      // available to the owner that started it.
      removePendingBackendJob(jobId);
      reportSkippedDiscoveredBackendJob({jobId, kind:"running"});
      setStatus(mismatch.message, "warning");
      return false;
    }

    beginServerJobReattachLease(jobId);
    const persisted = writePendingBackendJob(jobId, scheduleFingerprint, {
      createdAt:metadata.createdAtMs || metadata.createdAt,
      solverStartedAtMs:metadata.startedAtMs || metadata.solverStartedAtMs,
      progressBudgetSeconds:metadata.progressBudgetSeconds,
      progressRunIndex:metadata.progressRunIndex,
      optimizationFocus:metadata.optimizationFocus,
      optimizationGapTarget:metadata.optimizationGapTarget,
      solveRequestMode:metadata.solveRequestMode,
      discoveredFromOwnerState:metadata.discoveredFromOwnerState === true,
      strictBrowserAutomatic:metadata.strictBrowserAutomatic === true,
      localClickTimeline:false,
      observeOnly:false,
      allowSettledReplay:true
    });
    // A browser may have lost localStorage while the API still owns the job.
    // Keep polling from the immutable metadata even if persistence failed.
    const effectiveMetadata = persisted || Object.assign({}, metadata, {
      jobId,
      scheduleFingerprint
    });
    const runId = `reattach:${jobId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    const applyGuardFingerprint = durableScheduleFingerprint(data);
    window.__TKB_SERVER_JOB_RESUME_STARTED = true;
    window.__TKB_RUST_SOLVER_RUNNING = true;
    window.__TKB_SOLVE_UI_BUSY = true;
    window.__TKB_SOLVE_BACKEND_POSTED = false;
    window.__TKB_SOLVE_QUEUE_WAITING = false;
    window.__TKB_BACKEND_JOB_OBSERVER_ONLY = false;
    window.__TKB_ACTIVE_SOLVE_RUN_ID = runId;
    window.__AUTO_SORT_STOP_REQUESTED = false;
    setActiveBackendJobId(jobId, scheduleFingerprint);
    bindActiveSolveAbortController(controller);
    setAutoSortButtonBusy(true);
    setStatus("\u0110ang s\u1eafp x\u1ebfp...", "info");
    startInstantProgressTicker();
    publishE2EState("running", null, {runId, pollOnlyReattach:true, jobId});

    try{
      const apiBase = await rustApiBase();
      if(!apiBase) throw detachedServerJobError("solver_resume_backend_unavailable", 0);
      let browserWasmReactivated = false;
      const allowBrowserWasmReactivation = localAgentRoleAllowed()
        && !isMobileBrowserAgentNavigator(window.navigator);
      const reactivateKnownBrowserAgent = async () => {
        if(
          !allowBrowserWasmReactivation
          ||
          controller.signal.aborted
          || typeof window.TKBBrowserWasmExecutor?.activate !== "function"
        ) return false;
        browserWasmReactivated = await window.TKBBrowserWasmExecutor.activate({
          apiBase,
          jobId,
          resumeKnownJob:true,
          preferNativeAgent:true,
          signal:controller.signal
        }).catch(() => false);
        return browserWasmReactivated;
      };
      if(
        allowBrowserWasmReactivation
        &&
        foregroundAgentHandoff
        && !controller.signal.aborted
        && typeof window.TKBBrowserWasmExecutor?.activate === "function"
      ){
        // A desktop reload may reclaim the immutable canonical job. Mobile is
        // deliberately poll-only after any reload/reattach: reclaiming a VPS
        // rescue used to cold-start exact WASM again, repeat the OS tab kill,
        // and consume the only bounded rescue epoch without a terminal TKB.
        await reactivateKnownBrowserAgent();
        try{
          window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign(
            {},
            window.__TKB_RUST_LAST_REQUEST_DEBUG || {},
            {browserWasmForegroundReactivated:browserWasmReactivated}
          );
        }catch(_){ }
      }
      const response = await waitForServerOwnedSolverResult(
        apiBase,
        jobId,
        runId,
        serverOwnedResultWaitMs(0, effectiveMetadata),
        700,
        controller.signal,
        {
          vpsReclaimAttempted:browserWasmReactivated || !allowBrowserWasmReactivation,
          onVpsFallback:allowBrowserWasmReactivation
            ? reactivateKnownBrowserAgent
            : undefined
        }
      );
      const terminal = await reattachTerminalPayloadFromResponse(response, data);
      const status = terminal.status;
      const payload = terminal.payload;
      if(status < 200 || status >= 300 || status === 202){
        throw reattachTerminalPayloadError(
          payload?.error || `Máy chủ trả về HTTP ${status || 0}.`,
          "solver_resume_terminal_http_error",
          payload
        );
      }
      const completion = payloadCompletion(payload);
      const metricsShapeOk = completion.expected > 0
        && completion.scheduled >= 0
        && completion.unassigned >= 0
        && completion.violations >= 0;
      const usable = payloadHasUsableSchedule(payload);
      const acceptablePartial = payloadAcceptableWithUnassigned(payload)
        || payloadAcceptableForUiCleanup(payload);
      if(
        !payload
        || payload.ok === false
        || !metricsShapeOk
        || (!usable && !acceptablePartial)
        || (completion.hardOk === false && !acceptablePartial)
      ){
        throw reattachTerminalPayloadError(
          "Kết quả máy chủ chưa đủ điều kiện để áp dụng; lịch hiện tại được giữ nguyên.",
          "solver_resume_terminal_invalid",
          payload
        );
      }
      const persistedContractSettings = settingsForPersistedOptimizationContract(
        effectiveMetadata,
        payload
      );
      const strictReattachSettings = effectiveMetadata.strictBrowserAutomatic === true
        ? {
            optimization_focus:"automatic",
            ui_unified_solve_kind:"refine_complete",
            ui_use_existing_complete_incumbent:true,
            ui_existing_incumbent_revalidated:true,
            require_complete_schedule:true,
            ui_agent_execution_policy:"web_agent_required",
            ui_execution_mode:"local",
            ui_browser_agent_required:true
          }
        : null;
      const strictReattachMessage = strictReattachSettings
        ? strictBrowserAutomaticQualityMessage(payload, strictReattachSettings)
        : "";
      if(strictReattachMessage){
        const qualityError = reattachTerminalPayloadError(
          strictReattachMessage,
          "browser_agent_quality_unmet",
          payload
        );
        qualityError.localModeRequired = true;
        throw qualityError;
      }
      if(
        applyGuardFingerprint
        && !durableScheduleFingerprintMatches(applyGuardFingerprint, data)
      ){
        throw reattachTerminalPayloadError(
          "Lịch hiện tại đã thay đổi trong lúc nối lại; kết quả cũ không được áp dụng.",
          "solver_stale_result",
          payload
        );
      }

      // applyPayload performs the full UI-constraint validation. The snapshot
      // makes that operation transactional if a late constraint or malformed
      // lesson is rejected after the payload has started applying.
      const snapshot = snapshotScheduleData(data);
      const retainedCompleteState = completeScheduleStateForExistingOptimize(data);
      let incumbentPayload = snapshot?.tkbSolverResult || null;
      if(retainedCompleteState){
        incumbentPayload = visibleCompleteIncumbentQualityPayload(
          data,
          incumbentPayload
        );
        if(snapshot && incumbentPayload){
          snapshot.tkbSolverResult = clonePlain(incumbentPayload);
          incumbentPayload = snapshot.tkbSolverResult;
        }
      }
      const retainedQualityGuard = retainedCompleteState
        ? incumbentQualityGuardState(
            incumbentPayload,
            snapshot,
            data,
            Object.assign(
              {ui_keep_better_existing_on_resort:true},
              persistedContractSettings
            )
          )
        : null;
      if(
        retainedQualityGuard?.complete === true
        && (
          !strictReattachSettings
          || !strictBrowserAutomaticQualityMessage(
            incumbentPayload,
            strictReattachSettings
          )
        )
        && shouldKeepIncumbentForTeacherQuality(
          payload,
          incumbentPayload,
          retainedQualityGuard,
          strictReattachSettings || persistedContractSettings
        )
      ){
        inheritRefinementRound(incumbentPayload, payload);
        restoreScheduleData(data, snapshot);
        const retainedIncumbent = data.tkbSolverResult || incumbentPayload;
        clearActiveBackendJobId(jobId, {force:true});
        endServerJobReattachLease(jobId);
        syncVisibleCompletionMetrics(retainedIncumbent, retainedIncumbent);
        window.__TKB_SOLVER_LAST_PAYLOAD = retainedIncumbent;
        window.__TKB_SOLVER_LAST_RESULT = retainedIncumbent;
        finishProgress("100%", "ok");
        window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = SOLVE_COMPLETE_MESSAGE;
        setStatus(SOLVE_COMPLETE_MESSAGE, "ok");
        schedulePostSolveUi(retainedIncumbent, retainedIncumbent);
        publishE2EState("done", retainedIncumbent, {
          message:SOLVE_COMPLETE_MESSAGE,
          pollOnlyReattach:true,
          jobId,
          keptIncumbent:true,
          rejectedWorseQuality:true
        });
        return retainedIncumbent;
      }
      let applied;
      try{
        applied = await applyPayload(
          payload,
          strictReattachSettings || persistedContractSettings
        );
      }catch(err){
        restoreScheduleData(data, snapshot);
        throw err;
      }
      clearActiveBackendJobId(jobId, {force:true});
      endServerJobReattachLease(jobId);
      window.__TKB_SOLVER_LAST_PAYLOAD = payload;
      window.__TKB_SOLVER_LAST_RESULT = applied;
      const quality = completionQualityStatus(payload, data);
      finishProgress("100%", "ok");
      window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = SOLVE_COMPLETE_MESSAGE;
      setStatus(SOLVE_COMPLETE_MESSAGE, "ok");
      schedulePostSolveUi(payload, applied);
      publishE2EState("done", payload, {
        message:SOLVE_COMPLETE_MESSAGE,
        pollOnlyReattach:true,
        jobId,
        qualityTargetMet:quality.targetMet
      });
      return applied || payload;
    }catch(err){
      const keep = err?.keepPendingServerJob === true
        || (err?.name === "AbortError" && !isStopRequested())
        || err?.kind === "solver_result_wait_timeout"
        || err?.kind === "solver_result_transport_unavailable"
        || err?.kind === "solver_result_unknown"
        || err?.kind === "solver_result_auth_required";
      if(keep){
        if(err?.kind === "solver_result_auth_required" || err?.authRequired === true){
          // Authentication is not a transport outage. Keep the canonical id,
          // stop polling, and let the central login flow resume it after the
          // same owner authenticates again.
          suspendBackendResumeForAuth(err?.status, err?.payload, "solver-reattach");
        }else{
          // Reconnect metadata is diagnostic only; visibly this remains the
          // same running job until Stop or a terminal server result arrives.
          setStatus("\u0110ang s\u1eafp x\u1ebfp...", "info");
          schedulePendingBackendResume(0, SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
        }
      }else{
        // A terminal quality/deadline response can legitimately contain no
        // replacement candidate even though the incumbent timetable is still
        // complete and hard-valid. Treat that as a successful retained
        // schedule, just like the foreground solve path, instead of showing
        // a red error after an iPhone reload/background resume.
        const friendly = friendlySolveError(err);
        const retainedState = completeScheduleStateForExistingOptimize(data);
        const terminalKind = String(err?.kind || err?.payload?.kind || "")
          .trim()
          .toLowerCase();
        const localModeTerminalFailure = err?.localModeRequired === true
          || terminalKind === "web_agent_required"
          || terminalKind === "local_agent_unavailable"
          || terminalKind.startsWith("browser_agent_");
        const retainedCompleteTerminal = !!retainedState && !localModeTerminalFailure;
        if(retainedCompleteTerminal){
          const retainedPayload = visibleCompleteIncumbentQualityPayload(
            data,
            data?.tkbSolverResult || window.__TKB_SOLVER_LAST_PAYLOAD || null
          );
          clearActiveBackendJobId(jobId, {force:true});
          endServerJobReattachLease(jobId);
          window.__TKB_SOLVER_LAST_PAYLOAD = retainedPayload;
          window.__TKB_SOLVER_LAST_RESULT = retainedPayload;
          window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = SOLVE_COMPLETE_MESSAGE;
          finishProgress("100%", "ok");
          setStatus(SOLVE_COMPLETE_MESSAGE, "ok");
          publishE2EState("done", retainedPayload, {
            message:SOLVE_COMPLETE_MESSAGE,
            pollOnlyReattach:true,
            jobId,
            keptIncumbent:true,
            terminalQualityFailure:true,
            terminalKind:String(err?.kind || err?.payload?.kind || ""),
            terminalMessage:String(err?.message || ""),
            terminalStatusLevel:String(friendly?.statusLevel || friendly?.level || "")
          });
          return retainedPayload || data?.tkbSolverResult || null;
        }
        clearActiveBackendJobId(jobId, {force:true});
        const rawError = String(err && (err.message || err) || err);
        const level = friendly?.level || "error";
        const statusLevel = friendly?.statusLevel || level;
        const statusMessage = friendly?.statusMessage
          || (friendly?.title ? `${friendly.title}: ${friendly.message}` : friendly?.message)
          || "Không theo dõi được lượt xếp trên máy chủ.";
        window.__TKB_SOLVER_LAST_ERROR_RAW = rawError;
        window.__TKB_SOLVER_LAST_ERROR = friendly?.message || statusMessage;
        if(err?.payload && typeof err.payload === "object"){
          window.__TKB_SOLVER_LAST_ERROR_PAYLOAD = err.payload;
        }
        finishProgress(level === "warning" ? (friendly?.progressLabel || "Chưa đủ") : "Lỗi", level);
        setStatus(statusMessage, statusLevel);
        publishE2EState(level === "warning" ? "incomplete" : "error", err?.payload || null, {
          title:friendly?.title || "",
          message:friendly?.message || statusMessage,
          rawError,
          pollOnlyReattach:true,
          jobId
        });
      }
      return keep;
    }finally{
      stopProgressTicker();
      clearActiveSolveAbortController(controller);
      if(window.__TKB_ACTIVE_SOLVE_RUN_ID === runId) window.__TKB_ACTIVE_SOLVE_RUN_ID = "";
      window.__TKB_RUST_SOLVER_RUNNING = false;
      window.__TKB_SOLVE_UI_BUSY = false;
      window.__TKB_SOLVE_BACKEND_POSTED = false;
      window.__TKB_SOLVE_QUEUE_WAITING = false;
      window.__TKB_SERVER_JOB_RESUME_STARTED = false;
      endServerJobReattachLease(jobId);
      releaseAutoSortButtonSoon();
    }
  }

  async function cancelBackendSolver(jobIdOverride, options){
    const jobId = String(
      jobIdOverride
      || activeBackendJobId
      || window.__TKB_ACTIVE_BACKEND_JOB_ID
      || window.__TKB_ACTIVE_SOLVE_RUN_ID
      || ""
    ).trim();
    if(!jobId) return {ok:false, cancelRequested:false, jobId:""};
    const apiBase = await rustApiBase();
    if(!apiBase) return null;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3000);
    try{
      const response = await fetch(`${apiBase}/api/solve-cancel`, {
        method: "POST",
        headers: solverRequestHeaders({"Content-Type": "application/json"}),
        body: JSON.stringify({
          solve_run_id:jobId,
          retainBest:options?.retainBest === true
        }),
        cache: "no-store",
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      if(payload?.cancelRequested === true && options?.retainBest !== true){
        clearActiveBackendJobId(jobId);
      }
      return payload;
    }catch(_){
      return null;
    }finally{
      window.clearTimeout(timer);
    }
  }

  function backendSolverAtCapacity(state){
    if(!state || typeof state !== "object") return false;
    if(state.busy === true) return true;
    const max = Number(state.maxConcurrent || 0) || 0;
    const active = Number(state.activeJobs || 0) || 0;
    if(max > 0) return active >= max;
    return state.busy === true;
  }

  async function waitForBackendSolverIdle(maxMs){
    const deadline = Date.now() + Math.max(500, Number(maxMs || 6000) || 6000);
    let lastState = null;
    while(Date.now() < deadline){
      lastState = await backendSolverState();
      if(lastState && !backendSolverAtCapacity(lastState) && lastState.busy !== true) return true;
      if(lastState && Number(lastState.activeJobs || 0) === 0) return true;
      await sleep(350);
    }
    return false;
  }

  async function cancelBusyBackendAndWait(maxMs){
    const before = await backendSolverState();
    if(before && before.busy !== true) return true;
    await cancelBackendSolver();
    return waitForBackendSolverIdle(maxMs || 8000);
  }

  async function ensureBackendReadyForNewSolve(){
    const before = await backendSolverState();
    if(!before || before.busy !== true) return true;
    setStatus("Đang dừng lượt xếp cũ...", "info");
    await yieldResponsiveUi();
    await cancelBackendSolver();
    const ready = await waitForBackendSolverIdle(3500);
    if(ready){
      setStatus("Đang sắp xếp...", "info");
      return true;
    }
    finishProgress("!", "error");
    setStatus("Lượt xếp cũ vẫn đang dừng. Bạn bấm lại sau vài giây nhé.", "warning");
    return false;
  }

  function isStopRequested(){
    return window.__AUTO_SORT_STOP_REQUESTED === true;
  }

  function makeUserCancelError(){
    const err = new Error("Đã dừng sắp xếp theo yêu cầu.");
    err.kind = "user_cancelled";
    err.backendUnavailable = false;
    return err;
  }

  function throwIfStopRequested(runId){
    if(runId && !isCurrentSolveRun(runId)) throw makeUserCancelError();
    if(isStopRequested()) throw makeUserCancelError();
  }

  function rethrowCancelledSolve(err, runId){
    if(err?.kind === "user_cancelled") throw err;
    throwIfStopRequested(runId);
  }

  function rethrowAuthRequiredSolve(err){
    if(err?.kind === "solver_result_auth_required" || err?.authRequired === true) throw err;
  }

  async function waitForBackendSolverTurn(
    runId,
    maxMs,
    retryAfterMs,
    backendJobIdOverride,
    requiredWorkersOverride
  ){
    const deadline = Date.now() + Math.max(5000, Number(maxMs || 0) || 1_800_000);
    const pollMs = Math.max(250, Math.min(2000, Number(retryAfterMs || 700) || 700));
    const backendJobId = String(backendJobIdOverride || runId || "");
    let unavailablePolls = 0;
    window.__TKB_SOLVE_QUEUE_WAITING = true;
    try{
      while(Date.now() < deadline){
        throwIfStopRequested(runId);
        const state = await backendSolverState(backendJobId);
        if(!state){
          unavailablePolls += 1;
          if(unavailablePolls >= 3) return true;
          await sleep(pollMs);
          continue;
        }
        unavailablePolls = 0;
        const queue = Array.isArray(state?.queue) ? state.queue : [];
        const queuedIndex = queue.findIndex(item => String(item?.jobId || "") === backendJobId);
        const queuedItem = queuedIndex >= 0 ? queue[queuedIndex] : null;
        const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
        const requestedJobActive = state?.requestedJobActive === true
          || jobs.some(item => String(item?.jobId || "") === backendJobId);
        if(requestedJobActive){
          setStatus("\u0110ang s\u1eafp x\u1ebfp...", "info");
          await sleep(pollMs);
          continue;
        }
        if(state && queuedIndex < 0) return true;
        const queuedPosition = queuedIndex >= 0
          ? Math.max(1, Number(queuedItem?.position || queuedIndex + 1) || queuedIndex + 1)
          : 0;
        const active = Number(state?.activeJobs || 0) || 0;
        const max = Number(state?.maxConcurrent || 20) || 20;
        const minWorkers = Math.max(1, Number(state?.minWorkersPerJob || 1) || 1);
        const availableWorkers = Math.max(0, Number(state?.workerTokensAvailable || 0) || 0);
        const ticketWorkers = Math.max(
          0,
          Number(
            requiredWorkersOverride
            || queuedItem?.desiredWorkers
            || queuedItem?.requiredWorkers
            || 0
          ) || 0
        );
        if(queuedPosition === 1 && active < max){
          if(ticketWorkers > 0 && availableWorkers >= ticketWorkers) return true;
          if(ticketWorkers <= 0 && availableWorkers >= minWorkers){
            // Older servers do not expose the ticket demand. Keep legacy
            // compatibility without spinning POST requests in a tight loop.
            await sleep(pollMs);
            return true;
          }
        }
        setStatus("Đang sắp xếp...", "info");
        if(typeof window.setAutoSortProgress === "function"){
          const pct = Math.max(3, Math.min(12, progressState?.lastPercent || 3));
          window.setAutoSortProgress(pct, "Đang chờ máy chủ");
        }
        await sleep(pollMs);
      }
      return false;
    }finally{
      window.__TKB_SOLVE_QUEUE_WAITING = false;
    }
  }

  function bindActiveSolveAbortController(controller){
    activeSolveAbortController = controller || null;
  }

  function clearActiveSolveAbortController(controller){
    if(activeSolveAbortController === controller) activeSolveAbortController = null;
  }

  function legacyBackendJobStorageScope(){
    try{
      const context = window.__TKB_SCHOOL_CONTEXT || {};
      const explicit = String(context.storeKey || context.sid || context.schoolId || context.id || "").trim();
      if(explicit) return explicit;
      const params = new URLSearchParams(String(window.location?.search || ""));
      const schoolId = String(params.get("sid") || params.get("id") || params.get("schoolId") || "").trim();
      if(schoolId) return schoolId;
      return String(window.location?.pathname || "tkb").trim() || "tkb";
    }catch(_){
      return "tkb";
    }
  }

  function backendJobOwnerScope(){
    try{
      const session = window.TKBAuth && typeof window.TKBAuth.getSession === "function"
        ? window.TKBAuth.getSession()
        : null;
      const identity = String(
        session?.userId
        || session?.loginId
        || session?.id
        || "anonymous"
      ).trim().toLocaleLowerCase("vi");
      return identity || "anonymous";
    }catch(_){
      return "anonymous";
    }
  }

  function backendJobStorageScope(){
    return `${legacyBackendJobStorageScope()}::${backendJobOwnerScope()}`;
  }

  function backendScheduleScope(){
    try{
      const raw = String(legacyBackendJobStorageScope() || "tkb").trim();
      const safe = raw.replace(/[^A-Za-z0-9:._\/-]/g, "_").slice(0, 128);
      return safe || "tkb";
    }catch(_){
      return "tkb";
    }
  }

  function ownerBackendJobDiscoveryAllowed(){
    // Anonymous mode is the normal public TKB deployment. Discovery is safe
    // because the selector below requires both the same schedule scope and the
    // same durable fingerprint before a result can be attached.
    if(backendJobOwnerScope() !== "anonymous") return true;
    // Do not let a not-yet-hydrated anonymous page inspect an authenticated
    // owner's job. Once the session is available the owner-scoped retry will
    // take over; an actually anonymous schedule remains discoverable.
    try{
      const map = JSON.parse(localStorage.getItem(SERVER_SOLVER_JOB_STORAGE_KEY) || "{}");
      const legacyScope = legacyBackendJobStorageScope();
      const hasHydratingOwnerJob = Object.keys(map || {}).some(key => {
        const separator = `${legacyScope}::`;
        return key.startsWith(separator)
          && key.slice(separator.length)
          && key.slice(separator.length) !== "anonymous";
      });
      if(hasHydratingOwnerJob) return false;
    }catch(_){ }
    return true;
  }

  function persistentAutoResumeSuppressionForScope(){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_AUTO_RESUME_SUPPRESSED_KEY) || "{}");
      const entry = root && typeof root === "object" ? root[backendJobStorageScope()] : null;
      return entry === true || Number(entry?.suppressedAt || entry || 0) > 0;
    }catch(_){
      return false;
    }
  }

  function rememberPersistentAutoResumeSuppression(){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_AUTO_RESUME_SUPPRESSED_KEY) || "{}");
      const safeRoot = root && typeof root === "object" ? root : {};
      safeRoot[backendJobStorageScope()] = {suppressedAt:Date.now()};
      localStorage.setItem(SERVER_SOLVER_AUTO_RESUME_SUPPRESSED_KEY, JSON.stringify(safeRoot));
      return true;
    }catch(_){
      return false;
    }
  }

  function clearPersistentAutoResumeSuppression(){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_AUTO_RESUME_SUPPRESSED_KEY) || "{}");
      if(!root || typeof root !== "object") return false;
      const scope = backendJobStorageScope();
      const existed = Object.prototype.hasOwnProperty.call(root, scope);
      if(!existed) return false;
      delete root[scope];
      if(Object.keys(root).length > 0){
        localStorage.setItem(SERVER_SOLVER_AUTO_RESUME_SUPPRESSED_KEY, JSON.stringify(root));
      }else{
        localStorage.removeItem(SERVER_SOLVER_AUTO_RESUME_SUPPRESSED_KEY);
      }
      return true;
    }catch(_){
      return false;
    }
  }

  function scheduleMutationTombstone(){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_SCHEDULE_TOMBSTONE_KEY) || "{}");
      const entry = root && typeof root === "object" ? root[backendJobStorageScope()] : null;
      return entry && typeof entry === "object" && Number(entry.revision || 0) > 0
        ? entry
        : null;
    }catch(_){ return null; }
  }

  function markScheduleMutationTombstone(){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_SCHEDULE_TOMBSTONE_KEY) || "{}");
      const safeRoot = root && typeof root === "object" ? root : {};
      const revision = Date.now();
      safeRoot[backendJobStorageScope()] = {revision, markedAt:revision};
      localStorage.setItem(SERVER_SOLVER_SCHEDULE_TOMBSTONE_KEY, JSON.stringify(safeRoot));
      return revision;
    }catch(_){ return 0; }
  }

  function clearScheduleMutationTombstone(){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_SCHEDULE_TOMBSTONE_KEY) || "{}");
      if(!root || typeof root !== "object") return false;
      const scope = backendJobStorageScope();
      if(!Object.prototype.hasOwnProperty.call(root, scope)) return false;
      delete root[scope];
      if(Object.keys(root).length) localStorage.setItem(SERVER_SOLVER_SCHEDULE_TOMBSTONE_KEY, JSON.stringify(root));
      else localStorage.removeItem(SERVER_SOLVER_SCHEDULE_TOMBSTONE_KEY);
      return true;
    }catch(_){ return false; }
  }

  function readServerCancellationIntent(){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_CANCEL_INTENT_KEY) || "{}");
      const entry = root && typeof root === "object" ? root[backendJobStorageScope()] : null;
      if(!entry || typeof entry !== "object") return null;
      const jobIds = Array.from(new Set(
        (Array.isArray(entry.jobIds) ? entry.jobIds : [])
          .map(value => String(value || "").trim())
          .filter(Boolean)
      ));
      return jobIds.length ? {jobIds, markedAt:Number(entry.markedAt || 0) || 0} : null;
    }catch(_){ return null; }
  }

  function rememberServerCancellationIntent(jobIds){
    const ids = Array.from(new Set(
      (Array.isArray(jobIds) ? jobIds : [jobIds])
        .map(value => String(value || "").trim())
        .filter(Boolean)
    ));
    if(!ids.length) return false;
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_CANCEL_INTENT_KEY) || "{}");
      const safeRoot = root && typeof root === "object" ? root : {};
      const scope = backendJobStorageScope();
      const existing = readServerCancellationIntent();
      safeRoot[scope] = {
        markedAt:Date.now(),
        jobIds:Array.from(new Set([...(existing?.jobIds || []), ...ids]))
      };
      localStorage.setItem(SERVER_SOLVER_CANCEL_INTENT_KEY, JSON.stringify(safeRoot));
      return true;
    }catch(_){ return false; }
  }

  function clearServerCancellationIntent(jobIds){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_CANCEL_INTENT_KEY) || "{}");
      if(!root || typeof root !== "object") return false;
      const scope = backendJobStorageScope();
      const entry = root[scope];
      if(!entry || typeof entry !== "object") return false;
      const remove = new Set(
        (Array.isArray(jobIds) ? jobIds : [jobIds])
          .map(value => String(value || "").trim())
          .filter(Boolean)
      );
      const remaining = (Array.isArray(entry.jobIds) ? entry.jobIds : [])
        .map(value => String(value || "").trim())
        .filter(value => value && !remove.has(value));
      if(remaining.length) root[scope] = Object.assign({}, entry, {jobIds:Array.from(new Set(remaining))});
      else delete root[scope];
      if(Object.keys(root).length) localStorage.setItem(SERVER_SOLVER_CANCEL_INTENT_KEY, JSON.stringify(root));
      else localStorage.removeItem(SERVER_SOLVER_CANCEL_INTENT_KEY);
      return true;
    }catch(_){ return false; }
  }

  async function retryServerCancellationIntent(){
    const intent = readServerCancellationIntent();
    if(!intent?.jobIds?.length) return false;
    const settled = [];
    for(const jobId of intent.jobIds){
      const response = await cancelBackendSolver(jobId);
      if(response?.cancelRequested === true || response?.ok === true) settled.push(jobId);
    }
    if(settled.length) clearServerCancellationIntent(settled);
    return settled.length > 0;
  }

  function settledBackendJobsForScope(){
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_JOB_SETTLED_KEY) || "{}");
      const safeRoot = root && typeof root === "object" ? root : {};
      const scope = backendJobStorageScope();
      const scoped = safeRoot[scope] && typeof safeRoot[scope] === "object" ? safeRoot[scope] : {};
      const now = Date.now();
      const active = Object.fromEntries(
        Object.entries(scoped)
          .map(([jobId, timestamp]) => [String(jobId || "").trim(), Math.max(0, Number(timestamp || 0) || 0)])
          .filter(([jobId, timestamp]) => jobId && timestamp > 0 && now - timestamp <= SERVER_SOLVER_JOB_RETENTION_MAX_AGE_MS)
          .sort((left, right) => right[1] - left[1])
          .slice(0, 48)
      );
      if(JSON.stringify(active) !== JSON.stringify(scoped)){
        safeRoot[scope] = active;
        localStorage.setItem(SERVER_SOLVER_JOB_SETTLED_KEY, JSON.stringify(safeRoot));
      }
      return active;
    }catch(_){
      return {};
    }
  }

  function rememberSettledBackendJob(jobId){
    const value = String(jobId || "").trim();
    if(!value) return false;
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_JOB_SETTLED_KEY) || "{}");
      const safeRoot = root && typeof root === "object" ? root : {};
      const scope = backendJobStorageScope();
      const scoped = settledBackendJobsForScope();
      scoped[value] = Date.now();
      safeRoot[scope] = Object.fromEntries(
        Object.entries(scoped)
          .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))
          .slice(0, 48)
      );
      localStorage.setItem(SERVER_SOLVER_JOB_SETTLED_KEY, JSON.stringify(safeRoot));
      return true;
    }catch(_){
      return false;
    }
  }

  function isSettledBackendJob(jobId){
    const value = String(jobId || "").trim();
    return !!value && Number(settledBackendJobsForScope()[value] || 0) > 0;
  }

  function forgetSettledBackendJob(jobId){
    const value = String(jobId || "").trim();
    if(!value) return false;
    try{
      const root = JSON.parse(localStorage.getItem(SERVER_SOLVER_JOB_SETTLED_KEY) || "{}");
      if(!root || typeof root !== "object") return false;
      const scope = backendJobStorageScope();
      const scoped = root[scope] && typeof root[scope] === "object"
        ? root[scope]
        : null;
      if(!scoped || !Object.prototype.hasOwnProperty.call(scoped, value)) return false;
      delete scoped[value];
      if(Object.keys(scoped).length > 0){
        root[scope] = scoped;
      }else{
        delete root[scope];
      }
      if(Object.keys(root).length > 0){
        localStorage.setItem(SERVER_SOLVER_JOB_SETTLED_KEY, JSON.stringify(root));
      }else{
        localStorage.removeItem(SERVER_SOLVER_JOB_SETTLED_KEY);
      }
      return true;
    }catch(_){
      return false;
    }
  }

  function epochMillisFromBackend(value){
    let timestamp = Number(value);
    if(!Number.isFinite(timestamp) || timestamp <= 0) return 0;
    // Accept older servers that reported Unix seconds, plus defensive support
    // for micro/nanosecond epochs. The current API contract is milliseconds.
    if(timestamp < 100_000_000_000) timestamp *= 1_000;
    else if(timestamp >= 100_000_000_000_000_000) timestamp /= 1_000_000;
    else if(timestamp >= 100_000_000_000_000) timestamp /= 1_000;
    return Math.round(timestamp);
  }

  function normalizeBackendStartedAtMs(value, createdAtMs, nowMs){
    const now = Math.max(0, Number(nowMs || Date.now()) || Date.now());
    const timestamp = epochMillisFromBackend(value);
    if(timestamp <= 0) return 0;
    const createdAt = epochMillisFromBackend(createdAtMs);
    const clockSkewToleranceMs = 60_000;
    const earliest = Math.max(
      now - SERVER_SOLVER_JOB_MAX_AGE_MS,
      createdAt > 0 ? createdAt - clockSkewToleranceMs : 0
    );
    if(timestamp < earliest || timestamp > now + clockSkewToleranceMs) return 0;
    return Math.min(now, timestamp);
  }

  function normalizePendingProgressPercent(value){
    const percent = Number(value);
    if(!Number.isFinite(percent) || percent <= 0) return 0;
    return Math.max(1, Math.min(99, Math.round(percent)));
  }

  function normalizePendingProgressSeconds(value){
    const seconds = Number(value);
    if(!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.max(1, Math.min(MAX_CUSTOM_SOLVE_DURATION_SECONDS, seconds));
  }

  function normalizePendingProgressRunIndex(value){
    const runIndex = Number(value);
    if(!Number.isFinite(runIndex) || runIndex <= 0) return 1;
    return Math.max(1, Math.min(999, Math.round(runIndex)));
  }

  function readPendingBackendJob(){
    try{
      const map = JSON.parse(localStorage.getItem(SERVER_SOLVER_JOB_STORAGE_KEY) || "{}");
      const scope = backendJobStorageScope();
      const legacyScope = legacyBackendJobStorageScope();
      let item = map && typeof map === "object" ? map[scope] : null;
      if(!item && map && typeof map === "object" && legacyScope !== scope && map[legacyScope]){
        item = map[legacyScope];
        map[scope] = item;
        delete map[legacyScope];
        localStorage.setItem(SERVER_SOLVER_JOB_STORAGE_KEY, JSON.stringify(map));
      }
      const jobId = String(item?.jobId || "").trim();
      const createdAt = Math.max(0, Number(item?.createdAt || 0) || 0);
      if(!jobId) return null;
      if(createdAt > 0 && Date.now() - createdAt > SERVER_SOLVER_JOB_RETENTION_MAX_AGE_MS){
        rememberSettledBackendJob(jobId);
        delete map[scope];
        localStorage.setItem(SERVER_SOLVER_JOB_STORAGE_KEY, JSON.stringify(map));
        return null;
      }
      const rawStartedAt = Math.max(0, Number(item?.solverStartedAtMs || 0) || 0);
      const solverStartedAtMs = normalizeBackendStartedAtMs(rawStartedAt, createdAt);
      const rawUiStartedAt = Math.max(0, Number(item?.uiStartedAtMs || 0) || 0);
      const uiStartedAtMs = normalizeBackendStartedAtMs(rawUiStartedAt, 0);
      const rawLastPercent = Number(item?.lastPercent || 0) || 0;
      const lastPercent = normalizePendingProgressPercent(rawLastPercent);
      const rawEstimateSeconds = Number(item?.progressEstimateSeconds || 0) || 0;
      const progressEstimateSeconds = normalizePendingProgressSeconds(rawEstimateSeconds);
      const rawBudgetSeconds = Number(item?.progressBudgetSeconds || 0) || 0;
      const progressBudgetSeconds = normalizePendingProgressSeconds(rawBudgetSeconds);
      const rawRunIndex = Number(item?.progressRunIndex || 0) || 0;
      const progressRunIndex = normalizePendingProgressRunIndex(rawRunIndex);
      if(
        (rawStartedAt > 0 && solverStartedAtMs !== rawStartedAt)
        || (rawUiStartedAt > 0 && uiStartedAtMs !== rawUiStartedAt)
        || (rawLastPercent > 0 && lastPercent !== rawLastPercent)
        || (rawEstimateSeconds > 0 && progressEstimateSeconds !== rawEstimateSeconds)
        || (rawBudgetSeconds > 0 && progressBudgetSeconds !== rawBudgetSeconds)
        || (rawRunIndex > 0 && progressRunIndex !== rawRunIndex)
      ){
        item.solverStartedAtMs = solverStartedAtMs;
        item.uiStartedAtMs = uiStartedAtMs;
        item.lastPercent = lastPercent;
        item.progressEstimateSeconds = progressEstimateSeconds;
        item.progressBudgetSeconds = progressBudgetSeconds;
        item.progressRunIndex = progressRunIndex;
        map[scope] = item;
        localStorage.setItem(SERVER_SOLVER_JOB_STORAGE_KEY, JSON.stringify(map));
      }
      return {
        jobId,
        createdAt,
        scheduleFingerprint:String(item?.scheduleFingerprint || ""),
        qualityDebtFreshRebuild:item?.qualityDebtFreshRebuild === true,
        discoveredFromOwnerState:item?.discoveredFromOwnerState === true,
        observeOnly:item?.observeOnly === true,
        trialLocal:item?.trialLocal === true,
        strictBrowserAutomatic:item?.strictBrowserAutomatic === true,
        localClickTimeline:item?.localClickTimeline === true,
        solverStartedAtMs,
        uiStartedAtMs,
        lastPercent,
        progressEstimateSeconds,
        progressBudgetSeconds,
        progressRunIndex,
        optimizationFocus:String(item?.optimizationFocus || ""),
        optimizationGapTarget:String(item?.optimizationGapTarget || ""),
        solveRequestMode:String(item?.solveRequestMode || ""),
        executor:String(item?.executor || "").trim().toLowerCase(),
        executionPhase:String(item?.executionPhase || "").trim().toLowerCase(),
        serverOwned:item?.serverOwned === true
      };
    }catch(_){
      return null;
    }
  }

  function writePendingBackendJob(jobId, scheduleFingerprint, metadata){
    const value = String(jobId || "").trim();
    if(!value) return null;
    // A late callback from a stopped/consumed request must never recreate the
    // durable pending entry that Stop just removed. This also protects another
    // open tab sharing the same localStorage ledger.
    // A poll-only foreground reattach may arrive just after an older page has
    // consumed the local pending row while its terminal callback was still
    // unwinding.  The server state probe is the authority in that narrow case;
    // allow that caller to recreate the row under its immutable reattach lease.
    if(isSettledBackendJob(value) && metadata?.allowSettledReplay !== true) return null;
    try{
      const map = JSON.parse(localStorage.getItem(SERVER_SOLVER_JOB_STORAGE_KEY) || "{}");
      const safeMap = map && typeof map === "object" ? map : {};
      const scope = backendJobStorageScope();
      const legacyScope = legacyBackendJobStorageScope();
      const existing = safeMap[scope];
      const sameJob = existing?.jobId === value;
      const requestedCreatedAt = Math.max(0, Number(metadata?.createdAt || 0) || 0);
      const createdAt = sameJob && Number(existing?.createdAt || 0) > 0
        ? Number(existing.createdAt)
        : (requestedCreatedAt || Date.now());
      const requestedStartedAt = Math.max(0, Number(metadata?.solverStartedAtMs || 0) || 0)
        || (sameJob ? Math.max(0, Number(existing?.solverStartedAtMs || 0) || 0) : 0);
      const solverStartedAtMs = metadata?.clearSolverStartedAt === true
        ? 0
        : normalizeBackendStartedAtMs(requestedStartedAt, createdAt);
      const uiStartedAtMs = [
        metadata?.uiStartedAtMs,
        sameJob ? existing?.uiStartedAtMs : 0,
        progressState?.uiStartedAt || progressState?.startedAt,
        solverStartedAtMs,
        createdAt
      ].map(candidate => normalizeBackendStartedAtMs(candidate, 0)).find(candidate => candidate > 0) || 0;
      const lastPercent = normalizePendingProgressPercent(
        metadata?.lastPercent
        || (sameJob ? existing?.lastPercent : 0)
        || progressState?.lastPercent
      );
      const progressEstimateSeconds = normalizePendingProgressSeconds(
        metadata?.progressEstimateSeconds
        || (sameJob ? existing?.progressEstimateSeconds : 0)
        || progressState?.estimatedSeconds
      );
      const progressBudgetSeconds = normalizePendingProgressSeconds(
        metadata?.progressBudgetSeconds
        || (sameJob ? existing?.progressBudgetSeconds : 0)
        || progressState?.progressBudgetSeconds
      );
      const progressRunIndex = normalizePendingProgressRunIndex(
        metadata?.progressRunIndex
        || (sameJob ? existing?.progressRunIndex : 0)
        || progressState?.runIndex
        || 1
      );
      const localClickTimeline = metadata?.localClickTimeline === false
        ? false
        : (
            metadata?.localClickTimeline === true
            || (sameJob && existing?.localClickTimeline === true)
            || progressState?.localClickTimeline === true
          );
      const observeOnly = metadata?.observeOnly === false
        ? false
        : (
            metadata?.observeOnly === true
          || (sameJob && existing?.observeOnly === true)
          );
      const trialLocal = metadata?.trialLocal === true
        || (sameJob && existing?.trialLocal === true);
      const strictBrowserAutomatic = metadata?.strictBrowserAutomatic === true
        || (sameJob && existing?.strictBrowserAutomatic === true);
      const qualityDebtFreshRebuild = metadata?.qualityDebtFreshRebuild === true
        || (sameJob && existing?.qualityDebtFreshRebuild === true);
      const optimizationFocus = String(
        metadata?.optimizationFocus
        || (sameJob ? existing?.optimizationFocus : "")
        || progressState?.settings?.optimization_focus
        || ""
      ).trim().toLowerCase().replace(/[\s-]+/g, "_");
      const rawSolveRequestMode = String(
        metadata?.solveRequestMode
        || (sameJob ? existing?.solveRequestMode : "")
        || progressState?.settings?.ui_requested_solve_mode
        || ""
      ).trim();
      const solveRequestMode = rawSolveRequestMode
        ? normalizeSolveRequestMode(rawSolveRequestMode)
        : "";
      const optimizationGapTarget = normalizedGapOptimizationTarget({
        optimization_gap_target:
          metadata?.optimizationGapTarget
          || (sameJob ? existing?.optimizationGapTarget : "")
          || progressState?.settings?.optimization_gap_target
          || gapOptimizationTargetForSolveRequestMode(solveRequestMode)
      });
      const executor = String(
        metadata?.executor
        || (sameJob ? existing?.executor : "")
        || ""
      ).trim().toLowerCase();
      const executionPhase = String(
        metadata?.executionPhase
        || (sameJob ? existing?.executionPhase : "")
        || ""
      ).trim().toLowerCase();
      const serverOwned = metadata?.serverOwned === true
        || (sameJob && existing?.serverOwned === true);
      safeMap[scope] = {
        jobId:value,
        createdAt,
        scheduleFingerprint:String(
          scheduleFingerprint
          || (sameJob ? existing?.scheduleFingerprint : "")
          || ""
        ),
        qualityDebtFreshRebuild,
        discoveredFromOwnerState:metadata?.discoveredFromOwnerState === true
          || (sameJob && existing?.discoveredFromOwnerState === true),
        observeOnly,
        trialLocal,
        strictBrowserAutomatic,
        localClickTimeline,
        solverStartedAtMs,
        uiStartedAtMs,
        lastPercent,
        progressEstimateSeconds,
        progressBudgetSeconds,
        progressRunIndex,
        optimizationFocus,
        optimizationGapTarget,
        solveRequestMode,
        executor,
        executionPhase,
        serverOwned
      };
      if(
        legacyScope !== scope
        && String(safeMap[legacyScope]?.jobId || "") === value
      ){
        delete safeMap[legacyScope];
      }
      localStorage.setItem(SERVER_SOLVER_JOB_STORAGE_KEY, JSON.stringify(safeMap));
      setAutoSortHomeHiddenState(true);
      return safeMap[scope];
    }catch(_){
      return null;
    }
  }

  function resetPendingBackendJobForReplay(jobId){
    const value = String(jobId || "").trim();
    if(!value) return null;
    try{
      const map = JSON.parse(localStorage.getItem(SERVER_SOLVER_JOB_STORAGE_KEY) || "{}");
      if(!map || typeof map !== "object") return null;
      const scope = backendJobStorageScope();
      const legacyScope = legacyBackendJobStorageScope();
      const item = map[scope] || map[legacyScope];
      if(String(item?.jobId || "") !== value) return null;
      const now = Date.now();
      const localClickTimeline = item?.localClickTimeline === true;
      const preservedUiStartedAt = normalizeBackendStartedAtMs(item?.uiStartedAtMs, 0, now) || now;
      const preservedLastPercent = normalizePendingProgressPercent(item?.lastPercent);
      map[scope] = Object.assign({}, item, {
        createdAt:now,
        solverStartedAtMs:0,
        uiStartedAtMs:localClickTimeline ? preservedUiStartedAt : now,
        lastPercent:localClickTimeline ? preservedLastPercent : 0
      });
      if(legacyScope !== scope) delete map[legacyScope];
      localStorage.setItem(SERVER_SOLVER_JOB_STORAGE_KEY, JSON.stringify(map));
      if(progressState){
        progressState.backendQueued = false;
        progressState.serverStartedAtMs = 0;
        progressState.startedAt = now;
        progressState.localClickTimeline = localClickTimeline;
        progressState.uiStartedAt = localClickTimeline
          ? (Number(progressState.uiStartedAt || 0) || preservedUiStartedAt)
          : now;
        progressState.lastPercent = localClickTimeline
          ? Math.max(preservedLastPercent, Number(progressState.lastPercent || 0) || 0)
          : Math.min(4, Math.max(0, Number(progressState.lastPercent || 0) || 0));
      }
      return readPendingBackendJob();
    }catch(_){
      return null;
    }
  }

  function discoveredBackendJobTime(item, keys){
    for(const key of keys || []){
      const timestamp = epochMillisFromBackend(item?.[key]);
      if(timestamp > 0) return timestamp;
    }
    return 0;
  }

  function discoverableBackendJobCandidate(item, kind, data, nowMs, currentScope, matchesCurrentSchedule){
    const jobId = String(item?.jobId || "").trim();
    const scheduleFingerprint = String(item?.scheduleFingerprint || "").trim();
    if(!jobId || !scheduleFingerprint) return null;
    // A completed result that this browser already consumed stays ignored.
    // Running/queued server state is stronger than a stale settled bit that an
    // older tab may have written while a newer Agent/VPS executor still owns
    // the canonical job. Explicit Stop remains authoritative through the
    // persistent auto-resume suppression checked before discovery.
    if(isSettledBackendJob(jobId) && kind === "completed") return null;
    if(item?.serverOwned !== true) return null;
    const itemScope = String(item?.scheduleScope || "").trim();
    if(itemScope && itemScope !== String(currentScope || "").trim()) return null;
    const executionPhase = String(item?.executionPhase || "").trim().toLowerCase();
    if(
      (kind === "running" || kind === "queued")
      && (
        item?.cancelRequested === true
        || executionPhase === "cancelling"
        || executionPhase === "completed"
      )
    ) return null;
    const now = Math.max(0, Number(nowMs || Date.now()) || Date.now());
    const createdAtMs = discoveredBackendJobTime(item, ["createdAtMs", "queuedAtMs", "startedAtMs"]);
    const startedAtMs = kind === "running"
      ? discoveredBackendJobTime(item, ["startedAtMs"])
      : 0;
    const completedAtMs = kind === "completed"
      ? discoveredBackendJobTime(item, ["completedAtMs"])
      : 0;
    if(
      kind === "completed"
      && (
        completedAtMs <= 0
        || completedAtMs > now + 60_000
        || now - completedAtMs > SERVER_SOLVER_RESULT_MAX_AGE_MS
      )
    ) return null;
    const reportedSolveRequestMode = String(
      item?.progress?.solveRequestMode
      || item?.progress?.solve_request_mode
      || ""
    ).trim();
    const solveRequestMode = reportedSolveRequestMode
      ? normalizeSolveRequestMode(reportedSolveRequestMode)
      : "";
    return {
      jobId,
      kind,
      scheduleFingerprint,
      createdAtMs,
      startedAtMs,
      completedAtMs,
      scheduleScope:itemScope,
      executor:String(item?.executor || "").trim().toLowerCase(),
      executionPhase,
      serverOwned:item?.serverOwned === true,
      progressBudgetSeconds:normalizePendingProgressSeconds(item?.progressBudgetSeconds),
      progressRunIndex:Number(item?.progressRunIndex || 0) > 0
        ? normalizePendingProgressRunIndex(item.progressRunIndex)
        : 0,
      optimizationFocus:solveRequestMode
        ? optimizationFocusForSolveRequestMode(solveRequestMode)
        : "",
      optimizationGapTarget:gapOptimizationTargetForSolveRequestMode(solveRequestMode),
      solveRequestMode,
      position:Math.max(0, Number(item?.position || 0) || 0),
      matchesCurrentSchedule:typeof matchesCurrentSchedule === "function"
        ? matchesCurrentSchedule(scheduleFingerprint)
        : durableScheduleFingerprintMatches(scheduleFingerprint, data)
    };
  }

  function selectDiscoverableBackendJob(state, data, nowMs){
    if(!state || state.ok !== true || !data) return {job:null, observerJob:null, staleJob:null};
    const now = Math.max(0, Number(nowMs || Date.now()) || Date.now());
    const currentScope = backendScheduleScope();
    const matchesCurrentSchedule = durableScheduleFingerprintMatcher(data);
    const queuedJobIds = new Set(
      (Array.isArray(state.queue) ? state.queue : [])
        .map(item => String(item?.jobId || "").trim())
        .filter(Boolean)
    );
    const completedJobIds = new Set(
      (Array.isArray(state.completedJobs) ? state.completedJobs : [])
        .map(item => String(item?.jobId || "").trim())
        .filter(Boolean)
    );
    const running = (Array.isArray(state.jobs) ? state.jobs : [])
      .map(item => discoverableBackendJobCandidate(item, "running", data, now, currentScope, matchesCurrentSchedule))
      .filter(Boolean)
      .filter(item => !queuedJobIds.has(item.jobId) && !completedJobIds.has(item.jobId))
      .sort((left, right) => (
        right.startedAtMs - left.startedAtMs
        || right.createdAtMs - left.createdAtMs
        || left.jobId.localeCompare(right.jobId)
      ));
    const queued = (Array.isArray(state.queue) ? state.queue : [])
      .map(item => discoverableBackendJobCandidate(item, "queued", data, now, currentScope, matchesCurrentSchedule))
      .filter(Boolean)
      .filter(item => !completedJobIds.has(item.jobId))
      .sort((left, right) => (
        (left.position || Number.MAX_SAFE_INTEGER) - (right.position || Number.MAX_SAFE_INTEGER)
        || right.createdAtMs - left.createdAtMs
        || left.jobId.localeCompare(right.jobId)
      ));
    const completed = (Array.isArray(state.completedJobs) ? state.completedJobs : [])
      .map(item => discoverableBackendJobCandidate(item, "completed", data, now, currentScope, matchesCurrentSchedule))
      .filter(Boolean)
      .sort((left, right) => (
        right.completedAtMs - left.completedAtMs
        || right.createdAtMs - left.createdAtMs
        || left.jobId.localeCompare(right.jobId)
      ));
    // A matching completed result is safe to recover on another device because
    // the durable fingerprint binds it to the exact input schedule. Running
    // and queued work still wins so an older result cannot replace live work.
    const priorityGroups = [running, queued, completed];
    for(const group of priorityGroups){
      const matching = group.find(item => item.matchesCurrentSchedule === true);
      if(matching) return {job:matching, observerJob:null, staleJob:null};
    }
    const observerJob = backendJobOwnerScope() !== "anonymous"
      ? [...running, ...queued].find(item => (
          item.matchesCurrentSchedule !== true
          && item.scheduleScope
          && item.scheduleScope === currentScope
        )) || null
      : null;
    const staleJob = priorityGroups.flat().find(item => item.matchesCurrentSchedule !== true) || null;
    return {job:null, observerJob, staleJob};
  }

  function reportSkippedDiscoveredBackendJob(job){
    const jobId = String(job?.jobId || "").trim();
    if(!jobId || window.__TKB_SKIPPED_DISCOVERED_JOB_ID === jobId) return;
    window.__TKB_SKIPPED_DISCOVERED_JOB_ID = jobId;
    // A mismatched result is an expected safety case after deleting, editing,
    // or re-sorting a timetable. Keep ignoring it silently so a harmless old
    // VPS result never occupies the planner toolbar with a warning.
  }

  function removePendingBackendJob(jobId){
    const value = String(jobId || "").trim();
    try{
      const map = JSON.parse(localStorage.getItem(SERVER_SOLVER_JOB_STORAGE_KEY) || "{}");
      if(!map || typeof map !== "object") return;
      const scope = backendJobStorageScope();
      const legacyScope = legacyBackendJobStorageScope();
      let removed = false;
      for(const key of new Set([scope, legacyScope])){
        if(value && String(map[key]?.jobId || "") !== value) continue;
        if(map[key]){
          delete map[key];
          removed = true;
        }
      }
      if(removed) localStorage.setItem(SERVER_SOLVER_JOB_STORAGE_KEY, JSON.stringify(map));
      setAutoSortHomeHiddenState(false);
    }catch(_){ }
  }

  function setActiveBackendJobId(jobId, scheduleFingerprint, metadata){
    const value = String(jobId || "").trim();
    activeBackendJobId = value;
    window.__TKB_ACTIVE_BACKEND_JOB_ID = value;
    if(value) writePendingBackendJob(value, scheduleFingerprint, {
      allowSettledReplay:activeServerJobReattachLeaseId === value,
      qualityDebtFreshRebuild:metadata?.qualityDebtFreshRebuild === true,
      trialLocal:metadata?.trialLocal === true,
      strictBrowserAutomatic:metadata?.strictBrowserAutomatic === true,
      optimizationFocus:metadata?.optimizationFocus,
      optimizationGapTarget:metadata?.optimizationGapTarget,
      solveRequestMode:metadata?.solveRequestMode
    });
    return value;
  }

  function persistPendingProgressState(){
    if(!progressState) return null;
    const pending = readPendingBackendJob();
    if(!pending?.jobId) return null;
    return writePendingBackendJob(pending.jobId, pending.scheduleFingerprint, {
      solverStartedAtMs:progressState.serverStartedAtMs || pending.solverStartedAtMs,
      uiStartedAtMs:progressState.uiStartedAt || progressState.startedAt,
      lastPercent:progressState.lastPercent,
      localClickTimeline:progressState.localClickTimeline === true,
      progressEstimateSeconds:progressState.estimatedSeconds,
      progressBudgetSeconds:progressState.progressBudgetSeconds,
      progressRunIndex:progressState.runIndex,
      optimizationFocus:progressState.settings?.optimization_focus,
      optimizationGapTarget:progressState.settings?.optimization_gap_target,
      solveRequestMode:progressState.settings?.ui_requested_solve_mode
    });
  }

  function markBackendJobQueued(jobId, metadata){
    const value = String(jobId || "").trim();
    if(!value) return;
    const pending = readPendingBackendJob();
    const reportedBudgetSeconds = normalizePendingProgressSeconds(metadata?.progressBudgetSeconds);
    const reportedRunIndex = Number(metadata?.progressRunIndex || 0) > 0
      ? normalizePendingProgressRunIndex(metadata.progressRunIndex)
      : 0;
    if(pending?.jobId === value){
      writePendingBackendJob(value, pending.scheduleFingerprint, {
        clearSolverStartedAt:true,
        progressBudgetSeconds:reportedBudgetSeconds || pending.progressBudgetSeconds,
        progressRunIndex:reportedRunIndex || pending.progressRunIndex
      });
    }
    if(progressState && progressState.backendQueued !== true){
      progressState.backendQueued = true;
      progressState.serverStartedAtMs = 0;
      progressState.startedAt = Date.now();
      if(progressState.localClickTimeline !== true){
        progressState.lastPercent = Math.min(
          PRE_ADMISSION_PROGRESS_CAP,
          Math.max(3, Number(progressState.lastPercent || 3) || 3)
        );
      }
      progressState.phase = "queued";
      if(reportedBudgetSeconds > 0) progressState.progressBudgetSeconds = reportedBudgetSeconds;
      if(reportedRunIndex > 0) progressState.runIndex = reportedRunIndex;
      persistPendingProgressState();
    }
  }

  function recordBackendJobStarted(jobId, startedAtMs, metadata){
    const value = String(jobId || "").trim();
    const rawStartedAt = Math.max(0, Number(startedAtMs || 0) || 0);
    const authoritativeRunning = metadata?.authoritativeRunning === true;
    if(!value || (rawStartedAt <= 0 && !authoritativeRunning)) return 0;
    const now = Date.now();
    const pending = readPendingBackendJob();
    const reportedStartedAt = rawStartedAt > 0
      ? normalizeBackendStartedAtMs(rawStartedAt, pending?.createdAt, now)
      : 0;
    const persistedStartedAt = pending?.jobId === value
      ? normalizeBackendStartedAtMs(pending.solverStartedAtMs, pending.createdAt, now)
      : 0;
    const admittedStartedAt = progressState?.backendProgressJobId === value
      ? normalizeBackendStartedAtMs(progressState.serverStartedAtMs, pending?.createdAt, now)
      : 0;
    // A concrete running/started response is authoritative even when an older
    // backend omits its clock or a skewed timestamp fails normalization. Keep
    // the first safe fallback stable for this job across later status polls;
    // queued and idle responses must stay inside the pre-admission band.
    const canonicalStartedAt = reportedStartedAt
      || persistedStartedAt
      || admittedStartedAt
      || (authoritativeRunning ? now : 0);
    const localStartedAt = normalizeBackendStartedAtMs(
      progressState?.startedAt,
      pending?.createdAt,
      now
    );
    const localUiStartedAt = normalizeBackendStartedAtMs(
      progressState?.uiStartedAt || progressState?.startedAt,
      0,
      now
    );
    // Never turn a malformed/stale server timestamp into an artificial six-hour
    // elapsed time. The canonical compute clock uses the safe fallback above,
    // while the visible timer keeps the earliest valid UI origin.
    const normalizedStartedAt = canonicalStartedAt
      || localStartedAt
      || ((progressState || pending?.jobId === value) ? now : 0);
    if(normalizedStartedAt <= 0) return 0;
    const reportedBudgetSeconds = normalizePendingProgressSeconds(metadata?.progressBudgetSeconds);
    const reportedRunIndex = Number(metadata?.progressRunIndex || 0) > 0
      ? normalizePendingProgressRunIndex(metadata.progressRunIndex)
      : 0;
    if(pending?.jobId === value){
      writePendingBackendJob(value, pending.scheduleFingerprint, {
        solverStartedAtMs:canonicalStartedAt,
        progressBudgetSeconds:reportedBudgetSeconds || pending.progressBudgetSeconds,
        progressRunIndex:reportedRunIndex || pending.progressRunIndex
      });
    }
    if(progressState){
      const firstAdmissionForJob = progressState.backendProgressJobId !== value
        || progressState.serverStartedAtMs <= 0;
      if(firstAdmissionForJob){
        progressState.serverAdmissionPercent = Math.max(
          4,
          Math.min(PRE_ADMISSION_PROGRESS_CAP, Number(progressState.lastPercent || 4) || 4)
        );
      }
      progressState.backendProgressJobId = value;
      // Reattachment is complete once the canonical server reports that the
      // job is running. Keep the transport detail internal so the visible
      // status cannot alternate with the normal sorting label.
      progressState.reconnecting = false;
      progressState.backendQueued = false;
      progressState.serverStartedAtMs = canonicalStartedAt;
      progressState.startedAt = canonicalStartedAt || normalizedStartedAt;
      progressState.uiStartedAt = localUiStartedAt > 0
        ? Math.min(localUiStartedAt, normalizedStartedAt)
        : normalizedStartedAt;
      progressState.phase = canonicalStartedAt > 0 ? "running" : "preparing";
      if(reportedBudgetSeconds > 0) progressState.progressBudgetSeconds = reportedBudgetSeconds;
      if(reportedRunIndex > 0) progressState.runIndex = reportedRunIndex;
      if(canonicalStartedAt > 0) tickEstimatedProgress();
      else persistPendingProgressState();
    }
    return normalizedStartedAt;
  }

  function beginServerJobReattachLease(jobId){
    const value = String(jobId || "").trim();
    if(!value) return false;
    activeServerJobReattachLeaseId = value;
    return true;
  }

  function endServerJobReattachLease(jobId){
    const value = String(jobId || "").trim();
    if(!value || activeServerJobReattachLeaseId === value){
      activeServerJobReattachLeaseId = "";
      return true;
    }
    return false;
  }

  function consumeActiveBackendResumeTarget(jobId){
    const value = String(jobId || "").trim();
    if(!value || String(activeBackendResumeTarget?.jobId || "") !== value) return false;
    window.__TKB_SERVER_JOB_RESUME_CONSUMED_ID = value;
    activeBackendResumeTarget = null;
    endServerJobReattachLease(value);
    return true;
  }

  function clearActiveBackendJobId(jobId, options){
    const value = String(jobId || "").trim();
    const force = options?.force === true;
    if(!force && value && activeServerJobReattachLeaseId === value){
      // The old page may finish the same request while iOS is restoring this
      // page.  Do not mark the result settled or remove the durable row until
      // the poll-only reattach has atomically applied it.
      return false;
    }
    if(value && activeBackendJobId && activeBackendJobId !== value) return;
    if(value) rememberSettledBackendJob(value);
    if(value && bestEffortStopJobId === value){
      setBestEffortStopPending(value, false);
    }
    clearCurrentSolveExecutorState(value);
    activeBackendJobId = "";
    window.__TKB_ACTIVE_BACKEND_JOB_ID = "";
    removePendingBackendJob(value);
  }

  function deferBackendResultSettlement(jobId, payload){
    const value = String(jobId || "").trim();
    if(!value || !payload || typeof payload !== "object") return false;
    deferredBackendResultJobId = value;
    try{ deferredBackendResultPayloads.set(payload, value); }catch(_){ }
    return true;
  }

  function terminalApplySaveWatchdogMs(){
    let override = 0;
    try{
      override = Number(window.__TKB_TERMINAL_APPLY_SAVE_WATCHDOG_MS || 0) || 0;
    }catch(_){ }
    return override > 0
      ? Math.max(50, Math.min(120_000, Math.round(override)))
      : TERMINAL_APPLY_SAVE_WATCHDOG_MS;
  }

  function deferredBackendJobIdForPayload(payload){
    try{
      return String(deferredBackendResultPayloads.get(payload) || "").trim();
    }catch(_){
      return "";
    }
  }

  function deferredBackendSavePendingFor(jobId){
    const value = String(jobId || "").trim();
    return !!value && deferredBackendSavePendingJobId === value;
  }

  function markDeferredBackendSavePending(payload){
    const jobId = deferredBackendJobIdForPayload(payload);
    if(!jobId) return "";
    deferredBackendSavePendingJobId = jobId;
    try{
      window.__TKB_DEFERRED_BACKEND_SAVE_PENDING_JOB_ID = jobId;
    }catch(_){ }
    return jobId;
  }

  function clearDeferredBackendSavePending(jobId){
    const value = String(jobId || "").trim();
    if(value && deferredBackendSavePendingJobId !== value) return false;
    deferredBackendSavePendingJobId = "";
    try{
      window.__TKB_DEFERRED_BACKEND_SAVE_PENDING_JOB_ID = "";
      if(
        !value
        || !window.__TKB_SOLVER_SAVE_PENDING_JOB_ID
        || String(window.__TKB_SOLVER_SAVE_PENDING_JOB_ID) === value
      ){
        window.__TKB_SOLVER_SAVE_PENDING = false;
        window.__TKB_SOLVER_SAVE_PENDING_JOB_ID = "";
      }
    }catch(_){ }
    scheduleQueuedAutoSortContinuation();
    return true;
  }

  function reportDeferredBackendSaveFailure(payload, error){
    const jobId = deferredBackendJobIdForPayload(payload)
      || deferredBackendSavePendingJobId;
    clearDeferredBackendSavePending(jobId);
    const message = String(error?.message || error || "remote timetable save failed");
    try{
      window.__TKB_SOLVER_LAST_SAVE_ERROR = message;
      window.__TKB_SOLVER_LAST_SAVE_ERROR_JOB_ID = jobId;
    }catch(_){ }
    // Do not roll back the already-materialized timetable.  Retain the exact
    // server result and let the normal poll-only recovery path retry its apply
    // after the transient storage failure.
    if(jobId && readPendingBackendJob()?.jobId === jobId){
      schedulePendingBackendResume(0, SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
    }
  }

  async function awaitTrustedSolverApplySave(saveStoreFn, options, payload){
    if(typeof saveStoreFn !== "function"){
      return {timedOut:false, value:false};
    }
    const requested = saveStoreFn.call(window, options);
    if(!requested || typeof requested.then !== "function"){
      return {timedOut:false, value:requested};
    }

    let timer = 0;
    const tracked = Promise.resolve(requested).then(
      value => ({ok:true, value}),
      error => ({ok:false, error})
    );
    const timeout = new Promise(resolve => {
      timer = window.setTimeout(
        () => resolve({timedOut:true}),
        terminalApplySaveWatchdogMs()
      );
    });
    const outcome = await Promise.race([tracked, timeout]);
    if(outcome?.timedOut !== true){
      window.clearTimeout(timer);
      if(outcome?.ok !== true) throw outcome?.error;
      return {timedOut:false, value:outcome.value};
    }

    const jobId = markDeferredBackendSavePending(payload);
    const pending = tracked.then(final => {
      if(final?.ok === true){
        clearDeferredBackendSavePending(jobId);
        settleDeferredBackendResultForPayload(payload);
      }else{
        reportDeferredBackendSaveFailure(payload, final?.error);
      }
      return final;
    }).catch(error => {
      reportDeferredBackendSaveFailure(payload, error);
      return {ok:false, error};
    });
    try{ deferredBackendSavePromises.set(payload, pending); }catch(_){ }
    return {timedOut:true, pending:true, jobId};
  }

  function settleDeferredBackendResult(jobId){
    const value = String(jobId || deferredBackendResultJobId || "").trim();
    if(!value) return false;
    if(deferredBackendResultJobId === value) deferredBackendResultJobId = "";
    clearDeferredBackendSavePending(value);
    clearActiveBackendJobId(value, {force:true});
    return true;
  }

  function settleDeferredBackendResultForPayload(payload){
    let jobId = "";
    try{ jobId = String(deferredBackendResultPayloads.get(payload) || "").trim(); }catch(_){ }
    if(!jobId) return false;
    try{ deferredBackendResultPayloads.delete(payload); }catch(_){ }
    return settleDeferredBackendResult(jobId);
  }

  function settleStoppedSolveUi(jobId, controller){
    const value = String(jobId || "").trim();
    cancelPendingBackendResume();
    stopProgressTicker();
    stopStatusDots();
    if(value) endServerJobReattachLease(value);
    activeBackendResumeTarget = null;
    activeServerJobReattachLeaseId = "";
    clearCurrentSolveExecutorState(value);
    activeBackendJobId = "";
    window.__TKB_ACTIVE_BACKEND_JOB_ID = "";
    clearActiveSolveAbortController(controller);
    window.__TKB_ACTIVE_SOLVE_RUN_ID = "";
    window.__TKB_SERVER_JOB_RESUME_STARTED = false;
    window.__TKB_RUST_SOLVER_RUNNING = false;
    window.__TKB_SOLVE_UI_BUSY = false;
    window.__TKB_SOLVE_BACKEND_POSTED = false;
    window.__TKB_SOLVE_QUEUE_WAITING = false;
    window.__TKB_BACKEND_JOB_OBSERVER_ONLY = false;
    setAutoSortButtonBusy(false);
    hideAutoSortProgressDom();
    callMaybe("hideAutoSortProgress", [{preserveStopRequest:true}]);
    setStatus(makeUserCancelError().message, "info");
    publishE2EState("cancelled", null, {
      message:"user_cancelled",
      jobId:value,
      reconnectHydration:value !== ""
    });
  }

  function activeFocusedOptimizationSupportsBestStop(){
    const pending = readPendingBackendJob();
    const focus = String(
      progressState?.settings?.optimization_focus
      || pending?.optimizationFocus
      || ""
    ).trim().toLowerCase().replace(/[\s-]+/g, "_");
    return ["singletons", "sessions", "gaps"].includes(focus);
  }

  function bestEffortStopPendingFor(jobId){
    const value = String(jobId || "").trim();
    return !!value && (
      bestEffortStopJobId === value
      || progressState?.bestEffortStopPending === true
    );
  }

  function bestEffortStopStatusActive(){
    const jobId = String(
      activeBackendJobId
      || window.__TKB_ACTIVE_BACKEND_JOB_ID
      || readPendingBackendJob()?.jobId
      || ""
    ).trim();
    return bestEffortStopPendingFor(jobId);
  }

  function setActiveSolveRunningStatus(){
    setStatus(
      bestEffortStopStatusActive()
        ? "\u0110ang nh\u1eadn ph\u01b0\u01a1ng \u00e1n t\u1ed1t nh\u1ea5t..."
        : "\u0110ang s\u1eafp x\u1ebfp...",
      "info"
    );
  }

  function setBestEffortStopPending(jobId, pending){
    const value = String(jobId || "").trim();
    if(pending === true){
      bestEffortStopJobId = value;
    }else if(!value || bestEffortStopJobId === value){
      bestEffortStopJobId = "";
    }
    if(progressState){
      progressState.bestEffortStopPending = pending === true;
      progressState.phase = pending === true ? "best_effort_stop" : "running";
    }
    const stopButton = document.getElementById("btnStopAutoSort");
    if(stopButton) stopButton.disabled = pending === true;
  }

  async function requestStopActiveSolve(options){
    const backendJobId = String(
      activeBackendJobId
      || window.__TKB_ACTIVE_BACKEND_JOB_ID
      || readPendingBackendJob()?.jobId
      || ""
    ).trim();
    const retainBest = options?.retainBest !== false
      && options?.hardCancel !== true
      && activeFocusedOptimizationSupportsBestStop();
    if(backendJobId && retainBest){
      // A repeated tap while the server is materializing its incumbent is the
      // same soft Stop. Never fall through to hard cancellation and discard a
      // focused improvement already accepted by CP-SAT.
      if(bestEffortStopPendingFor(backendJobId)) return true;
      setBestEffortStopPending(backendJobId, true);
      setStatus("\u0110ang nh\u1eadn ph\u01b0\u01a1ng \u00e1n t\u1ed1t nh\u1ea5t...", "info");
      tickEstimatedProgress();
      let browserStopResult = null;
      if(typeof window.TKBBrowserWasmExecutor?.stopAndSubmitBest === "function"){
        try{
          const stopped = window.TKBBrowserWasmExecutor.stopAndSubmitBest({
            jobId:backendJobId,
            reason:"user_best_effort_stop"
          });
          if(stopped && typeof stopped.then === "function"){
            void Promise.resolve(stopped).catch(() => null);
          }else{
            browserStopResult = stopped;
          }
        }catch(_){ }
      }
      const response = await cancelBackendSolver(backendJobId, {retainBest:true});
      if(
        response?.bestEffortStopRequested === true
        || browserStopResult?.submitted === true
      ){
        return true;
      }
      const stillActive = String(
        activeBackendJobId
        || window.__TKB_ACTIVE_BACKEND_JOB_ID
        || readPendingBackendJob()?.jobId
        || ""
      ).trim() === backendJobId;
      if(!stillActive) return true;
      setBestEffortStopPending(backendJobId, false);
      setStatus("\u0110ang s\u1eafp x\u1ebfp...", "info");
      return false;
    }
    // Quick/Fresh Stop and schedule-mutation cancellation remain destructive.
    // Ordinary page navigation never enters this path; it keeps the durable
    // job id so a later planner visit can reattach without spending a new job.
    rememberPersistentAutoResumeSuppression();
    window.__TKB_AUTO_RESUME_SUPPRESSED = true;
    window.__AUTO_SORT_STOP_REQUESTED = true;
    backendResumeEpoch += 1;
    cancelPendingBackendResume();
    const controller = activeSolveAbortController;
    if(backendJobId){
      rememberSettledBackendJob(backendJobId);
      removePendingBackendJob(backendJobId);
      endServerJobReattachLease(backendJobId);
      rememberServerCancellationIntent(backendJobId);
    }
    if(typeof window.__TKB_PHANMON_REQUEST_STOP === "function"){
      window.__TKB_PHANMON_REQUEST_STOP();
    }else if(typeof window.requestStopAutoSort === "function" && window.requestStopAutoSort !== requestStopActiveSolve){
      window.__AUTO_SORT_STOP_REQUESTED = true;
    }
    if(controller){
      try{ controller.abort(); }catch(_){}
    }
    settleStoppedSolveUi(backendJobId, controller);
    try{
      if(backendJobId){
        const cancellation = await cancelBackendSolver(backendJobId);
        if(cancellation?.cancelRequested === true || cancellation?.ok === true){
          clearServerCancellationIntent(backendJobId);
        }
      }
    }finally{
      if(backendJobId){
        clearActiveBackendJobId(backendJobId);
      }
      settleStoppedSolveUi(backendJobId, controller);
    }
  }

  function serverJobIdsForCurrentSchedule(state){
    if(!state || state.ok !== true) return [];
    const scheduleScope = backendScheduleScope();
    return [
      ...(Array.isArray(state.jobs) ? state.jobs : []),
      ...(Array.isArray(state.queue) ? state.queue : [])
    ]
      .filter(item => item?.serverOwned === true && item?.cancelRequested !== true)
      .filter(item => String(item?.scheduleScope || "").trim() === scheduleScope)
      .map(item => String(item?.jobId || "").trim())
      .filter(Boolean);
  }

  function beginScheduleMutationCancellation(knownJobId){
    if(scheduleMutationCancellationInFlight) return scheduleMutationCancellationInFlight;
    const known = String(knownJobId || "").trim();
    const run = (async () => {
      const cancelled = new Set();
      const cancelOne = async jobId => {
        const value = String(jobId || "").trim();
        if(!value || cancelled.has(value)) return null;
        cancelled.add(value);
        rememberServerCancellationIntent(value);
        const response = await cancelBackendSolver(value).catch(() => null);
        if(response?.cancelRequested === true || response?.ok === true){
          clearServerCancellationIntent(value);
        }
        return response;
      };
      const knownCancellation = known ? cancelOne(known) : Promise.resolve(null);
      const state = await backendSolverState("");
      await knownCancellation;
      await Promise.all(serverJobIdsForCurrentSchedule(state).map(cancelOne));
      return {ok:true, jobIds:Array.from(cancelled)};
    })().catch(() => ({ok:false, jobIds:known ? [known] : []}));
    scheduleMutationCancellationInFlight = run;
    try{ window.__TKB_SCHEDULE_MUTATION_CANCEL_PROMISE = run; }catch(_){ }
    run.finally(() => {
      if(scheduleMutationCancellationInFlight === run){
        scheduleMutationCancellationInFlight = null;
        try{ window.__TKB_SCHEDULE_MUTATION_CANCEL_PROMISE = null; }catch(_){ }
      }
    });
    return run;
  }

  async function waitForScheduleMutationCancellation(){
    const pending = scheduleMutationCancellationInFlight;
    if(!pending) return true;
    await pending.catch(() => null);
    return true;
  }

  async function waitForScheduleMutationPersistence(){
    let pending = null;
    try{ pending = window.__TKB_SCHEDULE_MUTATION_SAVE_PROMISE; }catch(_){ }
    if(!pending || typeof pending.then !== "function") return true;
    try{
      await Promise.resolve(pending);
      return true;
    }catch(_){
      return false;
    }
  }

  function invalidatePendingSolveForScheduleMutation(){
    const backendJobId = String(
      activeBackendJobId
      || window.__TKB_ACTIVE_BACKEND_JOB_ID
      || readPendingBackendJob()?.jobId
      || ""
    ).trim();
    const revision = markScheduleMutationTombstone();
    rememberPersistentAutoResumeSuppression();
    window.__TKB_AUTO_RESUME_SUPPRESSED = true;
    window.__AUTO_SORT_STOP_REQUESTED = true;
    backendResumeEpoch += 1;
    cancelPendingBackendResume();
    const controller = activeSolveAbortController;
    if(backendJobId){
      rememberSettledBackendJob(backendJobId);
      removePendingBackendJob(backendJobId);
      endServerJobReattachLease(backendJobId);
    }
    if(controller){
      try{ controller.abort(); }catch(_){ }
    }
    settleStoppedSolveUi(backendJobId, controller);
    const cancellation = beginScheduleMutationCancellation(backendJobId);
    cancellation.finally(() => {
      if(backendJobId) clearActiveBackendJobId(backendJobId, {force:true});
    });
    return {ok:true, jobId:backendJobId, revision, cancellation};
  }

  function isBackendUnavailableError(err){
    if(!err) return true;
    if(err.payload && err.payload.kind) return false;
    if(err.backendUnavailable === false) return false;
    if(err.kind === "client_timeout" || err.kind === "request_timeout") return false;
    if(err.name === "AbortError") return false;
    const status = Number(err.status || 0);
    if(status && ![404, 405, 502, 503, 504].includes(status)) return false;
    const msg = String(err.message || err || "").toLowerCase();
    if(!status && (
      msg.includes("quá ") ||
      msg.includes("timeout") ||
      msg.includes("time out") ||
      msg.includes("abort")
    )) return false;
    return !status
      || msg.includes("backend")
      || msg.includes("failed to fetch")
      || msg.includes("network")
      || msg.includes("load failed")
      || msg.includes("api/solve-data")
      || [404, 405, 502, 503, 504].includes(status);
  }

  function backendRequiredMessage(data){
    const reason = hasActiveConstraintData(data)
      ? "Dữ liệu đang có ràng buộc/tiết nghỉ nên cần dịch vụ xếp lịch để xử lý đúng."
      : "Dữ liệu toàn trường khá lớn nên cần dịch vụ xếp lịch để chạy ổn định.";
    const deploymentHint = isLocalPageOrigin()
      ? "Hãy chạy python .\\start.py trong thư mục TKB, mở http://127.0.0.1:1010/, rồi bấm Sắp xếp TKB > Sắp xếp."
      : "Hãy mở bản local tại http://127.0.0.1:1010/ để kết nối dịch vụ xếp lịch.";
    return [
      "Không kết nối được dịch vụ xếp lịch.",
      reason,
      deploymentHint
    ].join(" ");
  }

  function solveDiagnosticText(){
    const d = window.__TKB_RUST_LAST_REQUEST_DEBUG || {};
    const parts = [`bridge=${VERSION}`];
    if(d.apiBase) parts.push(`api=${d.apiBase}`);
    if(d.requestBytes) parts.push(`body=${d.requestBytes}B`);
    if(d.timeoutMs != null) parts.push(`timeout=${Math.round(Number(d.timeoutMs || 0) / 1000)}s`);
    if(d.healthStatus != null) parts.push(`health=${d.healthStatus}`);
    if(d.responseStatus != null) parts.push(`post=${d.responseStatus}`);
    if(Array.isArray(d.attempts) && d.attempts.length){
      const last = d.attempts[d.attempts.length - 1] || {};
      if(last.error) parts.push(`last=${last.error}`);
      else if(last.status != null) parts.push(`last=${last.status}`);
    }
    return parts.join("; ");
  }

  function shouldUseLegacyFallback(_data){
    return false;
  }

  function rescueTeacherList(raw){
    try{
      if(typeof teacherListFromValue === "function") return teacherListFromValue(raw);
    }catch(_){}
    if(Array.isArray(raw)) return raw.map(x => String(x || "").trim()).filter(Boolean);
    return String(raw || "")
      .replace(/\r?\n/g, ",")
      .replace(/[;+]+/g, ",")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);
  }

  function rescueClassCanon(data, classId){
    try{
      if(typeof getLopCanonById === "function") return String(getLopCanonById(classId) || classId || "").trim();
    }catch(_){}
    const cls = (data?.lop || []).find(item => String(item.id) === String(classId));
    return String(cls?.ten || cls?.ten2 || cls?.id || classId || "").trim();
  }

  function rescueSubjectList(data, cls){
    const classId = String(cls?.id || cls?.ten2 || cls?.ten || "").trim();
    const canon = rescueClassCanon(data, classId);
    const khoiNum = (() => {
      try{
        if(typeof extractKhoiNumber === "function"){
          return extractKhoiNumber(cls?.khoi) || extractKhoiNumber(cls?.ten2) || extractKhoiNumber(cls?.ten) || "";
        }
      }catch(_){}
      const m = String(cls?.khoi || cls?.ten2 || cls?.ten || "").match(/\d+/);
      return m ? m[0] : "";
    })();
    try{
      if(typeof computeMonsForClass === "function"){
        const list = computeMonsForClass(khoiNum, canon) || [];
        if(list.length) return list.map(item => ({
          ten: String(item?.ten || "").trim(),
          sotiet: Math.max(0, Math.round(Number(item?.sotiet || 0))),
          gioihan: Math.max(1, Math.round(Number(item?.gioihan || 1)))
        })).filter(item => item.ten && item.sotiet > 0);
      }
    }catch(_){}

    const out = new Map();
    const add = (subject, periods, limit) => {
      const ten = String(subject || "").trim();
      if(!ten) return;
      const key = ten.toLowerCase();
      const prev = out.get(key) || {ten, sotiet:0, gioihan:1};
      const n = Math.max(0, Math.round(Number(periods || 0)));
      if(n > 0) prev.sotiet = n;
      const g = Math.max(1, Math.round(Number(limit || 1)));
      if(g > prev.gioihan) prev.gioihan = g;
      out.set(key, prev);
    };
    Object.keys(data?.pccmMatrix || {}).forEach(key => {
      const [clsKey, subject] = String(key || "").split("|");
      if(clsKey === canon || clsKey === classId) add(subject, data?.pccmTietMatrix?.[key], data?.pccmGioihanMatrix?.[key]);
    });
    (data?.mon || []).forEach(row => {
      const rowKhoi = (() => {
        try{ return typeof extractKhoiNumber === "function" ? extractKhoiNumber(row?.khoi) : ""; }catch(_){ return ""; }
      })();
      if(khoiNum && rowKhoi && String(rowKhoi) !== String(khoiNum)) return;
      add(row?.ten, row?.sotiet, row?.gioihan);
    });
    return Array.from(out.values()).filter(item => item.ten && item.sotiet > 0);
  }

  function rescueTeacherFor(data, classId, subject){
    const canon = rescueClassCanon(data, classId);
    try{
      if(typeof getTeacherForClassMon === "function") return String(getTeacherForClassMon(canon, subject) || "").trim();
    }catch(_){}
    const classAliases = Array.from(new Set([canon, classId].map(value => String(value || "").trim()).filter(Boolean)));
    const subjectAliases = Array.from(new Set(
      expandSubjectAliases(data, [subject])
        .map(value => String(value || "").trim())
        .filter(Boolean)
    ));
    const maps = [data?.tkbLessonTeachers, data?.pccmMatrix];
    for(const source of maps){
      if(!source || typeof source !== "object") continue;
      for(const classAlias of classAliases){
        for(const subjectAlias of subjectAliases){
          const value = source[`${classAlias}|${subjectAlias}`];
          if(value) return String(value).trim();
        }
      }
    }
    return "";
  }

  function rescueRoomFor(data, classId, subject){
    const canon = rescueClassCanon(data, classId);
    try{
      if(typeof getRoomForClassMon === "function") return String(getRoomForClassMon(canon, subject) || "").trim();
    }catch(_){}
    const tries = [`${canon}|${subject}`, `${classId}|${subject}`];
    for(const key of tries){
      const value = data?.pccmRoomMatrix?.[key];
      if(value) return String(value).trim();
    }
    return "";
  }

  function callMaybe(name, args){
    try{
      const fn = window[name];
      if(typeof fn === "function") return fn.apply(window, args || []);
    }catch(err){
      console.warn(`[${VERSION}] ${name} failed`, err);
    }
    return undefined;
  }

  function autoSortProgressAllowed(){
    const btn = document.getElementById("btnAutoSort");
    if(!btn) return true;
    const solving = window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true;
    return !!btn.disabled || solving;
  }

  function setProgress(percent, label, options){
    if(!autoSortProgressAllowed()){
      hideAutoSortProgressDom();
      callMaybe("hideAutoSortProgress");
      return;
    }
    // setProgress owns only an active solve lifecycle. Keep 100% reserved for
    // finishProgress so a completed work metric or stale snapshot cannot make
    // the live UI look terminal while the result is still being validated.
    let n = Math.max(0, Math.min(SERVER_WAIT_PROGRESS_CAP, Math.round(Number(percent || 0))));
    if(progressState){
      if(options?.replaceLocalPercent !== true){
        n = Math.max(n, normalizePendingProgressPercent(progressState.lastPercent));
      }
      progressState.lastPercent = n;
      progressState.lastLabel = String(label || progressState.lastLabel || "");
      if(options?.phase) progressState.phase = String(options.phase);
      persistPendingProgressState();
    }
    const metricProgress = progressState?.metricProgress || null;
    const elapsedLabel = String(options?.elapsedLabel || label || "");
    const metricLabel = String(options?.metricLabel || "").trim();
    window.__TKB_RUST_PROGRESS_STATE = Object.assign({}, window.__TKB_RUST_PROGRESS_STATE || {}, {
      percent: n,
      label: String(label || ""),
      elapsedLabel,
      metricLabel,
      runIndex:normalizePendingProgressRunIndex(progressState?.runIndex || 1),
      budgetSeconds:normalizePendingProgressSeconds(progressState?.progressBudgetSeconds),
      phase:String(options?.phase || progressState?.phase || ""),
      canonicalServerProgress:progressState?.serverStartedAtMs > 0 && progressState?.backendQueued !== true,
      serverStartedAtMs:Math.max(0, Number(progressState?.serverStartedAtMs || 0) || 0),
      backendProgressStage:String(progressState?.backendProgressStage || ""),
      backendProgressGeneration:Math.max(0, Number(progressState?.backendProgressGeneration || 0) || 0),
      backendProgressSequence:Math.max(0, Number(progressState?.backendProgressSequence || 0) || 0),
      backendProgressElapsedMs:Math.max(0, Number(progressState?.backendProgressElapsedMs || 0) || 0),
      optimizationFocus:String(metricProgress?.focus || ""),
      metricCurrent:metricProgress ? Number(metricProgress.current) : null,
      metricTarget:metricProgress ? Number(metricProgress.target) : null,
      metricBaseline:metricProgress ? Number(metricProgress.baseline) : null,
      metricPercent:metricProgress ? Number(metricProgress.percent) : null,
      bestEffortStopPending:progressState?.bestEffortStopPending === true,
      updatedAt: Date.now()
    });
    callMaybe("setAutoSortProgress", [n, elapsedLabel, {metricLabel}]);
  }

  function hardFinishProgressDom(label, state){
    if(!autoSortProgressAllowed()){
      hideAutoSortProgressDom();
      callMaybe("hideAutoSortProgress");
      return;
    }
    const textValue = String(label || "").trim();
    const lower = textValue.toLowerCase();
    const stateKind = String(state || "").toLowerCase();
    const isWarning = stateKind === "warning"
      || lower.includes("chưa đủ")
      || lower.includes("chua du");
    const isError = stateKind === "error"
      || lower.includes("error")
      || lower.includes("loi")
      || lower.includes("lỗi")
      || lower.includes("chưa đạt");
    const needsAttention = isError || isWarning;
    const wrap = document.getElementById("autoSortProgress");
    const fill = document.getElementById("autoSortProgressFill");
    const pct = document.getElementById("autoSortProgressPct");
    const track = wrap?.querySelector(".auto-sort-track");
    const text = wrap?.querySelector(".auto-sort-label");
    const metric = wrap?.querySelector(".auto-sort-metric");
    if(!wrap || !fill || !pct) return;
    const currentPct = Number((pct.textContent || "").match(/\d+/)?.[0]);
    const n = needsAttention ? Math.max(1, Math.min(99, Number.isFinite(currentPct) && currentPct > 0 ? currentPct : 99)) : 100;
    wrap.classList.add("is-active");
    wrap.classList.remove("is-idle");
    wrap.hidden = false;
    wrap.classList.toggle("is-error", isError);
    wrap.classList.toggle("is-warning", isWarning);
    wrap.classList.toggle("is-complete", !needsAttention);
    wrap.setAttribute("aria-hidden", "false");
    if(track){
      track.style.setProperty("--auto-sort-progress", (n * 3.6) + "deg");
      track.setAttribute("aria-label", needsAttention ? `${isWarning ? "Chưa đủ" : "Lỗi"} ${n}%` : "100%");
    }
    fill.style.width = n + "%";
    pct.textContent = needsAttention ? "!" : "100%";
    if(text){
      text.textContent = needsAttention ? (textValue || (isWarning ? "Chưa đủ" : "Lỗi")) : "Hoàn tất";
      text.title = needsAttention ? (textValue || (isWarning ? "Chưa đủ" : "Lỗi")) : "";
    }
    if(metric){
      metric.textContent = "";
      metric.title = "";
      metric.hidden = true;
    }
    try{ callMaybe("setAutoSortStopVisible", [false]); }catch(_){}
    try{ callMaybe("resetAutoSortStopRequest"); }catch(_){}
    window.clearTimeout(window.__autoSortProgressHideTimer);
    window.__autoSortProgressHideTimer = null;
  }

  function finishProgress(label, state){
    if(!autoSortProgressAllowed()){
      hideAutoSortProgressDom();
      callMaybe("hideAutoSortProgress");
      return;
    }
    // A complete, hard-valid timetable has one terminal message. Quality debt
    // remains available in metrics/E2E metadata for a later refinement click,
    // but must not be rendered beside success as a contradictory status.
    if(String(state || "ok").toLowerCase() === "ok"){
      callMaybe("hideAutoSortProgress");
      hideAutoSortProgressDom();
      return;
    }
    callMaybe("finishAutoSortProgress", [label || "100%", state || "ok"]);
    hardFinishProgressDom(label || "100%", state || "ok");
  }

  function hideAutoSortProgressDom(){
    // Keep the feedback row's height reserved, but do not expose an idle or
    // successful progress label. The status message owns the terminal text.
    window.clearTimeout(window.__autoSortProgressHideTimer);
    window.__autoSortProgressHideTimer = null;
    const wrap = document.getElementById("autoSortProgress");
    if(wrap){
      wrap.classList.remove("is-active", "is-error", "is-warning", "is-complete");
      wrap.classList.add("is-idle");
      wrap.hidden = true;
      wrap.setAttribute("aria-hidden", "true");
      const fill = document.getElementById("autoSortProgressFill");
      const pct = document.getElementById("autoSortProgressPct");
      const track = wrap.querySelector(".auto-sort-track");
      const text = wrap.querySelector(".auto-sort-label");
      const metric = wrap.querySelector(".auto-sort-metric");
      if(track){
        track.style.setProperty("--auto-sort-progress", "0deg");
        track.setAttribute("aria-label", "Sẵn sàng");
      }
      if(fill) fill.style.width = "0%";
      if(pct) pct.textContent = "0%";
      if(text){
        text.textContent = "Sẵn sàng";
        text.title = "";
      }
      if(metric){
        metric.textContent = "";
        metric.title = "";
        metric.hidden = true;
      }
    }
    try{ callMaybe("setAutoSortStopVisible", [false]); }catch(_){}
    try{ callMaybe("resetAutoSortStopRequest"); }catch(_){}
  }

  function settleAuthoritativeIdleSolveUi(options){
    // A reconnect warning is only provisional until the owner-scoped VPS
    // state probe completes. Once that probe confirms there is no canonical
    // job, clear the terminal-looking warning as well as the durable job id;
    // otherwise the page stays stuck on "Nối lại" even though Play is usable.
    if(localSolveLifecycleActive()) return false;
    // An ordinary foreground wake also receives an authoritative idle state.
    // Clear a visible terminal warning/error even when there was no durable
    // pending id (for example an old "Chưa đủ" left by a suspended iOS tab).
    // Do not otherwise touch an idle page merely because it was foregrounded.
    const progressWrap = document.getElementById("autoSortProgress");
    const visibleAttention = !!progressWrap
      && progressWrap.hidden !== true
      && (
        progressWrap.classList.contains("is-warning")
        || progressWrap.classList.contains("is-error")
      );
    const hasCurrentExecutor = window.__TKB_CURRENT_SOLVE_EXECUTOR?.active === true;
    if(options?.force !== true && !visibleAttention && !hasCurrentExecutor) return false;
    const statusText = String(document.getElementById("statusMsg")?.textContent || "").trim();
    const preserveCompletion = statusText === SOLVE_COMPLETE_MESSAGE;
    stopProgressTicker();
    stopStatusDots();
    progressState = null;
    try{ window.__TKB_RUST_LAST_LIVE_PROGRESS = null; }catch(_){ }
    try{
      window.__TKB_RUST_PROGRESS_STATE = {
        percent:0,
        label:"",
        phase:"idle",
        updatedAt:Date.now()
      };
    }catch(_){ }
    setAutoSortButtonBusy(false);
    hideAutoSortProgressDom();
    callMaybe("hideAutoSortProgress", [{preserveStopRequest:false}]);
    setAutoSortHomeHiddenState(false);
    clearCurrentSolveExecutorState();
    if(!preserveCompletion) setStatus("", "ok");
    return true;
  }

  function autoSortProgressFinishedInDom(){
    const wrap = document.getElementById("autoSortProgress");
    if(!wrap || wrap.hidden || !wrap.classList.contains("is-active")) return false;
    return wrap.classList.contains("is-complete")
      || wrap.classList.contains("is-warning")
      || wrap.classList.contains("is-error");
  }

  function setAutoSortHomeHiddenState(hidden){
    const shouldLock = !!hidden
      || window.__TKB_RUST_SOLVER_RUNNING === true
      || window.__TKB_SOLVE_UI_BUSY === true
      || !!readPendingBackendJob()?.jobId;
    const handled = callMaybe("setAutoSortHomeHidden", [shouldLock]);
    if(handled === true) return;
    const btn = document.getElementById("btnHome");
    const agentBtn = document.getElementById("btnAgentHelper");
    const optimizeBtn = document.getElementById("btnOptimizeMenu");
    const optimizeMenu = document.getElementById("plannerOptimizeMenu");
    if(btn){
      btn.hidden = false;
      btn.setAttribute("aria-hidden", "false");
      // Leaving the planner only detaches this browser poll. The server job
      // keeps running and its durable id is recovered on the next page load.
      if(btn.dataset.autoSortLock){
        btn.disabled = btn.dataset.autoSortPrevDisabled === "1";
        delete btn.dataset.autoSortLock;
        delete btn.dataset.autoSortPrevDisabled;
      }
      if(btn.disabled) btn.setAttribute("aria-disabled", "true");
      else btn.removeAttribute?.("aria-disabled");
      btn.classList.remove("is-auto-sort-disabled");
    }
    if(agentBtn){
      agentBtn.hidden = false;
      agentBtn.setAttribute("aria-hidden", "false");
      if(shouldLock){
        if(!agentBtn.dataset.autoSortLock){
          agentBtn.dataset.autoSortLock = "1";
          agentBtn.dataset.autoSortPrevDisabled = agentBtn.disabled ? "1" : "0";
        }
        agentBtn.disabled = true;
        agentBtn.setAttribute("aria-disabled", "true");
        agentBtn.classList.add("is-auto-sort-disabled");
      }else{
        if(agentBtn.dataset.autoSortLock){
          agentBtn.disabled = agentBtn.dataset.autoSortPrevDisabled === "1";
          delete agentBtn.dataset.autoSortLock;
          delete agentBtn.dataset.autoSortPrevDisabled;
        }
        if(agentBtn.disabled) agentBtn.setAttribute("aria-disabled", "true");
        else agentBtn.removeAttribute?.("aria-disabled");
        agentBtn.classList.remove("is-auto-sort-disabled");
      }
    }
    if(optimizeBtn){
      if(shouldLock){
        if(!optimizeBtn.dataset.autoSortLock){
          optimizeBtn.dataset.autoSortLock = "1";
          optimizeBtn.dataset.autoSortPrevDisabled = optimizeBtn.disabled ? "1" : "0";
        }
        optimizeBtn.disabled = true;
        optimizeBtn.setAttribute("aria-disabled", "true");
        optimizeBtn.setAttribute("aria-expanded", "false");
        optimizeBtn.classList.add("is-auto-sort-disabled");
        if(optimizeMenu) optimizeMenu.hidden = true;
      }else{
        if(optimizeBtn.dataset.autoSortLock){
          optimizeBtn.disabled = optimizeBtn.dataset.autoSortPrevDisabled === "1";
          delete optimizeBtn.dataset.autoSortLock;
          delete optimizeBtn.dataset.autoSortPrevDisabled;
        }
        if(optimizeBtn.disabled) optimizeBtn.setAttribute("aria-disabled", "true");
        else optimizeBtn.removeAttribute?.("aria-disabled");
        optimizeBtn.classList.remove("is-auto-sort-disabled");
      }
    }
  }

  function setAutoSortButtonBusy(busy){
    try{
      setAutoSortHomeHiddenState(!!busy);
      callMaybe("setAutoSortBusyControls", [!!busy]);
      const btn = document.getElementById("btnAutoSort");
      if(!btn) return;
      btn.disabled = !!busy;
      btn.classList.toggle("is-busy", !!busy);
      btn.setAttribute("aria-busy", busy ? "true" : "false");
      if(!busy && !autoSortProgressFinishedInDom()){
        hideAutoSortProgressDom();
        callMaybe("hideAutoSortProgress", [{preserveStopRequest:isStopRequested()}]);
      }
      if(!busy) syncOptimizationLockState();
    }catch(_){}
  }

  function initialVisibleProgressSettings(requestedMode, data){
    const mode = normalizeSolveRequestMode(requestedMode);
    const isAutoMode = mode === SOLVE_REQUEST_MODES.automatic || mode === SOLVE_REQUEST_MODES.autoMin2;
    const settings = {
      ui_default_fresh_sort:isAutoMode,
      ui_requested_solve_mode:mode,
      optimization_focus:optimizationFocusForSolveRequestMode(mode),
      ui_progress_mode:isAutoMode ? "time" : "work"
    };
    const gapTarget = gapOptimizationTargetForSolveRequestMode(mode);
    if(gapTarget) settings.optimization_gap_target = gapTarget;
    if(isAutoMode) return settings;

    const safeData = data || getData() || {};
    const expected = Math.max(0, expectedLessonCount(safeData));
    const scheduled = Math.max(0, countScheduledLessons(safeData));
    if(mode === SOLVE_REQUEST_MODES.quickComplete || expected <= 0 || scheduled < expected){
      settings.ui_requested_solve_mode = SOLVE_REQUEST_MODES.quickComplete;
      settings.optimization_focus = "quick_complete";
      configurePlanMetricProgress(
        settings,
        "scheduled_periods",
        scheduled,
        expected,
        expected
      );
      return settings;
    }

    const visibleMetrics = uiTeacherQualityMetrics(safeData);
    const savedMetrics = safeData?.tkbSolverResult?.metrics
      || safeData?.tkbRustSolverResult?.metrics
      || {};
    const metrics = metricNumber(visibleMetrics?.teacher_sessions, 0) > 0
      ? visibleMetrics
      : savedMetrics;
    const currentSessions = Math.max(0, metricNumber(metrics?.teacher_sessions, 0));
    if(currentSessions <= 0) return settings;

    if(mode === SOLVE_REQUEST_MODES.singletons){
      const currentSingletons = Math.max(
        0,
        metricNumber(metrics?.one_period_teacher_sessions, 0)
      );
      const singletonTarget = onePeriodTeacherSessionLowerBound(metrics);
      configurePlanMetricProgress(
        settings,
        "one_period_teacher_sessions",
        currentSingletons,
        singletonTarget,
        currentSingletons
      );
      return settings;
    }

    if(mode === SOLVE_REQUEST_MODES.sessions){
      const activeStudentSessions = Math.max(1, activeStudentSessionCount(safeData));
      const loadLowerBound = Math.max(1, teacherSessionLoadLowerCap(safeData));
      const target = Math.min(
        currentSessions,
        Math.max(loadLowerBound, activeStudentSessions)
      );
      configurePlanMetricProgress(
        settings,
        "teacher_sessions",
        currentSessions,
        target,
        currentSessions
      );
      return settings;
    }

    const currentGap2 = Math.max(0, gap2PlusCount(metrics));
    const currentGap1 = Math.max(0, gapExactCount(metrics, 1));
    const gapBaseline = readGapProgressBaseline(safeData);
    const gap2Baseline = gapBaseline ? gapBaseline.gap2Plus : currentGap2;
    const gap1Baseline = gapBaseline ? gapBaseline.gap1 : currentGap1;
    settings.ui_progress_gap1_baseline = gap1Baseline;
    settings.ui_progress_gap2_baseline = gap2Baseline;
    if(mode === SOLVE_REQUEST_MODES.gap2){
      configurePlanMetricProgress(
        settings,
        "teacher_gap2_sessions",
        currentGap2,
        0,
        gap2Baseline
      );
      return settings;
    }
    if(mode === SOLVE_REQUEST_MODES.gap1){
      configurePlanMetricProgress(
        settings,
        "teacher_gap1_sessions",
        currentGap1,
        0,
        gap1Baseline
      );
      return settings;
    }
    configurePlanMetricProgress(
      settings,
      "teacher_gap_sessions",
      currentGap1 + currentGap2,
      0,
      gap1Baseline + gap2Baseline
    );
    return settings;
  }

  function startInstantProgressTicker(options){
    stopProgressTicker();
    const now = Date.now();
    // Only a confirmed reload/cross-device resume may reuse persisted UI
    // progress. A brand-new user click must always start from a fresh timer,
    // even if a just-finished job has not been removed from storage yet.
    const isResume = options?.resumePending === true
      || window.__TKB_SERVER_JOB_RESUME_STARTED === true
      || window.__TKB_BACKEND_JOB_OBSERVER_ONLY === true;
    const pending = isResume
      ? readPendingBackendJob()
      : null;
    const localClickTimeline = !isResume || pending?.localClickTimeline === true;
    const persistedServerStartedAt = Math.max(0, Number(pending?.solverStartedAtMs || 0) || 0);
    const persistedUiStartedAt = Math.max(0, Number(pending?.uiStartedAtMs || 0) || 0);
    const startedAt = persistedServerStartedAt > 0 ? persistedServerStartedAt : now;
    const uiStartedAt = persistedUiStartedAt
      || persistedServerStartedAt
      || (pending?.jobId ? normalizeBackendStartedAtMs(pending.createdAt, 0, now) : 0)
      || now;
    const canonicalServerProgress = persistedServerStartedAt > 0;
    const instantProgressSettings = isResume
      ? Object.assign(
          initialVisibleProgressSettings(
            solveRequestModeForOptimizationContract(
              pending?.solveRequestMode,
              pending?.optimizationFocus,
              pending?.optimizationGapTarget
            ),
            getData()
          ),
          {ui_default_fresh_sort:true}
        )
      : initialVisibleProgressSettings(
          options?.requestedSolveMode,
          options?.data || getData()
        );
    const instantWorkMode = progressUsesWorkMetrics(instantProgressSettings);
    instantProgressSettings.ui_progress_mode = instantWorkMode ? "work" : "time";
    const instantMetricProgress = normalizeMetricProgressSnapshot({
      optimizationFocus:instantProgressSettings.ui_progress_metric_focus,
      metricCurrent:instantProgressSettings.ui_progress_metric_current,
      metricTarget:instantProgressSettings.ui_progress_metric_target,
      metricBaseline:instantProgressSettings.ui_progress_metric_baseline,
      metricPercent:instantProgressSettings.ui_progress_metric_percent
    });
    progressState = {
      startedAt,
      uiStartedAt,
      localClickTimeline,
      reconnecting:isResume,
      serverStartedAtMs:persistedServerStartedAt,
      backendQueued:persistedServerStartedAt <= 0 && !!pending?.jobId,
      estimatedSeconds:normalizePendingProgressSeconds(pending?.progressEstimateSeconds) || INITIAL_AUTO_DURATION_SECONDS,
      lastPercent:instantWorkMode
        ? Math.min(
            SERVER_WAIT_PROGRESS_CAP,
            instantMetricProgress?.percent ?? normalizePendingProgressPercent(pending?.lastPercent)
          )
        : (canonicalServerProgress && !localClickTimeline
            ? 3
            : Math.max(3, normalizePendingProgressPercent(pending?.lastPercent) || 3)),
      lastLabel:"",
      phase:canonicalServerProgress ? "running" : (pending?.jobId ? "queued" : "preparing"),
      deferFirstPaint:Math.max(0, now - uiStartedAt) < FIRST_PROGRESS_PAINT_DELAY_MS,
      modeLabel: "Sắp xếp",
      settings:instantProgressSettings,
      metricProgress:instantWorkMode ? instantMetricProgress : null,
      progressBudgetSeconds:normalizePendingProgressSeconds(pending?.progressBudgetSeconds) || INITIAL_AUTO_DURATION_SECONDS,
      runIndex:normalizePendingProgressRunIndex(pending?.progressRunIndex || 1)
    };
    publishLiveStatsProgress(progressState.metricProgress);
    if(progressState.deferFirstPaint) scheduleFirstProgressPaint();
    else tickEstimatedProgress();
    progressTimer = window.setInterval(tickEstimatedProgress, 1000);
  }

  function primeAutoSortStartUi(options){
    // A deliberate Play/resume owns the lifecycle from this point. Do not let
    // an older page-load discovery timer race its request or progress state.
    cancelPendingBackendResume();
    setAutoSortButtonBusy(true);
    setProgress(0, "Đang sắp xếp...", {replaceLocalPercent:true, phase:"preparing"});
    setStatus("Đang sắp xếp...", "info");
    startInstantProgressTicker(options);
  }

  function releaseAutoSortButtonSoon(){
    const release = () => {
      try{
        if(window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true) return;
        stopProgressTicker();
        setAutoSortButtonBusy(false);
        const statusEl = document.getElementById("statusMsg");
        const statusText = String(statusEl?.textContent || "").trim();
        if(/^Đang (sắp xếp|cập nhật bảng)/.test(statusText)){
          setStatus("", "ok");
        }
      }catch(_){}
    };
    release();
    try{ window.setTimeout(release, 0); }catch(_){}
    try{ window.setTimeout(release, 150); }catch(_){}
    try{ window.setTimeout(release, 600); }catch(_){}
  }

  function scheduleUiRefresh(){
    const refresh = () => {
      try{ callMaybe("renderCurrentView"); }catch(err){ console.warn(`[${VERSION}] render refresh failed`, err); }
      try{
        if(typeof window.scheduleLoadMonList === "function") window.scheduleLoadMonList("rust-refresh");
        else callMaybe("loadMonList");
      }catch(err){ console.warn(`[${VERSION}] mon list refresh failed`, err); }
    };
    try{
      if(typeof window.requestIdleCallback === "function"){
        window.requestIdleCallback(refresh, {timeout: 1200});
        return;
      }
    }catch(_){}
    window.setTimeout(refresh, 0);
  }

  function schedulePostSolveUi(payload, result){
    window.setTimeout(() => {
      const metrics = payload?.metrics || result?.metrics || {};
      const validatedVisible = {
        scheduled:Math.max(0, metricNumber(metrics.scheduled_periods, 0)),
        expected:Math.max(0, metricNumber(metrics.expected_periods, 0)),
        unassigned:Math.max(0, metricNumber(metrics.unassigned_periods, 0)),
        fromVisibleSchedule:true,
        source:"validated_apply"
      };
      try{ syncVisibleCompletionMetrics(payload, result, validatedVisible); }catch(err){ console.warn(`[${VERSION}] visible completion metrics sync failed`, err); }
      try{ renderSolverPanel(result); }catch(err){ console.warn(`[${VERSION}] solver panel render failed`, err); }
      try{ writeSolverPayloadDom(payload); }catch(err){ console.warn(`[${VERSION}] solver payload dom failed`, err); }
      try{
        const message = buildCompletionMessage(payload, validatedVisible);
        notifyCompletion(payload, validatedVisible, message);
      }catch(err){ console.warn(`[${VERSION}] completion status failed`, err); }
      refreshStatsPopoverIfOpen();
    }, 0);
  }

  function refreshStatsPopoverIfOpen(){
    try{
      const pop = document.getElementById("statsPopover");
      if(!pop || pop.hidden) return;
      // A complete solve can contain thousands of placed periods.  Rendering
      // the whole-school teacher/student scan synchronously here blocks the
      // result-apply turn and makes the terminal UI feel frozen.  The planner
      // already exposes a coalescing, post-paint scheduler for this exact
      // workload; use it when available and retain the direct call only for
      // older pages that do not have the scheduler yet.
      if(typeof window.scheduleStatsBoxRender === "function"){
        window.scheduleStatsBoxRender({onlyIfOpen:true});
      }else{
        callMaybe("renderStatsBox");
      }
    }catch(_){}
  }

  function publishLiveStatsProgress(metricProgress){
    const normalized = metricProgress && typeof metricProgress === "object"
      ? {
          focus:String(metricProgress.focus || ""),
          current:Number(metricProgress.current),
          target:Number(metricProgress.target),
          baseline:Number(metricProgress.baseline),
          percent:Number(metricProgress.percent)
        }
      : null;
    try{ window.__TKB_LIVE_STATS_PROGRESS = normalized; }catch(_){ }
    try{
      const pop = document.getElementById("statsPopover");
      if(pop && !pop.hidden && normalized) callMaybe("updateStatsBoxLiveProgress", [normalized]);
    }catch(_){ }
  }

  function shouldAutoPlaceUnassignedFromUi(before, options){
    if(!before) return false;
    const unassigned = Math.max(0, Number(before.unassigned || 0) || 0);
    if(unassigned <= 0) return false;
    const expected = Math.max(0, Number(before.expected || 0) || 0);
    const scheduled = Math.max(0, Number(before.scheduled || 0) || 0);
    const maxPlace = Math.max(1, Math.round(Number(options?.maxPlace ?? 24) || 24));
    const maxMissing = Math.max(maxPlace, Math.round(Number(options?.nearCompleteMaxMissing ?? maxPlace) || maxPlace));
    return expected > 0 && scheduled > 0 && unassigned <= maxMissing;
  }

  function autoPlaceUnassignedFromUi(reason, options){
    try{
      const fn = window.__tkbAutoPlaceUnassignedLessons;
      if(typeof fn !== "function") return null;
      const before = uiSchoolCompletionStats();
      if(before && Number(before.unassigned || 0) <= 0) return null;
      if(!shouldAutoPlaceUnassignedFromUi(before, options || {})){
        window.__TKB_LAST_LOCAL_UNASSIGNED_REPAIR = {
          reason,
          skipped: true,
          before,
          message: "Bỏ qua vá nhanh vì lịch chưa gần đầy."
        };
        return null;
      }
      const result = fn(Object.assign({maxPlace: 24, reason}, options || {}));
      if(result && Number(result.placed || 0) > 0){
        window.__TKB_LAST_LOCAL_UNASSIGNED_REPAIR = Object.assign({reason}, result);
        refreshStatsPopoverIfOpen();
      }
      return result || null;
    }catch(err){
      console.warn(`[${VERSION}] local unassigned repair failed`, err);
      return null;
    }
  }

  function forceFinishSolveUi(message, state){
    stopProgressTicker();
    finishProgress(state === "error" ? "Lỗi" : "100%", state || "ok");
    window.__TKB_RUST_SOLVER_RUNNING = false;
    window.__TKB_SOLVE_UI_BUSY = false;
    releaseAutoSortButtonSoon();
    if(message) setStatus(message, state === "error" ? "error" : (state === "warning" ? "warning" : "ok"));
  }

  function installFinishWatchdog(){
    const startedAt = Date.now();
    const activeRunId = window.__TKB_ACTIVE_SOLVE_RUN_ID || "";
    const timer = window.setInterval(() => {
      try{
        const data = getData();
        const result = data?.tkbSolverResult || {};
        const runtime = result?.solver?.runtime_settings || {};
        const resultRunId = String(runtime.ui_solve_run_id || runtime.solve_run_id || result.solveRunId || "");
        if(activeRunId && resultRunId !== activeRunId){
          if(Date.now() - startedAt > 20_000 && window.__TKB_RUST_SOLVER_RUNNING === false){
            window.clearInterval(timer);
          }
          return;
        }
        const generatedAt = Date.parse(result.generatedAt || "");
        const freshResult = Number.isFinite(generatedAt) && generatedAt >= startedAt - 1000;
        const metrics = freshResult ? (result.metrics || {}) : {};
        const scheduled = metricNumber(metrics.scheduled_periods);
        const expected = metricNumber(metrics.expected_periods);
        const completion = freshResult ? payloadCompletion({metrics, validation: result.validation || {}, bestEffort: result.metrics?.best_effort}) : {complete:false};
        const hasBackendResult = freshResult && completion.complete && (scheduled > 0 || (expected > 0 && scheduled >= expected));
        const elapsed = Date.now() - startedAt;
        if(hasBackendResult && elapsed > 1200){
          forceFinishSolveUi("", "ok");
          window.clearInterval(timer);
          return;
        }
        if(elapsed > 20_000 && window.__TKB_RUST_SOLVER_RUNNING === false){
          window.clearInterval(timer);
        }
      }catch(_){
        if(Date.now() - startedAt > 20_000) window.clearInterval(timer);
      }
    }, 500);
    return timer;
  }

  function formatDuration(seconds){
    const n = Math.max(0, Math.round(Number(seconds || 0)));
    if(n < 60) return `${n} giây`;
    const minutes = Math.floor(n / 60);
    const rest = String(n % 60).padStart(2, "0");
    return `${minutes}:${rest}`;
  }

  function formatLiveDuration(seconds){
    const n = Math.max(0, Math.floor(Number(seconds || 0)));
    if(n < 60) return `${n} giây`;
    const minutes = Math.floor(n / 60);
    const secs = String(n % 60).padStart(2, "0");
    return `${minutes}:${secs}`;
  }

  function constraintProfile(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo && typeof memo.constraintProfile === "string") return memo.constraintProfile;
    const c = data?.tkbConstraints || {};
    const fixed = c.fixedOff || {};
    const fixedTypes = ["class","teacher","subject","room","subjectGroup"].filter(kind => {
      const obj = fixed[kind];
      return hasTruthyOffMap(obj);
    });
    const hasTeacher = c.teacher && typeof c.teacher === "object" && Object.keys(c.teacher).length > 0;
    const hasSubject = c.subject && typeof c.subject === "object" && Object.keys(c.subject).length > 0;
    const hasSubjectGroup = c.subjectGroup && typeof c.subjectGroup === "object" && Object.keys(c.subjectGroup).length > 0;
    const hasTimeLimit = Array.isArray(c.timeLimit) && c.timeLimit.length > 0;
    const profile = !hasTeacher && !hasSubject && !hasSubjectGroup && !hasTimeLimit && fixedTypes.length === 0
      ? "plain"
      : (!hasTeacher && !hasSubject && !hasSubjectGroup && !hasTimeLimit && fixedTypes.length === 1 && fixedTypes[0] === "class"
          ? "class-fixed-off"
          : (!hasTeacher && !hasSubject && !hasSubjectGroup && !hasTimeLimit && fixedTypes.length > 0
              ? "fixed-off"
              : "constrained"));
    if(memo) memo.constraintProfile = profile;
    return profile;
  }

  function solveTimingProfileKey(settings, data){
    const expected = expectedLessonCount(data);
    const bucket = expected >= 600 ? "600+" : (expected >= 300 ? "300+" : (expected >= 100 ? "100+" : "small"));
    const strategy = String(settings?.auto_sort_strategy || "").trim().toLowerCase() || "auto";
    const mode = normalizedAutoSortMode(settings);
    const refinementRound = Math.max(0, Math.round(Number(settings?.optimization_refinement_round || 0) || 0));
    const refinementTier = refinementRound > 0 ? `|r${Math.min(3, refinementRound)}` : "";
    return `${bucket}|${constraintProfile(data)}|${strategy}|${mode}${refinementTier}`;
  }

  function persistedSolveTimings(data){
    const learning = data?.tkbAdaptiveLearning;
    return learning && typeof learning === "object"
      && learning.solveTimings && typeof learning.solveTimings === "object"
      ? learning.solveTimings
      : {};
  }

  function newestSolveTimingItem(localItem, persistedItem){
    const items = [localItem, persistedItem].filter(item => item && typeof item === "object");
    if(items.length <= 1) return items[0] || null;
    return items.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
  }

  function readSolveTimingEstimate(settings, data){
    try{
      const safeData = data || getData();
      const key = solveTimingProfileKey(settings || {}, safeData);
      const map = JSON.parse(localStorage.getItem(SOLVE_TIMING_KEY) || "{}");
      const item = newestSolveTimingItem(map && map[key], persistedSolveTimings(safeData)[key]);
      const estimate = Number(item?.estimateSeconds || item?.elapsedSeconds || 0);
      if(Number.isFinite(estimate) && estimate > 0) return Math.max(2, Math.min(240, estimate * 1.2));
    }catch(_){}
    return 0;
  }

  function rememberSolveTiming(settings, data, elapsedSeconds){
    const elapsed = Number(elapsedSeconds);
    if(!Number.isFinite(elapsed) || elapsed <= 0) return;
    try{
      const safeData = data || getData();
      const key = solveTimingProfileKey(settings || {}, safeData);
      const map = JSON.parse(localStorage.getItem(SOLVE_TIMING_KEY) || "{}");
      const persisted = persistedSolveTimings(safeData);
      const previousItem = newestSolveTimingItem(map?.[key], persisted[key]);
      const prev = Number(previousItem?.estimateSeconds || 0);
      const estimate = prev > 0 ? (prev * 0.55 + elapsed * 0.45) : elapsed;
      const learnedItem = {
        estimateSeconds: Math.max(1, Math.min(240, estimate)),
        lastElapsedSeconds: elapsed,
        updatedAt: Date.now()
      };
      map[key] = learnedItem;
      localStorage.setItem(SOLVE_TIMING_KEY, JSON.stringify(map));
      if(safeData && typeof safeData === "object"){
        const solveTimings = Object.assign({}, persisted, {[key]:learnedItem});
        const boundedTimings = Object.fromEntries(
          Object.entries(solveTimings)
            .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))
            .slice(0, 24)
        );
        safeData.tkbAdaptiveLearning = Object.assign({}, safeData.tkbAdaptiveLearning || {}, {
          version: 1,
          solveTimings: boundedTimings,
          updatedAt: learnedItem.updatedAt
        });
      }
    }catch(_){}
  }

  function estimateSolveSeconds(settings, data){
    const explicitEstimate = Number(settings?.progress_estimate_seconds || settings?.progressEstimateSeconds || 0);
    if(Number.isFinite(explicitEstimate) && explicitEstimate > 0) return Math.max(2, Math.min(MAX_CUSTOM_SOLVE_DURATION_SECONDS, Math.round(explicitEstimate)));
    if(isTeacherSessionOptSettings(settings)){
      const optLimit = Number(settings?.optimization_time_limit_seconds || settings?.overall_time_limit_seconds || 300);
      return Math.max(30, Math.min(MAX_CUSTOM_SOLVE_DURATION_SECONDS, Number.isFinite(optLimit) && optLimit > 0 ? Math.round(optLimit) : 300));
    }
    const learned = readSolveTimingEstimate(settings || {}, data || getData());
    if(learned > 0) return learned;
    const expected = expectedLessonCount(data || getData());
    const profile = constraintProfile(data || getData());
    const sessionLimit = Number(settings?.session_time_limit || DEFAULT_SETTINGS.session_time_limit);
    const periodLimit = Number(settings?.period_time_limit || DEFAULT_SETTINGS.period_time_limit);
    const integratedLimit = Number(settings?.integrated_time_limit || DEFAULT_SETTINGS.integrated_time_limit);
    const boundedSession = Number.isFinite(sessionLimit) ? Math.max(4, Math.min(sessionLimit, 18)) : 8;
    const boundedPeriod = Number.isFinite(periodLimit) ? Math.max(8, Math.min(periodLimit, 30)) : 20;
    const boundedIntegrated = Number.isFinite(integratedLimit) ? Math.max(30, Math.min(integratedLimit, 120)) : 90;
    let estimate = Math.round(boundedSession * 0.22 + boundedPeriod * 0.16 + boundedIntegrated * 0.01);
    if(expected >= 600) estimate += 2;
    if(profile === "class-fixed-off") estimate = Math.min(4, estimate);
    else if(profile === "fixed-off") estimate += 2;
    else if(profile === "constrained") estimate += 7;
    estimate = Math.max(3, estimate);
    const overallLimit = Number(settings?.overall_time_limit_seconds || DEFAULT_SETTINGS.overall_time_limit_seconds);
    const cappedEstimate = Math.min(90, estimate);
    if(Number.isFinite(overallLimit) && overallLimit > 0) return Math.max(2, Math.min(Math.round(overallLimit), cappedEstimate));
    return cappedEstimate;
  }

  function progressBudgetSeconds(settings, estimateSeconds){
    const customDurationSeconds = customSolveDurationFromSettings(settings);
    if(customDurationSeconds > 0) return customDurationSeconds;
    const estimate = Math.max(1, Number(estimateSeconds || 0) || 1);
    const rawCandidates = [
      Number(settings?.backend_deadline_ms || 0) / 1000,
      Number(settings?.native_global_deadline_ms || 0) / 1000,
      Number(settings?.optimization_time_limit_seconds || 0),
      Number(settings?.overall_time_limit_seconds || 0),
      Number(settings?.integrated_time_limit || 0),
      Number(settings?.ui_unified_refine_ceiling_seconds || 0)
    ].filter(value => Number.isFinite(value) && value > 0);
    const deadline = rawCandidates.length ? Math.max(...rawCandidates) : 0;
    if(settings?.ui_incremental_refine_progress === true){
      const refineBudget = deadline > 0 ? deadline : estimate;
      return Math.max(10, Math.min(MAX_CUSTOM_SOLVE_DURATION_SECONDS, Math.round(refineBudget)));
    }
    const expanded = Math.max(estimate + 60, estimate * 2.4, 120);
    const budget = deadline > 0 ? Math.min(deadline, expanded) : expanded;
    return Math.max(30, Math.min(MAX_CUSTOM_SOLVE_DURATION_SECONDS, Math.round(budget)));
  }

  function progressPhase(ratio){
    if(ratio < 0.12) return "prepare";
    if(ratio < 0.78) return "search";
    if(ratio < 0.94) return "improve";
    return "finish";
  }

  function normalizedAutoSortMode(settings){
    return String(settings?.auto_sort_mode || "fast").trim().toLowerCase().replace(/-/g, "_");
  }

  function isTeacherSessionOptSettings(settings){
    return normalizedAutoSortMode(settings) === "teacher_session_opt";
  }

  function progressUsesWorkMetrics(settings){
    if(!settings || typeof settings !== "object") return false;
    const explicitMode = String(settings.ui_progress_mode || "")
      .trim()
      .toLowerCase();
    if(explicitMode === "work") return true;
    if(explicitMode === "time") return false;
    const requestedMode = String(settings.ui_requested_solve_mode || "").trim();
    if(requestedMode){
      const norm = normalizeSolveRequestMode(requestedMode);
      return norm !== SOLVE_REQUEST_MODES.automatic && norm !== SOLVE_REQUEST_MODES.autoMin2;
    }
    const focus = String(settings.optimization_focus || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    return !!focus && optimizationFocusForSolveRequestMode(focus) !== "automatic";
  }

  function optimizationFocusForSolveRequestMode(value){
    const mode = normalizeSolveRequestMode(value);
    if(mode === SOLVE_REQUEST_MODES.quickComplete) return "quick_complete";
    if(mode === SOLVE_REQUEST_MODES.singletons) return "singletons";
    if(mode === SOLVE_REQUEST_MODES.sessions) return "sessions";
    if([
      SOLVE_REQUEST_MODES.gap2,
      SOLVE_REQUEST_MODES.gap1,
      SOLVE_REQUEST_MODES.gaps
    ].includes(mode)) return "gaps";
    return "automatic";
  }

  function gapOptimizationTargetForSolveRequestMode(value){
    const mode = normalizeSolveRequestMode(value);
    if(mode === SOLVE_REQUEST_MODES.gap2) return "gap2";
    if(mode === SOLVE_REQUEST_MODES.gap1) return "gap1";
    return "";
  }

  // Focused Cloud Run jobs must deduplicate by the semantic solve request,
  // not merely by the browser's school storage scope.  Keep the scope short
  // and PII-free: focus/target identify the objective and the fixed-lock hash
  // prevents a request with a different immutable state from reusing it.
  function backendHybridDedupeScope(settings, data){
    const base = backendScheduleScope();
    const focus = optimizationFocusForSolveRequestMode(
      settings?.ui_requested_solve_mode || settings?.optimization_focus
    );
    const target = String(settings?.optimization_gap_target || "").trim().toLowerCase() || "none";
    const fixed = compactFingerprintHash(JSON.stringify(classOffLocksForFingerprint(data || getData())));
    const deep = settings?.ui_hybrid_deep_optimize === true ? "deep" : "standard";
    return `${base}::hybrid:${focus}:${target}:${deep}:${fixed}`.slice(0, 240);
  }

  // The bridge is the one canonical translation boundary between UI action
  // names and solver settings.  Callers send only `mode`; they must not carry
  // competing focus aliases such as optimization_focus_mode.
  function settingsForSolveRequestMode(requestedMode, baseSettings, data){
    const safeData = data || getData() || {};
    const plan = {
      settings:Object.assign({}, baseSettings || {})
    };
    return applyRequestedSolveModeToPlan(
      plan,
      normalizeSolveRequestMode(requestedMode),
      safeData,
      expectedLessonCount(safeData)
    );
  }

  function solveRequestModeForOptimizationContract(requestedMode, focus, gapTarget){
    const explicit = String(requestedMode || "").trim();
    if(explicit) return normalizeSolveRequestMode(explicit);
    const normalizedGapTarget = normalizedGapOptimizationTarget({
      optimization_gap_target:gapTarget
    });
    if(normalizedGapTarget === "gap2") return SOLVE_REQUEST_MODES.gap2;
    if(normalizedGapTarget === "gap1") return SOLVE_REQUEST_MODES.gap1;
    const normalizedFocus = optimizationFocusForSolveRequestMode(focus);
    if(normalizedFocus === "singletons") return SOLVE_REQUEST_MODES.singletons;
    if(normalizedFocus === "sessions") return SOLVE_REQUEST_MODES.sessions;
    if(normalizedFocus === "gaps") return SOLVE_REQUEST_MODES.gaps;
    if(normalizedFocus === "quick_complete") return SOLVE_REQUEST_MODES.quickComplete;
    return SOLVE_REQUEST_MODES.automatic;
  }

  function settingsForPersistedOptimizationContract(metadata, payload){
    const source = metadata && typeof metadata === "object" ? metadata : {};
    const runtime = payload?.solver?.runtime_settings
      && typeof payload.solver.runtime_settings === "object"
      ? payload.solver.runtime_settings
      : {};
    const mode = solveRequestModeForOptimizationContract(
      source.solveRequestMode || runtime.ui_requested_solve_mode,
      source.optimizationFocus || runtime.optimization_focus,
      source.optimizationGapTarget || runtime.optimization_gap_target
    );
    const settings = {
      ui_requested_solve_mode:mode,
      optimization_focus:optimizationFocusForSolveRequestMode(mode)
    };
    const gapTarget = gapOptimizationTargetForSolveRequestMode(mode)
      || normalizedGapOptimizationTarget({
        optimization_gap_target:
          source.optimizationGapTarget || runtime.optimization_gap_target
      });
    if(gapTarget) settings.optimization_gap_target = gapTarget;
    if(["singletons", "sessions", "gaps"].includes(settings.optimization_focus)){
      settings.optimization_focused_objective_only = true;
      settings.optimization_two_stage_teacher_quality = false;
      settings.ui_keep_better_existing_on_resort = true;
      settings.ui_return_complete_incumbent_on_existing_optimize_failure = true;
    }
    return settings;
  }

  function clearPlanMetricProgress(settings){
    if(!settings || typeof settings !== "object") return settings;
    delete settings.ui_progress_metric_focus;
    delete settings.ui_progress_metric_current;
    delete settings.ui_progress_metric_target;
    delete settings.ui_progress_metric_baseline;
    delete settings.ui_progress_metric_percent;
    delete settings.ui_progress_gap1_baseline;
    delete settings.ui_progress_gap2_baseline;
    return settings;
  }

  function isFreshVisibleProgressSettings(settings){
    if(!settings || typeof settings !== "object") return false;
    const strategy = String(settings.auto_sort_strategy || "").toLowerCase();
    return settings.ui_default_fresh_sort === true
      || settings.ui_initial_fast_draft === true
      || strategy.startsWith("fresh_speed_first")
      || strategy.startsWith("fresh_fast_quality");
  }

  function visibleProgressLimit(settings, ratio){
    if(!isFreshVisibleProgressSettings(settings)) return null;
    return null;
  }

  const BACKEND_LIVE_PROGRESS_PROTOCOL = "tkb-reference-solver-progress-v1";

  function backendProgressStageLabel(stage){
    const value = String(stage || "").trim().toLowerCase();
    if(!value) return "";
    if(value.startsWith("period:")) return "Đang phân tiết";
    if(value.startsWith("validate:")) return "Đang kiểm tra lịch";
    if(value.startsWith("result:") || value.startsWith("output:")) return "Đang nhận kết quả";
    if(value.endsWith(":done")) return "Đang nhận kết quả";
    if(
      value.startsWith("runtime:")
      || value.startsWith("request:")
      || value === "solver:starting"
    ) return "Đang nhận dữ liệu";
    if(value.startsWith("input:")) return "Đã nhận dữ liệu";
    if(value.endsWith(":attempt")) return "Đang thử phương án";
    if(
      value.startsWith("session:")
      || value.startsWith("session_cp_sat:")
      || value.startsWith("integrated:")
      || value.startsWith("fast_benders:")
      || value.includes("feasibility")
      || value.includes("direct_first")
    ) return "Đang tạo lịch hợp lệ";
    if(
      value.startsWith("teacher_session_opt:")
      || value.startsWith("gap0_cp_sat:")
      || value.includes("quality")
      || value.includes("local_lns")
      || value.endsWith(":best")
    ) return "Đang cải thiện phương án";
    return "Đang sắp xếp";
  }

  function recordBackendLiveProgress(snapshot){
    if(!progressState || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
    if(String(snapshot.protocol || "") !== BACKEND_LIVE_PROGRESS_PROTOCOL) return false;
    const stage = String(snapshot.stage || "").trim();
    if(!stage || stage.length > 160 || !/^[a-z0-9_.:-]+$/i.test(stage)) return false;
    const sequence = Number(snapshot.sequence);
    if(!Number.isSafeInteger(sequence) || sequence <= 0) return false;
    const generation = Number(
      snapshot.executionGeneration
      ?? snapshot.execution_generation
      ?? 0
    );
    const normalizedGeneration = Number.isSafeInteger(generation) && generation > 0
      ? generation
      : 0;
    const previousGeneration = Math.max(
      0,
      Number(progressState.backendProgressGeneration || 0) || 0
    );
    if(
      normalizedGeneration > 0
      && previousGeneration > 0
      && normalizedGeneration < previousGeneration
    ) return false;
    if(normalizedGeneration > previousGeneration){
      progressState.backendProgressGenerationPercentFloor = Math.max(
        0,
        Number(progressState.lastPercent || 0) || 0
      );
      progressState.backendProgressGeneration = normalizedGeneration;
      progressState.backendProgressSequence = 0;
      progressState.backendProgressStage = "";
      progressState.backendProgressElapsedMs = 0;
      // Keep the accepted incumbent metric visible while a new VPS/Agent
      // generation is starting. Early lifecycle frames do not always carry a
      // metric; clearing it here made repeated focused runs fall back to the
      // 12% preparation band until the next strict improvement appeared.
      // A metric-bearing frame below will replace this incumbent immediately.
    }
    const previousSequence = Math.max(0, Number(progressState.backendProgressSequence || 0) || 0);
    if(sequence <= previousSequence) return false;
    const elapsedMs = Math.max(0, Math.min(
      SERVER_SOLVER_JOB_MAX_AGE_MS,
      Number(snapshot.elapsedMs || 0) || 0
    ));
    progressState.backendProgressStage = stage;
    progressState.backendProgressSequence = sequence;
    progressState.backendProgressElapsedMs = elapsedMs;
    progressState.backendProgressUpdatedAtMs = Date.now();
    const solveRequestMode = String(
      snapshot.solveRequestMode
      ?? snapshot.solve_request_mode
      ?? ""
    ).trim();
    if(solveRequestMode){
      const normalizedMode = normalizeSolveRequestMode(solveRequestMode);
      const nextProgressSettings = Object.assign({}, progressState.settings || {}, {
        ui_requested_solve_mode:normalizedMode,
        optimization_focus:optimizationFocusForSolveRequestMode(normalizedMode),
        ui_progress_mode:(normalizedMode === SOLVE_REQUEST_MODES.automatic || normalizedMode === SOLVE_REQUEST_MODES.autoMin2) ? "time" : "work"
      });
      const gapTarget = gapOptimizationTargetForSolveRequestMode(normalizedMode);
      if(gapTarget) nextProgressSettings.optimization_gap_target = gapTarget;
      else delete nextProgressSettings.optimization_gap_target;
      progressState.settings = nextProgressSettings;
    }
    const canonicalProgressSnapshot = canonicalizeGapProgressSnapshot(snapshot, getData());
    const metricProgress = normalizeMetricProgressSnapshot(canonicalProgressSnapshot);
    if(metricProgress && progressUsesWorkMetrics(progressState.settings || {})){
      progressState.metricProgress = metricProgress;
    }else if(!progressUsesWorkMetrics(progressState.settings || {})){
      progressState.metricProgress = null;
    }
    publishLiveStatsProgress(progressState.metricProgress);
    try{
      window.__TKB_RUST_LAST_LIVE_PROGRESS = {
        protocol:BACKEND_LIVE_PROGRESS_PROTOCOL,
        stage,
        sequence,
        elapsedMs,
        ...(normalizedGeneration > 0 ? {executionGeneration:normalizedGeneration} : {}),
        ...(solveRequestMode ? {solveRequestMode:normalizeSolveRequestMode(solveRequestMode)} : {}),
        ...(metricProgress ? {
          optimizationFocus:metricProgress.focus,
          metricCurrent:metricProgress.current,
          metricTarget:metricProgress.target,
          metricBaseline:metricProgress.baseline,
          metricPercent:metricProgress.percent
        } : {})
      };
    }catch(_){ }
    tickEstimatedProgress();
    return true;
  }

    function solveActionLabel(settings){
      if(isTeacherSessionOptSettings(settings)) return "Tối ưu";
      if(isFreshVisibleProgressSettings(settings)) return "Xếp mới";
      return "Sắp xếp";
    }

  function progressLabel(_phase, elapsedSeconds, _backendStage){
    // Preserve one combined diagnostic label for resume/E2E state. The visible
    // toolbar receives elapsed and metric as separate fields below.
    const elapsed = formatLiveDuration(elapsedSeconds);
    const metric = progressUsesWorkMetrics(progressState?.settings || {})
      ? metricProgressCurrentLabel(progressState?.metricProgress)
      : "";
    return metric ? `${metric} \u00b7 ${elapsed}` : elapsed;
  }

  function progressDisplayParts(elapsedSeconds){
    return {
      elapsedLabel:formatLiveDuration(elapsedSeconds),
      metricLabel:progressUsesWorkMetrics(progressState?.settings || {})
        ? metricProgressCurrentLabel(progressState?.metricProgress)
        : ""
    };
  }

  function stopProgressTicker(){
    if(progressTimer){
      window.clearInterval(progressTimer);
      progressTimer = 0;
    }
    if(progressFirstPaintTimer){
      window.clearTimeout(progressFirstPaintTimer);
      progressFirstPaintTimer = 0;
    }
  }

  function scheduleFirstProgressPaint(){
    if(!progressState?.deferFirstPaint || progressFirstPaintTimer) return;
    const now = Date.now();
    const uiStartedAt = Number(progressState.uiStartedAt || progressState.startedAt || now) || now;
    const remainingMs = Math.max(
      0,
      FIRST_PROGRESS_PAINT_DELAY_MS - Math.max(0, now - uiStartedAt)
    );
    progressFirstPaintTimer = window.setTimeout(() => {
      progressFirstPaintTimer = 0;
      tickEstimatedProgress();
    }, remainingMs);
  }

  function tickEstimatedProgress(){
    if(!progressState) return;
    const now = Date.now();
    const firstUiStartedAt = Number(progressState.uiStartedAt || progressState.startedAt || now) || now;
    if(
      progressState.deferFirstPaint === true
      && Math.max(0, now - firstUiStartedAt) < FIRST_PROGRESS_PAINT_DELAY_MS
    ){
      scheduleFirstProgressPaint();
      return;
    }
    progressState.deferFirstPaint = false;
    // _setStatus has a short generic timeout. Refresh the one stable running
    // status on every visible progress tick so it cannot disappear mid-solve.
    try{
      if(!isStopRequested()){
        // A running canonical job always has one user-facing status. The
        // reconnecting flag is diagnostic only and must not cause flicker.
        progressState.reconnecting = false;
        setActiveSolveRunningStatus();
      }
    }catch(_){ }
    const serverStartedAtMs = Math.max(0, Number(progressState.serverStartedAtMs || 0) || 0);
    const canonicalServerProgress = serverStartedAtMs > 0 && progressState.backendQueued !== true;
    const elapsedSeconds = canonicalServerProgress
      ? Math.max(0, (now - serverStartedAtMs) / 1000)
      : 0;
    const uiStartedAt = Number(progressState.uiStartedAt || progressState.startedAt || now) || now;
    const uiElapsedSeconds = Math.max(0, (now - uiStartedAt) / 1000);
    const budget = Math.max(1, Number(progressState.progressBudgetSeconds || progressState.estimatedSeconds || 1));
    // The browser that owns the click shows end-to-end user time. A job merely
    // discovered on another device stays on the canonical VPS clock so all
    // observers of that resumed job converge on the same elapsed value.
    const localClickTimeline = progressState.localClickTimeline === true;
    const visibleElapsedSeconds = localClickTimeline
      ? uiElapsedSeconds
      : (canonicalServerProgress ? elapsedSeconds : uiElapsedSeconds);
    if(progressState.phase === "result_apply"){
      const applyPercent = Math.min(
        RESULT_APPLY_PROGRESS_CAP,
        Math.max(4, metricNumber(progressState.lastPercent, 4))
      );
      progressState.lastLabel = progressLabel("result_apply", visibleElapsedSeconds);
      const displayParts = progressDisplayParts(visibleElapsedSeconds);
      setProgress(applyPercent, progressState.lastLabel, {
        replaceLocalPercent:true,
        phase:"result_apply",
        ...displayParts
      });
      return;
    }
    const ratio = Math.min(1, elapsedSeconds / budget);
    const freshCap = visibleProgressLimit(progressState.settings || {}, ratio);
    const cap = canonicalServerProgress
      ? (freshCap != null ? freshCap : SERVER_WAIT_PROGRESS_CAP)
      : PRE_ADMISSION_PROGRESS_CAP;
    // Before admission, advance one visible point per second up to the small
    // preparation band. Once the VPS starts, continue from that band through
    // the remaining solver budget. Both paths are monotonic, so admission can
    // never jump back to 4% or appear frozen at 0 seconds.
    const preAdmissionRatio = Math.min(
      1,
      visibleElapsedSeconds / PRE_ADMISSION_PROGRESS_SECONDS
    );
    const serverAdmissionPercent = localClickTimeline
      ? Math.max(
          4,
          Math.min(
            PRE_ADMISSION_PROGRESS_CAP,
            Number(progressState.serverAdmissionPercent ?? PRE_ADMISSION_PROGRESS_CAP)
              || PRE_ADMISSION_PROGRESS_CAP
          )
        )
      : PRE_ADMISSION_PROGRESS_CAP;
    const estimatedPercent = canonicalServerProgress
      ? Math.round(
          serverAdmissionPercent
          + ratio * (cap - serverAdmissionPercent)
        )
      : Math.round(4 + preAdmissionRatio * (cap - 4));
    const lastPercent = Number(progressState.lastPercent || 0) || 0;
    const generationPercentFloor = Math.max(
      0,
      Number(progressState.backendProgressGenerationPercentFloor || 0) || 0
    );
    const workMetricMode = progressUsesWorkMetrics(progressState.settings || {});
    const metricPercent = Number(progressState.metricProgress?.percent);
    const hasMetricProgress = workMetricMode && Number.isFinite(metricPercent);
    const metricFocus = String(progressState.metricProgress?.focus || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const gapMetricProgress = metricFocus === "teacher_gap_sessions"
      || metricFocus === "teacher_gap1_sessions"
      || metricFocus === "teacher_gap2_sessions";
    // Once the solver publishes a real quality/completion metric, the ring is
    // driven only by that metric. Time remains visible in the compact label but
    // no longer pretends to be percent-complete.
    const percent = hasMetricProgress
      ? (gapMetricProgress
          ? Math.max(0, Math.min(SERVER_WAIT_PROGRESS_CAP, Math.round(metricPercent)))
          : Math.max(
              Math.min(SERVER_WAIT_PROGRESS_CAP, lastPercent),
              Math.min(SERVER_WAIT_PROGRESS_CAP, generationPercentFloor),
              Math.max(0, Math.min(SERVER_WAIT_PROGRESS_CAP, Math.round(metricPercent)))
            ))
      : (!workMetricMode
          ? Math.max(lastPercent, Math.max(4, Math.min(cap, estimatedPercent)))
          : Math.max(0, Math.min(PRE_ADMISSION_PROGRESS_CAP, lastPercent)));
    const phase = progressState.bestEffortStopPending === true
      ? "best_effort_stop"
      : (progressState.backendQueued === true
          ? "queued"
          : (!canonicalServerProgress
              ? "preparing"
              : (elapsedSeconds >= budget
              ? "server_wait"
              : "running")));
    if(phase === "server_wait" && progressState.serverWaitStatusShown !== true){
      progressState.serverWaitStatusShown = true;
    }
    progressState.lastLabel = progressLabel(
      phase,
      visibleElapsedSeconds,
      progressState.backendProgressStage
    );
    setProgress(percent, progressState.lastLabel, {
      replaceLocalPercent:true,
      phase,
      ...progressDisplayParts(visibleElapsedSeconds)
    });
  }

  function startProgressTicker(settings, data){
    const previousLocalClickTimeline = progressState?.localClickTimeline === true;
    const previousDeferFirstPaint = progressState?.deferFirstPaint === true;
    const previousStartedAt = Number(progressState?.startedAt || 0) || 0;
    const previousUiStartedAt = Number(progressState?.uiStartedAt || previousStartedAt || 0) || 0;
    const previousPercent = metricNumber(progressState?.lastPercent, 0);
    const pending = readPendingBackendJob();
    const persistedServerStartedAt = Math.max(0, Number(pending?.solverStartedAtMs || 0) || 0);
    const persistedUiStartedAt = Math.max(0, Number(pending?.uiStartedAtMs || 0) || 0);
    const persistedPercent = normalizePendingProgressPercent(pending?.lastPercent);
    const localClickTimeline = previousLocalClickTimeline || pending?.localClickTimeline === true;
    stopProgressTicker();
    const startedAt = persistedServerStartedAt > 0
      ? Math.min(Date.now(), persistedServerStartedAt)
      : (previousStartedAt > 0 ? previousStartedAt : Date.now());
    const visibleStartCandidates = localClickTimeline
      ? [previousUiStartedAt, persistedUiStartedAt].filter(timestamp => timestamp > 0)
      : [];
    if(localClickTimeline && persistedServerStartedAt > 0){
      visibleStartCandidates.push(persistedServerStartedAt);
    }
    const uiStartedAt = localClickTimeline && visibleStartCandidates.length
      ? Math.min(...visibleStartCandidates)
      : (persistedServerStartedAt || persistedUiStartedAt || startedAt);
    const canonicalServerProgress = persistedServerStartedAt > 0;
    const calculatedEstimateSeconds = estimateSolveSeconds(settings || {}, data || getData());
    const estimatedSeconds = normalizePendingProgressSeconds(pending?.progressEstimateSeconds)
      || calculatedEstimateSeconds;
    const configuredMetricProgress = normalizeMetricProgressSnapshot({
      optimizationFocus:settings?.ui_progress_metric_focus,
      metricCurrent:settings?.ui_progress_metric_current,
      metricTarget:settings?.ui_progress_metric_target,
      metricBaseline:settings?.ui_progress_metric_baseline,
      metricPercent:settings?.ui_progress_metric_percent
    });
    const workMetricMode = progressUsesWorkMetrics(settings || {});
    const initialPercent = workMetricMode && configuredMetricProgress
      ? Math.max(0, Math.min(SERVER_WAIT_PROGRESS_CAP, Math.round(configuredMetricProgress.percent)))
      : (canonicalServerProgress && !localClickTimeline
          ? 3
          : Math.max(3, previousPercent, persistedPercent));
    progressState = {
      startedAt,
      uiStartedAt,
      localClickTimeline,
      serverStartedAtMs:persistedServerStartedAt,
      backendQueued:persistedServerStartedAt <= 0 && !!pending?.jobId,
      estimatedSeconds,
      lastPercent: initialPercent,
      lastLabel: "",
      phase:canonicalServerProgress ? "running" : (pending?.jobId ? "queued" : "preparing"),
      deferFirstPaint:previousDeferFirstPaint
        && Math.max(0, Date.now() - uiStartedAt) < FIRST_PROGRESS_PAINT_DELAY_MS,
      modeLabel: solveActionLabel(settings || {}),
      settings: Object.assign({}, settings || {}),
      metricProgress:workMetricMode
        ? configuredMetricProgress
        : null,
      runIndex:normalizePendingProgressRunIndex(
        pending?.progressRunIndex
        || progressState?.runIndex
        || 1
      )
    };
    publishLiveStatsProgress(progressState.metricProgress);
    progressState.progressBudgetSeconds = normalizePendingProgressSeconds(pending?.progressBudgetSeconds)
      || progressBudgetSeconds(progressState.settings, progressState.estimatedSeconds);
    if(progressState.deferFirstPaint) scheduleFirstProgressPaint();
    else tickEstimatedProgress();
    progressTimer = window.setInterval(tickEstimatedProgress, 1000);
  }

  const ROUTINE_SORTING_STATUS_BASE = "Đang sắp xếp";

  function writeStatus(message, type){
    let handled = false;
    if(typeof window._setStatus === "function"){
      window._setStatus(message, type || "info");
      handled = true;
    }
    const el = document.getElementById("statusMsg");
    if(el){
      if(!handled) el.textContent = message || "";
      const statusText = String(message || "");
      const isRoutineSortingLabel = (type || "info") === "info"
        && [ROUTINE_SORTING_STATUS_BASE].some(base => (
          statusText === base
          || (statusText.startsWith(base) && /^\.{1,3}$/.test(statusText.slice(base.length)))
        ));
      el.classList.toggle("is-auto-sort-running-label", isRoutineSortingLabel);
      el.style.display = message ? "inline-block" : "none";
    }
  }

  function stopStatusDots(){
    if(statusDotsTimer){
      window.clearInterval(statusDotsTimer);
      statusDotsTimer = 0;
    }
    statusDotsFrame = 0;
    statusDotsBase = "";
    statusDotsType = "";
  }

  function startStatusDots(baseText, type){
    const nextBase = String(baseText || "");
    const nextType = String(type || "info");
    if(statusDotsTimer && statusDotsBase === nextBase && statusDotsType === nextType) return;
    stopStatusDots();
    statusDotsBase = nextBase;
    statusDotsType = nextType;
    const tick = () => {
      statusDotsFrame = (statusDotsFrame % 3) + 1;
      writeStatus(`${nextBase}${".".repeat(statusDotsFrame)}`, nextType);
    };
    tick();
    statusDotsTimer = window.setInterval(tick, 420);
  }

  function setStatus(message, type){
    const text = String(message || "");
    if((type || "info") === "info" && text === `${ROUTINE_SORTING_STATUS_BASE}...`){
      startStatusDots(ROUTINE_SORTING_STATUS_BASE, type || "info");
      return;
    }
    stopStatusDots();
    writeStatus(message, type);
  }

  function dismissCompletionPopup(immediate){
    if(completionPopupTimer){
      window.clearTimeout(completionPopupTimer);
      completionPopupTimer = 0;
    }
    const popup = document.getElementById("tkbSolveCompletionPopup");
    if(!popup) return;
    if(immediate){
      popup.remove();
      return;
    }
    popup.style.opacity = "0";
    popup.style.transform = "translate(-50%, -48%) scale(0.98)";
    window.setTimeout(() => popup.remove(), 180);
  }

  function showCompletionPopup(message, type){
    dismissCompletionPopup(true);
    return null;
  }

  function ensureSolverPanel(){
    let panel = document.getElementById("tkbRustSolverStatus");
    if(panel) return panel;
    panel = document.createElement("div");
    panel.id = "tkbRustSolverStatus";
    panel.style.cssText = [
      "margin:10px 0",
      "padding:10px 12px",
      "border:1px solid #d7e0f2",
      "border-radius:8px",
      "background:#f8fbff",
      "font:13px/1.45 Arial,sans-serif",
      "color:#172033",
      "display:none"
    ].join(";");
    const anchor = document.querySelector(".toolbar,.topbar,#statusMsg,main,body");
    if(anchor && anchor.parentNode && anchor !== document.body){
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }else{
      document.body.insertBefore(panel, document.body.firstChild);
    }
    return panel;
  }

  function renderSolverPanel(result){
    document.getElementById("tkbRustSolverStatus")?.remove();
  }

  function writeSolverPayloadDom(payload){
    try{
      document.getElementById("tkbRustSolverPayloadJson")?.remove();
      const script = document.createElement("script");
      script.id = "tkbRustSolverPayloadJson";
      script.type = "application/json";
      const metrics = payload?.metrics || {};
      script.textContent = JSON.stringify({
        version: VERSION,
        generatedAt: payload?.generatedAt || "",
        metrics,
        solver: payload?.solver || null,
        validation: payload?.validation ? {
          hard_ok: payload.validation.hard_ok,
          warnings: Array.isArray(payload.validation.warnings) ? payload.validation.warnings.slice(0, 20) : []
        } : null,
        unassignedCount: Array.isArray(payload?.unassignedLessons) ? payload.unassignedLessons.length : 0,
        warnings: Array.isArray(payload?.warnings) ? payload.warnings.slice(0, 20) : []
      });
      document.body.appendChild(script);
    }catch(err){
      console.warn(`[${VERSION}] failed to write e2e payload`, err);
    }
  }

  function metricNumber(value, fallback){
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function clonePlain(value){
    try{
      return value == null ? value : JSON.parse(JSON.stringify(value));
    }catch(_){
      return value;
    }
  }

  function refinementLearningCandidate(value){
    if(!value || typeof value !== "object") return null;
    if(value.school_signature != null && value.operators && typeof value.operators === "object"){
      return value;
    }
    const solver = value.solver && typeof value.solver === "object" ? value.solver : {};
    const optimization = solver.teacher_session_optimization
      && typeof solver.teacher_session_optimization === "object"
      ? solver.teacher_session_optimization
      : {};
    const runtime = solver.runtime_settings && typeof solver.runtime_settings === "object"
      ? solver.runtime_settings
      : {};
    return optimization.refinement_learning || runtime.refinement_learning || null;
  }

  function sanitizeRefinementLearning(value){
    const raw = refinementLearningCandidate(value);
    if(!raw || typeof raw !== "object") return null;
    const signature = Math.round(Number(raw.school_signature || 0) || 0);
    if(!Number.isSafeInteger(signature) || signature <= 0) return null;
    const rawOperators = raw.operators && typeof raw.operators === "object"
      ? raw.operators
      : {};
    const operators = {};
    REFINEMENT_OPERATOR_NAMES.forEach(name => {
      const source = rawOperators[name];
      if(!source || typeof source !== "object") return;
      const attempts = Math.max(0, Math.min(10000, Math.round(Number(source.attempts || 0) || 0)));
      if(attempts <= 0) return;
      operators[name] = {
        attempts,
        improvements:Math.max(
          0,
          Math.min(attempts, Math.round(Number(source.improvements || 0) || 0))
        ),
        reward:Number(Math.max(0, Math.min(1000000, Number(source.reward || 0) || 0)).toFixed(6)),
        seconds:Number(Math.max(0, Math.min(1000000, Number(source.seconds || 0) || 0)).toFixed(6)),
        last_round:Math.max(0, Math.round(Number(source.last_round || 0) || 0))
      };
    });
    return {
      version:Math.max(2, Math.round(Number(raw.version || 2) || 2)),
      school_signature:signature,
      total_attempts:Object.values(operators).reduce((sum, item) => sum + item.attempts, 0),
      operators
    };
  }

  function mergeRefinementLearning(currentValue, incomingValue){
    const current = sanitizeRefinementLearning(currentValue);
    const incoming = sanitizeRefinementLearning(incomingValue);
    if(!incoming) return current;
    if(!current || current.school_signature !== incoming.school_signature) return incoming;
    const operators = {};
    REFINEMENT_OPERATOR_NAMES.forEach(name => {
      const left = current.operators?.[name];
      const right = incoming.operators?.[name];
      if(!left && !right) return;
      if(!left){ operators[name] = right; return; }
      if(!right){ operators[name] = left; return; }
      if(right.attempts > left.attempts){ operators[name] = right; return; }
      if(left.attempts > right.attempts){ operators[name] = left; return; }
      operators[name] = {
        attempts:left.attempts,
        improvements:Math.min(left.attempts, Math.max(left.improvements, right.improvements)),
        reward:Number(Math.max(left.reward, right.reward).toFixed(6)),
        seconds:Number(Math.max(left.seconds, right.seconds).toFixed(6)),
        last_round:Math.max(left.last_round, right.last_round)
      };
    });
    return {
      version:Math.max(current.version, incoming.version),
      school_signature:current.school_signature,
      total_attempts:Object.values(operators).reduce((sum, item) => sum + item.attempts, 0),
      operators
    };
  }

  function rememberRefinementLearning(data, payload, persist = false){
    if(!data || typeof data !== "object") return false;
    const merged = mergeRefinementLearning(data[REFINEMENT_LEARNING_DATA_KEY], payload);
    if(!merged) return false;
    const before = sanitizeRefinementLearning(data[REFINEMENT_LEARNING_DATA_KEY]);
    if(JSON.stringify(before) === JSON.stringify(merged)) return false;
    data[REFINEMENT_LEARNING_DATA_KEY] = clonePlain(merged);
    if(persist){
      try{ callMaybe("saveStore", [{force:true, suppressHistory:true}]); }catch(_){}
    }
    return true;
  }

  function traceSolveStep(step, detail){
    try{
      const item = {
        step: String(step || ""),
        at: new Date().toISOString()
      };
      if(detail && typeof detail === "object") item.detail = detail;
      const list = Array.isArray(window.__TKB_SOLVE_TRACE) ? window.__TKB_SOLVE_TRACE.slice(-60) : [];
      list.push(item);
      window.__TKB_SOLVE_TRACE = list;
      window.__TKB_SOLVE_TRACE_LAST = item;
      let node = document.getElementById("__tkbSolveTraceDom");
      if(!node){
        node = document.createElement("script");
        node.type = "application/json";
        node.id = "__tkbSolveTraceDom";
        document.documentElement.appendChild(node);
      }
      node.textContent = JSON.stringify({last:item, trace:list.slice(-20)});
    }catch(_){}
  }

  function compactSolverResultForSnapshot(payload){
    if(!payload || typeof payload !== "object") return payload || null;
    const metrics = payload.metrics && typeof payload.metrics === "object"
      ? Object.assign({}, payload.metrics)
      : {};
    [
      "gap_sessions",
      "teacher_gap1_sessions",
      "teacher_gap_periods",
      "assignment_mismatches",
      "app_constraint_violations",
      "app_constraint_warnings",
      "class_session_violations",
      "contiguous_block_violations"
    ].forEach(key => {
      if(Array.isArray(metrics[key]) || (metrics[key] && typeof metrics[key] === "object")) delete metrics[key];
    });
    return {
      version: payload.version,
      generatedAt: payload.generatedAt,
      inputs: payload.inputs || {},
      metrics,
      validation: payload.validation || {},
      solver: payload.solver || {},
      warnings: Array.isArray(payload.warnings) ? payload.warnings.slice(0, 20) : [],
      unassignedLessons: Array.isArray(payload.unassignedLessons) ? payload.unassignedLessons.slice(0, 80) : []
    };
  }

  function dataForSolverRequest(data, settings){
    const allowWarmStart = isTruthySetting(settings?.allow_solver_warm_start)
      || isTruthySetting(settings?.preserve_existing_tkb)
      || ["preserve_existing", "preserve-existing", "preserve"].includes(String(settings?.auto_sort_strategy || "").trim().toLowerCase());
    const carryCompleteIncumbentLessons = String(settings?.ui_unified_solve_kind || "")
      .trim()
      .toLowerCase()
      .replace(/-/g, "_") === "refine_complete"
      && isTruthySetting(settings?.ui_use_existing_complete_incumbent)
      && isTruthySetting(settings?.ui_existing_incumbent_revalidated);
    const requestSource = Object.assign({}, data || {});
    if(!allowWarmStart){
      delete requestSource.tkbSolverResult;
      delete requestSource.tkbRustSolverResult;
      delete requestSource.tkbSolverPayload;
      delete requestSource.solverResult;
      delete requestSource.solverMetrics;
    }else if(requestSource.tkbSolverResult){
      const incumbent = requestSource.tkbSolverResult;
      let compactIncumbent = compactSolverResultForSnapshot(incumbent);
      if(
        carryCompleteIncumbentLessons
        && compactIncumbent
        && typeof compactIncumbent === "object"
      ){
        // The visible timetable is authoritative after apply-time fixed-lock
        // restoration.  An older solver payload may still contain the
        // pre-restoration slots; sending those lessons back to the Agent makes
        // every improved checkpoint fail canonical fixed-lesson validation.
        const visibleIncumbentLessons = visibleScheduleLessonsFromData(data);
        const incumbentLessons = Array.isArray(visibleIncumbentLessons) && visibleIncumbentLessons.length
          ? visibleIncumbentLessons
          : incumbent.lessons;
        compactIncumbent = visibleCompleteIncumbentQualityPayload(data, compactIncumbent)
          || compactIncumbent;
        if(Array.isArray(incumbentLessons) && incumbentLessons.length){
          compactIncumbent.lessons = incumbentLessons;
        }
      }
      requestSource.tkbSolverResult = compactIncumbent;
    }
    const next = clonePlain(requestSource);
    if(!next || typeof next !== "object") return next;
    stripFixedLessonOffForSolver(data, next);
    sanitizeTeacherMustTeachForSolverRequest(next);
    if(!allowWarmStart) delete next.tkbSolverResult;
    delete next.tkbRustSolverResult;
    delete next.tkbSolverPayload;
    delete next.solverResult;
    delete next.solverMetrics;
    const preserveExisting = isTruthySetting(settings?.preserve_existing_tkb)
      || ["preserve_existing", "preserve-existing", "preserve"].includes(String(settings?.auto_sort_strategy || "").trim().toLowerCase());
    if(!preserveExisting){
      const fixedOnlyTkb = fixedOnlyTkbForSolverRequest(data, {
        includeOff:settings?.ui_preserve_off_cells_in_solver_request === true
      });
      const mustTeachAnchorCount = addMustTeachAnchorsToFixedOnlyTkb(data, fixedOnlyTkb);
      if(Object.keys(fixedOnlyTkb).length){
        next.tkb = fixedOnlyTkb;
        next.__tkbRequestFixedScheduleOnly = true;
        if(mustTeachAnchorCount > 0) next.__tkbRequestMustTeachAnchors = mustTeachAnchorCount;
      }else{
        delete next.tkb;
      }
      delete next.tkbLessonTeachers;
      delete next.tkbLessonRooms;
      next.__tkbRequestStrippedSchedule = true;
    }
    return next;
  }

  function shouldBuildClientFastSeed(data, settings){
    if(!data || !settings) return false;
    if(typeof window.Worker !== "function") return false;
    if(settings.ui_resume_existing_server_job_only === true) return false;
    if(settings.optimize_existing_schedule === true || isTruthySetting(settings.preserve_existing_tkb)) return false;
    if(String(settings.optimization_focus || "automatic").trim().toLowerCase() !== "automatic") return false;
    const solveKind = String(settings.ui_unified_solve_kind || "").trim().toLowerCase().replace(/-/g, "_");
    if(solveKind !== "fresh_complete_first") return false;
    const expected = expectedLessonCount(data);
    const scheduled = countScheduledLessons(data);
    return expected >= 300 && scheduled < expected;
  }

  function compactClientFastSeed(result){
    if(!result || result.ok !== true || !Array.isArray(result.lessons)) return null;
    const expected = Math.max(0, Number(result.expectedPeriods || 0) || 0);
    const scheduled = result.lessons.length;
    if(expected <= 0 || scheduled <= 0 || scheduled > expected) return null;
    if(scheduled / expected < 0.85) return null;
    return {
      version:String(result.version || "tkb-fast-seed-v1"),
      lessons:result.lessons.map(item => ({
        classId:String(item?.classId || ""),
        className:String(item?.className || ""),
        subject:String(item?.subject || ""),
        teacher:String(item?.teacher || ""),
        room:String(item?.room || ""),
        day:Number(item?.day || 0),
        session:String(item?.session || ""),
        period:Number(item?.period || 0)
      })),
      elapsedMs:Math.max(0, Number(result.elapsedMs || 0) || 0),
      attempts:Math.max(0, Number(result.attempts || 0) || 0),
      seed:Math.max(1, Number(result.seed || 1) || 1),
      clientExpectedPeriods:expected,
      clientScheduledPeriods:scheduled
    };
  }

  function buildClientFastSeed(data, settings, signal){
    if(!shouldBuildClientFastSeed(data, settings)) return Promise.resolve(null);
    const expected = expectedLessonCount(data);
    const maxMs = expected >= 2000 ? 4_500 : 2_800;
    const workerUrl = "tkb-fast-seed-worker.js?v=20260811-hybrid-fast-seed-v1";
    return new Promise(resolve => {
      let settled = false;
      let worker = null;
      let timer = 0;
      const finish = value => {
        if(settled) return;
        settled = true;
        if(timer) window.clearTimeout(timer);
        try{ worker?.terminate?.(); }catch(_){ }
        resolve(value || null);
      };
      try{
        worker = new window.Worker(workerUrl);
        worker.onmessage = event => finish(
          event?.data?.ok === true ? compactClientFastSeed(event.data.result) : null
        );
        worker.onerror = () => finish(null);
        timer = window.setTimeout(() => finish(null), maxMs + 1_500);
        if(signal){
          if(signal.aborted) return finish(null);
          signal.addEventListener("abort", () => finish(null), {once:true});
        }
        worker.postMessage({
          data,
          options:{
            maxMs,
            attempts:24,
            seed:Math.max(1, Number(settings.random_seed || makeRandomSeed()) || 1)
          }
        });
      }catch(_){
        finish(null);
      }
    });
  }

  function classAliasIdsForFixedOff(data, classId){
    const ids = new Set([String(classId || "").trim()].filter(Boolean));
    try{
      const lop = (data?.lop || []).find(item => {
        return [item?.id, item?.ten, item?.ten2, item?.ma, item?.name]
          .map(value => String(value || "").trim())
          .filter(Boolean)
          .some(value => value === String(classId || "").trim());
      });
      if(lop){
        [lop.id, lop.ten, lop.ten2, lop.ma, lop.name].forEach(value => {
          const text = String(value || "").trim();
          if(text) ids.add(text);
        });
      }
    }catch(_){}
    return Array.from(ids);
  }

  function removeFixedOffSlotForIds(root, ids, slotKeyValue){
    if(!root || typeof root !== "object") return 0;
    const wanted = Array.from(new Set((ids || []).map(id => String(id || "").trim()).filter(Boolean)));
    if(!wanted.length) return 0;
    const wantedLower = new Set(wanted.map(id => id.toLowerCase()));
    let removed = 0;
    const removeFromId = id => {
      const text = String(id || "").trim();
      if(!text || !root[text]) return;
      const raw = root[text];
      if(Array.isArray(raw)){
        const before = raw.length;
        root[text] = raw.filter(item => String(item) !== slotKeyValue);
        removed += before - root[text].length;
        if(!root[text].length) delete root[text];
      }else if(raw && typeof raw === "object" && raw[slotKeyValue]){
        delete raw[slotKeyValue];
        removed += 1;
        if(!Object.keys(raw).length) delete root[text];
      }
    };
    wanted.forEach(removeFromId);
    Object.keys(root).forEach(id => {
      if(wantedLower.has(String(id || "").trim().toLowerCase())) removeFromId(id);
    });
    return removed;
  }

  function fixedLessonSubjectIds(subject){
    const out = new Set();
    const add = value => {
      const text = String(value || "").trim();
      if(!text) return;
      out.add(text);
      out.add(subjectKey(text));
    };
    add(subject);
    try{
      if(typeof findMonHoc === "function"){
        const meta = findMonHoc(subject);
        ["ten", "ma", "ma2", "id"].forEach(key => add(meta?.[key]));
      }
    }catch(_){}
    return Array.from(out).filter(Boolean);
  }

  function stripFixedLessonOffForSolver(sourceData, requestData){
    const fixedLocks = collectFixedLessonLocks(sourceData);
    if(!fixedLocks || !fixedLocks.size || !requestData || typeof requestData !== "object") return 0;
    let removed = 0;
    fixedLocks.forEach((lock, key) => {
      const parts = String(key || "").split("|");
      if(parts.length !== 4) return;
      const [classId, thu, buoi, tiRaw] = parts;
      const slotKey = `${thu}|${buoi}|${Number(tiRaw)}`;
      const subject = fixedLessonLockSubject(lock);
      classAliasIdsForFixedOff(sourceData, classId).forEach(id => {
        const userOff = requestData.tkbUserOff?.[id];
        if(Array.isArray(userOff)){
          const before = userOff.length;
          requestData.tkbUserOff[id] = userOff.filter(item => String(item) !== slotKey);
          if(requestData.tkbUserOff[id].length !== before) removed += before - requestData.tkbUserOff[id].length;
        }else if(userOff && typeof userOff === "object" && userOff[slotKey]){
          delete userOff[slotKey];
          removed += 1;
        }
        const fixedClass = requestData.tkbConstraints?.fixedOff?.class?.[id];
        if(fixedClass && typeof fixedClass === "object" && fixedClass[slotKey]){
          delete fixedClass[slotKey];
          removed += 1;
        }
      });
      const fixedOff = requestData.tkbConstraints?.fixedOff || {};
      const teachers = rescueTeacherList(rescueTeacherFor(sourceData, classId, subject));
      removed += removeFixedOffSlotForIds(fixedOff.teacher, teachers, slotKey);
      removed += removeFixedOffSlotForIds(fixedOff.subject, fixedLessonSubjectIds(subject), slotKey);
      const room = rescueRoomFor(sourceData, classId, subject);
      removed += removeFixedOffSlotForIds(fixedOff.room, room ? [room] : [], slotKey);
    });
    try{
      requestData.__tkbFixedLessonOffIgnored = removed;
      requestData.__tkbFixedLessonClassOffIgnored = removed;
    }catch(_){}
    return removed;
  }

  function classOffIdsForMustTeach(data, classRow){
    const ids = new Set();
    const add = value => {
      const text = String(value || "").trim();
      if(text) ids.add(text);
    };
    add(classRow?.id);
    add(classRow?.ten);
    add(classRow?.ten2);
    add(classRow?.ma);
    add(classRow?.name);
    return Array.from(ids);
  }

  function slotOffForAnyId(root, ids, key){
    if(!root || typeof root !== "object") return false;
    const wanted = [];
    (ids || []).forEach(id => {
      const text = String(id || "").trim();
      if(text) wanted.push(text);
    });
    return wanted.some(id => fixedOffSlotMapHas(root[id], key));
  }

  function classSlotOffForMustTeach(data, classRow, key){
    const ids = classOffIdsForMustTeach(data, classRow);
    return slotOffForAnyId(data?.tkbUserOff, ids, key)
      || slotOffForAnyId(data?.tkbConstraints?.fixedOff?.class, ids, key);
  }

  function classesForTeacherMustTeach(data, teacher){
    const rows = [];
    const seen = new Set();
    (data?.lop || []).forEach(cls => {
      const classId = String(cls?.id || cls?.ten2 || cls?.ten || "").trim();
      if(!classId) return;
      const subjects = rescueSubjectList(data, cls);
      const matches = subjects.some(subject => {
        const teachers = rescueTeacherList(rescueTeacherFor(data, classId, subject?.ten || subject));
        return teachers.some(item => sameTeacherCode(item, teacher));
      });
      if(!matches) return;
      const key = String(classId || "").toLowerCase();
      if(seen.has(key)) return;
      seen.add(key);
      rows.push(cls);
    });
    return rows;
  }

  function teacherMustTeachSlotHasClassRoom(data, teacher, slotKeyValue){
    const parsed = parseOffKey(slotKeyValue);
    if(!parsed) return true;
    const rows = classesForTeacherMustTeach(data, teacher);
    if(!rows.length) return true;
    return rows.some(cls => !classSlotOffForMustTeach(data, cls, parsed.key));
  }

  function sanitizeTeacherMustTeachForSolverRequest(data){
    const rules = data?.tkbConstraints?.teacher;
    if(!rules || typeof rules !== "object") return 0;
    let removed = 0;
    Object.entries(rules).forEach(([teacher, rule]) => {
      const slots = rule?.mustTeach;
      if(!slots || typeof slots !== "object") return;
      Object.keys(slots).forEach(key => {
        if(!slots[key]) return;
        if(teacherMustTeachSlotHasClassRoom(data, teacher, key)) return;
        delete slots[key];
        removed += 1;
      });
      if(!Object.keys(slots).length) delete rule.mustTeach;
    });
    if(removed > 0) data.__tkbIgnoredImpossibleMustTeachSlots = removed;
    return removed;
  }

  function fixedOnlyTkbForSolverRequest(data, options){
    const includeOff = options?.includeOff === true;
    const out = {};
    Object.entries(data?.tkb || {}).forEach(([classId, tkb]) => {
      let classTkb = null;
      ["thu2","thu3","thu4","thu5","thu6","thu7"].forEach(thu => {
        ["sang","chieu"].forEach(buoi => {
          (tkb?.[thu]?.[buoi] || []).forEach((value, ti) => {
            const subject = cellSubjectText(value);
            const keepOff = includeOff && subject === "OFF";
            if(!keepOff && !isFixedScheduledCell(value)) return;
            if(!subject) return;
            if(!classTkb) classTkb = makeEmptyTKB();
            const arr = classTkb?.[thu]?.[buoi];
            if(arr && ti >= 0 && ti < arr.length){
              arr[ti] = keepOff ? "OFF" : {mon: subject, fixed: true};
            }
          });
        });
      });
      if(classTkb) out[classId] = classTkb;
    });
    return out;
  }

  function sameTeacherCode(left, right){
    const a = String(left || "").trim();
    const b = String(right || "").trim();
    return !!a && !!b && (a === b || a.toLowerCase() === b.toLowerCase());
  }

  function addMustTeachAnchorsToFixedOnlyTkb(data, fixedOnlyTkb){
    const rules = data?.tkbConstraints?.teacher || {};
    if(!data?.tkb || !rules || typeof rules !== "object") return 0;
    const anchored = new Set();
    let count = 0;
    Object.entries(rules).forEach(([teacher, rule]) => {
      const slots = rule?.mustTeach || {};
      if(!slots || typeof slots !== "object") return;
      Object.keys(slots).forEach(slotKeyValue => {
        if(!slots[slotKeyValue]) return;
        const parsed = parseOffKey(slotKeyValue);
        if(!parsed) return;
        const anchorKey = `${String(teacher || "").toLowerCase()}|${parsed.key}`;
        if(anchored.has(anchorKey)) return;
        for(const [classId, tkb] of Object.entries(data.tkb || {})){
          const arr = tkb?.[parsed.thu]?.[parsed.buoi];
          if(!Array.isArray(arr) || parsed.ti < 0 || parsed.ti >= arr.length) continue;
          const value = arr[parsed.ti];
          const subject = cellSubjectText(value);
          if(!subject || subject === "OFF") continue;
          const teachers = rescueTeacherList(rescueTeacherFor(data, classId, subject));
          if(!teachers.some(item => sameTeacherCode(item, teacher))) continue;
          if(!fixedOnlyTkb[classId]) fixedOnlyTkb[classId] = makeEmptyTKB();
          const target = fixedOnlyTkb[classId]?.[parsed.thu]?.[parsed.buoi];
          if(Array.isArray(target) && !isScheduledCell(target[parsed.ti])){
            target[parsed.ti] = {mon: subject, fixed: true};
            count += 1;
          }
          anchored.add(anchorKey);
          break;
        }
      });
    });
    return count;
  }

  function snapshotScheduleData(data){
    if(!data || typeof data !== "object") return null;
    return {
      tkb: clonePlain(data.tkb || {}),
      tkbLessonTeachers: clonePlain(data.tkbLessonTeachers || {}),
      tkbLessonRooms: clonePlain(data.tkbLessonRooms || {}),
      tkbSolverResult: clonePlain(compactSolverResultForSnapshot(data.tkbSolverResult || null))
    };
  }

  function snapshotScheduledLessonCount(snapshot){
    if(!snapshot || typeof snapshot !== "object") return 0;
    return countScheduledLessons({tkb: snapshot.tkb || {}});
  }

  function restoreScheduleData(data, snapshot){
    if(!data || !snapshot) return;
    data.tkb = clonePlain(snapshot.tkb || {});
    data.tkbLessonTeachers = clonePlain(snapshot.tkbLessonTeachers || {});
    data.tkbLessonRooms = clonePlain(snapshot.tkbLessonRooms || {});
    if(snapshot.tkbSolverResult) data.tkbSolverResult = clonePlain(snapshot.tkbSolverResult);
    else delete data.tkbSolverResult;
    try{ callMaybe("saveStore", [{force:true}]); }catch(_){}
    scheduleUiRefresh();
  }

  function restoreUnimprovedRefinementSnapshot(data, snapshot, candidatePayload){
    if(!data || !snapshot) return null;
    // Keep the visible incumbent, but remember that this refinement round was
    // already explored so the next Play advances to a different trajectory.
    inheritRefinementRound(snapshot.tkbSolverResult, candidatePayload);
    restoreScheduleData(data, snapshot);
    return data.tkbSolverResult || snapshot.tkbSolverResult || null;
  }

  function restoreFailedConstraintRepairSnapshot(result, releasedCount, data, snapshot){
    if(result || Math.max(0, Number(releasedCount || 0) || 0) <= 0 || !data || !snapshot) return false;
    restoreScheduleData(data, snapshot);
    window.__TKB_SOLVE_RELEASED_CONSTRAINT_VIOLATIONS = 0;
    return true;
  }

  function cellFingerprintValue(value){
    if(value == null) return "";
    if(typeof value === "string") return value;
    if(typeof value === "number" || typeof value === "boolean") return String(value);
    if(typeof value === "object"){
      const subject = value.mon ?? value.subject ?? value.name ?? value.ten ?? "";
      const fixed = value.fixed === true ? "fixed" : "";
      return [subject, fixed].filter(Boolean).join("#");
    }
    return String(value);
  }

  function scheduleFingerprintFromParts(tkb, teachers, rooms){
    const rows = [];
    const root = tkb && typeof tkb === "object" ? tkb : {};
    Object.keys(root).sort().forEach(classId => {
      const byDay = root[classId] && typeof root[classId] === "object" ? root[classId] : {};
      Object.keys(byDay).sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b))).forEach(day => {
        const bySession = byDay[day] && typeof byDay[day] === "object" ? byDay[day] : {};
        Object.keys(bySession).sort().forEach(session => {
          const periods = Array.isArray(bySession[session]) ? bySession[session] : [];
          periods.forEach((cell, index) => {
            const value = cellFingerprintValue(cell);
            if(value) rows.push(["S", classId, day, session, index, value].join("\u001f"));
          });
        });
      });
    });
    const teacherMap = teachers && typeof teachers === "object" ? teachers : {};
    Object.keys(teacherMap).sort().forEach(key => {
      const value = String(teacherMap[key] == null ? "" : teacherMap[key]);
      if(value) rows.push(["T", key, value].join("\u001f"));
    });
    const roomMap = rooms && typeof rooms === "object" ? rooms : {};
    Object.keys(roomMap).sort().forEach(key => {
      const value = String(roomMap[key] == null ? "" : roomMap[key]);
      if(value) rows.push(["R", key, value].join("\u001f"));
    });
    return rows.join("\n");
  }

  function scheduleFingerprintFromSnapshot(snapshot){
    if(!snapshot) return "";
    return scheduleFingerprintFromParts(snapshot.tkb, snapshot.tkbLessonTeachers, snapshot.tkbLessonRooms);
  }

  function scheduleFingerprintFromData(data){
    if(!data) return "";
    return scheduleFingerprintFromParts(data.tkb, data.tkbLessonTeachers, data.tkbLessonRooms);
  }

  function stableFingerprintClone(value, seen){
    if(value == null) return null;
    const type = typeof value;
    if(type === "string" || type === "boolean") return value;
    if(type === "number") return Number.isFinite(value) ? value : null;
    if(type !== "object") return null;
    const visited = seen || new WeakSet();
    if(visited.has(value)) return "[Circular]";
    visited.add(value);
    if(Array.isArray(value)){
      const result = value.map(item => stableFingerprintClone(item, visited));
      visited.delete(value);
      return result;
    }
    const result = {};
    Object.keys(value).sort().forEach(key => {
      const item = value[key];
      if(typeof item === "undefined" || typeof item === "function") return;
      const cloned = stableFingerprintClone(item, visited);
      if(
        cloned
        && typeof cloned === "object"
        && !Array.isArray(cloned)
        && Object.keys(cloned).length === 0
      ) return;
      result[key] = cloned;
    });
    visited.delete(value);
    return result;
  }

  function compactFingerprintHash(text){
    const value = String(text || "");
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for(let index = 0; index < value.length; index += 1){
      const code = value.charCodeAt(index);
      left = Math.imul(left ^ (code & 0xff), 0x01000193);
      left = Math.imul(left ^ (code >>> 8), 0x01000193);
      right = Math.imul(right ^ code, 0x85ebca6b);
      right ^= right >>> 13;
    }
    return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
  }

  function classOffLocksForFingerprint(data){
    const collected = {};
    const add = (classId, key) => {
      const id = String(classId || "").trim();
      const parsed = parseOffKey(key);
      if(!id || !parsed) return;
      if(!collected[id]) collected[id] = new Set();
      collected[id].add(parsed.key);
    };
    const collect = source => {
      Object.entries(source && typeof source === "object" ? source : {}).forEach(([classId, raw]) => {
        if(Array.isArray(raw)){
          raw.forEach(key => add(classId, key));
          return;
        }
        if(!raw || typeof raw !== "object") return;
        Object.entries(raw).forEach(([key, enabled]) => {
          if(isTruthySetting(enabled)) add(classId, key);
        });
      });
    };
    collect(data?.tkbUserOff);
    collect(data?.tkbConstraints?.fixedOff?.class);
    const normalized = {};
    Object.keys(collected).sort().forEach(classId => {
      const keys = Array.from(collected[classId] || []).sort();
      if(keys.length) normalized[classId] = keys;
    });
    return normalized;
  }

  function constraintsForDurableFingerprint(raw){
    const constraints = stableFingerprintClone(raw);
    if(!constraints || typeof constraints !== "object" || Array.isArray(constraints)) return null;
    // These values are UI/cache metadata. defaultGroupsSig embeds an in-memory
    // cache revision, so it can change after a reload while the constraints do not.
    delete constraints.version;
    delete constraints.meta;
    const groups = constraints.groups;
    if(groups && typeof groups === "object"){
      ["class","teacher","subject","room"].forEach(type => {
        const items = groups[type];
        if(!items || typeof items !== "object") return;
        delete items.all;
        if(type === "class"){
          Object.keys(items).forEach(id => {
            if(/^khoi_\d+$/i.test(String(id || ""))) delete items[id];
          });
        }
      });
    }
    // Class off-slots exist in two legacy mirrors. Hash their semantic union
    // separately so synchronizing one mirror cannot make a running job look stale.
    if(constraints.fixedOff && typeof constraints.fixedOff === "object"){
      delete constraints.fixedOff.class;
    }
    return constraints;
  }

  function legacyV2ScheduleFingerprint(data){
    if(!data || typeof data !== "object") return "";
    const solverRelevant = {};
    [
      "lop",
      "mon",
      "monhoc",
      "giaovien",
      "phong",
      "pccmMatrix",
      "pccmTietMatrix",
      "pccmRoomMatrix",
      "pccmGioihanMatrix",
      "tkb",
      "tkbLessonTeachers",
      "tkbLessonRooms",
      "tkbConfig",
      "tkbUserOff",
      "tkbConstraints"
    ].forEach(key => {
      if(Object.prototype.hasOwnProperty.call(data, key)) solverRelevant[key] = data[key];
    });
    const serialized = JSON.stringify(stableFingerprintClone(solverRelevant));
    return `v2:${compactFingerprintHash(serialized)}:${serialized.length}`;
  }

  function durableScheduleFingerprint(data){
    if(!data || typeof data !== "object") return "";
    const solverRelevant = {};
    [
      "lop",
      "mon",
      "monhoc",
      "giaovien",
      "phong",
      "pccmMatrix",
      "pccmTietMatrix",
      "pccmRoomMatrix",
      "pccmGioihanMatrix",
      "tkb",
      "tkbLessonTeachers",
      "tkbLessonRooms",
      "tkbConfig",
      "tkbScheduleRevision"
    ].forEach(key => {
      if(Object.prototype.hasOwnProperty.call(data, key)) solverRelevant[key] = data[key];
    });
    const offLocks = classOffLocksForFingerprint(data);
    if(Object.keys(offLocks).length) solverRelevant.classOffLocks = offLocks;
    const constraints = constraintsForDurableFingerprint(data.tkbConstraints);
    if(constraints && Object.keys(constraints).length) solverRelevant.tkbConstraints = constraints;
    const serialized = JSON.stringify(stableFingerprintClone(solverRelevant));
    return `v3:${compactFingerprintHash(serialized)}:${serialized.length}`;
  }

  function durableScheduleFingerprintMatches(fingerprint, data){
    const expected = String(fingerprint || "");
    if(!expected) return true;
    if(expected.startsWith("v1:")) return expected === `v1:${scheduleFingerprintFromData(data)}`;
    if(expected.startsWith("v2:")) return expected === legacyV2ScheduleFingerprint(data);
    return expected === durableScheduleFingerprint(data);
  }

  function durableScheduleFingerprintMatcher(data){
    const currentByVersion = new Map();
    return fingerprint => {
      const expected = String(fingerprint || "");
      if(!expected) return true;
      const version = expected.startsWith("v1:")
        ? "v1"
        : (expected.startsWith("v2:") ? "v2" : "v3");
      if(!currentByVersion.has(version)){
        const current = version === "v1"
          ? `v1:${scheduleFingerprintFromData(data)}`
          : (version === "v2" ? legacyV2ScheduleFingerprint(data) : durableScheduleFingerprint(data));
        currentByVersion.set(version, current);
      }
      return expected === currentByVersion.get(version);
    };
  }

  function lessonSessionValue(lesson){
    const raw = String(lesson?.session || "").trim();
    if(!raw) return "";
    const lower = raw.toLowerCase();
    if(lower === "sang") return "AM";
    if(lower === "chieu") return "PM";
    return raw.toUpperCase();
  }

  function visibleScheduleLessonsFromData(data){
    const rows = [];
    const source = data?.tkb && typeof data.tkb === "object" ? data.tkb : {};
    const grades = classGradeLookup(data);
    Object.entries(source).forEach(([classId, tkb]) => {
      const className = rescueClassCanon(data, classId) || String(classId || "").trim();
      if(!className) return;
      const grade = grades.get(String(classId || "").trim())
        || grades.get(className)
        || "";
      ["thu2","thu3","thu4","thu5","thu6","thu7"].forEach(thu => {
        const day = Number(String(thu).replace(/\D+/g, ""));
        ["sang","chieu"].forEach(buoi => {
          const session = buoi === "sang" ? "AM" : "PM";
          (tkb?.[thu]?.[buoi] || []).forEach((value, ti) => {
            const subject = cellSubjectText(value);
            if(!subject || subject === "OFF" || subject.toLowerCase() === "nghỉ") return;
            const teacher = rescueTeacherFor(data, classId, subject);
            const room = rescueRoomFor(data, classId, subject);
            rows.push({
              class: className,
              className,
              classId: String(classId || ""),
              grade,
              subject,
              teacher,
              room,
              day,
              session,
              period: Number(ti) + 1,
              fixed:isFixedScheduledCell(value)
            });
          });
        });
      });
    });
    return rows;
  }

  function currentScheduleLessonsFromData(data){
    const visible = visibleScheduleLessonsFromData(data);
    if(visible.length) return visible;
    const fromData = data?.tkbSolverResult?.lessons;
    if(Array.isArray(fromData) && fromData.length) return fromData;
    const fromLast = window.__TKB_SOLVER_LAST_PAYLOAD?.lessons;
    if(Array.isArray(fromLast) && fromLast.length) return fromLast;
    return [];
  }

  function teacherSessionSignatureFromLessons(lessons){
    if(!Array.isArray(lessons) || !lessons.length) return "";
    const rows = new Set();
    lessons.forEach(lesson => {
      const teacher = String(lesson?.teacher || "").trim();
      const day = Number(lesson?.day || 0);
      const session = lessonSessionValue(lesson);
      if(teacher && day > 0 && session) rows.add(`${teacher}|${day}|${session}`);
    });
    return Array.from(rows).sort().join("~");
  }

  function lessonAssignmentSignatureFromLessons(lessons){
    if(!Array.isArray(lessons) || !lessons.length) return "";
    return lessons.map(lesson => [
      String(lesson?.class || lesson?.className || lesson?.classId || "").trim(),
      String(lesson?.subject || "").trim(),
      String(lesson?.teacher || "").trim(),
      String(lesson?.room || "").trim(),
      Number(lesson?.day || 0),
      lessonSessionValue(lesson),
      Number(lesson?.period || 0)
    ].join("|")).sort().join("~");
  }

  function payloadCompletion(payload){
    const metrics = payload?.metrics || {};
    const scheduled = metricNumber(metrics.scheduled_periods);
    const expected = metricNumber(metrics.expected_periods);
    const unassigned = metricNumber(metrics.unassigned_periods);
    const violations = metricNumber(metrics.app_constraint_violation_count);
    const hardOk = metrics.hard_ok !== false && metrics.core_hard_ok !== false && payload?.validation?.hard_ok !== false;
    const rawBestEffort = payload?.bestEffort === true || metrics.best_effort === true;
    const incomplete = expected > 0 && scheduled < expected;
    const hardComplete = unassigned === 0 && violations === 0 && hardOk && !incomplete;
    const bestEffort = rawBestEffort && !hardComplete;
    return {
      scheduled,
      expected,
      unassigned,
      violations,
      hardOk,
      bestEffort,
      rawBestEffort,
      complete: hardComplete
    };
  }

  function payloadHasUsableSchedule(payload){
    const c = payloadCompletion(payload);
    const lessons = Array.isArray(payload?.lessons) ? payload.lessons.length : 0;
    return c.expected > 0 && (c.scheduled > 0 || lessons > 0);
  }

  function payloadIsMobileLocalQualityTerminal(payload){
    const runtime = payload?.solver?.runtime_settings || {};
    const marked = payload?.browser_local_quality_terminal === true
      || runtime.browser_local_quality_terminal === true
      || payload?.mobile_local_quality_terminal === true
      || runtime.mobile_local_quality_terminal === true;
    if(!marked) return false;
    const metrics = payload?.metrics || {};
    const completion = payloadCompletion(payload);
    // This marker relaxes only soft quality targets. Completeness, server hard
    // validation, zero application violations, and the normal apply contract
    // remain mandatory before a phone's bounded local best can be displayed.
    return payload?.ok === true
      && completion.complete
      && Number.isSafeInteger(Number(metrics.expected_periods))
      && Number(metrics.expected_periods) > 0
      && Number(metrics.scheduled_periods) === Number(metrics.expected_periods)
      && Number(metrics.unassigned_periods) === 0
      && Number(metrics.app_constraint_violation_count) === 0
      && metrics.hard_ok === true
      && metrics.core_hard_ok !== false
      && payload?.validation?.hard_ok === true
      && Array.isArray(payload?.lessons)
      && payload.lessons.length === Number(metrics.expected_periods)
      && Array.isArray(payload?.unassignedLessons)
      && payload.unassignedLessons.length === 0;
  }

  function payloadUnassignedPeriods(payload){
    const metricValue = metricNumber(payload?.metrics?.unassigned_periods, NaN);
    if(Number.isFinite(metricValue)) return metricValue;
    const items = Array.isArray(payload?.unassignedLessons) ? payload.unassignedLessons : [];
    return items.reduce((sum, item) => sum + metricNumber(item?.periods ?? item?.count, 0), 0);
  }

  function payloadIsPureCapacityShortage(payload){
    const c = payloadCompletion(payload);
    const metrics = payload?.metrics || {};
    const capacityUnassigned = metricNumber(metrics.capacity_unassigned_periods, 0);
    const solverUnassigned = metricNumber(metrics.solver_unassigned_periods, 0);
    const unassigned = Math.max(c.unassigned, payloadUnassignedPeriods(payload));
    return (
      payloadHasUsableSchedule(payload) &&
      capacityUnassigned > 0 &&
      unassigned > 0 &&
      unassigned <= capacityUnassigned &&
      solverUnassigned <= 0 &&
      c.violations <= 0 &&
      c.hardOk
    );
  }

  function payloadHasCapacityShortage(payload){
    const metrics = payload?.metrics || {};
    return payloadHasUsableSchedule(payload) && metricNumber(metrics.capacity_unassigned_periods, 0) > 0;
  }

  function payloadIsSafeCapacityPartial(payload){
    const metrics = payload?.metrics || {};
    const c = payloadCompletion(payload);
    const unassigned = Math.max(c.unassigned, payloadUnassignedPeriods(payload));
    const capacityUnassigned = metricNumber(metrics.capacity_unassigned_periods, 0);
    const solverUnassigned = metricNumber(metrics.solver_unassigned_periods, 0);
    const scheduled = Math.max(c.scheduled, Array.isArray(payload?.lessons) ? payload.lessons.length : 0);
    const expected = c.expected;
    const accounted = scheduled + unassigned;
    const declaredUnassigned = capacityUnassigned + solverUnassigned;
    const validationViolations = Array.isArray(payload?.validation?.violations)
      ? payload.validation.violations.length
      : 0;
    const applicationViolations = Array.isArray(metrics.app_constraint_violations)
      ? metrics.app_constraint_violations.length
      : 0;
    const lessons = Array.isArray(payload?.lessons) ? payload.lessons : null;
    const unassignedLessons = Array.isArray(payload?.unassignedLessons)
      ? payload.unassignedLessons
      : null;
    let itemTotal = 0;
    let itemCapacity = 0;
    if(lessons && lessons.length !== scheduled) return false;
    if(!unassignedLessons) return false;
    for(const item of unassignedLessons){
      const periods = metricNumber(item?.periods ?? item?.count, NaN);
      if(!Number.isFinite(periods) || periods <= 0) return false;
      itemTotal += periods;
      if(String(item?.reason || '').trim() === 'not_enough_available_slots'){
        itemCapacity += periods;
      }
    }
    return (
      scheduled > 0
      && expected > 0
      && unassigned > 0
      && capacityUnassigned >= 0
      && solverUnassigned >= 0
      && unassigned === declaredUnassigned
      && accounted === expected
      && itemTotal === unassigned
      && itemCapacity === capacityUnassigned
      && itemTotal - itemCapacity === solverUnassigned
      && metrics.accounting_ok === true
      && metrics.placement_hard_ok === true
      && metrics.placement_core_hard_ok === true
      && metricNumber(metrics.class_slot_conflicts, 0) === 0
      && metricNumber(metrics.teacher_slot_conflicts, 0) === 0
      && metricNumber(metrics.room_slot_conflicts, 0) === 0
      && c.violations === 0
      && validationViolations === 0
      && applicationViolations === 0
    );
  }

  function payloadAcceptableWithUnassigned(payload){
    const c = payloadCompletion(payload);
    const unassigned = Math.max(c.unassigned, payloadUnassignedPeriods(payload));
    const incomplete = c.expected > 0 && c.scheduled < c.expected;
    const bestEffort = c.bestEffort || payload?.bestEffort === true || payload?.metrics?.best_effort === true;
    return (
      payloadHasUsableSchedule(payload) &&
      unassigned > 0 &&
      (bestEffort || incomplete || c.violations > 0 || !c.hardOk)
    );
  }

  function payloadAcceptableForUiCleanup(payload){
    const c = payloadCompletion(payload);
    const unassigned = Math.max(c.unassigned, payloadUnassignedPeriods(payload));
    const incomplete = c.expected > 0 && c.scheduled < c.expected;
    return (
      payloadHasUsableSchedule(payload) &&
      (unassigned > 0 || c.violations > 0 || !c.hardOk || c.bestEffort || incomplete)
    );
  }

  function strictBrowserAutomaticRequired(settings){
    // Native/Web client solver lanes are retired.  The Super Admin Agent icon
    // now selects the server route (Cloud Run or VPS); it must never turn an
    // otherwise safe server-owned capacity result into a BrowserAgent-only
    // completeness failure.
    if(window.__TKB_CLIENT_AGENT_LANES_ENABLED === false) return false;
    const focus = optimizationFocusForSolveRequestMode(settings?.optimization_focus);
    const solveKind = String(settings?.ui_unified_solve_kind || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const policy = String(settings?.ui_agent_execution_policy || "")
      .trim()
      .toLowerCase();
    return focus === "automatic"
      && settings?.require_complete_schedule === true
      && ["fresh_complete_first", "repair_constraints", "refine_complete"].includes(solveKind)
      && (
        settings?.ui_browser_agent_required === true
        || policy === "web_agent_required"
        || policy === "browser_required"
      );
  }

  function strictBrowserAutomaticQualityState(payload){
    const metrics = payload?.metrics;
    const distribution = metrics?.gap_distribution;
    const ownMetric = key => {
      if(!metrics || !Object.prototype.hasOwnProperty.call(metrics, key)) return null;
      const value = Number(metrics[key]);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const onePeriod = ownMetric("one_period_teacher_sessions");
    const onePeriodLowerBound = onePeriodTeacherSessionLowerBound(metrics);
    const explicitGap2 = ownMetric("teacher_gap2_sessions");
    let distributionGap2 = null;
    let distributionValid = !!distribution
      && typeof distribution === "object"
      && !Array.isArray(distribution);
    if(distributionValid){
      distributionGap2 = 0;
      for(const [gapKey, rawCount] of Object.entries(distribution)){
        const gap = Number(gapKey);
        const count = Number(rawCount);
        if(
          !Number.isSafeInteger(gap)
          || gap < 0
          || !Number.isSafeInteger(count)
          || count < 0
        ){
          distributionValid = false;
          distributionGap2 = null;
          break;
        }
        if(gap >= 2) distributionGap2 += count;
      }
    }
    const completion = payloadCompletion(payload);
    const lessons = payload?.lessons;
    const unassignedLessons = payload?.unassignedLessons;
    const completeHard = payload?.ok === true
      && completion.complete === true
      && completion.hardOk === true
      && metrics?.hard_ok === true
      && payload?.validation?.hard_ok === true
      && ownMetric("app_constraint_violation_count") === 0
      && Array.isArray(lessons)
      && lessons.length === completion.expected
      && Array.isArray(unassignedLessons)
      && unassignedLessons.length === 0;
    const metricsPresent = onePeriod != null
      && explicitGap2 != null
      && distributionValid
      && distributionGap2 != null;
    const metricsConsistent = metricsPresent && explicitGap2 === distributionGap2;
    return {
      completeHard,
      metricsPresent,
      metricsConsistent,
      onePeriod,
      onePeriodLowerBound,
      explicitGap2,
      distributionGap2,
      met:completeHard
        && metricsConsistent
        && onePeriod <= onePeriodLowerBound
        && explicitGap2 === 0
    };
  }

  function strictBrowserAutomaticQualityMessage(payload, settings){
    if(!strictBrowserAutomaticRequired(settings)) return "";
    const state = strictBrowserAutomaticQualityState(payload);
    const reasons = [];
    if(!state.completeHard) reasons.push("lịch chưa đầy đủ hoặc chưa hard-valid");
    if(!state.metricsPresent) reasons.push("thiếu chỉ số chất lượng bắt buộc");
    else if(!state.metricsConsistent){
      reasons.push(
        `chỉ số Trống 2 tiết mâu thuẫn (${state.explicitGap2}/${state.distributionGap2})`
      );
    }
    if(state.metricsPresent && state.onePeriod > state.onePeriodLowerBound){
      reasons.push(
        `Dạy 1 tiết/buổi = ${state.onePeriod}, mục tiêu ${state.onePeriodLowerBound}`
      );
    }
    if(state.metricsPresent && state.explicitGap2 > 0){
      reasons.push(`Trống 2 tiết = ${state.explicitGap2}, yêu cầu 0`);
    }
    return reasons.length
      ? `WebAgent chưa đạt chuẩn bắt buộc: ${reasons.join("; ")}.`
      : "";
  }

  function synchronizeBrowserSettlementSettings(target, source){
    if(!target || !source) return target;
    for(const key of [
      "optimization_focus",
      "ui_unified_solve_kind",
      "ui_use_existing_complete_incumbent",
      "ui_existing_incumbent_revalidated",
      "require_complete_schedule",
      "ui_agent_execution_policy",
      "ui_execution_mode",
      "ui_browser_agent_required",
      "ui_native_agent_required",
      "ui_agent_preference_enabled"
    ]){
      if(Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
      else delete target[key];
    }
    return target;
  }

  function hardQualityViolationMessage(payload, settings){
    const metrics = payload?.metrics || {};
    const reasons = [];
    const strictBrowserMessage = strictBrowserAutomaticQualityMessage(payload, settings);
    if(strictBrowserMessage) return strictBrowserMessage;
    const violations = metricNumber(metrics.app_constraint_violation_count, 0);
    const hardOk = metrics.hard_ok !== false && metrics.core_hard_ok !== false && payload?.validation?.hard_ok !== false;
    const acceptableWithUnassigned = payloadAcceptableWithUnassigned(payload);
    const acceptableForUiCleanup = payloadAcceptableForUiCleanup(payload);
    if(violations > 0 && !acceptableForUiCleanup) reasons.push(`còn ${violations} lỗi ràng buộc cứng`);
    if(!hardOk && !acceptableWithUnassigned && !acceptableForUiCleanup) reasons.push("chưa đạt ràng buộc cứng");
    if(settings?.require_complete_schedule === true && !acceptableWithUnassigned && !acceptableForUiCleanup){
      const scheduled = metricNumber(metrics.scheduled_periods, 0);
      const expected = metricNumber(metrics.expected_periods, 0);
      const unassigned = metricNumber(metrics.unassigned_periods, 0);
      if(unassigned > 0) reasons.push(`chưa xếp = ${unassigned}`);
      if(expected > 0 && scheduled < expected) reasons.push(`tiết đã xếp = ${scheduled}/${expected}`);
    }
    const optimizationFocus = optimizationFocusForSolveRequestMode(settings?.optimization_focus);
    const focusedOptimization = ["singletons", "sessions", "gaps"].includes(optimizationFocus);
    const browserExecutionPolicy = String(settings?.ui_agent_execution_policy || "")
      .trim()
      .toLowerCase();
    const strictBrowserAutomatic = optimizationFocus === "automatic"
      && (
        settings?.ui_browser_agent_required === true
        || browserExecutionPolicy === "web_agent_required"
        || browserExecutionPolicy === "browser_required"
      );
    const incrementalAutomaticRefinement =
      optimizationFocus === "automatic"
      && String(settings?.ui_unified_solve_kind || "").trim().toLowerCase() === "refine_complete"
      && settings?.ui_use_existing_complete_incumbent === true
      && settings?.ui_existing_incumbent_revalidated === true;
    // A refinement candidate is a durable next incumbent, not a claim that
    // every quality target has already reached zero. The Pareto guard below
    // still rejects regressions; accepting a hard-valid 108 -> 4 singleton
    // result lets the next click finish the remaining four instead of throwing
    // away three minutes of local CP-SAT work.
    const mobileLocalQualityTerminal = payloadIsMobileLocalQualityTerminal(payload);
    const incrementalQualityCheckpoint = focusedOptimization
      || (!strictBrowserAutomatic && (
        incrementalAutomaticRefinement
        || mobileLocalQualityTerminal
      ));
    const enforceOnePeriodCap = !incrementalQualityCheckpoint && (
      settings?.strict_one_period_sessions_cap === true
      || settings?.enforce_max_one_period_sessions === true
      || settings?.strict_quality_targets === true
      || settings?.enforce_quality_targets === true
    );
    const configuredMaxOne = nonnegativeNumberSetting(settings?.max_one_period_sessions);
    const maxOne = enforceOnePeriodCap
      ? onePeriodTeacherSessionTarget(metrics, configuredMaxOne)
      : null;
    const onePeriod = metricNumber(metrics.one_period_teacher_sessions, 0);
    if(maxOne != null && onePeriod > maxOne){
      reasons.push(`buổi GV chỉ dạy 1 tiết: ${onePeriod}, mục tiêu ${maxOne}`);
    }
    const maxTeacherGap = nonnegativeNumberSetting(settings?.period_max_teacher_gap);
    const gap2Plus = gap2PlusCount(metrics);
    if(!incrementalQualityCheckpoint && maxTeacherGap != null && maxTeacherGap <= 1 && gap2Plus > 0){
      reasons.push(`buổi GV có từ 2 tiết trống: ${gap2Plus}, mục tiêu 0`);
    }
    return reasons.length
      ? `Không áp dụng phương án vì chưa đạt ràng buộc cứng: ${reasons.join("; ")}.`
      : "";
  }

  function qualityDebtParts(payload, settings){
    const metrics = payload?.metrics || {};
    const debt = payload?.qualityDebt || metrics.quality_debt || {};
    let practicalTargets = null;
    try{ practicalTargets = practicalTeacherQualityTargets(getData()); }catch(_){}
    const parts = [];
    const configuredMaxOne = nonnegativeNumberSetting(settings?.max_one_period_sessions)
      ?? (settings?.one_period_priority_absolute === true || settings?.strict_quality_targets === true || settings?.enforce_quality_targets === true ? 0 : null);
    const maxOne = configuredMaxOne == null
      ? null
      : onePeriodTeacherSessionTarget(metrics, configuredMaxOne);
    const onePeriod = metricNumber(metrics.one_period_teacher_sessions ?? debt.one_period_teacher_sessions, 0);
    if(maxOne != null && onePeriod > maxOne) parts.push(`buổi GV chỉ dạy 1 tiết: ${onePeriod}, mục tiêu ${maxOne}`);
    const maxGap = nonnegativeNumberSetting(settings?.period_max_teacher_gap);
    const gap2Plus = metricNumber(debt.gap_over_limit_sessions, NaN);
    const measuredGap2Plus = Number.isFinite(gap2Plus) ? gap2Plus : gap2PlusCount(metrics);
    if(maxGap != null && maxGap <= 1 && measuredGap2Plus > 0) parts.push(`buổi GV có từ 2 tiết trống: ${measuredGap2Plus}`);
    const teacherTarget = positiveNumberSetting(
      settings?.optimization_accept_teacher_sessions
        ?? settings?.target_teacher_sessions
        ?? settings?.requested_max_teacher_sessions
        ?? settings?.max_teacher_sessions
    ) || positiveNumberSetting(practicalTargets?.teacherTarget);
    const teacherSessions = metricNumber(metrics.teacher_sessions ?? debt.teacher_sessions, 0);
    if(teacherTarget && teacherSessions > teacherTarget) parts.push(`tổng buổi dạy của GV: ${teacherSessions}, mục tiêu ${teacherTarget}`);
    const gap1Target = nonnegativeNumberSetting(
      settings?.optimization_accept_gap1_sessions
        ?? settings?.target_gap1_sessions
        ?? practicalTargets?.gap1Target
    );
    const gap1 = metricNumber((metrics.gap_distribution || {})["1"] ?? debt.gap1_sessions, 0);
    if(gap1Target != null && gap1 > gap1Target) parts.push(`buổi GV có trống 1 tiết: ${gap1}, mục tiêu ${gap1Target}`);
    return parts;
  }

  function qualityDebtMessage(payload, settings){
    const showAsRule = settings?.ui_show_quality_target_warning === true
      || settings?.enforce_quality_targets === true
      || settings?.strict_quality_targets === true;
    if(!showAsRule) return "";
    const parts = qualityDebtParts(payload, settings);
    return parts.length ? `Cần tối ưu thêm: ${parts.join("; ")}.` : "";
  }

  function hasCompletedSolverSchedule(data){
    const result = data?.tkbSolverResult || window.__TKB_SOLVER_LAST_PAYLOAD || null;
    const completion = payloadCompletion(result);
    const expected = expectedLessonCount(data);
    const scheduled = countScheduledLessons(data);
    return (
      completion.complete &&
      expected > 0 &&
      scheduled >= expected &&
      (completion.expected <= 0 || completion.scheduled >= completion.expected)
    );
  }

  function teacherCapacityPrecheckWarnings(){
    try{
      const api = window.TKBConstraints || window.TKBConstraintsFull;
      const warnings = [];
      if(api && typeof api.teacherFixedOffCapacityWarnings === "function"){
        const items = api.teacherFixedOffCapacityWarnings() || [];
        if(Array.isArray(items)) warnings.push(...items);
      }
      if(api && typeof api.classFixedOffCapacityWarnings === "function"){
        const items = api.classFixedOffCapacityWarnings() || [];
        if(Array.isArray(items)) warnings.push(...items);
      }
      return warnings;
    }catch(err){
      console.warn(`[${VERSION}] capacity precheck failed`, err);
    }
    return [];
  }

  function teacherCapacityPrecheckMessage(limit){
    const warnings = teacherCapacityPrecheckWarnings();
    if(!warnings.length) return "";
    const max = Math.max(1, Number(limit || 3));
    const parts = warnings.slice(0, max).map(item => {
      if(item.kind === "class.fixedOff.capacity"){
        const name = item.className || item.classId || "Lớp";
        const required = Number(item.required || 0);
        const capacity = Number(item.capacity || 0);
        const shortage = Number(item.shortage || Math.max(0, required - capacity));
        return `${name}: thiếu tối thiểu ${shortage} tiết (cần ${required}, còn tối đa ${capacity})`;
      }
      const name = item.teacherName || item.teacherId || "Giáo viên";
      const required = Number(item.required || 0);
      const capacity = Number(item.capacity || 0);
      const shortage = Number(item.shortage || Math.max(0, required - capacity));
      return `${name}: thiếu tối thiểu ${shortage} tiết (cần ${required}, còn tối đa ${capacity})`;
    });
    return `Cảnh báo thiếu ô xếp: ${parts.join("; ")}${warnings.length > max ? `; còn ${warnings.length - max} mục khác` : ""}. Hệ thống vẫn chạy, tiết dư sẽ nằm ở Chưa phân.`;
  }

  function capacityPrecheckPopupMessage(limit){
    const warnings = teacherCapacityPrecheckWarnings();
    if(!warnings.length) return {warnings: [], message: ""};
    const max = Math.max(1, Number(limit || 8));
    const lines = warnings.slice(0, max).map((item, index) => {
      const isClass = item.kind === "class.fixedOff.capacity";
      const label = isClass ? "Lớp" : "Giáo viên";
      const name = isClass
        ? (item.className || item.classId || "Lớp")
        : (item.teacherName || item.teacherId || "Giáo viên");
      const required = Number(item.required || 0);
      const capacity = Number(item.capacity || 0);
      const shortage = Number(item.shortage || Math.max(0, required - capacity));
      return `${index + 1}. ${label} ${name}: thiếu tối thiểu ${shortage} tiết (cần ${required}, còn tối đa ${capacity}).`;
    });
    if(warnings.length > max){
      lines.push(`... còn ${warnings.length - max} mục khác.`);
    }
    return {
      warnings,
      message: [
        "Phát hiện thiếu ô xếp trước khi sắp xếp:",
        ...lines,
        "",
        "Nếu tiếp tục, phần mềm vẫn chạy thuật toán sắp xếp bình thường; nếu thật sự thiếu chỗ, tiết dư sẽ nằm ở Chưa phân.",
        "Bạn có muốn tiếp tục không?"
      ].join("\n")
    };
  }

  function showCapacityPrecheckDialog(detail){
    return new Promise(resolve => {
      try{ document.getElementById("tkbCapacityPrecheckDialog")?.remove(); }catch(_){}
      const overlay = document.createElement("div");
      overlay.id = "tkbCapacityPrecheckDialog";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "padding:18px",
        "background:rgba(15,23,42,.42)",
        "font:14px/1.45 Arial,sans-serif"
      ].join(";");

      const card = document.createElement("div");
      card.style.cssText = [
        "width:min(560px,calc(100vw - 36px))",
        "max-height:min(78vh,620px)",
        "overflow:auto",
        "background:#fff",
        "color:#172033",
        "border:1px solid #d7e0f2",
        "border-radius:10px",
        "box-shadow:0 24px 70px rgba(15,23,42,.24)",
        "padding:18px 18px 14px"
      ].join(";");

      const title = document.createElement("div");
      title.textContent = "Thiếu ô xếp trước khi sắp xếp";
      title.style.cssText = "font-weight:700;font-size:16px;margin:0 0 10px;color:#0f172a";
      card.appendChild(title);

      const lines = String(detail?.message || "").split(/\n+/).filter(Boolean);
      const intro = document.createElement("div");
      intro.textContent = lines[0] || "Phát hiện thiếu ô xếp trước khi sắp xếp:";
      intro.style.cssText = "margin-bottom:8px";
      card.appendChild(intro);

      const list = document.createElement("div");
      list.style.cssText = [
        "display:grid",
        "gap:6px",
        "max-height:230px",
        "overflow:auto",
        "padding:10px",
        "border:1px solid #e2e8f0",
        "border-radius:8px",
        "background:#f8fbff",
        "margin-bottom:12px"
      ].join(";");
      lines.filter(line => /^\d+\.\s/.test(line) || /^\.\.\./.test(line)).forEach(line => {
        const item = document.createElement("div");
        item.textContent = line;
        item.style.cssText = "overflow-wrap:anywhere";
        list.appendChild(item);
      });
      card.appendChild(list);

      const note = document.createElement("div");
      note.textContent = "Nếu tiếp tục, phần mềm vẫn chạy thuật toán sắp xếp bình thường. Nếu thật sự thiếu chỗ, tiết dư sẽ nằm ở Chưa phân.";
      note.style.cssText = "margin:0 0 14px;color:#475569";
      card.appendChild(note);

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Hủy";
      cancel.style.cssText = "min-height:34px;padding:7px 14px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#1f2937;cursor:pointer";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.textContent = "Tiếp tục sắp xếp";
      ok.style.cssText = "min-height:34px;padding:7px 14px;border:1px solid #1f5bd6;border-radius:7px;background:#1f5bd6;color:#fff;cursor:pointer";
      actions.appendChild(cancel);
      actions.appendChild(ok);
      card.appendChild(actions);
      overlay.appendChild(card);

      let done = false;
      const finish = value => {
        if(done) return;
        done = true;
        try{ document.removeEventListener("keydown", onKeyDown, true); }catch(_){}
        try{ overlay.remove(); }catch(_){}
        resolve(!!value);
      };
      const onKeyDown = event => {
        if(event.key === "Escape"){
          event.preventDefault();
          finish(false);
        }else if(event.key === "Enter"){
          event.preventDefault();
          finish(true);
        }
      };
      cancel.addEventListener("click", () => finish(false));
      ok.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", event => {
        if(event.target === overlay) finish(false);
      });
      document.addEventListener("keydown", onKeyDown, true);
      document.body.appendChild(overlay);
      try{ ok.focus({preventScroll:true}); }catch(_){ try{ ok.focus(); }catch(__){} }
    });
  }

  function applyCapacityShortageAcceptedSettings(settings){
    if(!settings || typeof settings !== "object") return settings;
    const expected = (() => {
      try{ return expectedLessonCount(getData()); }catch(_){ return 0; }
    })();
    const shortageTotal = (() => {
      try{
        return teacherCapacityPrecheckWarnings().reduce((sum, item) => {
          const required = Number(item?.required || 0);
          const capacity = Number(item?.capacity || 0);
          const shortage = Number(item?.shortage || Math.max(0, required - capacity));
          return sum + (Number.isFinite(shortage) && shortage > 0 ? shortage : 0);
        }, 0);
      }catch(_){
        return 0;
      }
    })();
    const shortageFastThreshold = Math.max(8, Math.round(Math.max(1, expected) * 0.015));
    const explicitCustomSeconds = Number(settings.ui_custom_solve_duration_seconds);
    const solveBudgetSeconds = Number.isFinite(explicitCustomSeconds) && explicitCustomSeconds > 0
      ? normalizeOverallTimeLimit(explicitCustomSeconds)
      : Math.max(
          ROBUST_AUTO_DURATION_SECONDS,
          normalizeOverallTimeLimit(settings.overall_time_limit_seconds || ROBUST_AUTO_DURATION_SECONDS)
        );
    settings.ui_capacity_shortage_confirmed = true;
    settings.ui_accept_incomplete_best_effort = true;
    settings.best_effort_on_timeout = true;
    settings.ui_allow_best_effort_on_timeout = true;
    // A proven shortage changes only the terminal contract: the safely placed
    // portion may be returned with an explicit remainder.  It must not reduce
    // the normal completeness budget to the old 30/45/60-second fast lane,
    // because that manufactured avoidable solver-unassigned debt.
    settings.capacity_limited_fast_lane = false;
    delete settings.capacity_limited_overall_time_limit_seconds;
    delete settings.capacity_limited_session_time_limit;
    delete settings.capacity_limited_period_time_limit;
    delete settings.capacity_limited_period_retry_time_limit;
    settings.ui_allow_short_backend_deadline = true;
    settings.overall_time_limit_seconds = solveBudgetSeconds;
    settings.integrated_time_limit = Math.max(
      solveBudgetSeconds,
      Number(settings.integrated_time_limit || 0) || 0
    );
    settings.progress_estimate_seconds = solveBudgetSeconds;
    settings.native_global_deadline_ms = solveBudgetSeconds * 1000;
    settings.backend_deadline_ms = solveBudgetSeconds * 1000;
    settings.ui_allow_incomplete_retry_after_single_pass = true;
    settings.complete_schedule_seed_retry = true;
    settings.ui_skip_final_existing_teacher_gap_optimize = true;
    settings.allow_native_reference_fallback = true;
    settings.capacity_shortage_total = shortageTotal;
    settings.capacity_shortage_fast_threshold = shortageFastThreshold;
    return settings;
  }

  async function confirmCapacityPrecheckBeforeSolve(settings){
    // Automatic Play already performs the VPS precheck and the solver validates
    // the same hard constraints. Honour the fast-path flags before invoking
    // the synchronous local capacity scanner, which can monopolize the UI
    // thread for several seconds on a large school.
    const skipLocalCapacityScan = settings?.ui_skip_capacity_precheck === true
      || settings?.ui_fast_auto_sort_no_capacity_precheck === true;
    if(skipLocalCapacityScan){
      return {
        ok: true,
        warning: "",
        capacityShortage: false,
        localScanSkipped: true
      };
    }
    const warning = teacherCapacityPrecheckMessage(3);
    if(!warning) return {ok: true, warning: "", capacityShortage: false};
    if(settings?.ui_capacity_precheck_warning_only === true){
      return {ok: true, warning: warning || "", capacityShortage: false};
    }
    // A proven shortage is not a reason to abort the whole run.  Continue
    // automatically and let the backend's optional-demand lane put only the
    // excess in Chưa phân.  The warning remains available for status/diagnostic
    // UI, but no confirmation dialog can discard the rest of the timetable.
    if(shouldRequireCompletePresetResult(settings) && strictBrowserAutomaticRequired(settings)){
      return {
        ok:false,
        warning,
        capacityShortage:true,
        blocked:true,
        blockingMessage:"Chế độ Agent trình duyệt chỉ nhận lịch đầy đủ. Hãy tắt Agent để VPS xếp phần khả thi và đưa tiết dư vào Chưa phân."
      };
    }
    if(shouldRequireCompletePresetResult(settings)){
      return {ok:true, warning, capacityShortage:true, autoAccepted:true};
    }
    if(settings?.ui_skip_capacity_precheck_confirm === true || settings?.ui_skip_capacity_confirm === true){
      return {ok: true, warning, capacityShortage: true};
    }
    const detail = capacityPrecheckPopupMessage(8);
    if(!detail.warnings.length) return {ok: true, warning, capacityShortage: false};
    const ok = await showCapacityPrecheckDialog(detail);
    return {ok, warning, capacityShortage: true};
  }

  function incompleteSolveMessage(payload, options){
    const c = payloadCompletion(payload);
    const requireComplete = options?.requireComplete === true;
    const title = "Chưa tìm được lịch đủ.";
    const progress = c.expected > 0
      ? `Đã xếp thử ${c.scheduled}/${c.expected} tiết${c.unassigned > 0 ? `, còn ${c.unassigned} tiết` : ""}.`
      : (c.unassigned > 0 ? `Còn ${c.unassigned} tiết chưa xếp.` : "");
    const solverDetail = solverFailureSummary(payload);
    const action = requireComplete
      ? "Đã giữ lịch cũ để bạn điều chỉnh. Hãy nới bớt tiết Nghỉ/ràng buộc rồi xếp lại."
      : "Đã giữ phần xếp được để bạn xem và điều chỉnh.";
    return [title, progress, action, solverDetail].filter(Boolean).join(" ");
  }

  function solverFailureSummary(payload){
    const failures = payload?.solver?.period_solver?.best_effort_failed_sessions
      || payload?.solver?.session_solver?.best_effort_failed_sessions
      || [];
    if(!Array.isArray(failures) || !failures.length) return "";
    const first = failures.find(item => item && typeof item === "object") || {};
    const session = first.session || {};
    const diagnostics = first.diagnostics || {};
    const day = session.day ? `Thứ ${session.day}` : "";
    const part = session.part === "AM" ? "sáng" : session.part === "PM" ? "chiều" : "";
    const where = [day, part].filter(Boolean).join(" ");
    return `Điểm cần nới: ${where || "một buổi học"}.`;
  }

  function unassignedLessonSummary(payload){
    const items = Array.isArray(payload?.unassignedLessons) ? payload.unassignedLessons : [];
    if(!items.length) return "";
    const first = items.slice(0, 3).map(item => {
      const cls = item.className || item.class || "";
      const subject = item.subject || item.mon || "";
      const periods = Number(item.periods || item.count || 0) || 0;
      return [cls, subject, periods ? `${periods} tiết` : ""].filter(Boolean).join(" ");
    }).filter(Boolean);
    return first.length ? `Chưa xếp: ${first.join("; ")}${items.length > first.length ? "..." : "."}` : "";
  }

  function currentSolveClassLabel(){
    try{
      const candidates = [
        window.currentLop,
        window.currentClass,
        window.currentClassId,
        document.querySelector("#pairMainClassSelect")?.dataset?.value,
        document.querySelector("#listLop .lop-item.active")?.dataset?.id,
        document.querySelector(".lop-item.active")?.dataset?.id
      ].map(value => String(value || "").trim()).filter(Boolean);
      const current = candidates[0] || "";
      const data = typeof getData === "function" ? getData() : null;
      const classes = Array.isArray(data?.lop) ? data.lop : [];
      const row = classes.find(item => {
        const values = [item?.id, item?.ma, item?.code, item?.ten, item?.name, item?.label]
          .map(value => String(value || "").trim())
          .filter(Boolean);
        return values.some(value => candidates.includes(value));
      });
      return String(row?.ten2 || row?.ten || row?.name || row?.label || current || "").trim();
    }catch(_){
      return "";
    }
  }

  function friendlySolveError(err){
    const raw = String(err && (err.message || err) || "").trim();
    const kind = String(err?.payload?.kind || err?.kind || "").trim();
    const backendDetail = String(err?.payload?.error || err?.payload?.detail || "").trim();
    const text = `${kind} ${backendDetail} ${raw}`.toLowerCase();
    const normalizedKind = kind.toLowerCase();
    if(
      normalizedKind === "local_agent_unavailable"
      || normalizedKind === "browser_agent_required"
      || normalizedKind === "browser_agent_requires_async_job"
      || normalizedKind === "web_agent_required"
      || normalizedKind === "browser_agent_start_failed"
      || normalizedKind === "browser_agent_disconnected"
      || normalizedKind === "browser_agent_stopped"
      || normalizedKind === "browser_agent_failed"
      || normalizedKind === "browser_agent_quality_unmet"
    ){
      return {
        title: "Solver Local chưa chạy được",
        message: "Agent đang bật nhưng thiết bị này chưa chạy được lượt Local. Không tự chuyển sang VPS; hãy tắt Agent rồi bấm Xếp lại nếu muốn dùng VPS.",
        level: "warning",
        statusLevel: "warning",
        statusMessage: "Local thất bại; tắt Agent rồi bấm Xếp lại để dùng VPS.",
        progressLabel: "Local lỗi"
      };
    }
    if(
      normalizedKind === "native_agent_required"
      || normalizedKind === "native_agent_requires_async_job"
      || normalizedKind === "native_agent_start_failed"
      || normalizedKind === "native_agent_disconnected"
      || normalizedKind === "native_agent_quality_unmet"
      || normalizedKind === "native_agent_stopped"
    ){
      return {
        title: "Cần TKBCherry Agent Windows",
        message: "Lượt này chỉ chạy bằng TKBCherry Agent trên máy Windows. Hãy mở/cập nhật Agent rồi bấm Xếp lại; hệ thống không tự chuyển sang VPS.",
        level: "warning",
        statusLevel: "warning",
        statusMessage: "Hãy mở/cập nhật TKBCherry Agent Windows rồi bấm Xếp lại.",
        progressLabel: "Mở Agent"
      };
    }
    if(normalizedKind === "solver_result_auth_required" || err?.authRequired === true){
      return {
        title: "Phi\u00ean \u0111\u0103ng nh\u1eadp h\u1ebft h\u1ea1n",
        message: raw || "L\u01b0\u1ee3t x\u1ebfp v\u1eabn \u0111\u01b0\u1ee3c gi\u1eef tr\u00ean m\u00e1y ch\u1ee7.",
        level: "warning",
        statusLevel: "warning",
        statusMessage: "Phi\u00ean \u0111\u0103ng nh\u1eadp \u0111\u00e3 h\u1ebft h\u1ea1n.",
        progressLabel: "\u0110\u0103ng nh\u1eadp"
      };
    }
    if(
      err?.keepPendingServerJob === true
      || normalizedKind === "solver_result_wait_timeout"
    ){
      return {
        title: "Đang chờ kết nối lại",
        message: raw || "Lượt xếp vẫn chạy trên máy chủ và hệ thống đang tự nối lại.",
        level: "warning",
        statusLevel: "info",
        statusMessage: "\u0110ang s\u1eafp x\u1ebfp...",
        progressLabel: "Nối lại"
      };
    }
    if(normalizedKind === "user_cancelled"){
      return {
        title: "Đã dừng",
        message: raw || "Đã dừng sắp xếp theo yêu cầu."
      };
    }
    if(normalizedKind === "solver_queue_timeout"){
      return {
        title: "Hệ thống xếp đang bận",
        message: raw || "Đã chờ quá lâu vì trường khác đang xếp. Vui lòng thử lại sau."
      };
    }
    if(normalizedKind === "client_timeout" || normalizedKind === "request_timeout"){
      const completeState = completeScheduleStateForExistingOptimize(getData());
      if(completeState){
        const statusMessage = noBetterScheduleStatus(
          getData()?.tkbSolverResult || window.__TKB_SOLVER_LAST_PAYLOAD || null
        );
        return {
          title: "Chưa có kết quả mới",
          message: statusMessage,
          level: "warning",
          statusLevel: "ok",
          statusMessage,
          progressLabel: "Giữ lịch"
        };
      }
      return {
        title: "Chưa nhận được kết quả",
        message: "Lượt xếp chưa trả kết quả trong thời gian đã đặt. Lịch hiện tại vẫn được giữ nguyên.",
        level: "warning",
        statusLevel: "warning",
        statusMessage: "Chưa có kết quả mới; lịch hiện tại vẫn được giữ nguyên.",
        progressLabel: "Chờ lâu"
      };
    }
    if(
      text.includes("global solver deadline exhausted")
      && text.includes("feasibility phase")
    ){
      return {
        title: "Thời gian sắp xếp quá ngắn",
        message: `Lịch chưa xếp đủ hoặc đang vi phạm ràng buộc; lượt tìm phương án đầu tiên cần ít nhất ${MIN_FRESH_SOLVE_DURATION_SECONDS} giây.`,
        level: "warning",
        statusLevel: "warning",
        progressLabel: "Thiếu thời gian"
      };
    }
    if(
      text.includes("first-click feasibility phase did not produce")
      || text.includes("constraint-change feasibility phase did not produce")
    ){
      return {
        title: "Chưa tìm được lịch đủ",
        message: "Lượt xếp chưa kịp tạo lịch đầy đủ trong thời gian hiện tại. Lịch cũ vẫn được giữ nguyên; hãy bấm Xếp lại để thử seed tiếp theo.",
        level: "warning",
        statusLevel: "warning",
        progressLabel: "Chưa đủ"
      };
    }
    if(text.includes("benders teacher-session cap search failed")){
      const completeState = completeScheduleStateForExistingOptimize(getData());
      if(completeState){
        const statusMessage = noBetterScheduleStatus(
          getData()?.tkbSolverResult || window.__TKB_SOLVER_LAST_PAYLOAD || null
        );
        return {
          title: "Chưa cải thiện thêm",
          message: statusMessage,
          level: "warning",
          statusLevel: "ok",
          statusMessage,
          progressLabel: "Giữ lịch cũ"
        };
      }
      return {
        title: "Chưa tìm được lịch phù hợp",
        message: `Bộ xếp chưa tìm được phương án đầy đủ trong thời gian hiện tại. Hãy dùng ít nhất ${MIN_FRESH_SOLVE_DURATION_SECONDS} giây hoặc kiểm tra lại các ràng buộc.`,
        level: "warning",
        statusLevel: "warning",
        progressLabel: "Chưa có phương án"
      };
    }
    if(text.includes("no_valid_hint_candidate") || text.includes("no_valid_solution_candidate")){
      const classLabel = currentSolveClassLabel();
      const scope = classLabel ? ` cho ${classLabel}` : "";
      return {
        title: "Chưa tìm được lịch phù hợp",
        message: `Rust chưa tìm được lịch hợp lệ${scope} với bộ ràng buộc hiện tại. Thường nguyên nhân là rule nghỉ, tiết cố định hoặc ràng buộc lớp/giáo viên đang quá chặt; hãy nới bớt ràng buộc rồi xếp lại.`
      };
    }
    if(kind.toLowerCase() === "infeasible_constraints"){
      const fallback = "Bộ ràng buộc hiện tại đang quá chặt nên chưa tìm được lịch hợp lệ. Hãy kiểm tra tiết nghỉ, tiết cố định, số buổi/tiết của giáo viên hoặc giới hạn môn/nhóm môn rồi chạy lại.";
      const rawText = String(raw || "").trim();
      const message = rawText && !/(vô nghiệm|vo nghiem|không có nghiệm|khong co nghiem)/i.test(rawText)
        ? rawText
        : fallback;
      return {
        title: "Chưa tìm được lịch hợp lệ",
        message
      };
    }
    if(kind.toLowerCase() === "no_complete_schedule_before_deadline"){
      const metrics = err?.payload?.metrics || {};
      const scheduled = Number(metrics.scheduled_periods || 0) || 0;
      const expected = Number(metrics.expected_periods || 0) || 0;
      const retainedComplete = completeScheduleStateForExistingOptimize(getData());
      const progressHint = scheduled > 0
        ? `Đã xếp thử ${scheduled}/${expected || "?"} tiết.`
        : "Chưa tìm được lịch đủ tiết trong giới hạn thời gian hiện tại.";
      const actionHint = "Bảng cũ được giữ lại. Hãy nới bớt tiết Nghỉ/ràng buộc rồi xếp lại.";
      const statusMessage = retainedComplete
        ? noBetterScheduleStatus(
            getData()?.tkbSolverResult || window.__TKB_SOLVER_LAST_PAYLOAD || null
          )
        : "Chưa tìm được lịch đủ; lịch hiện tại vẫn được giữ nguyên.";
      return {
        title: "Chưa tìm được lịch đủ",
        message: [
          progressHint,
          actionHint
        ].filter(Boolean).join(" "),
        level: "warning",
        statusLevel: retainedComplete ? "ok" : "warning",
        statusMessage,
        progressLabel: "Chưa đủ"
      };
    }
    if(kind.toLowerCase() === "solver_schedule_busy"){
      return {
        title: "Lịch đang được xếp ở phiên khác",
        message: "Hệ thống đã chặn lượt xếp trùng để không chạy hai luồng. Hãy chờ lượt hiện tại hoàn tất rồi bấm Xếp lại.",
        level: "warning",
        statusLevel: "info",
        progressLabel: "Đang chờ lượt hiện tại"
      };
    }
    if(kind.toLowerCase() === "solver_busy"){
      return {
        title: "Hệ thống xếp đang bận",
        message: backendDetail || raw || "Tất cả lượt xếp đang bận. Hệ thống sẽ tự chờ đến lượt; nếu lâu quá hãy bấm Dừng rồi thử lại."
      };
    }
    if(Number(err?.status || 0) === 422 && kind){
      const detail = unassignedLessonSummary(err?.payload);
      return {
        title: "Dữ liệu hoặc ràng buộc chưa xếp được",
        message: [backendDetail || raw || "Dịch vụ xếp lịch trả lỗi ràng buộc có cấu trúc.", detail]
          .filter(Boolean)
          .join(" ")
      };
    }
    if(kind.toLowerCase() === "native_solver_unsupported"){
      return {
        title: "Rust chưa tìm được phương án",
        message: raw || "Bộ xếp Rust chưa tìm được lịch hợp lệ cho tổ hợp ràng buộc hiện tại."
      };
    }
    if(kind.toLowerCase() === "algorithm_removed"){
      return {
        title: "Thuật toán đã được dọn",
        message: raw || "Dịch vụ xếp lịch vẫn đang chạy, nhưng thuật toán xếp TKB đã được gỡ để chờ viết lại."
      };
    }
    if(text.includes("remote school store save failed")){
      return {
        title: "Đã xếp xong nhưng chưa lưu được",
        message: "Kết quả vẫn được giữ trên VPS. Phần mềm sẽ nhận lại khi kết nối ổn định.",
        level: "warning",
        statusLevel: "warning",
        progressLabel: "Chờ lưu"
      };
    }
    return {
      title: "Có lỗi khi sắp xếp",
      message: raw || "Không rõ lỗi từ bộ xếp lịch."
    };
  }

  function shouldRetryIncompleteSolve(settings, payload){
    if(settings?.ui_disable_automatic_retry === true) return false;
    if(
      isTeacherSessionOptSettings(settings)
      && settings?.ui_stop_after_first_complete_schedule !== true
    ) return false;
    if(settings?.robust_retry === true) return false;
    if(isCapacityShortageAccepted(settings)) return false;
    const c = payloadCompletion(payload);
    if(c.complete || c.expected <= 0) return false;
    return c.bestEffort || c.unassigned > 0 || (c.expected > 0 && c.scheduled < c.expected);
  }

  function shouldRetrySolveError(settings, err){
    if(settings?.ui_disable_automatic_retry === true) return false;
    if(
      isTeacherSessionOptSettings(settings)
      && settings?.ui_stop_after_first_complete_schedule !== true
    ) return false;
    if(settings?.robust_retry === true) return false;
    if(isCapacityShortageAccepted(settings)) return false;
    if(positiveNumberSetting(settings?.ui_custom_solve_duration_seconds) > 0) return false;
    if(err?.backendUnavailable === true || err?.kind === "client_timeout" || err?.kind === "solver_schedule_busy") return false;
    const status = Number(err?.status || 0);
    const payloadKind = String(err?.payload?.kind || "").toLowerCase();
    if(payloadKind === "no_complete_schedule_before_deadline"){
      return settings?.ui_allow_incomplete_retry_after_single_pass === true
        || positiveNumberSetting(settings?.complete_schedule_seed_retry_max_runs) > 0;
    }
    if(settings?.speed_first_complete === true && payloadKind === "period_allocation_best_effort_unavailable") return false;
    const text = String(err?.message || err || "").toLowerCase();
    if(text.includes("app constraints failed") || text.includes("app_constraint")) return false;
    return status >= 500
      || text.includes("period")
      || text.includes("xep tiet")
      || text.includes("xếp tiết")
      || text.includes("chua xep")
      || text.includes("chưa xếp");
  }

  function robustRetrySettings(baseSettings){
    const next = Object.assign({}, baseSettings || {});
    const nextProgressRunIndex = normalizePendingProgressRunIndex(
      (Number(progressState?.runIndex || 1) || 1) + 1
    );
    const automaticRetryFloor = nextProgressRunIndex >= 3
      ? DEEP_AUTO_DURATION_SECONDS
      : ROBUST_AUTO_DURATION_SECONDS;
    next.robust_retry = true;
    next.aggressive_fast_mode = false;
    next.deep_session_rescue = true;
    next.disable_period_feasibility_bridge = false;
    next.require_complete_schedule = true;
    next.best_effort_on_timeout = true;
    next.relax_period_teacher_gap_on_failure = false;
    next.period_max_teacher_gap = 1;
    next.minimize_teacher_gaps = true;
    next.overall_time_limit_seconds = Math.max(
      automaticRetryFloor,
      normalizeOverallTimeLimit(next.overall_time_limit_seconds || 0)
    );
    next.ui_progress_run_index = nextProgressRunIndex;
    next.progress_estimate_seconds = next.overall_time_limit_seconds;
    next.backend_deadline_ms = next.overall_time_limit_seconds * 1000;
    next.native_global_deadline_ms = next.overall_time_limit_seconds * 1000;
    if(next.ui_unified_auto_sort === true && String(next.ui_unified_solve_kind || "") === "fresh_complete_first"){
      next.ui_unified_initial_fast_stage = true;
      next.ui_unified_initial_ceiling_seconds = next.overall_time_limit_seconds;
    }
    next.session_time_limit = Math.max(30, Number(next.session_time_limit || 0) || 0);
    next.period_time_limit = Math.max(60, Number(next.period_time_limit || 0) || 0);
    next.period_fast_time_limit = Math.max(30, Number(next.period_fast_time_limit || 0) || 0);
    next.period_retry_time_limit = Math.max(60, Number(next.period_retry_time_limit || 0) || 0);
    next.auto_sort_strategy = `${next.auto_sort_strategy || "fresh"}_robust_retry`;
    return next;
  }

  function incompleteScheduleQuality(payload){
    const c = payloadCompletion(payload);
    return [
      c.complete ? 0 : 1,
      c.unassigned,
      c.expected > 0 ? Math.max(0, c.expected - c.scheduled) : 1e9,
      c.violations,
      c.hardOk ? 0 : 1,
      c.bestEffort ? 1 : 0
    ];
  }

  function payloadBetterIncompleteSchedule(candidate, incumbent){
    if(!incumbent) return true;
    const a = incompleteScheduleQuality(candidate);
    const b = incompleteScheduleQuality(incumbent);
    for(let i = 0; i < a.length; i += 1){
      if(a[i] < b[i]) return true;
      if(a[i] > b[i]) return false;
    }
    return false;
  }

  function completeScheduleSeedRetrySettings(baseSettings, data, seed, runIndex){
    const next = robustRetrySettings(baseSettings || readSettings());
    const expected = expectedLessonCount(data);
    const heavy = hasFixedOffPressure(data) || hasActiveConstraintData(data) || expected >= 600;
    const limit = Math.max(
      DEEP_AUTO_DURATION_SECONDS,
      normalizeOverallTimeLimit(next.overall_time_limit_seconds || 0),
      positiveNumberSetting(next.integrated_time_limit),
      positiveNumberSetting(next.optimization_time_limit_seconds)
    );
    next.complete_schedule_seed_retry = true;
    next.complete_schedule_seed_retry_run = runIndex;
    next.force_fresh_backend_solve = true;
    next.allow_backend_cache = false;
    next.preserve_existing_tkb = false;
    next.force_preserve_partial_existing = false;
    next.partial_existing_rebuild = false;
    next.repair_fill_first = true;
    next.repair_partial_existing = true;
    next.disable_period_feasibility_bridge = false;
    next.schedule_diversity = true;
    next.randomize_search = true;
    next.fresh_randomize = true;
    next.random_seed = seed;
    next.solve_run_id = `${next.solve_run_id || "complete-seed"}-${runIndex}-${seed}`;
    next.overall_time_limit_seconds = limit;
    next.backend_deadline_ms = limit * 1000;
    next.native_global_deadline_ms = limit * 1000;
    if(next.ui_unified_auto_sort === true && String(next.ui_unified_solve_kind || "") === "fresh_complete_first"){
      next.ui_unified_initial_fast_stage = true;
      next.ui_unified_initial_ceiling_seconds = limit;
    }
    next.integrated_time_limit = Math.max(limit, Number(next.integrated_time_limit || 0) || 0);
    next.progress_estimate_seconds = limit;
    next.session_time_limit = Math.max(45, Number(next.session_time_limit || 0) || 0);
    next.period_time_limit = Math.max(90, Number(next.period_time_limit || 0) || 0);
    next.period_fast_time_limit = next.period_time_limit;
    next.period_retry_time_limit = Math.max(next.period_time_limit, Number(next.period_retry_time_limit || 0) || 0);
    next.native_fresh_attempts = Math.max(heavy ? 120 : 80, Number(next.native_fresh_attempts || 0) || 0);
    next.native_fresh_max_iters = Math.max(180000, Number(next.native_fresh_max_iters || 0) || 0);
    next.native_fresh_time_limit_ms = Math.max(heavy ? 135000 : 70000, Number(next.native_fresh_time_limit_ms || 0) || 0);
    next.native_fresh_cleanup_time_limit_ms = Math.max(heavy ? 60000 : 30000, Number(next.native_fresh_cleanup_time_limit_ms || 0) || 0);
    next.auto_sort_strategy = `complete_schedule_seed_retry_${runIndex}`;
    enforceCompleteScheduleForUi(next);
    return enforceNoHintFreshSolveSettings(next);
  }

  async function postRobustFirstCompleteRetry(baseSettings, data, runId, usedSeedAttempts){
    const retrySettings = robustRetrySettings(baseSettings);
    setStatus("Đang sắp xếp...", "info");
    restartProgressForRetry(retrySettings, data);
    try{
      const payload = await postSolve(retrySettings);
      if(!isCurrentSolveRun(runId)) return {payload:null, seedAttemptsUsed:usedSeedAttempts || 0};
      return {payload, seedAttemptsUsed:usedSeedAttempts || 0};
    }catch(retryErr){
      rethrowCancelledSolve(retryErr, runId);
      rethrowAuthRequiredSolve(retryErr);
      if(
        baseSettings?.ui_stop_after_first_complete_schedule !== true
        || retryErr?.kind === "solver_busy"
        || !shouldRetrySolveError(baseSettings, retryErr)
      ) throw retryErr;

      const requestedSeedCount = positiveNumberSetting(baseSettings?.complete_schedule_seed_retry_max_runs);
      const seedCount = Math.min(12, requestedSeedCount);
      const seeds = schoolSeedSequence(data, seedCount);
      const firstIndex = Math.max(0, Math.min(seeds.length, Number(usedSeedAttempts || 0) || 0));
      let lastError = retryErr;
      for(let index = firstIndex; index < seeds.length; index += 1){
        throwIfStopRequested(runId);
        const seedSettings = completeScheduleSeedRetrySettings(
          baseSettings,
          data,
          seeds[index],
          index + 1
        );
        setStatus("Đang sắp xếp...", "info");
        restartProgressForRetry(seedSettings, data);
        try{
          const payload = await postSolve(seedSettings);
          if(!isCurrentSolveRun(runId)) return {payload:null, seedAttemptsUsed:index + 1};
          return {payload, seedAttemptsUsed:index + 1};
        }catch(seedErr){
          rethrowCancelledSolve(seedErr, runId);
          rethrowAuthRequiredSolve(seedErr);
          lastError = seedErr;
          console.warn(`[${VERSION}] complete schedule seed ${seeds[index]} skipped after retry error`, seedErr);
        }
      }
      throw lastError;
    }
  }

  function requestedTeacherSessionCap(settings){
    const values = [positiveNumberSetting(settings?.target_teacher_sessions)];
    if(settings?.teacher_session_target_explicit === true){
      values.push(
        positiveNumberSetting(settings?.requested_max_teacher_sessions),
        positiveNumberSetting(settings?.max_teacher_sessions)
      );
    }
    const numeric = values.filter(value => Number.isFinite(value) && value > 0);
    return numeric.length ? Math.min(...numeric) : 0;
  }

  function hasFixedOffPressure(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo && typeof memo.hasFixedOffPressure === "boolean") return memo.hasFixedOffPressure;
    const fixed = data?.tkbConstraints?.fixedOff || {};
    const result = hasTruthyOffMap(data?.tkbUserOff) ||
      ["class","teacher","subject","room","subjectGroup"].some(kind => hasTruthyOffMap(fixed[kind]));
    if(memo) memo.hasFixedOffPressure = result;
    return result;
  }

  function hasClassOffPressure(data){
    const fixedClass = data?.tkbConstraints?.fixedOff?.class;
    return hasTruthyOffMap(data?.tkbUserOff) || hasTruthyOffMap(fixedClass);
  }

  function shouldUseFixedOffValidatedQualityBank(data, settings){
    return false;
  }

  function clearPartialExistingRepairFlags(settings){
    if(!settings || typeof settings !== "object") return;
    settings.preserve_existing_tkb = false;
    settings.force_preserve_partial_existing = false;
    settings.partial_existing_rebuild = false;
    settings.repair_fill_first = false;
    settings.repair_partial_existing = false;
    delete settings.repair_partial_existing_reason;
    delete settings.repair_existing_missing_periods;
    delete settings.existing_scheduled_periods;
    delete settings.existing_flexible_scheduled_periods;
  }

  function applyFixedOffValidatedQualityBankSettings(settings, data, reason){
    return false;
  }

  function lowerBoundTeacherSessionQualityTarget(data, teacherSessions){
    if(hasFixedOffPressure(data)) return 0;
    const lowerCap = Math.max(0, Math.round(Number(teacherSessionLoadLowerCap(data) || 0)));
    if(lowerCap <= 0 || teacherSessions <= lowerCap) return 0;
    const over = teacherSessions - lowerCap;
    if(over > 24) return 0;
    const c = data?.tkbConstraints;
    const hasSubjectRules = !!(
      c && typeof c === "object" && (
        (c.subject && typeof c.subject === "object" && Object.keys(c.subject).length > 0) ||
        (c.subjectGroup && typeof c.subjectGroup === "object" && Object.keys(c.subjectGroup).length > 0) ||
        (c.subjectNoSameSession?.byClass && typeof c.subjectNoSameSession.byClass === "object" && Object.keys(c.subjectNoSameSession.byClass).length > 0) ||
        (Array.isArray(c.timeLimit) && c.timeLimit.length > 0)
      )
    );
    return hasSubjectRules ? lowerCap : 0;
  }

  function teacherSessionQualityTarget(settings, data, payload){
    if(String(settings?.auto_sort_mode || "") === "shuffle_fill") return 0;
    if(isTeacherSessionOptSettings(settings)) return 0;
    const c = payloadCompletion(payload);
    if(!c.complete) return 0;
    const metrics = payload?.metrics || {};
    const teacherSessions = metricNumber(metrics.teacher_sessions);
    if(teacherSessions <= 0) return 0;
    const hasExplicitTarget = settings?.teacher_session_target_explicit === true;
    const requestedCap = requestedTeacherSessionCap(settings);
    const explicitAcceptCap = hasExplicitTarget
      ? positiveNumberSetting(settings?.optimization_accept_teacher_sessions)
      : 0;
    if(hasExplicitTarget){
      const explicitCap = explicitAcceptCap > 0 ? explicitAcceptCap : requestedCap;
      if(explicitCap > 0) return teacherSessions > explicitCap ? explicitCap : 0;
      return 0;
    }
    const adaptiveDefaultCap = positiveNumberSetting(adaptiveTeacherSessionFastCap(data))
      || positiveNumberSetting(adaptiveTeacherSessionStartCap(data));
    const defaultCap = Math.max(
      positiveNumberSetting(DEFAULT_SETTINGS.max_teacher_sessions),
      adaptiveDefaultCap
    );
    if(requestedCap > 0 && teacherSessions > requestedCap) return requestedCap;
    if(explicitAcceptCap > 0 && teacherSessions > explicitAcceptCap) return explicitAcceptCap;
    if(defaultCap > 0 && teacherSessions > defaultCap) return defaultCap;
    if(settings?.allow_adaptive_teacher_session_quality_target === true){
      const adaptiveCap = positiveNumberSetting(adaptiveTeacherSessionStartCap(data))
        || (hasFixedOffPressure(data) ? 0 : positiveNumberSetting(teacherSessionLoadLowerCap(data)));
      if(adaptiveCap > 0 && teacherSessions > adaptiveCap) return adaptiveCap;
      const lowerTarget = lowerBoundTeacherSessionQualityTarget(data, teacherSessions);
      if(lowerTarget > 0) return lowerTarget;
    }
    return 0;
  }

  function teacherSessionGapQualityTarget(settings){
    const target = nonnegativeNumberSetting(settings?.target_gap1_sessions);
    if(target != null) return target;
    const accept = nonnegativeNumberSetting(settings?.optimization_accept_gap1_sessions);
    if(accept == null) return null;
    if(settings?.gap1_quality_target_explicit === true) return accept;
    if(settings?.teacher_session_quality_retry === true) return accept;
    if(settings?.teacher_session_fast_portfolio === true) return accept;
    if(isTeacherSessionOptSettings(settings)) return accept;
    return null;
  }

  function teacherSessionQualityRetryPlan(settings, data, payload){
    if(isTeacherSessionOptSettings(settings)) return null;
    const c = payloadCompletion(payload);
    if(!c.complete) return null;
    const metrics = payload?.metrics || {};
    const teacherSessions = metricNumber(metrics.teacher_sessions);
    if(teacherSessions <= 0) return null;
    const teacherTarget = teacherSessionQualityTarget(settings, data, payload);
    const gap1 = metricNumber((metrics.gap_distribution || {})["1"], 0);
    const gap2Plus = gap2PlusCount(metrics);
    const onePeriodSessions = metricNumber(metrics.one_period_teacher_sessions, 0);
    const onePeriodTarget = onePeriodTeacherSessionLowerBound(metrics);
    const gapTarget = teacherSessionGapQualityTarget(settings);
    const needsTeacher = teacherTarget > 0 && teacherSessions > teacherTarget;
    const softGapMayRemainDebt = settings?.allow_quality_debt === true
      && shouldUseFixedOffValidatedQualityBank(data, settings);
    const needsSoftGap = !softGapMayRemainDebt && gapTarget != null && gap1 > gapTarget;
    const needsGap = onePeriodSessions > onePeriodTarget || gap2Plus > 0 || needsSoftGap;
    if(!needsTeacher && !needsGap) return null;
    const hardGap = onePeriodSessions > onePeriodTarget || gap2Plus > 0;
    let effectiveTeacherTarget = teacherSessions;
    if(needsTeacher && teacherTarget > 0){
      if(hardGap){
        effectiveTeacherTarget = teacherSessions;
      }else{
        const teacherDebt = Math.max(0, teacherSessions - teacherTarget);
        const teacherStep = Math.max(8, Math.ceil(teacherDebt * 0.35));
        effectiveTeacherTarget = Math.max(teacherTarget, teacherSessions - teacherStep);
      }
    }
    let effectiveGapTarget = gapTarget;
    if(gapTarget != null && gap1 > gapTarget){
      if(hardGap){
        effectiveGapTarget = gap1;
      }else{
        const gapDebt = Math.max(0, gap1 - gapTarget);
        const gapStep = Math.max(8, Math.ceil(gapDebt * 0.35));
        effectiveGapTarget = Math.max(gapTarget, gap1 - gapStep);
      }
    }
    return {
      teacherTarget: effectiveTeacherTarget,
      startTeacherSessions: teacherSessions,
      gap1Target: effectiveGapTarget,
      finalTeacherTarget: teacherTarget,
      finalGap1Target: gapTarget,
      hardGap,
      needsTeacher,
      needsGap
    };
  }

  function shouldRetryTeacherSessionQuality(settings, data, payload){
    if(String(settings?.auto_sort_mode || "") === "shuffle_fill") return false;
    if(settings?.teacher_session_quality_retry === true) return false;
    if(settings?.ui_single_pass_auto_sort === true && settings?.ui_allow_fresh_deep_teacher_retry !== true) return false;
    if(settings?.allow_teacher_session_deep_retry !== true) return false;
    if(hasHardFixedLessons(data) && settings?.allow_optimize_with_fixed_lessons !== true) return false;
    return !!teacherSessionQualityRetryPlan(settings, data, payload);
  }

  function shouldRetryZeroOneQuality(settings, data, payload){
    if(String(settings?.auto_sort_mode || "") === "shuffle_fill") return false;
    if(settings?.zero_one_quality_retry === true) return false;
    if(settings?.allow_zero_one_quality_retry === false) return false;
    if(isTeacherSessionOptSettings(settings)) return false;
    if(hasHardFixedLessons(data) && settings?.allow_optimize_with_fixed_lessons !== true) return false;
    const c = payloadCompletion(payload);
    if(!c.complete) return false;
    const metrics = payload?.metrics || {};
    return !onePeriodTeacherSessionFloorReached(metrics) || gap2PlusCount(metrics) > 0;
  }

  function zeroOneQualityRetrySettings(baseSettings, data, payload, seed, runIndex){
    const metrics = payload?.metrics || {};
    const currentTeacherSessions = metricNumber(metrics.teacher_sessions, 0);
    const expected = expectedLessonCount(data);
    const fixedOnlySeed = countFixedScheduledLessons(data) > 0
      && countScheduledLessons(data) <= countFixedScheduledLessons(data);
    const heavyRetry = fixedOnlySeed || hasFixedOffPressure(data);
    const budgets = constraintAwareFastQualityBudgets(expected, data);
    const retryLimit = Math.max(
      heavyRetry ? 120 : 70,
      Math.min(
        heavyRetry ? 180 : 110,
        positiveNumberSetting(baseSettings?.zero_one_quality_retry_time_limit_seconds)
          || positiveNumberSetting(baseSettings?.fast_quality_retry_time_limit_seconds)
          || budgets.qualityRetry
          || 90
      )
    );
    const next = settingsForTeacherSessionOpt(baseSettings || readSettings());
    next.zero_one_quality_retry = true;
    next.allow_cpsat_quality_improvement = true;
    next.disable_cpsat_quality_improvement = false;
    next.allow_validated_quality_bank = false;
    next.allow_strict_quality_solution_bank = false;
    next.disable_native_hint_solver = true;
    next.disable_solver_hints = true;
    next.native_disable_cached_hint_candidate = true;
    next.native_disable_static_hint_candidate = true;
    next.native_hint_bank_max_entries = 0;
    next.native_hint_bank_time_limit_ms = 0;
    next.native_hint_bank_validation_limit = 0;
    next.native_hint_bank_cleanup_validation_limit = 0;
    next.native_hint_bank_candidate_cleanup_time_ms = 0;
    next.native_hint_bank_hard_repair_violation_cap = 0;
    delete next.native_hint_bank_min_stored_teacher_sessions;
    next.zero_one_quality_retry_run = runIndex;
    next.strict_quality_targets = true;
    next.enforce_quality_targets = true;
    next.max_one_period_sessions = 0;
    next.period_max_teacher_gap = 1;
    next.allow_one_period_gaps = true;
    next.minimize_one_period_sessions = true;
    next.one_period_priority_absolute = true;
    next.minimize_teacher_gaps = true;
    next.require_complete_schedule = true;
    next.best_effort_on_timeout = true;
    next.allow_backend_cache = false;
    next.force_fresh_backend_solve = true;
    next.disable_native_hint_solver = true;
    next.disable_solver_hints = true;
    next.allow_solver_warm_start = false;
    next.native_disable_cached_hint_candidate = true;
    next.native_disable_static_hint_candidate = true;
    next.native_hint_bank_max_entries = 0;
    next.native_hint_bank_time_limit_ms = 0;
    next.native_hint_bank_cleanup_validation_limit = 0;
    next.native_hint_bank_candidate_cleanup_time_ms = 0;
    next.native_hint_bank_hard_repair_violation_cap = 0;
    next.native_overlay_hard_repair_time_ms = Math.max(heavyRetry ? 2500 : 1500, Number(next.native_overlay_hard_repair_time_ms || 0) || 0);
    next.native_teacher_session_compact_time_limit_ms = Math.max(heavyRetry ? 4500 : 2500, Number(next.native_teacher_session_compact_time_limit_ms || 0) || 0);
    next.schedule_diversity = false;
    next.reclick_schedule_diversity = false;
    delete next.avoid_teacher_session_signature;
    delete next.avoid_teacher_session_signatures;
    delete next.avoid_lesson_signature;
    delete next.avoid_lesson_signatures;
    delete next.require_teacher_session_diversity;
    delete next.target_teacher_sessions;
    delete next.max_teacher_sessions;
    delete next.requested_max_teacher_sessions;
    delete next.optimization_accept_teacher_sessions;
    delete next.target_gap1_sessions;
    delete next.optimization_accept_gap1_sessions;
    next.optimization_start_teacher_sessions = Math.max(
      currentTeacherSessions + 24,
      positiveNumberSetting(adaptiveTeacherSessionSpeedCap(data)),
      positiveNumberSetting(adaptiveTeacherSessionStartCap(data)),
      260
    );
    next.optimization_time_limit_seconds = retryLimit;
    next.ui_client_timeout_reserve_ms = Math.max(
      45_000,
      Number(next.ui_client_timeout_reserve_ms || 0) || 0
    );
    next.native_cpsat_quality_time_limit_seconds = Math.max(
      heavyRetry ? 90 : 60,
      Math.min(180, Math.round(retryLimit * (heavyRetry ? 0.7 : 0.55)))
    );
    next.optimization_first_cap_time_limit_seconds = Math.max(45, Math.min(retryLimit, 90));
    next.optimization_session_time_limit = Math.max(45, Math.min(retryLimit, 90));
    next.optimization_period_retry_time_limit = Math.max(30, Math.min(retryLimit, 60));
    next.overall_time_limit_seconds = retryLimit;
    next.progress_estimate_seconds = retryLimit;
    next.native_fresh_time_limit_ms = Math.max(
      heavyRetry ? 135000 : 36000,
      Math.min(
        heavyRetry ? 150000 : 70000,
        Math.round(retryLimit * 1000 * 0.75)
      )
    );
    next.native_fresh_attempts = heavyRetry ? 80 : 56;
    next.native_fresh_max_iters = 120000;
    next.native_quality_cleanup_max_iters = Math.max(
        heavyRetry ? 120 : 80,
        Number(next.native_quality_cleanup_max_iters || 0) || 0
      );
    next.native_fresh_cleanup_time_limit_ms = Math.max(heavyRetry ? 42000 : 14000, Number(next.native_fresh_cleanup_time_limit_ms || 0) || 0);
    next.native_hint_quality_cleanup_time_limit_ms = 0;
    next.native_fresh_empty_moves = true;
    next.native_stop_on_zero_one = true;
    next.fresh_randomize = true;
    next.randomize_search = true;
    next.random_seed = seed;
    next.quality_variant_seed = seed;
    next.auto_sort_strategy = "fresh_zero_one_quality_retry";
    next.session_time_limit = Math.max(18, budgets.session || 12);
    next.period_time_limit = Math.max(30, budgets.period || 18);
    next.period_fast_time_limit = next.period_time_limit;
    next.period_retry_time_limit = next.period_time_limit;
    next.integrated_time_limit = retryLimit;
    return enforceNoHintFreshSolveSettings(next);
  }

  function teacherSessionQualityRetrySettings(baseSettings, data, payload){
    const plan = teacherSessionQualityRetryPlan(baseSettings, data, payload);
    if(!plan) return null;
    const next = settingsForTeacherSessionOpt(baseSettings || readSettings());
    const requestedRetryLimit = positiveNumberSetting(baseSettings?.fast_quality_retry_time_limit_seconds);
    const retryLimit = requestedRetryLimit > 0
      ? requestedRetryLimit
      : Math.max(90, Math.min(
          Number(DEFAULT_SETTINGS.optimization_time_limit_seconds || 240),
          180
        ));
    next.teacher_session_quality_retry = true;
    next.allow_cpsat_quality_improvement = true;
    next.disable_cpsat_quality_improvement = false;
    next.allow_validated_quality_bank = false;
    next.allow_strict_quality_solution_bank = false;
    next.disable_native_hint_solver = true;
    next.disable_solver_hints = true;
    next.native_disable_cached_hint_candidate = true;
    next.native_disable_static_hint_candidate = true;
    next.native_hint_bank_max_entries = 0;
    next.native_hint_bank_time_limit_ms = 0;
    next.native_hint_bank_validation_limit = 0;
    next.native_hint_bank_cleanup_validation_limit = 0;
    next.native_hint_bank_candidate_cleanup_time_ms = 0;
    next.native_hint_bank_hard_repair_violation_cap = 0;
    delete next.native_hint_bank_min_stored_teacher_sessions;
    next.schedule_diversity = false;
    next.reclick_schedule_diversity = false;
    delete next.avoid_teacher_session_signature;
    delete next.avoid_teacher_session_signatures;
    delete next.avoid_lesson_signature;
    delete next.avoid_lesson_signatures;
    delete next.require_teacher_session_diversity;
    next.target_teacher_sessions = plan.teacherTarget;
    next.max_teacher_sessions = plan.teacherTarget;
    next.requested_max_teacher_sessions = plan.teacherTarget;
    next.optimization_accept_teacher_sessions = plan.teacherTarget;
    if(plan.gap1Target != null){
      next.target_gap1_sessions = plan.gap1Target;
      next.optimization_accept_gap1_sessions = plan.gap1Target;
    }else{
      delete next.target_gap1_sessions;
      delete next.optimization_accept_gap1_sessions;
    }
    next.optimization_start_teacher_sessions = Math.max(
      plan.teacherTarget,
      plan.startTeacherSessions
    );
    next.native_cpsat_teacher_session_cap = next.optimization_start_teacher_sessions;
    next.native_cpsat_quality_time_limit_seconds = Math.max(
      plan.hardGap ? 90 : 75,
      Math.min(180, Math.round((retryLimit || 120) * (plan.hardGap ? 0.75 : 0.6)))
    );
    next.native_cpsat_lns_teacher_session_cap = plan.teacherTarget;
    next.native_cpsat_lns_time_limit_seconds = Math.max(
      plan.hardGap ? 300 : 600,
      Math.min(900, Math.round((retryLimit || 120) * (plan.hardGap ? 4 : 6)))
    );
    next.optimization_time_limit_seconds = retryLimit;
    next.ui_client_timeout_reserve_ms = Math.max(
      45_000,
      Number(next.ui_client_timeout_reserve_ms || 0) || 0
    );
    next.optimization_first_cap_time_limit_seconds = Math.max(60, Math.min(
      next.optimization_time_limit_seconds,
      Number(DEFAULT_SETTINGS.optimization_first_cap_time_limit_seconds || 120)
    ));
    next.optimization_session_time_limit = Math.max(60, Math.min(
      next.optimization_time_limit_seconds,
      Number(DEFAULT_SETTINGS.optimization_session_time_limit || 120)
    ));
    next.overall_time_limit_seconds = next.optimization_time_limit_seconds;
    next.progress_estimate_seconds = next.optimization_time_limit_seconds;
    next.native_fresh_time_limit_ms = Math.max(12000, Math.min(
      plan.hardGap ? 45000 : 32000,
      Math.round(next.optimization_time_limit_seconds * 1000 * 0.55)
    ));
    next.native_fresh_attempts = Math.max(plan.hardGap ? 36 : 18, Math.min(plan.hardGap ? 48 : 32, Number(next.native_fresh_attempts || 24) || 24));
    next.native_fresh_max_iters = Math.max(plan.hardGap ? 70000 : 30000, Math.min(plan.hardGap ? 120000 : 70000, Number(next.native_fresh_max_iters || 50000) || 50000));
    next.native_quality_cleanup_max_iters = Math.max(
      plan.hardGap ? 120 : 80,
      Number(next.native_quality_cleanup_max_iters || 0) || 0
    );
    next.native_fresh_cleanup_time_limit_ms = Math.max(2000, Math.min(
      plan.hardGap ? 14000 : 5000,
      Math.round(next.optimization_time_limit_seconds * 1000 * 0.08)
    ));
    next.native_hint_quality_cleanup_time_limit_ms = 0;
    next.local_one_period_cleanup_time_limit = Math.max(
      plan.hardGap ? 12 : 4,
      Number(next.local_one_period_cleanup_time_limit || 0) || 0
    );
    next.one_period_cluster_repair_time_limit = Math.max(
      plan.hardGap ? 12 : 4,
      Number(next.one_period_cluster_repair_time_limit || 0) || 0
    );
    next.session_priority_rescue_time_limit = Math.max(
      plan.hardGap ? 12 : 4,
      Number(next.session_priority_rescue_time_limit || 0) || 0
    );
    next.native_fresh_empty_moves = true;
    next.auto_sort_strategy = "fresh_teacher_session_quality_retry";
    next.teacher_session_quality_retry_reason = plan.needsTeacher && plan.needsGap
      ? "teacher_sessions_and_gap"
      : (plan.needsTeacher ? "teacher_sessions" : "gap");
    return enforceNoHintFreshSolveSettings(next);
  }

  function shouldTryFastTeacherSessionPortfolio(settings, data, payload){
    return !!fastTeacherSessionPortfolioPlan(settings, data, payload);
  }

  function fixedLessonPortfolioProfile(data){
    const fixedCount = countFixedScheduledLessons(data);
    if(fixedCount <= 0) return {allowed:true, fixedCount:0, cap:0};
    const expected = expectedLessonCount(data);
    const cap = Math.max(24, Math.min(180, Math.ceil(Math.max(1, expected) * 0.18)));
    return {
      allowed: fixedCount <= cap,
      fixedCount,
      cap
    };
  }

  function isFixedOnlySeedSchedule(data){
    const fixedCount = countFixedScheduledLessons(data);
    return fixedCount > 0 && countScheduledLessons(data) <= fixedCount;
  }

  function applyCompactFirstTimeBudget(settings, expected){
    if(!settings || settings.ui_compact_first_pass !== true) return settings;
    const size = Math.max(0, Number(expected || 0) || 0);
    const limit = size >= 900 ? 100 : 65;
    const freshMs = size >= 900 ? 76000 : 42000;
    const cleanupMs = size >= 900 ? 12000 : 8000;
    settings.overall_time_limit_seconds = Math.min(
      limit,
      Math.max(size >= 900 ? 82 : 50, Number(settings.overall_time_limit_seconds || limit) || limit)
    );
    settings.integrated_time_limit = settings.overall_time_limit_seconds;
    settings.session_time_limit = Math.min(
      size >= 900 ? 38 : 26,
      Math.max(20, Number(settings.session_time_limit || 0) || (size >= 900 ? 38 : 26))
    );
    settings.period_time_limit = Math.min(
      size >= 900 ? 30 : 22,
      Math.max(16, Number(settings.period_time_limit || 0) || (size >= 900 ? 30 : 22))
    );
    settings.period_fast_time_limit = settings.period_time_limit;
    settings.period_retry_time_limit = settings.period_time_limit;
    settings.native_fresh_time_limit_ms = Math.min(
      freshMs,
      Math.max(size >= 900 ? 62000 : 32000, Number(settings.native_fresh_time_limit_ms || freshMs) || freshMs)
    );
    settings.native_fresh_cleanup_time_limit_ms = Math.min(
      cleanupMs,
      Math.max(size >= 900 ? 8000 : 5500, Number(settings.native_fresh_cleanup_time_limit_ms || cleanupMs) || cleanupMs)
    );
    settings.native_hint_quality_cleanup_time_limit_ms = 0;
    settings.progress_estimate_seconds = Math.min(
      size >= 900 ? 62 : 42,
      Math.max(32, Number(settings.progress_estimate_seconds || 0) || (size >= 900 ? 62 : 42))
    );
    return settings;
  }

  function fastTeacherSessionPortfolioPlan(settings, data, payload){
    if(settings?.allow_teacher_session_fast_portfolio !== true) return null;
    if(settings?.teacher_session_fast_portfolio === true) return null;
    if(settings?.ui_compact_first_pass === true) return null;
    if(isTeacherSessionOptSettings(settings)) return null;
    const fixedProfile = fixedLessonPortfolioProfile(data);
    if(!fixedProfile.allowed) return null;
    if(!hasFixedOffPressure(data)) return null;
    if(!payloadCompletion(payload).complete) return null;
    const expected = expectedLessonCount(data);
    const practical = practicalTeacherQualityTargets(data);
    const teacherTarget = positiveNumberSetting(teacherSessionQualityTarget(settings, data, payload))
      || positiveNumberSetting(settings?.optimization_accept_teacher_sessions)
      || positiveNumberSetting(settings?.target_teacher_sessions)
      || positiveNumberSetting(practical.teacherTarget);
    let gap1Target = teacherSessionGapQualityTarget(settings);
    if(gap1Target == null) gap1Target = nonnegativeNumberSetting(practical.gap1Target);
    const q = teacherQualitySummary(payload);
    const needsTeacher = teacherTarget > 0 && q.teacherSessions > teacherTarget;
    const needsGap = !onePeriodTeacherSessionFloorReached(payload?.metrics || {})
      || q.gap2Plus > 0
      || (gap1Target != null && q.gap1 > gap1Target);
    if(!needsTeacher && !needsGap) return null;
    const teacherSlack = expected >= 900 ? 8 : 5;
    const gapSlack = expected >= 900 ? 1 : 0;
    return {
      expected,
      teacherTarget,
      gap1Target,
      teacherStop: teacherTarget > 0 ? teacherTarget + teacherSlack : 0,
      gap1Stop: gap1Target == null ? null : gap1Target + gapSlack,
      fixedLessonCount: fixedProfile.fixedCount,
      maxAttempts: expected >= 900 ? 4 : 3
    };
  }

  function fastTeacherSessionPortfolioSatisfied(payload, plan){
    const q = teacherQualitySummary(payload);
    const metrics = payload?.metrics || {};
    if(!onePeriodTeacherSessionFloorReached(metrics) || q.gap2Plus > 0) return false;
    if(plan.teacherStop > 0 && q.teacherSessions > plan.teacherStop) return false;
    if(plan.gap1Stop != null && q.gap1 > plan.gap1Stop) return false;
    return true;
  }

  function fastTeacherSessionPortfolioCap(plan, payload, attemptIndex){
    const q = teacherQualitySummary(payload);
    const current = Math.max(0, q.teacherSessions);
    if(plan.teacherTarget > 0 && current > plan.teacherTarget){
      if(attemptIndex >= 2) return plan.teacherTarget;
      const debt = current - plan.teacherTarget;
      const ratio = attemptIndex <= 1 ? 0.45 : 0.65;
      const step = Math.max(2, Math.ceil(debt * ratio));
      return Math.max(plan.teacherTarget, current - step);
    }
    if(
      plan.gap1Target != null
      && q.gap1 > plan.gap1Stop
      && plan.teacherStop > 0
    ){
      const gapPolishCap = plan.teacherTarget > 0
        ? Math.max(current, plan.teacherTarget)
        : current;
      return Math.min(plan.teacherStop, gapPolishCap);
    }
    return Math.max(plan.teacherTarget || 0, current || 0);
  }

  function teacherSessionFastPortfolioSettings(baseSettings, plan, seed, cap, attemptIndex){
    const next = settingsForFastQualityAutoSort(baseSettings || readSettings());
    next.teacher_session_fast_portfolio = true;
    next.allow_teacher_session_deep_retry = false;
    next.allow_teacher_session_fast_portfolio = false;
    next.allow_optimize_with_fixed_lessons = true;
    next.max_teacher_sessions = cap;
    next.requested_max_teacher_sessions = cap;
    if(plan.teacherTarget > 0){
      next.target_teacher_sessions = plan.teacherTarget;
      next.optimization_accept_teacher_sessions = plan.teacherTarget;
      next.teacher_session_target_explicit = true;
    }
    if(plan.gap1Target != null){
      next.target_gap1_sessions = plan.gap1Target;
      next.optimization_accept_gap1_sessions = plan.gap1Target;
      next.optimization_default_accept_gap1_sessions = plan.gap1Target;
      next.gap1_quality_target_explicit = true;
    }
    next.randomize_search = true;
    next.fresh_randomize = true;
    next.random_seed = seed;
    next.fresh_randomize_strategy = DEFAULT_SETTINGS.fresh_randomize_strategy || "solver_random";
    next.auto_sort_strategy = "fresh_fast_quality_seed_portfolio";
    next.solve_run_id = `${next.solve_run_id || makeSolveRunId()}-fast-compact-${attemptIndex}-${seed}`;
    next.allow_quality_debt = false;
    next.complete_schedule_seed_retry = false;
    if(Number(plan.fixedLessonCount || 0) > 0){
      next.preserve_fixed_lessons_only = true;
      next.existing_fixed_scheduled_periods = Number(plan.fixedLessonCount || 0);
      next.force_preserve_partial_existing = true;
      next.partial_existing_rebuild = true;
    }
    const budgets = constraintAwareFastQualityBudgets(plan.expected, getData());
    const slice = plan.expected >= 900 ? 90 : 60;
    next.session_time_limit = Math.max(35, Math.min(60, budgets.session || 45));
    next.period_time_limit = Math.max(35, Math.min(60, budgets.period || 45));
    next.period_fast_time_limit = next.period_time_limit;
    next.period_retry_time_limit = next.period_time_limit;
    next.overall_time_limit_seconds = Math.max(slice, Math.min(plan.expected >= 900 ? 105 : 75, normalizeOverallTimeLimit(next.overall_time_limit_seconds || slice)));
    next.integrated_time_limit = next.overall_time_limit_seconds;
    next.progress_estimate_seconds = Math.min(90, next.overall_time_limit_seconds);
    return enforceNoHintFreshSolveSettings(next);
  }

  function teacherSessionQuality(payload, gap1First){
    const metrics = payload?.metrics || {};
    const onePeriod = metricNumber(metrics.one_period_teacher_sessions, 1e9);
    const gap2Plus = gap2PlusCount(metrics);
    const gap1 = gapExactCount(metrics, 1);
    const totalGap = metricGapTotal(metrics);
    const teacherSessions = metricNumber(metrics.teacher_sessions, 1e9);
    return gap1First === true
      ? [onePeriod, gap1, gap2Plus, teacherSessions, totalGap]
      : [onePeriod, gap2Plus, teacherSessions, gap1, totalGap];
  }

  function teacherQualitySummary(payload){
    const metrics = payload?.metrics || {};
    return {
      scheduled: metricNumber(metrics.scheduled_periods, 0),
      expected: metricNumber(metrics.expected_periods, 0),
      unassigned: metricNumber(metrics.unassigned_periods, 0),
      teacherSessions: metricNumber(metrics.teacher_sessions, 0),
      onePeriod: metricNumber(metrics.one_period_teacher_sessions, 0),
      onePeriodLowerBound: onePeriodTeacherSessionLowerBound(metrics),
      gap1: gapExactCount(metrics, 1),
      gap2Plus: gap2PlusCount(metrics),
      totalGap: metricGapTotal(metrics)
    };
  }

  function inheritRefinementRound(targetPayload, sourcePayload){
    if(!targetPayload || typeof targetPayload !== "object") return 0;
    const targetRound = Math.max(0, Math.round(metricNumber(
      targetPayload?.solver?.runtime_settings?.optimization_refinement_round
        ?? targetPayload?.metrics?.optimization_refinement_round,
      0
    )));
    const sourceRound = Math.max(0, Math.round(metricNumber(
      sourcePayload?.solver?.runtime_settings?.optimization_refinement_round
        ?? sourcePayload?.metrics?.optimization_refinement_round,
      0
    )));
    const inherited = Math.max(targetRound, sourceRound);
    if(inherited <= 0) return targetRound;
    if(!targetPayload.metrics || typeof targetPayload.metrics !== "object") targetPayload.metrics = {};
    if(!targetPayload.solver || typeof targetPayload.solver !== "object") targetPayload.solver = {};
    if(!targetPayload.solver.runtime_settings || typeof targetPayload.solver.runtime_settings !== "object"){
      targetPayload.solver.runtime_settings = {};
    }
    targetPayload.metrics.optimization_refinement_round = inherited;
    targetPayload.solver.runtime_settings.optimization_refinement_round = inherited;
    return inherited;
  }

  function hasVisibleTeacherQualityMetrics(payload){
    const metrics = payload?.metrics;
    return !!(
      metrics
      && typeof metrics === "object"
      && Object.prototype.hasOwnProperty.call(metrics, "teacher_sessions")
      && Object.prototype.hasOwnProperty.call(metrics, "one_period_teacher_sessions")
      && metrics.gap_distribution
      && typeof metrics.gap_distribution === "object"
    );
  }

  function completionQualityStatus(payload, data){
    const completion = payloadCompletion(payload);
    const scheduled = Math.max(0, completion.scheduled || completion.expected || 0);
    const genericMessage = completion.complete && completion.hardOk !== false
      ? SOLVE_COMPLETE_MESSAGE
      : (scheduled > 0 ? `Đã xếp ${scheduled} tiết nhưng chưa hoàn tất.` : "Chưa xếp xong.");
    if(!completion.complete || completion.hardOk === false){
      return {level:"warning", progressLabel:"Chưa đủ", message:genericMessage, targetMet:false};
    }
    if(!hasVisibleTeacherQualityMetrics(payload)){
      return {level:"ok", progressLabel:"Hoàn tất", message:genericMessage, targetMet:null};
    }

    const q = teacherQualitySummary(payload);
    const metrics = payload?.metrics || {};
    const singletonFloorMessage = onePeriodTeacherSessionFloorMessage(payload);
    let targets = {teacherTarget:0, gap1Target:null};
    try{ targets = practicalTeacherQualityTargets(data || getData()); }catch(_){ }
    const teacherDebt = Number(targets.teacherTarget || 0) > 0
      && q.teacherSessions > Number(targets.teacherTarget || 0);
    const gap1Debt = targets.gap1Target != null
      && q.gap1 > Number(targets.gap1Target);
    const hardQualityDebt = !onePeriodTeacherSessionFloorReached(metrics)
      || q.gap2Plus > 0;
    const needsMore = hardQualityDebt || teacherDebt || gap1Debt;
    if(needsMore){
      return {
        level:"ok",
        progressLabel:"Hoàn tất",
        message:singletonFloorMessage || SOLVE_COMPLETE_MESSAGE,
        targetMet:false,
        quality:q,
        targets
      };
    }
    return {
      level:"ok",
      progressLabel:"Hoàn tất",
      message:singletonFloorMessage || SOLVE_COMPLETE_MESSAGE,
      targetMet:true,
      quality:q,
      targets
    };
  }

  function completeScheduleNeedsFreshQualityRebuild(data, qualityTargets){
    const safeData = data || getData();
    const payload = safeData?.tkbSolverResult || safeData?.tkbRustSolverResult || null;
    const visibleCompletion = cheapSchoolCompletionStats(safeData);
    const physicallyComplete = !!visibleCompletion
      && Number(visibleCompletion.expected || 0) > 0
      && Number(visibleCompletion.scheduled || 0) >= Number(visibleCompletion.expected || 0)
      && Number(visibleCompletion.unassigned || 0) <= 0;
    const payloadComplete = !!payload && payloadCompletion(payload).complete;
    const expected = Math.max(
      0,
      Number(visibleCompletion?.expected || 0) || 0,
      metricNumber(payload?.metrics?.expected_periods, 0),
      expectedLessonCount(safeData)
    );
    if(expected < 300 || (!physicallyComplete && !payloadComplete)) return false;
    // The physical timetable is authoritative. A reload, legacy save, or
    // retained incumbent can leave tkbSolverResult absent or with old quality
    // totals even though the visible table is complete (for example 521/100).
    const visibleMetrics = uiTeacherQualityMetrics(safeData);
    const visibleQualityUsable = metricNumber(visibleMetrics.teacher_sessions, 0) > 0;
    const payloadQualityUsable = payloadComplete && hasVisibleTeacherQualityMetrics(payload);
    if(!visibleQualityUsable && !payloadQualityUsable) return false;
    const qualityMetrics = visibleQualityUsable
      ? Object.assign({}, payload?.metrics || {}, visibleMetrics)
      : payload.metrics;
    const quality = teacherQualitySummary({metrics:qualityMetrics});
    const targets = qualityTargets || practicalTeacherQualityTargets(safeData);
    const teacherTarget = positiveNumberSetting(targets?.teacherTarget);
    const teacherDebt = teacherTarget > 0
      ? quality.teacherSessions - teacherTarget
      : 0;
    // A complete timetable with zero one-period sessions and zero gap-2 is a
    // valuable incumbent even when its teacher-session count is still above
    // the practical target. Refine that incumbent in place so the next click
    // spends its budget compacting sessions instead of rebuilding the same
    // feasibility trajectory. Rebuild from fixed anchors only when the
    // visible schedule still carries hard quality debt; that is the case where
    // the incumbent neighbourhood is genuinely too rough (for example the
    // former 612-session/75-singleton result).
    const hasHardQualityDebt = !onePeriodTeacherSessionFloorReached(qualityMetrics)
      || quality.gap2Plus > 0;
    if(!hasHardQualityDebt) return false;
    if(expected < 900) return true;
    const severeSingletonDebt = quality.onePeriod >= Math.max(
      40,
      teacherTarget > 0 ? Math.ceil(teacherTarget * 0.12) : 40
    );
    const severeGap2Debt = quality.gap2Plus >= 10;
    const severeTeacherDebt = teacherTarget > 0
      && teacherDebt >= Math.max(80, Math.ceil(teacherTarget * 0.20));
    return severeSingletonDebt || severeGap2Debt || severeTeacherDebt;
  }

  function noBetterScheduleStatus(payload){
    return onePeriodTeacherSessionFloorMessage(payload)
      || NO_BETTER_SCHEDULE_MESSAGE;
  }

  function onePeriodTeacherSessionCount(metrics){
    return metricNumber(metrics?.one_period_teacher_sessions, 0);
  }

  function onePeriodTeacherSessionLowerBound(metrics){
    if(!metrics || typeof metrics !== "object") return 0;
    if(!Object.prototype.hasOwnProperty.call(metrics, "one_period_teacher_sessions_lower_bound")){
      return 0;
    }
    const current = Math.max(0, onePeriodTeacherSessionCount(metrics));
    const reported = Number(metrics.one_period_teacher_sessions_lower_bound);
    if(!Number.isSafeInteger(reported) || reported < 0 || reported > current) return 0;
    if(reported === 0) return 0;
    const evidence = metrics.one_period_teacher_sessions_lower_bound_evidence;
    if(!Array.isArray(evidence) || evidence.length === 0) return 0;
    if(
      evidence.length === 1
      && evidence[0]
      && typeof evidence[0] === "object"
      && !Array.isArray(evidence[0])
      && String(evidence[0].kind || "") === "cp_sat_global_singleton_optimum"
    ){
      const proof = evidence[0];
      const objective = Number(proof.objective);
      const bestBound = Number(proof.best_bound);
      const proofFloor = Number(proof.one_period_teacher_sessions);
      const upperCap = Number(proof.nonbinding_teacher_session_cap);
      const problemFingerprint = String(proof.problem_fingerprint || "").toLowerCase();
      const metricFingerprint = String(
        metrics.one_period_teacher_sessions_lower_bound_problem_fingerprint || ""
      ).toLowerCase();
      return Number(proof.version) === 1
        && String(proof.status_name || "").toUpperCase() === "OPTIMAL"
        && String(proof.objective_mode || "") === "minimize_one_period_sessions"
        && Number.isSafeInteger(objective)
        && Number.isSafeInteger(bestBound)
        && objective === bestBound
        && objective === reported
        && Number.isSafeInteger(proofFloor)
        && proofFloor === reported
        && Number.isSafeInteger(upperCap)
        && upperCap > 0
        && typeof proof.fixed_aware === "boolean"
        && /^[0-9a-f]{64}$/.test(problemFingerprint)
        && metricFingerprint === problemFingerprint
          ? reported
          : 0;
    }
    const seen = new Set();
    let provenTotal = 0;
    for(const raw of evidence){
      if(!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
      const teacher = String(raw.teacher || "").trim();
      const part = String(raw.part || "").trim();
      const className = String(raw.class || "").trim();
      const subject = String(raw.subject || "").trim();
      const periods = Number(raw.periods_per_week);
      const maxPerSession = Number(raw.max_periods_per_session);
      const minimumSessions = Number(raw.minimum_sessions);
      const forcedSingletons = Number(raw.forced_singletons);
      const key = `${teacher}\u0000${part}`;
      if(
        !teacher || !className || !subject
        || !["AM", "PM"].includes(part)
        || seen.has(key)
        || !Number.isSafeInteger(periods) || periods <= 0
        || !Number.isSafeInteger(maxPerSession) || maxPerSession <= 0
        || !Number.isSafeInteger(minimumSessions) || minimumSessions <= 0
        || !Number.isSafeInteger(forcedSingletons) || forcedSingletons <= 0
      ) return 0;
      const expectedSessions = Math.ceil(periods / maxPerSession);
      const expectedSingletons = Math.max(0, 2 * expectedSessions - periods);
      if(
        minimumSessions !== expectedSessions
        || forcedSingletons !== expectedSingletons
      ) return 0;
      seen.add(key);
      provenTotal += forcedSingletons;
      if(!Number.isSafeInteger(provenTotal) || provenTotal > reported) return 0;
    }
    return provenTotal === reported ? reported : 0;
  }

  function onePeriodTeacherSessionTarget(metrics, configuredTarget){
    const configured = Number(configuredTarget);
    const target = Number.isFinite(configured) && configured >= 0
      ? Math.round(configured)
      : 0;
    return Math.max(target, onePeriodTeacherSessionLowerBound(metrics));
  }

  function onePeriodTeacherSessionFloorReached(metrics){
    return onePeriodTeacherSessionCount(metrics)
      <= onePeriodTeacherSessionLowerBound(metrics);
  }

  function onePeriodTeacherSessionFloorMessage(payload){
    const metrics = payload?.metrics || {};
    const floor = onePeriodTeacherSessionLowerBound(metrics);
    const current = onePeriodTeacherSessionCount(metrics);
    if(floor <= 0 || current > floor) return "";
    const evidence = Array.isArray(
      metrics.one_period_teacher_sessions_lower_bound_evidence
    )
      ? metrics.one_period_teacher_sessions_lower_bound_evidence
      : [];
    const item = evidence.find(row => row && typeof row === "object") || null;
    const exactCpSatFloor = String(item?.kind || "") === "cp_sat_global_singleton_optimum";
    const headline = exactCpSatFloor
      ? `Đã chứng minh mức tối ưu: Dạy 1 tiết/buổi thấp nhất là ${floor}.`
      : `Đã tối ưu theo phân công: Dạy 1 tiết/buổi thấp nhất là ${floor}.`;
    if(!item) return headline;
    const teacher = String(item.teacher || "").trim();
    const subject = String(item.subject || "").trim();
    const className = String(item.class || "").trim();
    const periods = Math.max(0, Math.round(metricNumber(item.periods_per_week, 0)));
    const maximum = Math.max(
      0,
      Math.round(metricNumber(item.max_periods_per_session, 0))
    );
    if(!teacher || periods <= 0 || maximum <= 0) return headline;
    const assignment = [subject, className].filter(Boolean).join(" · ");
    return `${headline} ${teacher}${assignment ? ` (${assignment})` : ""} có ${periods} tiết/tuần, tối đa ${maximum} tiết/buổi nên bắt buộc còn ${floor}.`;
  }

  function needsTeacherQualityCleanup(payload){
    const metrics = payload?.metrics || {};
    return !onePeriodTeacherSessionFloorReached(metrics) || metricGapTotal(metrics) > 0;
  }

  function needsStrictTeacherQualityCleanup(payload){
    const metrics = payload?.metrics || {};
    return !onePeriodTeacherSessionFloorReached(metrics) || gap2PlusCount(metrics) > 0;
  }

  function teacherQualityTargetsSatisfied(payload, settings){
    const metrics = payload?.metrics || {};
    const acceptTeacher = positiveNumberSetting(settings?.optimization_accept_teacher_sessions ?? settings?.target_teacher_sessions);
    const acceptGap1 = nonnegativeNumberSetting(settings?.optimization_accept_gap1_sessions ?? settings?.target_gap1_sessions);
    if(!acceptTeacher && acceptGap1 == null) return false;
    if(!onePeriodTeacherSessionFloorReached(metrics)) return false;
    if(gap2PlusCount(metrics) !== 0) return false;
    if(acceptTeacher && metricNumber(metrics.teacher_sessions, 1e9) > acceptTeacher) return false;
    if(acceptGap1 != null && gapExactCount(metrics, 1) > acceptGap1) return false;
    return true;
  }

  function teacherQualityNeedsCleanup(payload, settings, data){
    if(!payloadCompletion(payload).complete) return false;
    if(teacherQualityTargetsSatisfied(payload, settings || {})) return false;
    const metrics = payload?.metrics || {};
    if(!onePeriodTeacherSessionFloorReached(metrics) || gap2PlusCount(metrics) > 0) return true;
    if(teacherSessionQualityTarget(settings || {}, data || getData(), payload) > 0) return true;
    const gapTarget = teacherSessionGapQualityTarget(settings || {});
    if(gapTarget != null && gapExactCount(metrics, 1) > gapTarget) return true;
    return metricGapTotal(metrics) > 0;
  }

  function payloadFromExistingOptimize(payload){
    const name = String(payload?.solver?.name || "").toLowerCase();
    return name.includes("existing");
  }

  function teacherSessionOptGoalSatisfied(payload){
    const metrics = payload?.metrics || {};
    const solver = payload?.solver || {};
    const opt = solver.teacher_session_optimization || {};
    const completion = payloadCompletion(payload);
    if(!completion.complete || completion.hardOk === false) return false;
    if(!onePeriodTeacherSessionFloorReached(metrics)) return false;
    if(gap2PlusCount(metrics) !== 0) return false;
    if(opt.target_met === true || opt.good_enough_met === true) return true;
    const runtime = solver.runtime_settings || {};
    const acceptTeacher = positiveNumberSetting(
      opt.accept_teacher_sessions ?? runtime.optimization_accept_teacher_sessions ?? runtime.target_teacher_sessions
    );
    const acceptGap1 = nonnegativeNumberSetting(
      opt.accept_gap1_sessions ?? runtime.optimization_accept_gap1_sessions ?? runtime.target_gap1_sessions
    );
    if(!acceptTeacher && acceptGap1 == null) return false;
    if(acceptTeacher && metricNumber(metrics.teacher_sessions, 1e9) > acceptTeacher) return false;
    if(acceptGap1 != null && metricNumber((metrics.gap_distribution || {})["1"], 0) > acceptGap1) return false;
    return true;
  }

  function usesTwoStageTeacherQuality(settings, candidate, incumbent){
    const markers = [
      settings?.quality_priority_order,
      candidate?.metrics?.quality_priority_order,
      candidate?.solver?.runtime_settings?.quality_priority_order,
      incumbent?.metrics?.quality_priority_order,
      incumbent?.solver?.runtime_settings?.quality_priority_order
    ];
    return markers.some(value => String(value || "").trim().toLowerCase()
      === "one_period_teacher_sessions_gap2_gap1");
  }

  function normalizedGapOptimizationTarget(settings){
    const raw = String(settings?.optimization_gap_target || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if(["gap2", "gap_2", "teacher_gap2_sessions", "optimize_gap2"].includes(raw)){
      return "gap2";
    }
    if(["gap1", "gap_1", "teacher_gap1_sessions", "optimize_gap1"].includes(raw)){
      return "gap1";
    }
    return "";
  }

  function normalizeSolveRequestMode(value){
    const mode = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if(["quick", "complete", "fill", "quick_fill", "quick_complete"].includes(mode)){
      return SOLVE_REQUEST_MODES.quickComplete;
    }
    if([
      "singleton",
      "singletons",
      "one_period",
      "one_period_sessions",
      "one_period_teacher_sessions",
      "optimize_singletons"
    ].includes(mode)){
      return SOLVE_REQUEST_MODES.singletons;
    }
    if(["session", "sessions", "teacher_sessions", "optimize_sessions"].includes(mode)){
      return SOLVE_REQUEST_MODES.sessions;
    }
    if(["gap2", "gap_2", "teacher_gap2_sessions", "optimize_gap2"].includes(mode)){
      return SOLVE_REQUEST_MODES.gap2;
    }
    if(["gap1", "gap_1", "teacher_gap1_sessions", "optimize_gap1"].includes(mode)){
      return SOLVE_REQUEST_MODES.gap1;
    }
    if([
      "gap",
      "gaps",
      "teacher_gaps",
      "teacher_gap_sessions",
      "optimize_gaps"
    ].includes(mode)){
      return SOLVE_REQUEST_MODES.gaps;
    }
    return SOLVE_REQUEST_MODES.automatic;
  }

  function metricProgressPercent(focus, current, target, baseline){
    const normalizedFocus = String(focus || "").trim().toLowerCase();
    const currentValue = Math.max(0, Number(current || 0) || 0);
    const targetValue = Math.max(0, Number(target || 0) || 0);
    const parsedBaseline = Number(baseline);
    const baselineValue = Number.isFinite(parsedBaseline)
      ? Math.max(0, parsedBaseline)
      : currentValue;
    if(normalizedFocus === "scheduled_periods" || normalizedFocus === "quick_complete"){
      return targetValue > 0
        ? Math.max(0, Math.min(100, Math.round(currentValue * 100 / targetValue)))
        : 0;
    }
    if(normalizedFocus === "teacher_sessions" || normalizedFocus === "optimize_sessions"){
      if(currentValue <= targetValue) return 100;
      if(currentValue <= 0 || targetValue <= 0) return 0;
      return Math.max(0, Math.min(100, Math.round(targetValue * 100 / currentValue)));
    }
    if(
      normalizedFocus === "one_period_teacher_sessions"
      || normalizedFocus === "teacher_gap_sessions"
      || normalizedFocus === "teacher_gap2_sessions"
      || normalizedFocus === "teacher_gap1_sessions"
      || normalizedFocus === "optimize_singletons"
      || normalizedFocus === "optimize_gaps"
    ){
      if(currentValue <= targetValue) return 100;
      if(baselineValue <= targetValue) return 0;
      return Math.max(0, Math.min(100, Math.round(
        (baselineValue - currentValue) * 100 / (baselineValue - targetValue)
      )));
    }
    return 0;
  }

  function normalizeMetricProgressSnapshot(snapshot){
    if(!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
    const focus = String(
      snapshot.optimizationFocus
      ?? snapshot.optimization_focus
      ?? snapshot.metricFocus
      ?? snapshot.metric_focus
      ?? ""
    ).trim();
    if(!focus || focus.length > 80 || !/^[a-z0-9_.:-]+$/i.test(focus)) return null;
    const current = Number(snapshot.metricCurrent ?? snapshot.metric_current);
    const target = Number(snapshot.metricTarget ?? snapshot.metric_target);
    const baselineRaw = Number(snapshot.metricBaseline ?? snapshot.metric_baseline);
    const reportedPercent = Number(snapshot.metricPercent ?? snapshot.metric_percent);
    if(!Number.isFinite(current) || !Number.isFinite(target)) return null;
    const baseline = Number.isFinite(baselineRaw) ? Math.max(0, baselineRaw) : Math.max(0, current);
    const percent = Number.isFinite(reportedPercent)
      ? Math.max(0, Math.min(100, Math.round(reportedPercent)))
      : metricProgressPercent(focus, current, target, baseline);
    return {
      focus,
      current:Math.max(0, current),
      target:Math.max(0, target),
      baseline,
      percent
    };
  }

  function metricProgressCurrentLabel(snapshot){
    const normalized = snapshot?.focus
      ? snapshot
      : normalizeMetricProgressSnapshot(snapshot);
    if(!normalized) return "";
    const focus = String(normalized.focus || "").trim().toLowerCase();
    const current = Math.max(0, Math.round(Number(normalized.current || 0) || 0));
    const target = Math.max(0, Math.round(Number(normalized.target || 0) || 0));
    if(focus === "scheduled_periods" || focus === "quick_complete"){
      return `${current}/${target} ti\u1ebft`;
    }
    if(focus === "teacher_sessions" || focus === "optimize_sessions"){
      return `${current} bu\u1ed5i`;
    }
    if(
      focus === "one_period_teacher_sessions"
      || focus === "optimize_singletons"
    ){
      return `${current} bu\u1ed5i 1 ti\u1ebft`;
    }
    if(focus === "teacher_gap2_sessions") return `${current} tr\u1ed1ng 2 ti\u1ebft`;
    if(focus === "teacher_gap1_sessions") return `${current} tr\u1ed1ng 1 ti\u1ebft`;
    if(focus === "teacher_gap_sessions" || focus === "optimize_gaps"){
      return `${current} ti\u1ebft tr\u1ed1ng`;
    }
    return "";
  }

  function candidateWithinVisibleQualityEnvelope(candidate, incumbent, settings){
    const next = teacherQualitySummary(candidate);
    const current = teacherQualitySummary(incumbent);
    const focus = optimizationFocusForSolveRequestMode(settings?.optimization_focus);
    const gapTarget = normalizedGapOptimizationTarget(settings);
    const safeStagedAutomatic = focus === "automatic"
      && settings?.optimization_safe_staged_reclick === true;

    if(safeStagedAutomatic){
      // Repeated Automatic clicks may cross a small lower-priority valley only
      // while singleton/Gap2 debt is measurably shrinking. The backend enforces
      // the same bounded envelope; repeat it at settlement so an older or
      // mismatched executor can never publish arbitrary quality debt.
      // Candidate may carry a newly proven structural floor that the saved
      // incumbent did not know yet. Validate both evidence bundles and honor
      // the stronger proof during settlement.
      const singletonTarget = Math.max(
        onePeriodTeacherSessionTarget(incumbent?.metrics, 0),
        onePeriodTeacherSessionTarget(candidate?.metrics, 0)
      );
      const hardQualityDebt = current.onePeriod > singletonTarget || current.gap2Plus > 0;
      const singletonProgress = next.onePeriod < current.onePeriod;
      const gap2Progress = next.gap2Plus < current.gap2Plus;
      const hardQualityProgress = hardQualityDebt
        && (singletonProgress || gap2Progress);
      const legacySessionHeadroom = Math.max(
        8,
        Math.min(
          24,
          current.teacherSessions >= 600
            ? 24
            : Math.ceil(Math.max(1, current.teacherSessions) * 0.02)
        )
      );
      const legacyGap1Headroom = Math.max(
        8,
        Math.min(24, Math.ceil(Math.max(1, current.gap1) * 0.10))
      );
      const legacyTotalGapHeadroom = Math.max(
        8,
        Math.min(24, Math.ceil(Math.max(1, current.totalGap) * 0.10))
      );
      const boundedRepairCap = (field, currentValue, legacyHeadroom) => {
        const incumbentCap = Number(incumbent?.metrics?.[field]);
        const candidateCap = Number(candidate?.metrics?.[field]);
        // Once an incumbent carries a lineage cap, keep it even if an older
        // client bug already left the visible timetable above that cap. Using
        // the candidate's larger cap in that case would legitimize a ratchet
        // (for example 654 -> 678 -> 702). A candidate cap is considered only
        // on the first repair click, before the incumbent owns one.
        const carried = Number.isSafeInteger(incumbentCap) && incumbentCap >= 0
          ? incumbentCap
          : candidateCap;
        if(!Number.isSafeInteger(carried) || carried < 0){
          return currentValue + legacyHeadroom;
        }
        return Math.min(currentValue + 120, carried);
      };
      const sessionCap = boundedRepairCap(
        "automatic_quality_repair_session_cap",
        current.teacherSessions,
        legacySessionHeadroom
      );
      const gap1Cap = boundedRepairCap(
        "automatic_quality_repair_gap1_cap",
        current.gap1,
        legacyGap1Headroom
      );
      const totalGapCap = boundedRepairCap(
        "automatic_quality_repair_total_gap_cap",
        current.totalGap,
        legacyTotalGapHeadroom
      );
      return next.onePeriod <= current.onePeriod
        && next.gap2Plus <= current.gap2Plus
        && (
          !hardQualityDebt
          || singletonProgress
          || gap2Progress
        )
        && (
          next.teacherSessions <= current.teacherSessions
          || (hardQualityProgress && next.teacherSessions <= sessionCap)
        )
        && (
          next.gap1 <= current.gap1
          || (hardQualityProgress && next.gap1 <= gap1Cap)
        )
        && (
          next.totalGap <= current.totalGap
          || (hardQualityProgress && next.totalGap <= totalGapCap)
        );
    }

    // Every focused button owns exactly one visible objective.  The remaining
    // counters are safety envelopes only: a solver may incidentally improve
    // them, but it may never pay for the requested gain by making another
    // visible quality counter worse.
    if([
      "singletons",
      "sessions"
    ].includes(focus) || gapTarget){
      return next.onePeriod <= current.onePeriod
        && next.teacherSessions <= current.teacherSessions
        && next.gap2Plus <= current.gap2Plus
        && next.gap1 <= current.gap1
        && next.totalGap <= current.totalGap;
    }
    if(next.onePeriod > current.onePeriod) return false;
    if(next.teacherSessions > current.teacherSessions) return false;
    if(usesTwoStageTeacherQuality(settings, candidate, incumbent)){
      // A strict session reduction may temporarily carry gap debt from Phase
      // S. With the session count tied, Phase G must improve gaps instead.
      if(next.onePeriod < current.onePeriod) return true;
      if(next.teacherSessions < current.teacherSessions) return true;
      if(next.gap2Plus !== current.gap2Plus){
        return next.gap2Plus < current.gap2Plus;
      }
      if(next.totalGap !== current.totalGap){
        return next.totalGap < current.totalGap;
      }
      return next.gap1 <= current.gap1;
    }
    if(next.gap2Plus > current.gap2Plus) return false;
    if(next.gap1 > current.gap1) return false;
    if(next.totalGap > current.totalGap) return false;
    // Per-teacher imbalance remains a backend tie-breaker when the five visible
    // totals are equal. It must not hide a Pareto improvement such as
    // 478/59 -> 470/50 from the user.
    return true;
  }

  function visibleTeacherQualityTuple(payload, settings, candidate, incumbent){
    const quality = teacherQualitySummary(payload);
    const focus = optimizationFocusForSolveRequestMode(settings?.optimization_focus);
    if(
      focus === "automatic"
      && settings?.optimization_safe_staged_reclick === true
    ){
      // Zero singleton/Gap2 are portfolio targets before final compaction. The
      // envelope above bounds every temporary trade-off; this tuple keeps useful
      // progress even when escaping the local minimum needs a few extra sessions.
      return [
        quality.onePeriod,
        quality.gap2Plus,
        quality.teacherSessions,
        quality.gap1,
        quality.totalGap
      ];
    }
    if(usesTwoStageTeacherQuality(settings, candidate, incumbent)){
      return [
        quality.onePeriod,
        quality.teacherSessions,
        quality.gap2Plus,
        quality.totalGap,
        quality.gap1
      ];
    }
    return [
      quality.onePeriod,
      quality.gap2Plus,
      quality.teacherSessions,
      quality.gap1,
      quality.totalGap
    ];
  }

  function payloadStrictlyBetterTeacherQuality(candidate, incumbent, settings){
    if(!candidateWithinVisibleQualityEnvelope(candidate, incumbent, settings)) return false;
    const focus = optimizationFocusForSolveRequestMode(settings?.optimization_focus);
    const gapTarget = normalizedGapOptimizationTarget(settings);
    const nextFocused = teacherQualitySummary(candidate);
    const currentFocused = teacherQualitySummary(incumbent);
    if(focus === "singletons"){
      return nextFocused.onePeriod < currentFocused.onePeriod;
    }
    if(focus === "sessions"){
      return nextFocused.teacherSessions < currentFocused.teacherSessions;
    }
    if(gapTarget){
      return gapTarget === "gap2"
        ? nextFocused.gap2Plus < currentFocused.gap2Plus
        : nextFocused.gap1 < currentFocused.gap1;
    }
    const next = visibleTeacherQualityTuple(candidate, settings, candidate, incumbent);
    const current = visibleTeacherQualityTuple(incumbent, settings, candidate, incumbent);
    for(let index = 0; index < next.length; index += 1){
      if(next[index] < current[index]) return true;
      if(next[index] > current[index]) return false;
    }
    return false;
  }

  function payloadBetterOrEqualTeacherQuality(candidate, incumbent, settings){
    // Replacement candidates must make measurable progress. Equality keeps the
    // incumbent, which also prevents stale target flags from replacing it.
    return payloadStrictlyBetterTeacherQuality(candidate, incumbent, settings);
  }

  function incumbentQualityGuardState(incumbentPayload, scheduleSnapshot, data, settings){
    if(!incumbentPayload || typeof incumbentPayload !== "object") return null;
    const completion = payloadCompletion(incumbentPayload);
    const visibleState = cheapSchoolCompletionStats(data);
    if(
      !visibleState
      || Number(visibleState.expected || 0) <= 0
      || Number(visibleState.scheduled || 0) < Number(visibleState.expected || 0)
      || Number(visibleState.unassigned || 0) > 0
      || currentConstraintViolations(1).length > 0
    ) return null;
    const expected = Math.max(
      expectedLessonCount(data),
      metricNumber(incumbentPayload?.metrics?.expected_periods, 0)
    );
    const scheduled = snapshotScheduledLessonCount(scheduleSnapshot);
    const fixedScheduled = countFixedScheduledLessons({tkb: scheduleSnapshot?.tkb || {}});
    const flexibleScheduled = Math.max(0, scheduled - fixedScheduled);
    if(fixedScheduled > 0 && scheduled > 0 && flexibleScheduled <= 0 && scheduled < expected){
      return null;
    }
    const payloadScheduled = metricNumber(incumbentPayload?.metrics?.scheduled_periods, scheduled);
    const stalePayloadSchedule = expected > 0
      && scheduled < expected
      && payloadScheduled >= expected;
    if(stalePayloadSchedule) return null;
    const visibleMissing = expected > 0 ? Math.max(0, expected - scheduled) : 0;
    const payloadMissing = Math.max(
      0,
      metricNumber(incumbentPayload?.metrics?.unassigned_periods, visibleMissing),
      payloadUnassignedPeriods(incumbentPayload)
    );
    const missing = Math.max(visibleMissing, payloadMissing);
    const hardUsable = completion.violations <= 0 && completion.hardOk !== false;
    const complete = expected > 0 && scheduled >= expected && missing === 0 && hardUsable;
    if(!complete) return null;
    return {
      complete,
      nearComplete:false,
      missing,
      expected,
      scheduled
    };
  }

  function shouldKeepIncumbentForTeacherQuality(candidate, incumbent, guardState, settings){
    if(!guardState || !incumbent) return false;
    const candidateCompletion = payloadCompletion(candidate);
    if(!candidateCompletion.complete) return true;
    return !payloadStrictlyBetterTeacherQuality(candidate, incumbent, settings);
  }

  function shouldUseStagedExistingRepair(settings, data){
    const allowFreshStaged = settings?.ui_allow_staged_existing_on_fresh_sort === true;
    if(
      !data
      || (settings?.ui_disable_staged_existing_repair === true && !allowFreshStaged)
      || (
        settings?.ui_default_fresh_sort === true
        && !allowFreshStaged
      )
    ) return null;
    if(settings?.optimize_existing_schedule === true) return null;
    if(isTeacherSessionOptSettings(settings)) return null;
    if(isCapacityShortageAccepted(settings)) return null;
    const stagedMaxMissing = Math.max(0, Number(settings?.ui_staged_existing_max_missing ?? 96) || 0);
    const usableState = state => {
      if(!state?.eligible) return null;
      return Number(state.missing || 0) <= stagedMaxMissing ? state : null;
    };
    if(shouldUseFixedOffValidatedQualityBank(data, settings) && settings?.ui_force_staged_existing_repair !== true){
      const forced = Object.assign({}, settings || {}, { repair_fill_first_max_missing: 96 });
      const state = partialExistingRepairState(data, forced);
      return usableState(state);
    }
    const state = partialExistingRepairState(data, Object.assign({ repair_fill_first_max_missing: 96 }, settings || {}));
    return usableState(state);
  }

  function stagedExistingRepairSettings(baseSettings, state, phase, runId){
    const constraintChangeFill = phase === "fill" && baseSettings?.ui_constraint_change_repair === true;
    const deadlineMs = phase === "quality"
      ? 2_000
      : (constraintChangeFill
          ? Math.min(12_000, Math.max(8_000, (state?.missing || 1) * 1_200))
          : Math.min(12_000, Math.max(5_000, (state?.missing || 1) * 700)));
    const seconds = Math.max(1, Math.ceil(deadlineMs / 1000));
    const next = Object.assign({}, baseSettings || {});
    clearPostRollbackSettings(next);
    next.ui_staged_existing_repair = true;
    next.ui_staged_existing_phase = phase;
    next.ui_allow_short_backend_deadline = true;
    next.ui_client_timeout_reserve_ms = phase === "quality" ? 8_000 : 12_000;
    next.native_force_rust_solver = true;
    next.disable_reference_solver = true;
    next.disable_hybrid_reference_solver = true;
    next.solver_mode = "native";
    next.auto_sort_mode = "fast";
    next.auto_sort_strategy = phase === "quality"
      ? "staged_existing_quality_slice"
      : "staged_existing_fill_first";
    next.optimize_existing_schedule = true;
    next.existing_fill_missing_schedule = true;
    next.preserve_existing_tkb = true;
    next.force_preserve_partial_existing = true;
    next.partial_existing_rebuild = true;
    next.repair_fill_first = true;
    next.repair_partial_existing = true;
    next.repair_partial_existing_reason = next.auto_sort_strategy;
    next.repair_existing_missing_periods = phase === "quality" ? 0 : Math.max(0, Number(state?.missing || 0) || 0);
    next.repair_fill_first_max_missing = Math.max(96, Number(state?.maxMissing || 0) || 0, next.repair_existing_missing_periods);
    next.existing_scheduled_periods = Math.max(0, Number(state?.scheduled || 0) || 0);
    next.existing_flexible_scheduled_periods = Math.max(0, Number(state?.flexibleScheduled || 0) || 0);
    next.expected_scheduled_periods = Math.max(0, Number(state?.expected || 0) || 0);
    next.require_complete_schedule = true;
    next.best_effort_on_timeout = true;
    if(constraintChangeFill){
      // Keep the incumbent as a soft hint so the bounded class-neighborhood
      // repair may swap a few cells. Hard fixed lessons remain immutable.
      next.ui_unified_partial_repair = true;
      next.allow_quality_debt = true;
      next.preserve_fixed_lessons_only = true;
      next.repair_residual_lns_time_limit_seconds = 7;
    }
    next.native_skip_teacher_optimization = phase !== "quality";
    next.fresh_randomize = false;
    next.randomize_search = false;
    next.schedule_diversity = false;
    next.reclick_schedule_diversity = false;
    next.allow_solver_warm_start = true;
    next.allow_backend_cache = false;
    next.force_fresh_backend_solve = true;
    next.allow_zero_one_quality_retry = false;
    next.allow_teacher_session_deep_retry = false;
    next.allow_teacher_session_fast_portfolio = false;
    next.complete_schedule_seed_retry = true;
    next.overall_time_limit_seconds = seconds;
    next.integrated_time_limit = seconds;
    next.optimization_time_limit_seconds = 0;
    next.native_cpsat_quality_time_limit_seconds = 0;
    next.native_cpsat_time_limit_seconds = 0;
    next.native_cpsat_lns_time_limit_seconds = 0;
    next.native_cpsat_relaxed_hint_time_limit_ms = 0;
    next.native_cpsat_relaxed_hint_cleanup_ms = 0;
    next.backend_deadline_ms = deadlineMs;
    next.native_global_deadline_ms = deadlineMs;
    next.native_deadline_reserve_ms = 500;
    next.progress_estimate_seconds = seconds;
    next.ui_staged_existing_ceiling_seconds = seconds;
    next.solve_run_id = `${runId || makeSolveRunId()}-${phase}-${Date.now()}`;
    delete next.ui_custom_solve_duration_seconds;
    delete next.ui_custom_solve_duration_override;
    if(phase === "quality") next.random_seed = makeRandomSeed();
    else delete next.random_seed;
    delete next.max_teacher_sessions;
    delete next.requested_max_teacher_sessions;
    delete next.target_teacher_sessions;
    delete next.target_gap1_sessions;
    return next;
  }

  function markStagedExistingPayload(payload, state, phase, detail){
    if(!payload || typeof payload !== "object") return payload;
    payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
    payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
      ? payload.solver.runtime_settings
      : {};
    payload.solver.runtime_settings.ui_staged_existing_repair = true;
    payload.solver.runtime_settings.ui_staged_existing_phase = phase;
    payload.solver.runtime_settings.ui_staged_missing_periods = Math.max(0, Number(state?.missing || 0) || 0);
    if(detail && typeof detail === "object"){
      Object.assign(payload.solver.runtime_settings, detail);
    }
    return payload;
  }

  function stagedExistingNeedsFreshRetry(payload){
    const c = payloadCompletion(payload);
    const unassigned = Math.max(c.unassigned, payloadUnassignedPeriods(payload));
    const fullCount = c.expected > 0 && c.scheduled >= c.expected;
    if(c.violations > 0) return true;
    return fullCount && unassigned === 0 && !c.hardOk;
  }

  function stagedExistingErrorAllowsFreshRetry(err){
    if(!err) return true;
    if(err.backendUnavailable === true || err.name === "AbortError") return false;
    const kind = String(err.kind || err?.payload?.kind || "").trim().toLowerCase();
    if([
      "cancelled",
      "canceled",
      "client_timeout",
      "solver_busy",
      "solver_schedule_busy"
    ].includes(kind)) return false;
    const status = Number(err.status || 0);
    return status !== 401 && status !== 403;
  }

  function stagedExistingFreshRetrySettings(baseSettings, baseData, runId){
    const seed = makeRandomSeed();
    const constraintChangeFresh = baseSettings?.ui_constraint_change_repair === true;
    const requestedCustomSeconds = customSolveDurationFromSettings(baseSettings);
    const freshPlanningData = constraintChangeFresh
      ? dataForSolverRequest(baseData || getData() || {}, {
          allow_solver_warm_start:false,
          preserve_existing_tkb:false,
          auto_sort_strategy:"fresh"
        })
      : null;
    const freshInitialPlan = constraintChangeFresh
      ? buildAutomaticAutoSortPlan(
          freshPlanningData,
          expectedLessonCount(baseData),
          0
        )
      : null;
    const next = constraintChangeFresh
      ? Object.assign({}, freshInitialPlan?.settings || readSettings())
      : completeScheduleSeedRetrySettings(baseSettings || readSettings(), baseData, seed, 1);
    if(constraintChangeFresh){
      clearExistingRepairSettings(next);
      next.ui_unified_auto_sort = true;
      next.ui_unified_solve_kind = "fresh_complete_first";
      next.ui_constraint_change_repair = true;
      next.ui_constraint_change_fresh_retry = true;
      next.ui_constraint_change_rebuild_from_empty = true;
      // User requirements remain hard. Teacher singleton/gap cleanliness is a
      // quality objective and must not make an otherwise complete rebuild fail.
      next.ui_bounded_fresh_accept_quality_debt = true;
      next.ui_constraint_change_allow_quality_debt = true;
      next.ui_skip_pre_solve_constraint_release = true;
      next.ui_disable_automatic_retry = true;
      next.ui_allow_incomplete_retry_after_single_pass = false;
      next.ui_stop_after_first_complete_schedule = false;
      next.complete_schedule_seed_retry = false;
      next.complete_schedule_seed_retry_max_runs = 0;
      delete next.ui_custom_solve_duration_seconds;
      delete next.ui_custom_solve_duration_override;
      delete next.ui_requested_custom_solve_duration_seconds;
      delete next.ui_fresh_solve_duration_floor_applied;
      delete next.ui_custom_fresh_continue_quality;
      next.ui_constraint_change_fresh_ceiling_seconds = applyBoundedFreshFallbackCeiling(
        next,
        expectedLessonCount(baseData),
        baseData,
        requestedCustomSeconds
      );
      next.ui_unified_initial_fast_stage = true;
      next.ui_unified_initial_ceiling_seconds = next.ui_constraint_change_fresh_ceiling_seconds;
      delete next.robust_retry;
      delete next.complete_schedule_seed_retry_run;
    }else{
      // A failed light repair becomes the same bounded fresh solve as a first
      // click. Do not inherit the legacy 180-second robust-retry budget: the
      // current click owns one 60-second rebuild (or the user's explicit
      // duration), while a later click owns deeper refinement.
      clearExistingRepairSettings(next);
      next.ui_unified_auto_sort = true;
      next.ui_unified_solve_kind = "fresh_complete_first";
      next.ui_constraint_change_fresh_retry = true;
      next.ui_constraint_change_rebuild_from_empty = true;
      next.ui_bounded_fresh_accept_quality_debt = true;
      next.ui_constraint_change_allow_quality_debt = true;
      next.ui_skip_pre_solve_constraint_release = true;
      next.ui_disable_automatic_retry = true;
      next.ui_allow_incomplete_retry_after_single_pass = false;
      next.complete_schedule_seed_retry = false;
      next.complete_schedule_seed_retry_max_runs = 0;
      next.ui_constraint_change_fresh_ceiling_seconds = applyBoundedFreshFallbackCeiling(
        next,
        expectedLessonCount(baseData),
        baseData,
        requestedCustomSeconds
      );
      next.ui_unified_initial_fast_stage = true;
      next.ui_unified_initial_ceiling_seconds = next.ui_constraint_change_fresh_ceiling_seconds;
      delete next.robust_retry;
      delete next.complete_schedule_seed_retry_run;
    }
    next.ui_disable_staged_existing_repair = true;
    next.ui_local_repair_needs_rearrange = true;
    next.ui_staged_existing_fresh_retry = true;
    next.ui_staged_existing_fresh_retry_reason = "hard_invalid_after_fill";
    if(!constraintChangeFresh){
      next.auto_sort_strategy = "staged_existing_hard_invalid_fresh_retry";
    }
    next.solver_mode = "auto";
    next.native_force_rust_solver = false;
    next.disable_reference_solver = false;
    next.disable_hybrid_reference_solver = false;
    next.optimize_existing_schedule = false;
    next.existing_fill_missing_schedule = false;
    next.preserve_existing_tkb = false;
    next.force_preserve_partial_existing = false;
    next.partial_existing_rebuild = false;
    next.repair_fill_first = false;
    next.repair_partial_existing = false;
    next.allow_solver_warm_start = false;
    next.force_fresh_backend_solve = true;
    next.allow_backend_cache = false;
    next.solve_run_id = `${runId || makeSolveRunId()}-fresh-after-staged-hard-invalid-${seed}`;
    delete next.ui_staged_existing_repair;
    delete next.ui_staged_existing_phase;
    delete next.ui_unified_partial_repair;
    delete next.ui_unified_repair_ceiling_seconds;
    delete next.ui_force_staged_existing_repair;
    delete next.ui_allow_staged_existing_on_fresh_sort;
    delete next.native_skip_teacher_optimization;
    delete next.repair_partial_existing_reason;
    delete next.repair_existing_missing_periods;
    delete next.existing_scheduled_periods;
    delete next.existing_flexible_scheduled_periods;
    enforceNoHintFreshSolveSettings(next);
    if(requestedCustomSeconds > 0){
      applyCustomSolveDurationSettings(next, requestedCustomSeconds);
      next.ui_constraint_change_fresh_ceiling_seconds = requestedCustomSeconds;
    }
    return next;
  }

  function disableStagedExistingRepairForThisRun(settings){
    if(!settings || typeof settings !== "object") return;
    settings.ui_disable_staged_existing_repair = true;
    settings.ui_local_repair_needs_rearrange = true;
    settings.auto_sort_strategy = "staged_existing_hard_invalid_fresh_retry";
    settings.preserve_existing_tkb = false;
    settings.force_preserve_partial_existing = false;
    settings.partial_existing_rebuild = false;
    settings.optimize_existing_schedule = false;
    settings.existing_fill_missing_schedule = false;
    settings.allow_solver_warm_start = false;
    delete settings.ui_staged_existing_repair;
    delete settings.ui_staged_existing_phase;
    delete settings.repair_partial_existing_reason;
    delete settings.repair_existing_missing_periods;
    delete settings.existing_scheduled_periods;
    delete settings.existing_flexible_scheduled_periods;
  }

  function markStagedExistingFreshRetryPayload(payload, state, detail){
    if(!payload || typeof payload !== "object") return payload;
    payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
    payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
      ? payload.solver.runtime_settings
      : {};
    payload.solver.runtime_settings.ui_staged_existing_fresh_retry = true;
    payload.solver.runtime_settings.ui_staged_missing_periods = Math.max(0, Number(state?.missing || 0) || 0);
    if(detail && typeof detail === "object"){
      Object.assign(payload.solver.runtime_settings, detail);
    }
    payload.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    payload.warnings.push({
      kind: "staged_existing_hard_invalid_fresh_retry",
      message: "Vá nhanh lịch cũ đủ số tiết nhưng còn lỗi ràng buộc cứng; hệ thống đã chuyển sang xếp lại đầy đủ."
    });
    return payload;
  }

  async function solveStagedExistingRepair(baseSettings, baseData, state, runId){
    const fillSettings = stagedExistingRepairSettings(baseSettings, state, "fill", runId);
    setStatus("Đang sắp xếp...", "info");
    restartProgressForRetry(fillSettings, baseData);
    let fillPayload = null;
    let fillError = null;
    try{
      fillPayload = markStagedExistingPayload(
        await postSolve(fillSettings, baseData),
        state,
        "fill"
      );
    }catch(err){
      rethrowCancelledSolve(err, runId);
      rethrowAuthRequiredSolve(err);
      if(!stagedExistingErrorAllowsFreshRetry(err)) throw err;
      fillError = err;
    }
    const fillCompletion = payloadCompletion(fillPayload);
    const fillNeedsFreshRetry = !!fillError
      || !fillCompletion.complete
      || stagedExistingNeedsFreshRetry(fillPayload);
    if(fillNeedsFreshRetry){
      disableStagedExistingRepairForThisRun(baseSettings);
      const retrySettings = stagedExistingFreshRetrySettings(baseSettings, baseData, runId);
      if(baseSettings?.ui_constraint_change_repair === true){
        retrySettings.ui_constraint_change_repair = true;
        retrySettings.ui_constraint_change_fresh_retry = true;
      }
      retrySettings.ui_staged_existing_fresh_retry_reason = fillError
        ? "staged_fill_error"
        : (!fillCompletion.complete ? "partial_repair_incomplete" : "hard_invalid_after_fill");
      setStatus("Đang sắp xếp...", "info");
      restartProgressForRetry(retrySettings, baseData);
      const retryPayload = await postSolve(retrySettings, baseData);
      return markStagedExistingFreshRetryPayload(retryPayload, state, {
        ui_staged_fill_error:!!fillError,
        ui_staged_fill_error_kind:String(fillError?.kind || fillError?.payload?.kind || "").slice(0, 80),
        ui_staged_fill_error_status:Math.max(0, Number(fillError?.status || 0) || 0),
        ui_staged_fill_hard_invalid_count: fillCompletion.violations,
        ui_staged_fill_hard_ok: fillCompletion.hardOk,
        ui_staged_fill_incomplete: !fillCompletion.complete
      });
    }
    if(!fillCompletion.complete || !teacherQualityNeedsCleanup(fillPayload, baseSettings, baseData)){
      return fillPayload;
    }

    const qualityData = clonePlain(baseData || getData() || {});
    qualityData.tkbSolverResult = clonePlain(fillPayload);
    qualityData.__tkbStagedExistingQuality = true;
    const qualitySettings = stagedExistingRepairSettings(baseSettings, {
      expected: fillCompletion.expected || state.expected,
      scheduled: fillCompletion.scheduled || state.expected,
      flexibleScheduled: fillCompletion.scheduled || state.expected,
      missing: 0,
      maxMissing: state.maxMissing
    }, "quality", runId);
    setStatus("Đang sắp xếp...", "info");
    restartProgressForRetry(qualitySettings, qualityData);
    try{
      const qualityPayload = markStagedExistingPayload(
        await postSolve(qualitySettings, qualityData),
        state,
        "quality"
      );
      const qualityCompletion = payloadCompletion(qualityPayload);
      if(qualityCompletion.complete && payloadStrictlyBetterTeacherQuality(qualityPayload, fillPayload, qualitySettings)){
        return markStagedExistingPayload(qualityPayload, state, "quality", {
          ui_staged_quality_accepted: true
        });
      }
      return markStagedExistingPayload(fillPayload, state, "fill", {
        ui_staged_quality_rejected: true
      });
    }catch(err){
      rethrowCancelledSolve(err, runId);
      rethrowAuthRequiredSolve(err);
      console.warn(`[${VERSION}] staged quality slice skipped`, err);
      return markStagedExistingPayload(fillPayload, state, "fill", {
        ui_staged_quality_error: String(err && (err.message || err) || err).slice(0, 180)
      });
    }
  }

  function shouldUseInitialFastDraft(settings, data){
    if(!data || settings?.ui_disable_initial_fast_draft === true) return false;
    if(isTeacherSessionOptSettings(settings)) return false;
    if(settings?.optimize_existing_schedule === true) return false;
    const expected = expectedLessonCount(data);
    if(expected <= 0) return false;
    if(settings?.ui_force_initial_fast_draft === true || settings?.ui_default_fresh_sort === true) return true;
    const scheduled = countScheduledLessons(data);
    if(scheduled >= expected) return false;
    const flexibleScheduled = countScheduledLessons(data, {flexibleOnly:true});
    if(flexibleScheduled <= 0) return true;
    return flexibleScheduled <= 6 && flexibleScheduled / Math.max(1, expected) <= 0.02;
  }

  function shouldUseCapacitySafeFreshProbe(settings, data){
    if(!data || settings?.ui_capacity_safe_fresh_probe_attempted === true) return false;
    if(settings?.ui_capacity_safe_fresh_probe === true) return false;
    if(settings?.ui_unified_solve_kind !== "fresh_complete_first") return false;
    if(!isTeacherSessionOptSettings(settings)) return false;
    const expected = expectedLessonCount(data);
    if(expected <= 0 || countScheduledLessons(data) >= expected) return false;
    const fixedScheduled = countFixedScheduledLessons(data);
    if(fixedScheduled <= 0) return false;
    // Some large schools have ample class slots but a teacher-specific OFF
    // bottleneck. Their class-slack profile is therefore null even though the
    // backend can prove an exact capacity remainder. Route these heavy
    // fixed/OFF inputs through the same bounded capacity probe instead of
    // spending the whole 180s completeness lane first.
    if(
      expected >= 1200
      && fixedScheduled >= 20
      && hasFixedOffPressure(data)
    ) return true;
    const profile = settings?.tight_class_fixed_off_profile;
    if(!profile || typeof profile !== "object") return false;
    const profileExpected = Number(profile.expected || 0);
    const profileAvailable = Number(profile.availableSlots || 0);
    const profileSlack = Number(profile.slack);
    return Number.isFinite(profileExpected)
      && profileExpected === expected
      && Number.isFinite(profileAvailable)
      && profileAvailable <= expected
      && Number.isFinite(profileSlack)
      && profileSlack <= 0;
  }

  function capacitySafeFreshProbeSettings(baseSettings, data, runId){
    const workers = Math.max(2, Math.min(6, Number(baseSettings?.num_workers || 6) || 6));
    // The Cloud Run coordinator needs a little headroom to serialize and
    // publish a hard-valid capacity partial. A 30s watchdog can expire while
    // the solver has already found the safe 2097/2103 result (~25–28s).
    const seconds = 60;
    return {
      solver_mode: "auto",
      auto_sort_mode: "fresh",
      ui_requested_solve_mode: "automatic",
      ui_unified_solve_kind: "fresh_complete_first",
      ui_capacity_safe_fresh_probe: true,
      ui_capacity_shortage_confirmed: true,
      ui_accept_incomplete_best_effort: true,
      ui_allow_best_effort_on_timeout: true,
      ui_allow_short_backend_deadline: true,
      ui_internal_allow_incomplete: true,
      ui_preserve_off_cells_in_solver_request: true,
      ui_skip_capacity_precheck: true,
      ui_skip_pre_solve_constraint_release: true,
      ui_disable_automatic_retry: true,
      require_complete_schedule: false,
      best_effort_on_timeout: true,
      force_fresh_backend_solve: true,
      allow_backend_cache: false,
      allow_solver_warm_start: false,
      preserve_existing_tkb: false,
      fresh_randomize: true,
      randomize_search: true,
      num_workers: workers,
      session_time_limit: 12,
      period_time_limit: 12,
      period_retry_time_limit: 8,
      integrated_time_limit: seconds,
      overall_time_limit_seconds: seconds,
      optimization_time_limit_seconds: seconds,
      backend_deadline_ms: seconds * 1000,
      native_global_deadline_ms: seconds * 1000,
      reference_watchdog_deadline_ms: seconds * 1000,
      native_deadline_reserve_ms: 500,
      progress_estimate_seconds: seconds,
      solve_run_id: `${runId || makeSolveRunId()}-capacity-fresh-probe-${Date.now()}`
    };
  }

  async function solveCapacitySafeFreshProbe(baseSettings, baseData, runId){
    if(!shouldUseCapacitySafeFreshProbe(baseSettings, baseData)) return null;
    const probeSettings = capacitySafeFreshProbeSettings(baseSettings, baseData, runId);
    probeSettings.ui_capacity_safe_fresh_probe_attempted = true;
    const probeData = clonePlain(baseData || getData() || {});
    setStatus("Đang xếp phần dữ liệu có ô nghỉ...", "info");
    restartProgressForRetry(probeSettings, probeData);
    try{
      const payload = await postSolve(probeSettings, probeData);
      const completion = payloadCompletion(payload);
      if(
        (completion.complete && completion.hardOk)
        || payloadIsSafeCapacityPartial(payload)
      ){
        payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
        payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
          ? payload.solver.runtime_settings
          : {};
        payload.solver.runtime_settings.ui_capacity_safe_fresh_probe = true;
        return payload;
      }
    }catch(err){
      rethrowCancelledSolve(err, runId);
      rethrowAuthRequiredSolve(err);
      if(err?.kind === "solver_busy") throw err;
      console.warn(`[${VERSION}] capacity-safe fresh probe skipped`, err);
    }
    return null;
  }

  function initialFastDraftSettings(baseSettings, data, runId){
    const expected = expectedLessonCount(data);
    const budgets = speedFirstBudgets(expected);
    const next = Object.assign({}, baseSettings || {});
    clearPostRollbackSettings(next);
    next.ui_initial_fast_draft = true;
    next.ui_allow_short_backend_deadline = true;
    next.ui_client_timeout_reserve_ms = 12_000;
    next.auto_sort_mode = "fast";
    next.auto_sort_strategy = "fresh_speed_first_initial_draft";
    next.solver_mode = "auto";
    next.require_complete_schedule = true;
    next.best_effort_on_timeout = true;
    next.speed_first_complete = true;
    next.preserve_existing_tkb = false;
    next.force_preserve_partial_existing = false;
    next.partial_existing_rebuild = false;
    next.optimize_existing_schedule = false;
    next.existing_fill_missing_schedule = false;
    next.force_fresh_backend_solve = true;
    next.allow_backend_cache = false;
    next.allow_solver_warm_start = false;
    next.disable_native_hint_solver = true;
    next.disable_solver_hints = true;
    next.allow_zero_one_quality_retry = false;
    next.allow_teacher_session_deep_retry = false;
    next.allow_teacher_session_fast_portfolio = false;
    next.complete_schedule_seed_retry = false;
    next.schedule_diversity = false;
    next.reclick_schedule_diversity = false;
    next.require_teacher_session_diversity = false;
    next.fresh_randomize = true;
    next.randomize_search = true;
    next.random_seed = makeRandomSeed();
    next.session_time_limit = budgets.session;
    next.period_time_limit = budgets.period;
    next.period_fast_time_limit = budgets.period;
    next.period_retry_time_limit = budgets.period;
    next.period_retry_session_time_limit = budgets.retrySession || budgets.session;
    next.integrated_time_limit = budgets.overall;
    next.overall_time_limit_seconds = budgets.overall;
    next.progress_estimate_seconds = Math.min(90, budgets.overall);
    next.native_hint_bank_max_entries = 0;
    next.native_hint_bank_time_limit_ms = 50;
    next.native_fresh_attempts = Math.max(40, Number(next.native_fresh_attempts || 0) || 0);
    next.native_fresh_max_iters = Math.max(60000, Number(next.native_fresh_max_iters || 0) || 0);
    next.native_fresh_time_limit_ms = hasFixedOffPressure(data)
      ? Math.max(45000, Math.round((budgets.overall || 55) * 1000 * 0.72))
      : Math.min(30000, Math.max(16000, Math.round((budgets.overall || 45) * 1000 * 0.35)));
    next.native_fresh_cleanup_time_limit_ms = Math.min(
      12000,
      Math.max(3000, Number(next.native_fresh_cleanup_time_limit_ms || 0) || 0)
    );
    next.one_period_zero_probe_time_limit = 3;
    next.one_period_gap0_probe_time_limit = 3;
    next.session_priority_rescue_time_limit = 3;
    next.session_priority_period_time_limit = 4;
    next.local_one_period_cleanup_time_limit = 1;
    next.one_period_cluster_repair_time_limit = 1;
    next.solve_run_id = `${runId || makeSolveRunId()}-initial-fast-draft-${Date.now()}`;
    delete next.max_teacher_sessions;
    delete next.requested_max_teacher_sessions;
    delete next.target_teacher_sessions;
    delete next.target_gap1_sessions;
    delete next.optimization_accept_teacher_sessions;
    delete next.optimization_accept_gap1_sessions;
    return next;
  }

  function initialFastDraftOptimizeSettings(baseSettings, data, runId){
    const expected = expectedLessonCount(data);
    const seconds = expected >= 600 || hasActiveConstraintData(data) ? 36 : 16;
    const qualityTargets = practicalTeacherQualityTargets(data);
    const next = Object.assign({}, baseSettings || {});
    next.ui_initial_fast_draft_optimize = true;
    next.ui_allow_short_backend_deadline = true;
    next.ui_client_timeout_reserve_ms = 10_000;
    next.gap_existing_optimize_attempts = expected >= 600 || hasActiveConstraintData(data) ? 2 : 1;
    next.optimize_existing_schedule = true;
    next.existing_fill_missing_schedule = true;
    next.preserve_existing_tkb = true;
    next.force_preserve_partial_existing = true;
    next.preserve_existing_min_ratio = 1;
    next.force_fresh_backend_solve = true;
    next.allow_backend_cache = false;
    next.allow_solver_warm_start = true;
    next.best_effort_on_timeout = true;
    next.require_complete_schedule = true;
    next.schedule_diversity = false;
    next.reclick_schedule_diversity = false;
    next.allow_zero_one_quality_retry = false;
    next.allow_teacher_session_deep_retry = false;
    next.allow_teacher_session_fast_portfolio = false;
    next.allow_quality_debt = false;
    next.optimization_default_accept_gap1_sessions = qualityTargets.gap1Target == null
      ? 0
      : qualityTargets.gap1Target;
    if(qualityTargets.teacherTarget > 0){
      next.target_teacher_sessions = qualityTargets.teacherTarget;
      next.optimization_accept_teacher_sessions = qualityTargets.teacherTarget;
      next.max_teacher_sessions = Math.max(
        qualityTargets.speedTeacherCap,
        Number(next.max_teacher_sessions || 0) || 0
      );
      next.requested_max_teacher_sessions = next.max_teacher_sessions;
      next.teacher_session_target_explicit = true;
    }
    if(qualityTargets.gap1Target != null){
      next.target_gap1_sessions = qualityTargets.gap1Target;
      next.optimization_accept_gap1_sessions = qualityTargets.gap1Target;
      next.gap1_quality_target_explicit = true;
    }
    next.native_teacher_session_compact_time_limit_ms = Math.max(
      expected >= 600 ? 8000 : 4000,
      Number(next.native_teacher_session_compact_time_limit_ms || 0) || 0
    );
    next.native_quality_cleanup_max_iters = Math.max(
      expected >= 600 ? 220 : 120,
      Number(next.native_quality_cleanup_max_iters || 0) || 0
    );
    next.overall_time_limit_seconds = seconds;
    next.integrated_time_limit = seconds;
    next.progress_estimate_seconds = seconds;
    next.native_global_deadline_ms = seconds * 1000;
    next.backend_deadline_ms = seconds * 1000;
    next.native_deadline_reserve_ms = 500;
    next.solve_run_id = `${runId || makeSolveRunId()}-initial-draft-quality-${Date.now()}`;
    return next;
  }

  function markInitialFastDraftPayload(payload, detail){
    if(!payload || typeof payload !== "object") return payload;
    payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
    payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
      ? payload.solver.runtime_settings
      : {};
    Object.assign(payload.solver.runtime_settings, {
      ui_initial_fast_draft: true
    }, detail || {});
    return payload;
  }

  async function solveInitialFastDraft(baseSettings, baseData, runId){
    if(!shouldUseInitialFastDraft(baseSettings, baseData)) return null;
    await yieldResponsiveUi();
    const draftData = clonePlain(baseData || getData() || {});
    await yieldResponsiveUi();
    const draftSettings = initialFastDraftSettings(baseSettings, draftData, runId);
    setStatus("Đang sắp xếp...", "info");
    restartProgressForRetry(draftSettings, draftData);
    let draftPayload;
    try{
      draftPayload = markInitialFastDraftPayload(
        await postSolve(draftSettings, draftData),
        {phase: "draft"}
      );
    }catch(err){
      rethrowCancelledSolve(err, runId);
      rethrowAuthRequiredSolve(err);
      if(err?.kind === "solver_busy") throw err;
      console.warn(`[${VERSION}] initial fast draft skipped`, err);
      return null;
    }
    const draftCompletion = payloadCompletion(draftPayload);
    if(!draftCompletion.complete || !draftCompletion.hardOk){
      if(payloadIsPureCapacityShortage(draftPayload)){
        return markInitialFastDraftPayload(draftPayload, {
          phase: "draft",
          accepted_capacity_shortage_best_effort: true
        });
      }
      return null;
    }
    const optimizeSettings = initialFastDraftOptimizeSettings(baseSettings, draftData, runId);
    if(!teacherQualityNeedsCleanup(draftPayload, optimizeSettings, draftData)){
      return markInitialFastDraftPayload(draftPayload, {
        phase: "draft",
        accepted_without_quality_slice: true
      });
    }
    setStatus("Đang sắp xếp...", "info");
    restartProgressForRetry(optimizeSettings, draftData);
    try{
      const optimized = markInitialFastDraftPayload(
        await optimizeExistingPayloadForTeacherGaps(draftPayload, optimizeSettings, draftData, runId),
        {phase: "quality"}
      );
      const optimizedCompletion = payloadCompletion(optimized);
      if(optimizedCompletion.complete && payloadBetterOrEqualTeacherQuality(optimized, draftPayload, optimizeSettings)){
        return markInitialFastDraftPayload(optimized, {
          phase: "quality",
          quality_slice_accepted: true
        });
      }
    }catch(err){
      rethrowCancelledSolve(err, runId);
      rethrowAuthRequiredSolve(err);
      if(err?.kind === "solver_busy") throw err;
      console.warn(`[${VERSION}] initial fast draft quality slice skipped`, err);
    }
    return markInitialFastDraftPayload(draftPayload, {
      phase: "draft",
      quality_slice_rejected: true
    });
  }

  async function optimizeExistingPayloadForTeacherGaps(payload, baseSettings, baseData, runId){
    if(!payloadCompletion(payload).complete) return payload;
    if(!teacherQualityNeedsCleanup(payload, baseSettings, baseData)) return payload;
    let incumbent = payload;
    const requestedAttempts = Number(baseSettings?.gap_existing_optimize_attempts || baseSettings?.gap2_existing_optimize_attempts || 0) || 0;
    const defaultAttempts = 4;
    const maxAttempts = Math.max(1, Math.min(8, requestedAttempts || defaultAttempts));
    let noImproveAttempts = 0;
    for(let attempt = 0; attempt < maxAttempts && teacherQualityNeedsCleanup(incumbent, baseSettings, baseData); attempt += 1){
      const beforeQuality = teacherSessionQuality(incumbent).join("|");
      const data = clonePlain(baseData || getData() || {});
      data.tkbSolverResult = clonePlain(incumbent);
      data.__tkbOptimizeExistingPayload = true;
      const settings = Object.assign({}, baseSettings || {}, {
        optimize_existing_schedule: true,
        allow_solver_warm_start: true,
        preserve_existing_tkb: true,
        preserve_existing_min_ratio: 1,
        force_fresh_backend_solve: true,
        allow_backend_cache: false,
        random_seed: makeRandomSeed(),
        solve_run_id: `${runId || makeSolveRunId()}-teacher-gaps-existing-${attempt + 1}`
      });
      delete settings.auto_sort_mode;
      delete settings.auto_sort_strategy;
      delete settings.solver_mode;
      const currentMetrics = incumbent?.metrics || {};
      const currentTeacherSessions = metricNumber(currentMetrics.teacher_sessions, 0);
      const currentGap1 = gapExactCount(currentMetrics, 1);
      const currentHardGap = !onePeriodTeacherSessionFloorReached(currentMetrics)
        || gap2PlusCount(currentMetrics) > 0;
      const finalTeacherTarget = positiveNumberSetting(
        settings.optimization_accept_teacher_sessions ?? settings.target_teacher_sessions
      );
      const finalGap1Target = nonnegativeNumberSetting(
        settings.optimization_accept_gap1_sessions ?? settings.target_gap1_sessions
      );
      if(finalTeacherTarget > 0 && currentTeacherSessions > finalTeacherTarget){
        if(currentHardGap){
          settings.target_teacher_sessions = currentTeacherSessions;
          settings.optimization_accept_teacher_sessions = currentTeacherSessions;
        }else{
          const debt = currentTeacherSessions - finalTeacherTarget;
          const step = Math.max(8, Math.ceil(debt * 0.35));
          const progressiveTeacherTarget = Math.max(finalTeacherTarget, currentTeacherSessions - step);
          settings.target_teacher_sessions = progressiveTeacherTarget;
          settings.optimization_accept_teacher_sessions = progressiveTeacherTarget;
        }
        settings.max_teacher_sessions = settings.target_teacher_sessions;
        settings.requested_max_teacher_sessions = settings.target_teacher_sessions;
        settings.teacher_session_target_explicit = true;
      }
      if(finalGap1Target != null && currentGap1 > finalGap1Target){
        if(currentHardGap){
          settings.target_gap1_sessions = currentGap1;
          settings.optimization_accept_gap1_sessions = currentGap1;
        }else{
          const debt = currentGap1 - finalGap1Target;
          const step = Math.max(8, Math.ceil(debt * 0.35));
          const progressiveGapTarget = Math.max(finalGap1Target, currentGap1 - step);
          settings.target_gap1_sessions = progressiveGapTarget;
          settings.optimization_accept_gap1_sessions = progressiveGapTarget;
        }
        settings.gap1_quality_target_explicit = true;
      }
      const optimized = await postSolve(settings, data);
      const optimizedCompletion = payloadCompletion(optimized);
      if(optimizedCompletion.complete && payloadBetterOrEqualTeacherQuality(optimized, incumbent, settings)){
        const afterQuality = teacherSessionQuality(optimized).join("|");
        incumbent = optimized;
        noImproveAttempts = afterQuality === beforeQuality ? noImproveAttempts + 1 : 0;
        if(noImproveAttempts >= 2) break;
        continue;
      }
      noImproveAttempts += 1;
      if(noImproveAttempts >= 2) break;
    }
    return incumbent;
  }

  function restartProgressForRetry(settings, data){
    const previous = progressState || {};
    const startedAt = Date.now();
    const localClickTimeline = previous.localClickTimeline === true;
    const uiStartedAt = localClickTimeline
      ? (Number(previous.uiStartedAt || previous.startedAt || 0) || startedAt)
      : startedAt;
    const lastPercent = localClickTimeline
      ? Math.max(4, Number(previous.lastPercent || 0) || 0)
      : 4;
    const estimate = estimateSolveSeconds(settings || {}, data || getData());
    const configuredMetricProgress = normalizeMetricProgressSnapshot({
      optimizationFocus:settings?.ui_progress_metric_focus,
      metricCurrent:settings?.ui_progress_metric_current,
      metricTarget:settings?.ui_progress_metric_target,
      metricBaseline:settings?.ui_progress_metric_baseline,
      metricPercent:settings?.ui_progress_metric_percent
    });
    const workMetricMode = progressUsesWorkMetrics(settings || {});
    const runIndex = normalizePendingProgressRunIndex(
      settings?.ui_progress_run_index
      || ((Number(previous.runIndex || 1) || 1) + 1)
    );
    progressState = {
      startedAt,
      // Internal solver slices are one user action. Keep the click-origin
      // clock continuous even when a retry receives a fresh compute budget.
      uiStartedAt,
      localClickTimeline,
      serverStartedAtMs:0,
      backendQueued:false,
      estimatedSeconds:estimate,
      lastPercent,
      lastLabel: "",
      phase:"preparing",
      retry: true,
      modeLabel: solveActionLabel(settings || {}),
      settings: Object.assign({}, settings || {}),
      // Internal retries are one visible optimization action. Preserve the
      // latest real counter (for example 136 -> 134 singleton sessions) rather
      // than dropping back to an elapsed-time-only 12% placeholder.
      metricProgress:workMetricMode
        ? (previous.metricProgress || configuredMetricProgress || null)
        : null,
      runIndex
    };
    progressState.progressBudgetSeconds = progressBudgetSeconds(progressState.settings, estimate);
    setProgress(
      progressState.lastPercent,
      progressLabel(
          "preparing",
        localClickTimeline ? Math.max(0, (startedAt - uiStartedAt) / 1000) : 0
      ),
      {replaceLocalPercent:true, phase:"preparing"}
    );
    if(!progressTimer) progressTimer = window.setInterval(tickEstimatedProgress, 1000);
  }

  function gap2PlusCount(metrics){
    return Object.entries(metrics?.gap_distribution || {}).reduce((sum, [gap, count]) => {
      return sum + (Number(gap) > 1 ? metricNumber(count) : 0);
    }, 0);
  }

  function gapExactCount(metrics, targetGap){
    return metricNumber((metrics?.gap_distribution || {})[String(targetGap)], 0);
  }

  // Gap progress is relative to the most recent Quick timetable, not to the
  // incumbent at the start of each refinement click. Keep this small marker
  // in DATA so reloads and other devices use the same denominator.
  function readGapProgressBaseline(data){
    const source = data?.[GAP_PROGRESS_BASELINE_DATA_KEY];
    if(!source || typeof source !== "object" || Array.isArray(source)) return null;
    const gap1 = Number(source.gap1);
    const gap2Plus = Number(source.gap2Plus ?? source.gap2_plus);
    const expectedPeriods = Number(source.expectedPeriods ?? source.expected_periods);
    if(
      !Number.isFinite(gap1) || gap1 < 0
      || !Number.isFinite(gap2Plus) || gap2Plus < 0
    ) return null;
    const expected = Math.max(0, Math.round(Number(expectedPeriods) || 0));
    if(expected <= 0) return null;
    const currentExpected = Math.max(0, expectedLessonCount(data || getData()));
    // A changed demand set needs a new Quick anchor. Do not mutate the old
    // marker here; the next successful Quick click will replace it.
    if(expected > 0 && currentExpected > 0 && expected !== currentExpected) return null;
    return {
      version:Math.max(1, Math.round(Number(source.version || GAP_PROGRESS_BASELINE_VERSION) || GAP_PROGRESS_BASELINE_VERSION)),
      gap1:Math.max(0, Math.round(gap1)),
      gap2Plus:Math.max(0, Math.round(gap2Plus)),
      expectedPeriods:expected,
      updatedAt:String(source.updatedAt || "")
    };
  }

  function gapProgressCountsFromMetrics(metrics){
    if(!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
    const distribution = metrics.gap_distribution;
    const hasDistribution = distribution && typeof distribution === "object" && !Array.isArray(distribution);
    const gap1Raw = hasDistribution && Object.prototype.hasOwnProperty.call(distribution, "1")
      ? Number(distribution["1"])
      : Number(metrics.teacher_gap1_sessions ?? metrics.gap1_sessions);
    const gap2Raw = hasDistribution
      ? Object.entries(distribution).reduce((sum, [gap, count]) => (
          Number(gap) > 1 ? sum + Math.max(0, Number(count) || 0) : sum
        ), 0)
      : Number(metrics.teacher_gap2_sessions ?? metrics.gap2_plus_sessions ?? metrics.gap2_sessions);
    if(!Number.isFinite(gap1Raw) || !Number.isFinite(gap2Raw)) return null;
    return {
      gap1:Math.max(0, Math.round(gap1Raw)),
      gap2Plus:Math.max(0, Math.round(gap2Raw))
    };
  }

  function quickGapMetrics(data, payloadOrMetrics){
    const payloadMetrics = payloadOrMetrics?.metrics && typeof payloadOrMetrics.metrics === "object"
      ? payloadOrMetrics.metrics
      : payloadOrMetrics;
    const visible = uiTeacherQualityMetrics(data || getData());
    const visibleCounts = gapProgressCountsFromMetrics(visible);
    const payloadCounts = gapProgressCountsFromMetrics(payloadMetrics);
    const counts = visibleCounts || payloadCounts;
    if(!counts) return null;
    const expectedFromMetrics = Number(payloadMetrics?.expected_periods);
    const expected = Math.max(
      0,
      Math.round(
        Number.isFinite(expectedFromMetrics) && expectedFromMetrics > 0
          ? expectedFromMetrics
          : expectedLessonCount(data || getData())
      )
    );
    return Object.assign({}, counts, {expectedPeriods:expected});
  }

  function rememberQuickGapProgressBaseline(data, payloadOrMetrics){
    if(!data || typeof data !== "object") return null;
    const counts = quickGapMetrics(data, payloadOrMetrics);
    if(!counts) return null;
    const expected = Math.max(0, Math.round(Number(counts.expectedPeriods || 0) || 0));
    if(expected <= 0) return null;
    const baseline = {
      version:GAP_PROGRESS_BASELINE_VERSION,
      gap1:Math.max(0, Math.round(Number(counts.gap1 || 0) || 0)),
      gap2Plus:Math.max(0, Math.round(Number(counts.gap2Plus || 0) || 0)),
      expectedPeriods:expected,
      updatedAt:new Date().toISOString()
    };
    data[GAP_PROGRESS_BASELINE_DATA_KEY] = baseline;
    return clonePlain(baseline);
  }

  async function refreshGapProgressBaselineFromRemote(data){
    if(!data || typeof data !== "object") return null;
    const storage = window.TKBStorage;
    if(!storage || typeof storage.loadRemoteSchoolData !== "function"){
      return readGapProgressBaseline(data);
    }
    let schoolId = "";
    try{
      schoolId = typeof schoolParam !== "undefined" ? String(schoolParam || "") : "";
    }catch(_){ }
    if(!schoolId){
      try{ schoolId = new URLSearchParams(String(location.search || "")).get("sid") || ""; }catch(_){ }
    }
    if(!schoolId) return readGapProgressBaseline(data);

    let remote = null;
    try{ remote = await storage.loadRemoteSchoolData(schoolId); }catch(_){ }
    const remoteBaseline = readGapProgressBaseline(remote);
    if(!remoteBaseline) return readGapProgressBaseline(data);
    const currentExpected = Math.max(0, expectedLessonCount(data));
    if(currentExpected > 0 && remoteBaseline.expectedPeriods !== currentExpected){
      return readGapProgressBaseline(data);
    }

    const localBaseline = readGapProgressBaseline(data);
    const remoteUpdatedAt = Date.parse(String(remoteBaseline.updatedAt || ""));
    const localUpdatedAt = Date.parse(String(localBaseline?.updatedAt || ""));
    if(
      !localBaseline
      || (Number.isFinite(remoteUpdatedAt) && (!Number.isFinite(localUpdatedAt) || remoteUpdatedAt > localUpdatedAt))
    ){
      data[GAP_PROGRESS_BASELINE_DATA_KEY] = clonePlain(remoteBaseline);
      return clonePlain(remoteBaseline);
    }
    return localBaseline;
  }

  function canonicalizeGapProgressSnapshot(snapshot, data){
    if(!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
    const configuredFocus = String(progressState?.settings?.ui_progress_metric_focus || "").trim();
    const rawFocus = String(
      snapshot.optimizationFocus
      ?? snapshot.optimization_focus
      ?? snapshot.metricFocus
      ?? snapshot.metric_focus
      ?? ""
    ).trim();
    const focus = rawFocus || configuredFocus;
    const normalized = focus.toLowerCase().replace(/[\s-]+/g, "_");
    if(
      normalized !== "teacher_gap_sessions"
      && normalized !== "teacher_gap1_sessions"
      && normalized !== "teacher_gap2_sessions"
    ) return snapshot;
    const storedBaseline = readGapProgressBaseline(data || getData());
    const frameGap1 = Number(snapshot.gap1Baseline ?? snapshot.gap1_baseline);
    const frameGap2 = Number(snapshot.gap2Baseline ?? snapshot.gap2_baseline);
    const hasFrameBaseline = Number.isFinite(frameGap1) && frameGap1 >= 0
      && Number.isFinite(frameGap2) && frameGap2 >= 0;
    if(!storedBaseline && !hasFrameBaseline) return snapshot;
    const current = Number(snapshot.metricCurrent ?? snapshot.metric_current);
    const target = Number(snapshot.metricTarget ?? snapshot.metric_target);
    if(!Number.isFinite(current) || !Number.isFinite(target)) return snapshot;
    const baselineValue = normalized === "teacher_gap_sessions"
      ? (hasFrameBaseline
          ? frameGap1 + frameGap2
          : storedBaseline.gap1 + storedBaseline.gap2Plus)
      : (normalized === "teacher_gap2_sessions"
          ? (hasFrameBaseline ? frameGap2 : storedBaseline.gap2Plus)
          : (hasFrameBaseline ? frameGap1 : storedBaseline.gap1));
    const percent = metricProgressPercent(normalized, current, target, baselineValue);
    return Object.assign({}, snapshot, {
      optimizationFocus:normalized,
      metricBaseline:baselineValue,
      metricPercent:percent,
      metric_baseline:baselineValue,
      metric_percent:percent
    });
  }

  function metricGapTotal(metrics){
    return Object.entries(metrics?.gap_distribution || {}).reduce((sum, [gap, count]) => {
      return sum + Math.max(0, Number(gap) || 0) * Math.max(0, metricNumber(count));
    }, 0);
  }

  function uiSchoolCompletionStats(){
    try{
      const statsFn = typeof window.calcSchoolTKBStats === "function"
        ? window.calcSchoolTKBStats
        : (typeof calcSchoolTKBStats === "function" ? calcSchoolTKBStats : null);
      if(typeof statsFn !== "function") return null;
      const stats = statsFn() || {};
      const expected = metricNumber(stats.soTiet, NaN);
      const scheduled = metricNumber(stats.daXepTiet, NaN);
      const unassigned = metricNumber(stats.chuaXepTiet, NaN);
      if(Number.isFinite(expected) && expected > 0 && Number.isFinite(scheduled) && Number.isFinite(unassigned)){
        return {
          expected: Math.max(0, Math.round(expected)),
          scheduled: Math.max(0, Math.round(scheduled)),
          unassigned: Math.max(0, Math.round(unassigned))
        };
      }
    }catch(_){}
    return null;
  }

  function cheapSchoolCompletionStats(data){
    const bridgeStats = (() => {
      const scheduled = countScheduledLessons(data);
      const expected = expectedLessonCount(data);
      if(expected <= 0 && scheduled <= 0) return null;
      return {
        expected: Math.max(0, Math.round(expected)),
        scheduled: Math.max(0, Math.round(scheduled)),
        unassigned: expected > 0 ? Math.max(0, Math.round(expected - scheduled)) : 0,
        source: "bridge_count"
      };
    })();
    const uiStats = uiSchoolCompletionStats();
    if(uiStats){
      const normalizedUi = Object.assign({source: "ui_stats"}, uiStats);
      if(
        bridgeStats
        && bridgeStats.expected > 0
        && bridgeStats.expected === Math.max(0, Math.round(Number(normalizedUi.expected || 0) || 0))
      ){
        const expected = bridgeStats.expected;
        const physicalMissing = Math.max(0, expected - bridgeStats.scheduled);
        const demandMissing = Math.max(0, Math.round(Number(normalizedUi.unassigned || 0) || 0));
        const unassigned = Math.max(physicalMissing, demandMissing);
        return {
          expected,
          scheduled: Math.max(0, expected - unassigned),
          physicalScheduled: bridgeStats.scheduled,
          unassigned,
          source: "demand_aware_visible_schedule"
        };
      }
      return normalizedUi;
    }
    return bridgeStats;
  }

  function visibleCompletionMetrics(payload){
    const metrics = payload?.metrics || {};
    const fallbackScheduled = metricNumber(metrics.scheduled_periods, 0);
    const fallbackExpected = metricNumber(metrics.expected_periods, 0);
    const fallbackUnassigned = metricNumber(metrics.unassigned_periods, 0);
    let scheduled = 0;
    let expected = 0;
    let unassigned = 0;
    let fromVisibleSchedule = false;
    const uiStats = uiSchoolCompletionStats();
    let bridgeStats = null;
    try{
      const data = getData();
      if(data && data.tkb && typeof data.tkb === "object"){
        const bridgeScheduled = countScheduledLessons(data);
        const bridgeExpected = expectedLessonCount(data);
        if(bridgeScheduled > 0 || bridgeExpected > 0){
          bridgeStats = {
            scheduled: Math.max(0, Math.round(bridgeScheduled)),
            expected: Math.max(0, Math.round(bridgeExpected)),
            unassigned: bridgeExpected > 0 ? Math.max(0, Math.round(bridgeExpected - bridgeScheduled)) : 0,
            fromVisibleSchedule: true,
            source: "bridge_count"
          };
        }
      }
    }catch(_){}
    if(uiStats){
      if(
        bridgeStats
        && bridgeStats.expected > 0
        && bridgeStats.expected === Math.max(0, Math.round(Number(uiStats.expected || 0) || 0))
        && bridgeStats.scheduled !== Math.max(0, Math.round(Number(uiStats.scheduled || 0) || 0))
      ){
        bridgeStats.source = "bridge_count_preferred_over_stale_ui";
        return bridgeStats;
      }
      scheduled = uiStats.scheduled;
      expected = uiStats.expected;
      unassigned = uiStats.unassigned;
      fromVisibleSchedule = true;
      return {scheduled, expected, unassigned, fromVisibleSchedule, source: "ui_stats"};
    }
    if(bridgeStats){
      scheduled = bridgeStats.scheduled;
      expected = bridgeStats.expected;
      fromVisibleSchedule = true;
    }
    if(!fromVisibleSchedule){
      scheduled = fallbackScheduled;
      expected = fallbackExpected;
    }else if(expected <= 0){
      expected = Math.max(fallbackExpected, scheduled);
    }
    unassigned = expected > 0
      ? Math.max(0, expected - scheduled)
      : Math.max(0, fallbackUnassigned);
    return {scheduled, expected, unassigned, fromVisibleSchedule, source: fromVisibleSchedule ? "bridge_count" : "payload"};
  }

  function syncVisibleCompletionMetrics(payload, result, visibleOverride){
    const actual = visibleOverride || visibleCompletionMetrics(payload || result);
    if(!actual.fromVisibleSchedule) return actual;
    [payload, result].forEach(target => {
      if(!target || typeof target !== "object") return;
      target.metrics = target.metrics && typeof target.metrics === "object" ? Object.assign({}, target.metrics) : {};
      target.metrics.scheduled_periods = actual.scheduled;
      target.metrics.expected_periods = actual.expected;
      target.metrics.unassigned_periods = actual.unassigned;
      const violations = metricNumber(target.metrics.app_constraint_violation_count, 0);
      const hardOk = target.metrics.hard_ok !== false
        && target.metrics.core_hard_ok !== false
        && target?.validation?.hard_ok !== false;
      const visibleComplete = actual.expected > 0
        && actual.scheduled >= actual.expected
        && actual.unassigned === 0
        && violations === 0
        && hardOk;
      const existingBestEffort = target.bestEffort === true || target.metrics.best_effort === true;
      target.metrics.best_effort = visibleComplete ? false : (existingBestEffort || actual.unassigned > 0 || violations > 0);
      target.bestEffort = target.metrics.best_effort === true;
    });
    return actual;
  }

  function buildCompletionMessage(payload, visibleOverride){
    const metrics = payload?.metrics || {};
    const solver = payload?.solver || {};
    const runtime = solver.runtime_settings || {};
    let unchangedSchedule = runtime.schedule_unchanged === true;
    const visible = visibleOverride || visibleCompletionMetrics(payload);
    const scheduled = visible.scheduled;
    const expected = visible.expected;
    const unassigned = visible.unassigned;
    const violations = metricNumber(metrics.app_constraint_violation_count);
    const optElapsed = metricNumber(solver.teacher_session_optimization?.elapsed_seconds, NaN);
    const elapsed = metricNumber(
      runtime.display_elapsed_seconds ?? runtime.ui_wall_elapsed_seconds ?? optElapsed ?? runtime.elapsed_seconds,
      NaN
    );
    const incomplete = expected > 0 && scheduled < expected;
    const bestEffort = unassigned > 0 || incomplete || violations > 0;
    const capacityShortageOnly = payloadIsPureCapacityShortage(payload);
    const debtMessage = qualityDebtMessage(payload, runtime);
    if(bestEffort) unchangedSchedule = false;
    if(!bestEffort) return completionQualityStatus(payload, getData()).message;
    const returnedIncumbentNearDeadline = payloadReturnedCompleteIncumbentNearDeadline(payload);
    const lines = [
      returnedIncumbentNearDeadline
        ? "Đã sắp xếp xong, bỏ qua tối ưu thêm vì gần hết thời gian."
        : unchangedSchedule
        ? "Đã sắp xếp xong. Lịch mới trùng lịch hiện tại."
        : (bestEffort ? (
            capacityShortageOnly
              ? "Đã xếp phần có thể xếp. Tiết dư do thiếu ô nằm ở Chưa phân."
              : unassigned > 0 || incomplete
              ? "Chưa xếp đủ. Các tiết chưa có chỗ sẽ nằm ở Chưa phân."
              : "Đã sắp xếp đủ tiết. Còn ràng buộc cần kiểm tra."
          ) : (debtMessage ? "Đã xếp đủ tiết nhưng còn cần tối ưu giáo viên." : "Đã sắp xếp xong."))
    ];
    if(unassigned > 0) lines.push(capacityShortageOnly ? `Chưa phân: ${unassigned} tiết do thiếu ô.` : `Chưa phân: ${unassigned} tiết.`);
    if(violations > 0) lines.push(`Còn ${violations} lỗi ràng buộc.`);
    if(debtMessage) lines.push(debtMessage);
    if(Number.isFinite(elapsed)) lines.push(`Thời gian: ${formatDuration(elapsed)}.`);
    if(unchangedSchedule) lines.push("Ghi chú: phương án mới không đổi vị trí các tiết so với lịch đang hiển thị.");
    return lines.join("\n");
  }

  function payloadReturnedCompleteIncumbentNearDeadline(payload){
    const runtime = payload?.solver?.runtime_settings || {};
    if(runtime.returned_incumbent !== true) return false;
    if(runtime.deadline_hit !== true && !String(runtime.phase || "").toLowerCase().includes("deadline")) return false;
    const completion = payloadCompletion(payload);
    return completion.complete === true;
  }

  function businessReason(reason){
    const text = String(reason || "").trim();
    if(!text) return "";
    const lower = text.toLowerCase();
    if(lower.includes("timeout") || lower.includes("deadline") || lower.includes("time")) return "Bỏ qua lượt thử phụ vì gần hết thời gian.";
    if(lower.includes("capacity")) return "Số ô học hợp lệ không đủ cho toàn bộ tiết.";
    return text.replace(/[_-]+/g, " ");
  }

  function notifyCompletion(payload, visibleOverride, messageOverride){
    const metrics = payload?.metrics || {};
    const runtime = payload?.solver?.runtime_settings || {};
    const unchangedSchedule = runtime.schedule_unchanged === true;
    const visible = visibleOverride || visibleCompletionMetrics(payload);
    const message = messageOverride || buildCompletionMessage(payload, visible);
    const scheduled = visible.scheduled;
    const expected = visible.expected;
    const unassigned = visible.unassigned;
    const violations = metricNumber(metrics.app_constraint_violation_count);
    const incomplete = expected > 0 && scheduled < expected;
    const hardWarning = violations > 0 || unassigned > 0 || incomplete;
    const capacityShortageOnly = payloadIsPureCapacityShortage(payload);
    const debtMessage = qualityDebtMessage(payload, runtime);
    const statusType = hardWarning ? "warning" : "ok";
    window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = message;
    if(statusType === "ok"){
      const qualityStatus = completionQualityStatus(payload, getData());
      const completion = payloadCompletion(payload);
      if(completion.complete && completion.hardOk !== false){
        // Teacher-quality debt stays available to the next refinement click,
        // but a complete hard-valid timetable has one successful terminal UI.
        setStatus(SOLVE_COMPLETE_MESSAGE, "ok");
      }else{
        setStatus(qualityStatus.message, qualityStatus.level);
      }
    }
    else if(unassigned > 0 || incomplete){
      const remain = Math.max(unassigned, expected > 0 ? Math.max(0, expected - scheduled) : 0);
      setStatus(
        capacityShortageOnly
          ? `Đã xếp phần có thể xếp. Chưa phân: ${remain} tiết do thiếu ô${violations > 0 ? ` và ${violations} lỗi ràng buộc` : ""}.`
          : `Chưa xếp đủ. Chưa phân: ${remain} tiết${violations > 0 ? ` và ${violations} lỗi ràng buộc` : ""}.`,
        statusType
      );
    }else{
      setStatus(`Đã xếp đủ ${scheduled || expected || ""} tiết. Còn ${violations} lỗi ràng buộc cần kiểm tra.`, statusType);
    }
    dismissCompletionPopup(true);
    return message;
  }

  function escapeHtml(value){
    return String(value == null ? "" : value).replace(/[&<>'"]/g, ch => ({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      "'":"&#39;",
      "\"":"&quot;"
    })[ch]);
  }

    function readSettings(){
      try{
        const saved = JSON.parse(localStorage.getItem("TKB_NEW_SOLVER_SETTINGS") || "{}");
        const next = Object.assign({}, DEFAULT_SETTINGS, saved || {});
        const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
        const hasSavedGapTarget = hasOwn(saved, "target_gap1_sessions") || hasOwn(saved, "optimization_accept_gap1_sessions");
        if(hasSavedGapTarget) next.gap1_quality_target_explicit = true;
        if(
          hasOwn(saved, "optimization_accept_gap1_sessions")
          && !hasOwn(saved, "target_gap1_sessions")
          && saved.gap1_quality_target_explicit !== true
          && Number(saved.optimization_accept_gap1_sessions) === 10
        ){
          delete next.optimization_accept_gap1_sessions;
          next.gap1_quality_target_explicit = false;
        }
        if(
          saved.gap1_quality_target_explicit !== true
          && hasOwn(saved, "target_gap1_sessions")
          && Number(saved.target_gap1_sessions) === 0
          && (!hasOwn(saved, "optimization_accept_gap1_sessions") || Number(saved.optimization_accept_gap1_sessions) === 0)
        ){
          delete next.target_gap1_sessions;
          delete next.optimization_accept_gap1_sessions;
          next.gap1_quality_target_explicit = false;
        }
        if(
          !Object.prototype.hasOwnProperty.call(saved || {}, "target_teacher_sessions")
          && !Object.prototype.hasOwnProperty.call(saved || {}, "teacher_session_target_explicit")
          && Number(saved?.max_teacher_sessions) === 180
        ){
          next.max_teacher_sessions = DEFAULT_SETTINGS.max_teacher_sessions;
          delete next.requested_max_teacher_sessions;
        }
        next.overall_time_limit_seconds = normalizeOverallTimeLimit(saved?.overall_time_limit_seconds ?? DEFAULT_SETTINGS.overall_time_limit_seconds);
        enforceCompleteScheduleForUi(next);
        if(Number(saved?.session_time_limit || 0) <= 10) next.session_time_limit = DEFAULT_SETTINGS.session_time_limit;
        if(Number(saved?.period_time_limit || 0) <= 30) next.period_time_limit = DEFAULT_SETTINGS.period_time_limit;
        if(Number(saved?.period_fast_time_limit || 0) <= 4) next.period_fast_time_limit = DEFAULT_SETTINGS.period_fast_time_limit;
        if(Number(saved?.period_retry_time_limit || 0) <= 10) next.period_retry_time_limit = DEFAULT_SETTINGS.period_retry_time_limit;
        return next;
      }catch(_){
        return Object.assign({}, DEFAULT_SETTINGS);
      }
    }

    function hasTruthyOffMap(root){
      if(!root || typeof root !== "object") return false;
      return Object.values(root).some(raw => {
        if(Array.isArray(raw)) return raw.length > 0;
        if(!raw || typeof raw !== "object") return false;
        return Object.keys(raw).some(key => !!raw[key]);
      });
    }

    function hasActiveConstraintData(data){
      const memo = activeAutoSortPlanningMemo(data);
      if(memo && typeof memo.hasActiveConstraintData === "boolean") return memo.hasActiveConstraintData;
      if(hasTruthyOffMap(data?.tkbUserOff)){
        if(memo) memo.hasActiveConstraintData = true;
        return true;
      }
      const c = data && data.tkbConstraints;
      if(!c || typeof c !== "object"){
        if(memo) memo.hasActiveConstraintData = false;
        return false;
      }
      const hasKeys = obj => obj && typeof obj === "object" && Object.keys(obj).length > 0;
      const fixed = c.fixedOff || {};
      const result = hasKeys(c.teacher) || hasKeys(c.subject) || hasKeys(c.subjectGroup) ||
        (Array.isArray(c.timeLimit) && c.timeLimit.length > 0) ||
        ["class","teacher","subject","room","subjectGroup"].some(kind => hasKeys(fixed[kind]));
      if(memo) memo.hasActiveConstraintData = result;
      return result;
    }

    function heavySubjectBlockSessionCapFloor(data){
      const c = data?.tkbConstraints;
      if(!c || typeof c !== "object") return 0;
      let heavyRows = 0;
      const truthy = value => value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
      const countRoot = root => {
        const byClass = root?.byClass && typeof root.byClass === "object" ? root.byClass : {};
        Object.values(byClass).forEach(rule => {
          if(!rule || typeof rule !== "object") return;
          let heavy = false;
          const blocks = rule.lessonBlocks && typeof rule.lessonBlocks === "object" ? rule.lessonBlocks : {};
          Object.values(blocks).forEach(item => {
            const min = Number(item?.min || 0);
            if(Number.isFinite(min) && min > 0) heavy = true;
          });
          ["avoidBreakPair23", "avoidBreakPair34", "avoidBreakPairs"].forEach(key => {
            const item = rule[key];
            if(item && typeof item === "object" && (truthy(item.morning) || truthy(item.afternoon))) heavy = true;
          });
          if(heavy) heavyRows += 1;
        });
      };
      Object.values(c.subject || {}).forEach(countRoot);
      Object.values(c.subjectGroup || {}).forEach(countRoot);
      return heavyRows >= 5 ? 197 : 0;
    }

  function hasSubjectPeriodRequirements(data){
      const c = data?.tkbConstraints;
      if(!c || typeof c !== "object") return false;
      const truthy = value => value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
      const rowHasRequirement = rule => {
        if(!rule || typeof rule !== "object") return false;
        const blocks = rule.lessonBlocks && typeof rule.lessonBlocks === "object" ? rule.lessonBlocks : {};
        if(Object.values(blocks).some(item => {
          const min = Number(item?.min || 0);
          const max = Number(item?.max || 0);
          return (Number.isFinite(min) && min > 0) || (Number.isFinite(max) && max > 0);
        })) return true;
        return ["avoidBreakPair23", "avoidBreakPair34", "avoidBreakPairs"].some(key => {
          const item = rule[key];
          return item && typeof item === "object" && (truthy(item.morning) || truthy(item.afternoon));
        });
      };
      const rootHasRequirement = root => {
        const byClass = root?.byClass && typeof root.byClass === "object" ? root.byClass : {};
        return Object.values(byClass).some(rowHasRequirement);
      };
      return Object.values(c.subject || {}).some(rootHasRequirement)
        || Object.values(c.subjectGroup || {}).some(rootHasRequirement);
    }

    function normalizedConstraintViolationText(item){
      let text = String(item?.message || item || "").toLowerCase();
      try{
        text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      }catch(_){ }
      // Vietnamese d-stroke is not a decomposable diacritic, so NFD leaves it
      // intact. Keep this escape ASCII-safe because these messages come from
      // the localized validator and are also used to choose the solve lane.
      return text.replace(/\u0111/g, "d");
    }

    function isSubjectPeriodConstraintViolation(item){
      const kind = String(item?.kind || "").trim().toLowerCase();
      if(
        kind.startsWith("subject.lessonblock")
        || kind.startsWith("subjectgroup.lessonblock")
        || kind.startsWith("subject.avoidbreak")
        || kind.startsWith("subjectgroup.avoidbreak")
        || kind.startsWith("subject.linkedday")
        || kind.startsWith("subjectgroup.linkedday")
      ) return true;
      const text = normalizedConstraintViolationText(item);
      return (
        (text.includes("tiet xep lien") && (text.includes("so buoi/cum") || text.includes("min") || text.includes("max")))
        || text.includes("tranh xep lien tiet 2-3")
        || text.includes("tranh xep lien tiet 3-4")
        || text.includes("tranh xep tiet lien vao")
      );
    }

    function isDeferredIncompleteLessonBlockMinimumViolation(item){
      const kind = String(item?.kind || "").trim().toLowerCase();
      if(
        kind.startsWith("subject.lessonblocks.min")
        || kind.startsWith("subject.lessonblock.min")
        || kind.startsWith("subjectgroup.lessonblocks.min")
        || kind.startsWith("subjectgroup.lessonblock.min")
      ) return true;
      const text = normalizedConstraintViolationText(item);
      return text.includes("chua dat min")
        && (text.includes("tiet xep lien") || text.includes("cum"));
    }

    function isDeferredIncompleteMustTeachViolation(item){
      const kind = String(item?.kind || "").trim().toLowerCase();
      if(
        kind === "teacher.mustteach.missing"
        || kind === "teacher.must_teach.missing"
      ) return true;
      const text = normalizedConstraintViolationText(item);
      return text.includes("vi tri phai co tiet day")
        && (text.includes("chua duoc xep") || text.includes("chua co tiet"));
    }

    function isDeferredIncompleteLowerBoundViolation(item){
      return isDeferredIncompleteLessonBlockMinimumViolation(item)
        || isDeferredIncompleteMustTeachViolation(item);
    }

    function effectiveSettingsForSolve(settings, data){
      const next = Object.assign({}, settings || {});
      if(next.ui_capacity_safe_fresh_probe === true){
        // This is a bounded feasibility checkpoint for a zero-slack,
        // fixed-off schedule. Keep the deliberately small fresh contract;
        // the normal teacher-session policy can turn a hard-valid partial
        // incumbent into a 180-second all-or-nothing failure.
        return next;
      }
      const mode = String(next.solver_mode || "auto").toLowerCase();
      const teacherSessionOpt = isTeacherSessionOptSettings(next);
      const search = String(next.search_teacher_sessions ?? "1").toLowerCase() !== "false" && String(next.search_teacher_sessions ?? "1") !== "0";
      const cap = Number(next.max_teacher_sessions || 0);
      if(mode === "auto"){
        if(next.minimize_sessions == null) next.minimize_sessions = true;
        if(next.allow_one_period_gaps == null) next.allow_one_period_gaps = true;
        next.minimize_one_period_sessions = true;
        next.max_one_period_sessions = 0;
        next.minimize_teacher_gaps = true;
        next.period_max_teacher_gap = 1;
        next.require_complete_schedule = true;
        next.overall_time_limit_seconds = normalizeOverallTimeLimit(next.overall_time_limit_seconds ?? DEFAULT_SETTINGS.overall_time_limit_seconds);
        next.best_effort_on_timeout = true;
        next.preserve_existing_min_ratio = preserveExistingMinRatio(next);
        if(next.aggressive_fast_mode == null) next.aggressive_fast_mode = true;
        next.deep_session_rescue = isFalseSetting(next.aggressive_fast_mode) ? !!next.deep_session_rescue : false;
        next.num_workers = hardwareWorkerCount();
        normalizeSolveTimeLimits(next, data);
      }
      if(mode === "auto" && search && hasActiveConstraintData(data)){
        next.requested_max_teacher_sessions = Number.isFinite(cap) && cap > 0 ? Math.round(cap) : DEFAULT_SETTINGS.max_teacher_sessions;
        if(!Number.isFinite(cap) || cap <= 0) next.max_teacher_sessions = DEFAULT_SETTINGS.max_teacher_sessions;
      }
      if(teacherSessionOpt){
        const zeroOneRetry = next.zero_one_quality_retry === true;
        const randomizedFresh = zeroOneRetry || next.ui_no_hint_randomized_solve === true;
        const useExistingIncumbent = next.ui_use_existing_complete_incumbent === true;
        const incrementalRefine = useExistingIncumbent
          && String(next.ui_unified_solve_kind || "").trim().toLowerCase() === "refine_complete";
        const randomizedExistingRefine = incrementalRefine
          && next.ui_randomized_incumbent_refinement === true;
        const target = positiveNumberSetting(next.target_teacher_sessions);
        const gapTarget = nonnegativeNumberSetting(next.target_gap1_sessions);
        const startCap = positiveNumberSetting(next.optimization_start_teacher_sessions || next.max_teacher_sessions);
        const optLimit = Math.max(
          incrementalRefine ? 30 : 60,
          Math.round(Number(next.optimization_time_limit_seconds || DEFAULT_SETTINGS.optimization_time_limit_seconds))
        );
        next.auto_sort_mode = "teacher_session_opt";
        if(target > 0){
          next.target_teacher_sessions = target;
          next.max_teacher_sessions = target;
          next.requested_max_teacher_sessions = target;
        }else{
          delete next.target_teacher_sessions;
          delete next.max_teacher_sessions;
          delete next.requested_max_teacher_sessions;
        }
        if(gapTarget != null) next.target_gap1_sessions = gapTarget;
        else delete next.target_gap1_sessions;
        if(startCap > 0) next.optimization_start_teacher_sessions = startCap;
        else delete next.optimization_start_teacher_sessions;
        next.optimization_time_limit_seconds = optLimit;
        next.optimization_session_time_limit = Math.max(60, Math.round(Number(next.optimization_session_time_limit || DEFAULT_SETTINGS.optimization_session_time_limit)));
        next.optimization_period_retry_time_limit = Math.max(30, Math.round(Number(next.optimization_period_retry_time_limit || DEFAULT_SETTINGS.optimization_period_retry_time_limit)));
        next.overall_time_limit_seconds = optLimit;
        next.minimize_sessions = true;
        next.allow_one_period_gaps = true;
        next.minimize_one_period_sessions = true;
        next.max_one_period_sessions = 0;
        next.one_period_priority_absolute = true;
        next.minimize_teacher_gaps = true;
        next.period_max_teacher_gap = 1;
        next.best_effort_on_timeout = true;
        next.relax_period_teacher_gap_on_failure = false;
        next.aggressive_fast_mode = false;
        next.optimization_direct_first = false;
        next.deep_session_rescue = true;
        next.preserve_existing_tkb = useExistingIncumbent;
        next.preserve_fixed_lessons_only = useExistingIncumbent || next.preserve_fixed_lessons_only === true;
        next.auto_sort_strategy = useExistingIncumbent
          ? "continue_teacher_quality_from_incumbent"
          : (zeroOneRetry ? "fresh_zero_one_quality_retry" : "fresh_teacher_session_opt");
        next.fresh_randomize = useExistingIncumbent && !randomizedExistingRefine
          ? false
          : randomizedFresh || randomizedExistingRefine;
        next.randomize_search = useExistingIncumbent && !randomizedExistingRefine
          ? false
          : randomizedFresh || randomizedExistingRefine;
        next.session_time_limit = Math.max(60, Math.round(Number(next.session_time_limit || 0) || 0));
        next.period_time_limit = Math.max(90, Math.round(Number(next.period_time_limit || 0) || 0));
        next.period_fast_time_limit = next.period_time_limit;
        next.period_retry_time_limit = Math.max(next.period_time_limit, Math.round(Number(next.period_retry_time_limit || 0) || 0));
        next.integrated_time_limit = Math.max(optLimit, Math.round(Number(next.integrated_time_limit || 0) || 0));
        next.progress_estimate_seconds = optLimit;
        if(randomizedExistingRefine){
          if(next.random_seed == null || next.random_seed === "") next.random_seed = makeRandomSeed();
          next.quality_variant_seed = next.random_seed;
        }else if(randomizedFresh && !useExistingIncumbent){
          if(next.random_seed == null || next.random_seed === "") next.random_seed = makeRandomSeed();
        }else{
          delete next.random_seed;
        }
      }
      if(!teacherSessionOpt && (
        String(next.auto_sort_strategy || "").startsWith("fresh_fast_quality")
        || String(next.auto_sort_strategy || "").startsWith("fresh_speed_first")
      )){
        const expected = expectedLessonCount(data);
        const fastQuality = String(next.auto_sort_strategy || "").startsWith("fresh_fast_quality");
        const presetManagedFast = !fastQuality
          && next.ui_solver_preset === "fast"
          && String(next.auto_sort_strategy || "").startsWith("fresh_speed_first")
          && !isInternalIncompleteSolve(next);
        const budgets = fastQuality ? constraintAwareFastQualityBudgets(expected, data) : speedFirstBudgets(expected);
        const preservePortfolioCap = next.teacher_session_fast_portfolio === true
          || next.ui_compact_first_pass === true;
        const requestedFastCap = positiveNumberSetting(next.max_teacher_sessions);
        const startCap = preservePortfolioCap && requestedFastCap > 0
          ? requestedFastCap
          : Math.max(
              positiveNumberSetting(adaptiveTeacherSessionSpeedCap(data)),
              requestedFastCap,
              positiveNumberSetting(adaptiveTeacherSessionFastCap(data)),
              positiveNumberSetting(adaptiveTeacherSessionStartCap(data))
            );
        next.auto_sort_mode = "fast";
        next.solver_mode = "auto";
        if(startCap > 0){
          next.max_teacher_sessions = startCap;
          next.requested_max_teacher_sessions = startCap;
        }
        next.exact_teacher_sessions = false;
        next.search_teacher_sessions = true;
        next.minimize_sessions = true;
        next.allow_one_period_gaps = true;
        next.minimize_one_period_sessions = true;
        next.max_one_period_sessions = 0;
        next.one_period_priority_absolute = true;
        next.minimize_teacher_gaps = true;
        next.period_max_teacher_gap = 1;
        next.require_complete_schedule = true;
        next.best_effort_on_timeout = true;
        next.allow_backend_cache = false;
        next.force_fresh_backend_solve = true;
        next.disable_native_hint_solver = true;
        next.disable_solver_hints = true;
        next.allow_solver_warm_start = false;
        next.native_hint_bank_max_entries = 0;
        next.native_hint_bank_time_limit_ms = 50;
        const fixedPressure = hasFixedOffPressure(data);
        const useQualityFirstSessionBudget = fastQuality && fixedPressure && expected >= 900;
        if(!presetManagedFast){
          next.native_fresh_time_limit_ms = fixedPressure
            ? Math.max(120000, Math.round((budgets.overall || 150) * 1000 * 0.75))
            : Math.min(30000, Math.max(18000, Math.round((budgets.overall || 30) * 1000 * 0.32)));
          if(fixedPressure){
            next.native_fresh_cleanup_time_limit_ms = Math.max(
              42000,
              Number(next.native_fresh_cleanup_time_limit_ms || 0) || 0
            );
          }
        }
        next.native_fresh_attempts = 80;
        next.native_fresh_max_iters = 120000;
        next.fast_repair_period_hint = false;
        next.fast_validated_period_hint = false;
        next.disable_period_feasibility_bridge = false;
        next.speed_first_complete = useQualityFirstSessionBudget ? false : true;
        next.period_retry_session_time_limit = budgets.retrySession || budgets.session;
        next.one_period_zero_probe_time_limit = fastQuality ? budgets.probe : 3;
        next.one_period_gap0_probe_time_limit = fastQuality ? budgets.probe : 3;
        next.session_priority_rescue_time_limit = fastQuality ? budgets.probe : 3;
        next.session_priority_period_time_limit = fastQuality ? Math.min(8, budgets.probe) : 4;
        next.local_one_period_cleanup_time_limit = fastQuality ? budgets.cleanup : 1;
        next.one_period_cluster_repair_time_limit = fastQuality ? budgets.cleanup : 1;
        next.allow_teacher_session_deep_retry = fastQuality ? true : next.allow_teacher_session_deep_retry;
        next.allow_teacher_session_fast_portfolio = fastQuality ? true : next.allow_teacher_session_fast_portfolio;
        next.fast_quality_retry_time_limit_seconds = fastQuality ? budgets.qualityRetry : next.fast_quality_retry_time_limit_seconds;
        next.relax_period_teacher_gap_on_failure = false;
        next.aggressive_fast_mode = false;
        next.deep_session_rescue = false;
        next.preserve_existing_tkb = false;
        next.fresh_randomize = true;
        next.randomize_search = true;
        if(!preservePortfolioCap || next.random_seed == null || next.random_seed === ""){
          next.random_seed = makeRandomSeed();
        }
        if(useQualityFirstSessionBudget){
          next.auto_sort_strategy = "fresh_fast_quality_session_quality_budget";
          next.allow_teacher_session_deep_retry = false;
          next.allow_teacher_session_fast_portfolio = true;
          next.allow_quality_debt = false;
          const qualityTargets = practicalTeacherQualityTargets(data);
          if(qualityTargets.teacherTarget > 0){
            next.target_teacher_sessions = qualityTargets.teacherTarget;
            next.optimization_accept_teacher_sessions = qualityTargets.teacherTarget;
            next.max_teacher_sessions = preservePortfolioCap
              ? startCap
              : Math.max(
                  positiveNumberSetting(next.max_teacher_sessions),
                  positiveNumberSetting(qualityTargets.speedTeacherCap),
                  startCap
                );
            next.requested_max_teacher_sessions = next.max_teacher_sessions;
            next.teacher_session_target_explicit = true;
          }else{
            delete next.target_teacher_sessions;
            delete next.optimization_accept_teacher_sessions;
            next.teacher_session_target_explicit = false;
          }
          if(qualityTargets.gap1Target != null){
            next.target_gap1_sessions = qualityTargets.gap1Target;
            next.optimization_accept_gap1_sessions = qualityTargets.gap1Target;
            next.optimization_default_accept_gap1_sessions = qualityTargets.gap1Target;
            next.gap1_quality_target_explicit = true;
          }else{
            delete next.target_gap1_sessions;
            delete next.optimization_accept_gap1_sessions;
            delete next.optimization_default_accept_gap1_sessions;
            next.gap1_quality_target_explicit = false;
          }
        }
        if(!presetManagedFast){
          next.session_time_limit = budgets.session;
          next.period_time_limit = budgets.period;
          next.period_fast_time_limit = budgets.period;
          next.period_retry_time_limit = next.period_time_limit;
          next.integrated_time_limit = budgets.overall;
          next.overall_time_limit_seconds = budgets.overall;
          next.progress_estimate_seconds = Math.min(90, next.overall_time_limit_seconds);
          applyCompactFirstTimeBudget(next, expected);
        }
      }
      if(!teacherSessionOpt){
        applyPartialExistingRepairSettings(next, data, "few_unassigned_effective_settings");
      }
      if(next.require_complete_schedule === true){
        next.best_effort_on_timeout = true;
      }
      if(isNoHintSmartFreshSettings(next)){
        enforceNoHintFreshSolveSettings(next);
      }
      const effective = applySolverPresetQualityPolicy(next);
      if(effective.ui_unified_auto_sort === true){
        const unifiedKind = String(effective.ui_unified_solve_kind || "").trim().toLowerCase();
        const stagedExistingCeiling = effective.ui_staged_existing_repair === true;
        const requestedProgressEstimate = Number(
          effective.ui_incremental_progress_estimate_seconds
            || effective.progress_estimate_seconds
            || 0
        ) || 0;
        const boundedFreshFallback = effective.ui_constraint_change_fresh_retry === true;
        const requestedCeiling = boundedFreshFallback
          ? Number(effective.ui_constraint_change_fresh_ceiling_seconds || INITIAL_AUTO_DURATION_SECONDS)
          : stagedExistingCeiling
           ? Number(effective.ui_staged_existing_ceiling_seconds || effective.overall_time_limit_seconds || 0)
          : (unifiedKind === "repair_partial"
              ? Number(effective.ui_unified_repair_ceiling_seconds || 0)
              : (unifiedKind === "refine_complete"
                  ? Number(effective.ui_unified_refine_ceiling_seconds || 0)
              : (unifiedKind === "fresh_complete_first"
                  && Number(effective.ui_unified_initial_ceiling_seconds || 0) > 0
                    ? Number(effective.ui_unified_initial_ceiling_seconds || 0)
                    : automaticSolverCeilingSeconds(expectedLessonCount(data), data))));
        const unifiedCeiling = Math.max(stagedExistingCeiling ? 1 : 10, Math.round(requestedCeiling || 0));
        const capSeconds = key => {
          const current = Number(effective[key] || 0) || unifiedCeiling;
          effective[key] = Math.max(1, Math.min(unifiedCeiling, current));
        };
        effective.overall_time_limit_seconds = unifiedCeiling;
        effective.integrated_time_limit = unifiedCeiling;
        effective.optimization_time_limit_seconds = unifiedCeiling;
        effective.optimization_adaptive_time_limit_seconds = unifiedCeiling;
        [
          "optimization_session_time_limit",
          "optimization_period_retry_time_limit",
          "session_time_limit",
          "period_time_limit",
          "period_fast_time_limit",
          "period_retry_time_limit",
          "fast_quality_retry_time_limit_seconds"
        ].forEach(capSeconds);
        effective.backend_deadline_ms = unifiedCeiling * 1000;
        effective.native_global_deadline_ms = unifiedCeiling * 1000;
        effective.progress_estimate_seconds = unifiedCeiling;
        effective.ui_allow_short_backend_deadline = boundedFreshFallback
          || effective.ui_allow_short_backend_deadline === true
          || stagedExistingCeiling
          || effective.ui_unified_partial_repair === true;
        if(effective.ui_incremental_refine_progress === true){
          effective.progress_estimate_seconds = Math.max(
            30,
            Math.min(unifiedCeiling, requestedProgressEstimate || unifiedCeiling)
          );
        }
      }
      if(effective.ui_unified_partial_repair === true){
        const repairCeiling = Math.max(
          10,
          Math.round(Number(effective.ui_unified_repair_ceiling_seconds || 0) || 0)
        );
        if(repairCeiling > 0){
          effective.overall_time_limit_seconds = repairCeiling;
          effective.integrated_time_limit = repairCeiling;
          effective.optimization_time_limit_seconds = repairCeiling;
          effective.optimization_adaptive_time_limit_seconds = repairCeiling;
          effective.session_time_limit = Math.min(repairCeiling, Math.max(1, Number(effective.session_time_limit || repairCeiling)));
          effective.period_time_limit = Math.min(repairCeiling, Math.max(1, Number(effective.period_time_limit || repairCeiling)));
          effective.period_fast_time_limit = Math.min(effective.period_time_limit, Math.max(1, Number(effective.period_fast_time_limit || effective.period_time_limit)));
          effective.period_retry_time_limit = Math.min(effective.period_time_limit, Math.max(1, Number(effective.period_retry_time_limit || effective.period_time_limit)));
          effective.backend_deadline_ms = repairCeiling * 1000;
          effective.native_global_deadline_ms = repairCeiling * 1000;
          effective.progress_estimate_seconds = repairCeiling;
        }
      }
      applyCustomSolveDurationSettings(effective);
      applyFocusedOptimizationCeiling(effective);
      if(teacherSessionOpt) effective.ui_keep_better_existing_on_resort = true;
      return effective;
    }

    function shouldAutoConfirmForE2E(){
      try{
        const params = new URLSearchParams(window.location.search || "");
        if(params.get("e2e") === "1") return true;
      }catch(_){}
      try{
        return sessionStorage.getItem("TKB_E2E_AUTO_CONFIRM") === "1";
      }catch(_){
        return false;
      }
    }

    function shouldSuppressSolverAlertForAutomation(){
      try{
        if(window.__TKB_SUPPRESS_SOLVER_ALERTS === true) return true;
      }catch(_){}
      try{
        return sessionStorage.getItem("TKB_E2E_AUTO_CONFIRM") === "1";
      }catch(_){
        return false;
      }
    }

  function saveSettings(settings){
    try{
      localStorage.setItem("TKB_NEW_SOLVER_SETTINGS", JSON.stringify(settings));
    }catch(_){}
  }

  function promptSettings(){
    const current = readSettings();
    const raw = window.prompt(
      "Thiết lập xếp lịch: số buổi giáo viên tối đa, thời gian tìm buổi, thời gian xếp tiết",
      `${current.max_teacher_sessions}, ${current.session_time_limit}, ${current.period_time_limit}`
    );
    if(raw === null) return null;
    const parts = String(raw).split(",").map(x => Number(String(x).trim()));
      const next = {
        max_teacher_sessions: Number.isFinite(parts[0]) && parts[0] > 0 ? Math.round(parts[0]) : DEFAULT_SETTINGS.max_teacher_sessions,
        teacher_session_target_explicit: Number.isFinite(parts[0]) && parts[0] > 0,
        session_time_limit: Number.isFinite(parts[1]) && parts[1] > 0 ? Math.round(parts[1]) : DEFAULT_SETTINGS.session_time_limit,
        period_time_limit: Number.isFinite(parts[2]) && parts[2] > 0 ? Math.round(parts[2]) : DEFAULT_SETTINGS.period_time_limit,
        integrated_time_limit: DEFAULT_SETTINGS.integrated_time_limit,
        solver_mode: DEFAULT_SETTINGS.solver_mode,
        exact_teacher_sessions: DEFAULT_SETTINGS.exact_teacher_sessions,
        search_teacher_sessions: true,
        minimize_sessions: true,
        allow_one_period_gaps: true,
        minimize_one_period_sessions: true,
        max_one_period_sessions: 0,
        one_period_priority_absolute: true,
        minimize_teacher_gaps: true,
        period_max_teacher_gap: 1,
        require_complete_schedule: true,
        aggressive_fast_mode: true,
        overall_time_limit_seconds: DEFAULT_SETTINGS.overall_time_limit_seconds,
        best_effort_on_timeout: false,
        deep_session_rescue: false,
        period_fast_time_limit: DEFAULT_SETTINGS.period_fast_time_limit,
        period_retry_time_limit: DEFAULT_SETTINGS.period_retry_time_limit,
        num_workers: hardwareWorkerCount()
      };
    saveSettings(next);
    return next;
  }

  function makeEmptyTKB(){
    const days = Array.isArray(window.DAYS) ? window.DAYS : ["thu2","thu3","thu4","thu5","thu6","thu7"];
    const sang = Number(window.SANG || 5) || 5;
    const chieu = Number(window.CHIEU || 5) || 5;
    const out = {};
    days.forEach(day => {
      out[day] = {
        sang: Array.from({length: sang}, () => ""),
        chieu: Array.from({length: chieu}, () => "")
      };
    });
    return out;
  }

  function dayKey(day){
    const raw = String(day || "").trim().toLowerCase();
    if(/^thu[2-7]$/.test(raw)) return raw;
    const n = Number(day);
    return Number.isFinite(n) ? `thu${n}` : "";
  }

  function sessionKey(session){
    const raw = String(session || "").trim().toLowerCase();
    if(raw === "am" || raw === "sang" || raw === "morning") return "sang";
    if(raw === "pm" || raw === "chieu" || raw === "afternoon") return "chieu";
    return raw === "sáng" ? "sang" : (raw === "chiều" ? "chieu" : "");
  }

  function cellSubjectText(value){
    try{
      if(typeof cellMon === "function"){
        const text = String(cellMon(value) || "").trim();
        if(text) return text;
      }
    }catch(_){}
    try{
      if(window && typeof window.cellMon === "function"){
        const text = String(window.cellMon(value) || "").trim();
        if(text) return text;
      }
    }catch(_){}
    if(value && typeof value === "object"){
      return String(value.mon || value.subject || value.text || "").trim();
    }
    return String(value == null ? "" : value).trim();
  }

  function isScheduledCell(value){
    const text = cellSubjectText(value);
    return !!text && text !== "OFF";
  }

  function isFixedScheduledCell(value){
    return !!(value && typeof value === "object" && value.fixed);
  }

  function countScheduledLessons(data, options){
    const flexibleOnly = options && options.flexibleOnly === true;
    const sessionFilter = options && options.session ? sessionKey(options.session) : "";
    const memo = activeAutoSortPlanningMemo(data);
    const memoKey = `${flexibleOnly ? "flexible" : "all"}|${sessionFilter || "*"}`;
    if(memo?.scheduledLessonCounts?.has(memoKey)){
      return memo.scheduledLessonCounts.get(memoKey);
    }
    let count = 0;
    Object.values(data?.tkb || {}).forEach(tkb => {
      ["thu2","thu3","thu4","thu5","thu6","thu7"].forEach(thu => {
        ["sang","chieu"].forEach(buoi => {
          if(sessionFilter && buoi !== sessionFilter) return;
          (tkb?.[thu]?.[buoi] || []).forEach(value => {
            if(isScheduledCell(value) && (!flexibleOnly || !isFixedScheduledCell(value))) count += 1;
          });
        });
      });
    });
    if(memo){
      if(!memo.scheduledLessonCounts) memo.scheduledLessonCounts = new Map();
      memo.scheduledLessonCounts.set(memoKey, count);
    }
    return count;
  }

  function activeStudentSessionCount(data){
    let count = 0;
    Object.values(data?.tkb || {}).forEach(tkb => {
      ["thu2","thu3","thu4","thu5","thu6","thu7"].forEach(thu => {
        ["sang","chieu"].forEach(buoi => {
          if((tkb?.[thu]?.[buoi] || []).some(isScheduledCell)) count += 1;
        });
      });
    });
    return count;
  }

  function countSessionScheduledInPayload(payload){
    let am = 0;
    let pm = 0;
    const lessons = Array.isArray(payload?.lessons) ? payload.lessons : [];
    lessons.forEach(lesson => {
      const session = String(lesson?.session || "").toUpperCase();
      if(session === "PM") pm += 1;
      else am += 1;
    });
    return {am, pm};
  }

  function needsAfternoonFillPass(payload, data){
    const completion = payloadCompletion(payload);
    if(completion.complete || completion.unassigned <= 0 || !payloadHasUsableSchedule(payload)) return false;
    const fromPayload = countSessionScheduledInPayload(payload);
    const sang = Math.max(fromPayload.am, countScheduledLessons(data, {session: "AM"}));
    const chieu = Math.max(fromPayload.pm, countScheduledLessons(data, {session: "PM"}));
    if(sang < 8) return false;
    if(chieu <= 0) return true;
    return chieu < sang * 0.4 && completion.unassigned >= Math.max(20, Math.round(sang * 0.35));
  }

  function afternoonFillRetrySettings(baseSettings, data, runId){
    const next = Object.assign({}, baseSettings || {});
    const scheduled = countScheduledLessons(data);
    const overall = Math.max(
      90,
      Math.min(
        210,
        Math.round((Number(next.overall_time_limit_seconds || next.optimization_time_limit_seconds || 120) || 120) * 0.65)
      )
    );
    next.auto_sort_mode = "fast";
    next.auto_sort_strategy = "afternoon_fill_pass";
    next.solver_mode = "auto";
    next.optimize_existing_schedule = true;
    next.existing_fill_missing_schedule = true;
    next.preserve_existing_tkb = true;
    next.force_preserve_partial_existing = true;
    next.preserve_existing_min_ratio = Math.min(0.95, scheduled > 0 ? 0.15 : 0.1);
    next.best_effort_on_timeout = true;
    next.ui_allow_best_effort_on_timeout = true;
    next.require_complete_schedule = true;
    next.robust_retry = false;
    next.complete_schedule_seed_retry = false;
    next.overall_time_limit_seconds = overall;
    next.integrated_time_limit = overall;
    next.optimization_time_limit_seconds = overall;
    next.backend_deadline_ms = overall * 1000;
    next.ui_allow_short_backend_deadline = false;
    next.progress_estimate_seconds = overall;
    next.ui_afternoon_fill_pass = true;
    next.existing_scheduled_periods = scheduled;
    next.existing_flexible_scheduled_periods = countScheduledLessons(data, {flexibleOnly: true});
    next.expected_scheduled_periods = expectedLessonCount(data);
    next.solve_run_id = `${runId || makeSolveRunId()}-afternoon-fill-${Date.now()}`;
    return next;
  }

  function countFixedScheduledLessons(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo && Number.isFinite(memo.fixedScheduledLessonCount)) return memo.fixedScheduledLessonCount;
    let count = 0;
    Object.values(data?.tkb || {}).forEach(tkb => {
      ["thu2","thu3","thu4","thu5","thu6","thu7"].forEach(thu => {
        ["sang","chieu"].forEach(buoi => {
          (tkb?.[thu]?.[buoi] || []).forEach(value => {
            if(isScheduledCell(value) && isFixedScheduledCell(value)) count += 1;
          });
        });
      });
    });
    if(memo) memo.fixedScheduledLessonCount = count;
    return count;
  }

  function hasHardFixedLessons(data){
    return countFixedScheduledLessons(data) > 0;
  }

  function fixedLessonLockKey(classId, thu, buoi, ti){
    return `${String(classId || "")}|${String(thu || "")}|${String(buoi || "")}|${Number(ti)}`;
  }

  function fixedLessonCanonicalSubjectKey(subject){
    const aliases = new Set();
    try{ addSubjectAliases(aliases, subject); }catch(_){}
    try{
      const data = getData();
      const wanted = new Set(Array.from(aliases));
      wanted.add(subjectKey(subject));
      subjectAliasGroups(data).forEach(group => {
        const keys = group.map(subjectKey).filter(Boolean);
        if(keys.some(key => wanted.has(key))){
          keys.forEach(key => aliases.add(key));
        }
      });
    }catch(_){}
    const keys = Array.from(aliases).filter(Boolean).sort();
    return keys[0] || subjectKey(subject);
  }

  function collectFixedLessonLocks(data){
    const locks = new Map();
    Object.entries(data?.tkb || {}).forEach(([classId, tkb]) => {
      ["thu2","thu3","thu4","thu5","thu6","thu7"].forEach(thu => {
        ["sang","chieu"].forEach(buoi => {
          (tkb?.[thu]?.[buoi] || []).forEach((value, ti) => {
            if(!isScheduledCell(value) || !isFixedScheduledCell(value)) return;
            const subject = cellSubjectText(value);
            locks.set(fixedLessonLockKey(classId, thu, buoi, ti), {
              subject,
              key: fixedLessonCanonicalSubjectKey(subject)
            });
          });
        });
      });
    });
    return locks;
  }

  function fixedLessonLockSubject(lock, fallback){
    if(lock && typeof lock === "object"){
      return String(lock.subject || fallback || "").trim();
    }
    return String(fallback || lock || "").trim();
  }

  function fixedLessonLockSubjectKey(lock, fallback){
    if(lock && typeof lock === "object" && lock.key) return String(lock.key || "");
    return fixedLessonCanonicalSubjectKey(fixedLessonLockSubject(lock, fallback));
  }

  function fixedLessonLockMatches(lock, subject){
    const wanted = fixedLessonLockSubjectKey(lock);
    const actual = fixedLessonCanonicalSubjectKey(subject);
    return !!wanted && !!actual && wanted === actual;
  }

  function applyFixedLessonLocks(nextTkb, locks){
    (locks || new Map()).forEach((lock, key) => {
      const parts = String(key || "").split("|");
      if(parts.length !== 4) return;
      const [classId, thu, buoi, tiRaw] = parts;
      const ti = Number(tiRaw);
      const subject = fixedLessonLockSubject(lock);
      if(!classId || !subject || !Number.isFinite(ti)) return;
      if(!nextTkb[classId]) nextTkb[classId] = makeEmptyTKB();
      const arr = nextTkb[classId]?.[thu]?.[buoi];
      if(arr && ti >= 0 && ti < arr.length){
        arr[ti] = {mon: subject, fixed: true};
      }
    });
  }

  function gradeToken(value){
    const raw = String(value == null ? "" : value).trim();
    if(!raw) return "";
    const match = raw.match(/\d+/);
    if(match) return String(Number(match[0]));
    try{
      return raw.normalize("NFC").toLowerCase().replace(/\s+/g, " ");
    }catch(_){
      return raw.toLowerCase();
    }
  }

  function subjectAliasGroups(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo?.subjectAliasGroups) return memo.subjectAliasGroups;
    const groups = [];
    const addGroup = values => {
      const aliases = Array.from(new Set((values || [])
        .map(value => String(value == null ? "" : value).trim())
        .filter(Boolean)));
      if(aliases.length) groups.push(aliases);
      return aliases;
    };
    (data?.monhoc || []).forEach(item => {
      addGroup([item?.ten, item?.mon, item?.mamon, item?.ma, item?.ma2, item?.id, item?.key]);
    });
    if(memo) memo.subjectAliasGroups = groups;
    return groups;
  }

  function expandSubjectAliases(data, values){
    const memo = activeAutoSortPlanningMemo(data);
    const memoKey = (values || [])
      .map(value => String(value == null ? "" : value).trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "vi"))
      .join("\u0001");
    if(memo && memo.aliasesByKey.has(memoKey)) return memo.aliasesByKey.get(memoKey).slice();
    const aliases = new Set((values || [])
      .map(value => String(value == null ? "" : value).trim())
      .filter(Boolean));
    const keys = new Set(Array.from(aliases).map(subjectKey));
    subjectAliasGroups(data).forEach(group => {
      if(group.some(item => keys.has(subjectKey(item)))){
        group.forEach(item => aliases.add(item));
      }
    });
    const result = Array.from(aliases);
    if(memo) memo.aliasesByKey.set(memoKey, result);
    return result.slice();
  }

  function periodLookupByGradeSubject(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo?.periodLookupByGradeSubject) return memo.periodLookupByGradeSubject;
    const periods = new Map();
    const add = (grade, alias, count) => {
      const n = Number(count);
      const g = gradeToken(grade);
      const a = subjectKey(alias);
      if(!g || !a || !Number.isFinite(n) || n <= 0) return;
      periods.set(`${g}|${a}`, Math.round(n));
    };
    (data?.mon || []).forEach(item => {
      const aliases = expandSubjectAliases(data, [
        item?.ten, item?.mon, item?.mamon, item?.ma, item?.ma2, item?.id, item?.key
      ]);
      aliases.forEach(alias => add(item?.khoi || item?.grade || item?.lop || "", alias, item?.sotiet ?? item?.soTiet ?? item?.periods));
    });
    if(memo) memo.periodLookupByGradeSubject = periods;
    return periods;
  }

  function classGradeLookup(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo?.classGradeLookup) return memo.classGradeLookup;
    const classes = new Map();
    const add = (id, grade) => {
      const key = String(id == null ? "" : id).trim();
      if(!key || classes.has(key)) return;
      classes.set(key, gradeToken(grade));
    };
    (data?.lop || []).forEach(item => {
      const grade = item?.khoi || item?.grade || item?.khoiLop || "";
      [item?.id, item?.ten, item?.ten2, item?.ma, item?.name].forEach(alias => add(alias, grade));
    });
    if(memo) memo.classGradeLookup = classes;
    return classes;
  }

  function fallbackUiSubjectPeriods(data, classId, subject){
    try{
      if(typeof computeMonsForClass !== "function") return 0;
      const cls = (data?.lop || []).find(item => {
        const aliases = [item?.id, item?.ten, item?.ten2, item?.ma, item?.name].map(x => String(x || "").trim());
        return aliases.includes(String(classId || "").trim());
      });
      const khoiNum = typeof extractKhoiNumber === "function"
        ? (extractKhoiNumber(cls?.khoi) || extractKhoiNumber(cls?.ten2) || extractKhoiNumber(cls?.ten) || "")
        : gradeToken(cls?.khoi);
      const canon = typeof getLopCanonById === "function"
        ? getLopCanonById(cls?.id || classId)
        : String(cls?.ten2 || cls?.ten || cls?.id || classId || "").trim();
      const rows = computeMonsForClass(khoiNum, canon) || [];
      const wanted = new Set(expandSubjectAliases(data, [subject]).map(subjectKey));
      const found = rows.find(item => expandSubjectAliases(data, [item?.ten, item?.mon, item?.ma, item?.ma2, item?.id])
        .some(alias => wanted.has(subjectKey(alias))));
      const n = Number(found?.sotiet ?? found?.soTiet ?? found?.periods ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }catch(_){
      return 0;
    }
  }

  function expectedLessonCount(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo && Number.isFinite(memo.expected) && memo.expected >= 0) return memo.expected;
    try{
      const expected = expectedLessonCountUncached(data);
      if(memo) memo.expected = expected;
      return expected;
    }catch(_){
      return 0;
    }
  }

  function expectedLessonCountUncached(data){
    try{
      const classes = classGradeLookup(data);
      const periods = periodLookupByGradeSubject(data);
      let total = 0;
      Object.keys(data?.pccmMatrix || {}).forEach(rawKey => {
        // A period override is only scheduling demand after the subject has an
        // assigned teacher.  Legacy/imported data can retain a PCCM key whose
        // value is blank; the Python adapter intentionally skips that row.
        // Keep the UI completion contract aligned so a complete backend
        // result is not rejected as "scheduled < expected" after apply.
        if(rescueTeacherList(data?.pccmMatrix?.[rawKey]).length === 0) return;
        const parts = String(rawKey).split("|");
        const classId = String(parts.shift() || "").trim();
        const subject = String(parts.join("|") || "").trim();
        if(!classId || !subject) return;
        const direct = Number(data?.pccmTietMatrix?.[rawKey] ?? data?.pccmTietMatrix?.[`${classId}|${subject}`] ?? 0);
        if(Number.isFinite(direct) && direct > 0){
          total += Math.round(direct);
          return;
        }
        const grade = classes.get(classId) || "";
        const aliases = expandSubjectAliases(data, [subject]);
        let count = 0;
        for(const alias of aliases){
          count = periods.get(`${grade}|${subjectKey(alias)}`) || 0;
          if(count > 0) break;
        }
        if(count <= 0) count = fallbackUiSubjectPeriods(data, classId, subject);
        total += count;
      });
      return total;
    }catch(_){
      return 0;
    }
  }

  function adaptiveTeacherSessionStartCap(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo && Number.isFinite(memo.teacherSessionStartCap)) return memo.teacherSessionStartCap;
    const expected = expectedLessonCount(data);
    if(!Number.isFinite(expected) || expected <= 0){
      if(memo) memo.teacherSessionStartCap = 0;
      return 0;
    }
    const teachers = new Set();
    Object.values(data?.pccmMatrix || {}).forEach(value => {
      String(value || "")
        .replace(/\r?\n/g, ",")
        .replace(/[;+]+/g, ",")
        .split(",")
        .map(x => x.trim())
        .filter(Boolean)
        .forEach(name => teachers.add(name.toLowerCase()));
    });
    const teacherFloor = teachers.size > 0 ? Math.ceil(teachers.size * 1.5) : 0;
    const result = Math.max(teacherFloor, teacherSessionLoadLowerCap(data), Math.ceil((expected * 10) / 34));
    if(memo) memo.teacherSessionStartCap = result;
    return result;
  }

  function adaptiveTeacherSessionFastCap(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo && Number.isFinite(memo.teacherSessionFastCap)) return memo.teacherSessionFastCap;
    const startCap = positiveNumberSetting(adaptiveTeacherSessionStartCap(data));
    if(startCap <= 0){
      if(memo) memo.teacherSessionFastCap = 0;
      return 0;
    }
    const expected = expectedLessonCount(data);
    const margin = expected >= 600 ? 5 : (expected >= 300 ? 4 : 2);
    const result = startCap + margin;
    if(memo) memo.teacherSessionFastCap = result;
    return result;
  }

  function adaptiveTeacherSessionSpeedCap(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo && Number.isFinite(memo.teacherSessionSpeedCap)) return memo.teacherSessionSpeedCap;
    const startCap = positiveNumberSetting(adaptiveTeacherSessionStartCap(data));
    const expected = expectedLessonCount(data);
    if(startCap <= 0 && (!Number.isFinite(expected) || expected <= 0)){
      if(memo) memo.teacherSessionSpeedCap = 0;
      return 0;
    }
    const looseBySize = Number.isFinite(expected) && expected > 0 ? Math.ceil(expected * 0.4) : 0;
    const floor = expected >= 600 ? 260 : (expected >= 300 ? 160 : 0);
    const result = Math.max(startCap, looseBySize, floor);
    if(memo) memo.teacherSessionSpeedCap = result;
    return result;
  }

  function practicalTeacherQualityTargets(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo?.practicalTeacherQualityTargets){
      return Object.assign({}, memo.practicalTeacherQualityTargets);
    }
    const expected = expectedLessonCount(data);
    if(!Number.isFinite(expected) || expected <= 0){
      const empty = {teacherTarget:0, speedTeacherCap:0, gap1Target:null};
      if(memo) memo.practicalTeacherQualityTargets = empty;
      return Object.assign({}, empty);
    }
    const fixedPressure = hasFixedOffPressure(data);
    const constrained = hasActiveConstraintData(data);
    const startCap = positiveNumberSetting(adaptiveTeacherSessionStartCap(data));
    const densityDivisor = expected >= 900 ? 3.25 : (expected >= 600 ? 3.15 : 3.0);
    const densityTarget = Math.ceil(expected / densityDivisor);
    const compactMargin = expected >= 900 ? 5 : (expected >= 600 ? 4 : 2);
    const compactTarget = startCap > 0 ? startCap + compactMargin : densityTarget;
    // Phase F still builds a looser guaranteed-feasible timetable.  This is a
    // quality target for phase Q, so keep it close to the load lower bound
    // instead of stopping at the old density heuristic.
    const teacherTarget = startCap > 0
      ? Math.max(startCap, Math.min(densityTarget, compactTarget))
      : densityTarget;
    const speedTeacherCap = Math.max(
      teacherTarget + (expected >= 900 ? 32 : 24),
      positiveNumberSetting(adaptiveTeacherSessionFastCap(data)),
      teacherTarget
    );
    const gap1Target = (fixedPressure || constrained || expected >= 900)
      ? Math.max(20, Math.ceil(expected / 30))
      : 0;
    const result = {teacherTarget, speedTeacherCap, gap1Target};
    if(memo) memo.practicalTeacherQualityTargets = result;
    return Object.assign({}, result);
  }

  function speedFirstBudgets(expected){
    const total = Number(expected || 0);
    if(total >= 900){
      return { session: 10, period: 10, overall: 30, retrySession: 8 };
    }
    if(total >= 600){
      return { session: 8, period: 8, overall: 25, retrySession: 8 };
    }
    return { session: 6, period: 8, overall: 20, retrySession: 6 };
  }

  function fastQualityBudgets(expected){
    const total = Number(expected || 0);
    if(total >= 900){
      return { session: 25, period: 25, periodFast: 20, overall: 60, retrySession: 20, probe: 6, cleanup: 3, qualityRetry: 45 };
    }
    if(total >= 600){
      return { session: 20, period: 20, periodFast: 15, overall: 50, retrySession: 20, probe: 5, cleanup: 3, qualityRetry: 40 };
    }
    return { session: 10, period: 14, overall: 35, retrySession: 8, probe: 4, cleanup: 2, qualityRetry: 25 };
  }

  function constraintAwareFastQualityBudgets(expected, data){
    const budgets = Object.assign({}, fastQualityBudgets(expected));
    const profile = constraintProfile(data);
    if(profile === "plain") return budgets;

    const bump = patch => {
      Object.entries(patch).forEach(([key, value]) => {
        budgets[key] = Math.max(Number(budgets[key] || 0), Number(value || 0));
      });
    };

    if(profile === "class-fixed-off" || profile === "fixed-off"){
      if(Number(expected || 0) >= 900){
        bump({ session: 30, period: 30, periodFast: 25, overall: 80, retrySession: 30, probe: 7, cleanup: 24, qualityRetry: 60 });
      }else{
        bump({ session: 25, period: 25, periodFast: 20, overall: 70, retrySession: 25, probe: 7, cleanup: 24, qualityRetry: 50 });
      }
    }else{
      bump({ session: 16, period: 30, overall: 120, retrySession: 12, probe: 6, cleanup: 4, qualityRetry: 110 });
    }

    return budgets;
  }

  function isFixedOffPressureProfile(data){
    const profile = constraintProfile(data);
    return profile === "class-fixed-off" || profile === "fixed-off" || hasFixedOffPressure(data);
  }

  function applySchedulingPressureTimeFloor(settings, data){
    if(!settings || typeof settings !== "object") return;
    // A fresh fallback is the second half of the same user click.  Its explicit
    // 60-second (or user-entered) ceiling must win over the fixed-off pressure
    // floor used by ordinary deep/refinement solves.
    if(settings.ui_constraint_change_fresh_retry === true){
      return;
    }
    const expected = expectedLessonCount(data);
    const fixedPressure = isFixedOffPressureProfile(data);
    const constrained = hasActiveConstraintData(data);
    const speedFirst = isSpeedFirstSettings(settings);
    if(speedFirst){
      const limitSeconds = fastPresetDeadlineSeconds(expected, data);
      const currentOverall = normalizeOverallTimeLimit(settings.overall_time_limit_seconds || 0);
      const nextOverall = Math.max(10, Math.min(limitSeconds, currentOverall || limitSeconds));
      settings.overall_time_limit_seconds = nextOverall;
      settings.integrated_time_limit = nextOverall;
      settings.optimization_time_limit_seconds = Math.min(
        nextOverall,
        Math.max(0, Number(settings.optimization_time_limit_seconds || nextOverall) || nextOverall)
      );
      settings.progress_estimate_seconds = Math.min(
        nextOverall,
        Math.max(5, Number(settings.progress_estimate_seconds || nextOverall) || nextOverall)
      );
      return;
    }
    const floorSeconds = speedFirst
      ? (expected >= 900 ? 90 : (expected >= 600 ? 75 : 45))
      : (
          fixedPressure
            ? (expected >= 600 ? 180 : 150)
            : ((constrained || expected >= 600) ? (expected >= 600 ? 150 : 120) : 0)
        );
    if(floorSeconds <= 0) return;
    settings.overall_time_limit_seconds = Math.max(
      floorSeconds,
      normalizeOverallTimeLimit(settings.overall_time_limit_seconds || 0)
    );
    settings.integrated_time_limit = Math.max(
      floorSeconds,
      Number(settings.integrated_time_limit || 0) || 0
    );
    settings.progress_estimate_seconds = Math.max(
      Math.min(90, floorSeconds),
      Number(settings.progress_estimate_seconds || 0) || 0
    );
  }

  function alignNativeFreshToBackendDeadline(settings, data, backendDeadlineMs){
    if(!settings || typeof settings !== "object") return;
    const deadline = Math.round(Number(backendDeadlineMs || 0) || 0);
    if(deadline <= 0) return;
    const expected = expectedLessonCount(data);
    const fixedPressure = isFixedOffPressureProfile(data);
    const speedFirst = isSpeedFirstSettings(settings);
    if(speedFirst){
      const reserve = Math.max(500, Math.min(1500, Number(settings.native_deadline_reserve_ms || 750) || 750));
      const cleanupTarget = expected >= 900 ? 7000 : (expected >= 600 ? 6000 : 4500);
      const cleanupCeil = Math.max(0, Math.min(cleanupTarget, Math.round(deadline * 0.18)));
      const freshCeil = Math.max(1000, deadline - reserve - cleanupCeil);
      const currentFresh = Number(settings.native_fresh_time_limit_ms || 0) || 0;
      settings.native_fresh_time_limit_ms = Math.max(
        1000,
        Math.round(Math.min(
          freshCeil,
          currentFresh > 0 ? currentFresh : Math.round(deadline * 0.62)
        ))
      );
      settings.native_fresh_cleanup_time_limit_ms = Math.max(0, cleanupCeil);
      return;
    }
    const heavy = fixedPressure || hasActiveConstraintData(data) || expected >= 600;
    if(!heavy) return;

    const reserve = Math.max(2500, Number(settings.native_deadline_reserve_ms || 0) || 0);
    const cleanupTarget = fixedPressure
      ? (expected >= 600 ? 42000 : 30000)
      : (expected >= 600 ? 26000 : 18000);
    const freshFloor = fixedPressure
      ? (expected >= 600 ? 135000 : 90000)
      : (expected >= 600 ? 90000 : 55000);
    const freshRatio = fixedPressure ? 0.75 : 0.68;
    const freshCeil = Math.max(35000, deadline - reserve - cleanupTarget);
    const currentFresh = Number(settings.native_fresh_time_limit_ms || 0) || 0;
    const freshBudget = Math.min(
      freshCeil,
      Math.max(
        Math.min(freshFloor, freshCeil),
        Math.min(currentFresh, freshCeil),
        Math.min(Math.round(deadline * freshRatio), freshCeil)
      )
    );
    settings.native_fresh_time_limit_ms = Math.max(1000, Math.round(freshBudget));

    const cleanupCeil = Math.max(0, deadline - settings.native_fresh_time_limit_ms - reserve);
    const currentCleanup = Number(settings.native_fresh_cleanup_time_limit_ms || 0) || 0;
    settings.native_fresh_cleanup_time_limit_ms = Math.max(
      0,
      Math.round(Math.min(
        cleanupCeil,
        Math.max(currentCleanup, Math.min(cleanupTarget, cleanupCeil))
      ))
    );
  }

  function applyHeavyOnePeriodCleanupSettings(settings, data){
    if(!settings || typeof settings !== "object") return;
    const qualityRetry = settings.zero_one_quality_retry === true
      || settings.teacher_session_quality_retry === true
      || settings.strict_quality_targets === true
      || settings.enforce_quality_targets === true;
    if(!qualityRetry) return;
    const expected = expectedLessonCount(data);
    const heavy = hasFixedOffPressure(data) || expected >= 600 || hasActiveConstraintData(data);
    if(!heavy) return;
    const fixedPressure = hasFixedOffPressure(data);
    const setMin = (key, value) => {
      settings[key] = Math.max(value, Number(settings[key] || 0) || 0);
    };
    setMin("native_quality_cleanup_max_iters", fixedPressure ? 240 : 160);
    setMin("local_one_period_cleanup_time_limit", fixedPressure ? 18 : 12);
    setMin("one_period_cluster_repair_time_limit", fixedPressure ? 18 : 12);
    setMin("session_priority_rescue_time_limit", fixedPressure ? 18 : 12);
    setMin("native_one_period_teacher_repack_time_limit_ms", fixedPressure ? 30000 : 18000);
    setMin("native_one_period_teacher_repack_limit", fixedPressure ? 16 : 10);
    setMin("native_one_period_teacher_repack_branch_limit", 18);
    setMin("native_one_period_teacher_repack_node_limit", fixedPressure ? 250000 : 180000);
    setMin("native_one_period_class_lns_time_limit_ms", fixedPressure ? 26000 : 14000);
    setMin("native_one_period_class_lns_group_limit", fixedPressure ? 44 : 28);
    setMin("native_one_period_class_lns_rebuild_limit", fixedPressure ? 160 : 96);
    setMin("native_one_period_class_lns_attempts_per_group", fixedPressure ? 14 : 8);
    setMin("native_one_period_class_lns_max_group_classes", fixedPressure ? 28 : 22);
    setMin("native_one_period_teacher_lns_time_limit_ms", fixedPressure ? 26000 : 14000);
    setMin("native_one_period_teacher_lns_group_limit", fixedPressure ? 80 : 48);
    setMin("native_one_period_teacher_lns_rebuild_limit", fixedPressure ? 180 : 96);
    setMin("native_one_period_teacher_lns_attempts_per_group", fixedPressure ? 10 : 5);
    setMin("native_one_period_teacher_lns_max_teachers", fixedPressure ? 24 : 12);
    setMin("native_one_period_random_walk_time_limit_ms", fixedPressure ? 22000 : 14000);
    setMin("native_one_period_random_walk_max_iters", fixedPressure ? 420000 : 260000);
    setMin("native_one_period_random_walk_validation_limit", fixedPressure ? 220000 : 120000);
    setMin("native_one_period_3cycle_time_limit_ms", fixedPressure ? 18000 : 10000);
    setMin("native_one_period_3cycle_check_limit", fixedPressure ? 220000 : 120000);
    setMin("native_one_period_any_class_cycle_check_limit", fixedPressure ? 220000 : 120000);
    setMin("native_one_period_chain_check_limit", fixedPressure ? 70000 : 24000);
    setMin("native_one_period_plateau_time_limit_ms", fixedPressure ? 18000 : 10000);
    setMin("native_one_period_plateau_validation_limit", fixedPressure ? 1800 : 900);
    setMin("native_one_period_repair_swap_check_limit", fixedPressure ? 90000 : 30000);
  }

  function splitTeacherNames(value){
    return String(value || "")
      .replace(/\r?\n/g, ",")
      .replace(/[;+]+/g, ",")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
  }

  function teacherSessionLoadLowerCap(data){
    const memo = activeAutoSortPlanningMemo(data);
    if(memo && Number.isFinite(memo.teacherSessionLoadLowerCap)) return memo.teacherSessionLoadLowerCap;
    try{
      const classes = classGradeLookup(data);
      const periods = periodLookupByGradeSubject(data);
      const loads = new Map();
      Object.keys(data?.pccmMatrix || {}).forEach(rawKey => {
        const parts = String(rawKey).split("|");
        const classId = String(parts.shift() || "").trim();
        const subject = String(parts.join("|") || "").trim();
        if(!classId || !subject) return;
        const direct = Number(data?.pccmTietMatrix?.[rawKey] ?? data?.pccmTietMatrix?.[`${classId}|${subject}`] ?? 0);
        let count = Number.isFinite(direct) && direct > 0 ? Math.round(direct) : 0;
        if(count <= 0){
          const grade = classes.get(classId) || "";
          const aliases = expandSubjectAliases(data, [subject]);
          for(const alias of aliases){
            count = periods.get(`${grade}|${subjectKey(alias)}`) || 0;
            if(count > 0) break;
          }
        }
        if(count <= 0) count = fallbackUiSubjectPeriods(data, classId, subject);
        if(count <= 0) return;
        splitTeacherNames(data?.pccmMatrix?.[rawKey]).forEach(name => {
          const key = name.toLowerCase();
          loads.set(key, (loads.get(key) || 0) + count);
        });
      });
      let lower = 0;
      loads.forEach(periods => { lower += Math.ceil(Math.max(0, Number(periods) || 0) / 5); });
      if(memo) memo.teacherSessionLoadLowerCap = lower;
      return lower;
    }catch(_){
      if(memo) memo.teacherSessionLoadLowerCap = 0;
      return 0;
    }
  }

  function classFixedOffSlotSummary(data){
    const byClass = new Map();
    const add = (classId, key) => {
      const id = String(classId || "");
      const parsed = parseOffKey(key);
      if(!id || !parsed) return;
      if(!byClass.has(id)) byClass.set(id, new Set());
      byClass.get(id).add(parsed.key);
    };
    Object.entries(data?.tkbConstraints?.fixedOff?.class || {}).forEach(([classId, slots]) => {
      Object.keys(slots || {}).forEach(key => { if(slots[key]) add(classId, key); });
    });
    Object.entries(data?.tkbUserOff || {}).forEach(([classId, raw]) => {
      if(Array.isArray(raw)) raw.forEach(key => add(classId, key));
      else if(raw && typeof raw === "object") Object.keys(raw).forEach(key => { if(raw[key]) add(classId, key); });
    });
    const fixedSlots = Array.from(byClass.values()).reduce((sum, set) => sum + set.size, 0);
    const classCount = Array.isArray(data?.lop) ? data.lop.length : 0;
    const dayCount = Array.isArray(window.DAYS) ? window.DAYS.length : 6;
    const sang = Number(window.SANG || 5) || 5;
    const chieu = Number(window.CHIEU || 5) || 5;
    const totalSlots = classCount * dayCount * (sang + chieu);
    const availableSlots = Math.max(0, totalSlots - fixedSlots);
    return {classCount, fixedSlots, totalSlots, availableSlots};
  }

  function tightClassFixedOffProfile(data){
    const expected = expectedLessonCount(data);
    const summary = classFixedOffSlotSummary(data);
    if(expected <= 0 || summary.fixedSlots <= 0 || summary.availableSlots <= 0) return null;
    const slack = summary.availableSlots - expected;
    const slackLimit = Math.max(6, Math.ceil(summary.classCount * 1.25));
    if(slack < 0 || slack > slackLimit) return null;
    return Object.assign({expected, slack, slackLimit}, summary);
  }

  function applyTightClassFixedOffSettings(settings, data){
    const profile = tightClassFixedOffProfile(data);
    if(!profile) return null;
    settings.max_teacher_sessions = Math.max(adaptiveTeacherSessionStartCap(data), Number(settings.max_teacher_sessions || 0) || 0);
    settings.requested_max_teacher_sessions = settings.max_teacher_sessions;
    settings.minimize_teacher_gaps = false;
    settings.randomize_search = false;
    settings.fresh_randomize = false;
    settings.tight_class_fixed_off_profile = {
      expected: profile.expected,
      availableSlots: profile.availableSlots,
      fixedSlots: profile.fixedSlots,
      slack: profile.slack
    };
    delete settings.random_seed;
    return profile;
  }

  let randomSeedCursor = 0;

  function makeRandomSeed(){
    const maxSeed = 2147483646;
    if(randomSeedCursor <= 0){
      const now = Math.abs(Math.trunc(Number(Date.now()) || 0)) % maxSeed;
      const extra = Math.floor(Math.random() * 1000003);
      randomSeedCursor = ((now + extra) % maxSeed) + 1;
    }else{
      // A monotonic cursor guarantees distinct trajectories even when several
      // Play clicks happen inside the same millisecond or Math.random repeats.
      randomSeedCursor = (randomSeedCursor % maxSeed) + 1;
    }
    return randomSeedCursor;
  }

  function applyScheduleDiversitySettings(settings, data){
    if(!settings || typeof settings !== "object") return 0;
    const seed = makeRandomSeed();
    settings.schedule_diversity = true;
    settings.quality_variant_seed = seed;
    settings.random_seed = seed;
    settings.allow_backend_cache = false;
    settings.force_fresh_backend_solve = true;
    settings.allow_solver_warm_start = false;
    settings.disable_native_hint_solver = true;
    settings.disable_solver_hints = true;
    settings.native_disable_cached_hint_candidate = true;
    settings.native_disable_static_hint_candidate = true;
    settings.native_hint_bank_max_entries = 0;
    settings.native_hint_bank_time_limit_ms = 0;
    settings.native_hint_bank_cleanup_validation_limit = 0;
    settings.native_hint_bank_candidate_cleanup_time_ms = 0;
    settings.native_hint_bank_hard_repair_violation_cap = 0;
    settings.native_overlay_hard_repair_time_ms = Math.max(1500, Number(settings.native_overlay_hard_repair_time_ms || 0) || 0);
    settings.native_teacher_session_compact_time_limit_ms = Math.max(2500, Number(settings.native_teacher_session_compact_time_limit_ms || 0) || 0);
    settings.native_quality_variant_gap_slack = Number.isFinite(Number(settings.native_quality_variant_gap_slack))
      ? Math.max(0, Math.min(30, Math.round(Number(settings.native_quality_variant_gap_slack))))
      : DEFAULT_SETTINGS.native_quality_variant_gap_slack;
    settings.native_quality_variant_one_period_slack = Number.isFinite(Number(settings.native_quality_variant_one_period_slack))
      ? Math.max(0, Math.min(8, Math.round(Number(settings.native_quality_variant_one_period_slack))))
      : DEFAULT_SETTINGS.native_quality_variant_one_period_slack;
    settings.native_quality_variant_session_slack = Number.isFinite(Number(settings.native_quality_variant_session_slack))
      ? Math.max(0, Math.min(DEFAULT_SETTINGS.native_quality_variant_session_slack, Math.round(Number(settings.native_quality_variant_session_slack))))
      : DEFAULT_SETTINGS.native_quality_variant_session_slack;
    const currentLessons = currentScheduleLessonsFromData(data || getData());
    const currentTeacherSessionSignature = teacherSessionSignatureFromLessons(currentLessons);
    const currentLessonSignature = lessonAssignmentSignatureFromLessons(currentLessons);
    const avoidTeacherSessionSignatures = [
      currentTeacherSessionSignature
    ].filter(Boolean).filter((item, index, items) => items.indexOf(item) === index).slice(0, 8);
    if(currentTeacherSessionSignature){
      settings.avoid_teacher_session_signature = currentTeacherSessionSignature;
      settings.reclick_schedule_diversity = true;
      settings.require_teacher_session_diversity = true;
      settings.native_quality_variant_gap_slack = Math.max(12, Number(settings.native_quality_variant_gap_slack || 0) || 0);
      settings.native_quality_variant_one_period_slack = 0;
      settings.native_quality_variant_session_slack = Math.max(12, Number(settings.native_quality_variant_session_slack || 0) || 0);
      settings.native_diversity_teacher_session_swap_checks = Math.max(2200, Number(settings.native_diversity_teacher_session_swap_checks || 0) || 0);
      settings.native_diversity_swap_attempts = Math.max(4500, Number(settings.native_diversity_swap_attempts || 0) || 0);
      settings.native_fresh_time_limit_ms = Math.max(32000, Number(settings.native_fresh_time_limit_ms || 0) || 0);
      settings.native_fresh_attempts = Math.max(28, Number(settings.native_fresh_attempts || 0) || 0);
      settings.native_fresh_max_iters = Math.max(30000, Number(settings.native_fresh_max_iters || 0) || 0);
      settings.native_fresh_empty_moves = true;
      settings.allow_teacher_session_fast_portfolio = false;
      settings.allow_teacher_session_deep_retry = true;
      const fixedOnlySeed = countFixedScheduledLessons(data) > 0
        && countScheduledLessons(data) <= countFixedScheduledLessons(data);
      const retryCap = fixedOnlySeed ? 150 : 45;
      settings.fast_quality_retry_time_limit_seconds = Math.min(
        positiveNumberSetting(settings.fast_quality_retry_time_limit_seconds) || retryCap,
        retryCap
      );
    }else{
      delete settings.avoid_teacher_session_signature;
      delete settings.reclick_schedule_diversity;
      delete settings.require_teacher_session_diversity;
    }
    if(avoidTeacherSessionSignatures.length){
      settings.avoid_teacher_session_signatures = avoidTeacherSessionSignatures;
    }else{
      delete settings.avoid_teacher_session_signatures;
    }
    if(currentLessonSignature){
      settings.avoid_lesson_signature = currentLessonSignature;
    }else{
      delete settings.avoid_lesson_signature;
    }
    return seed;
  }

  function shouldUseScheduleDiversity(settings){
    return settings?.schedule_diversity === true || DEFAULT_SETTINGS.schedule_diversity === true;
  }

  function disableScheduleDiversitySettings(settings){
    if(!settings || typeof settings !== "object") return;
    settings.schedule_diversity = false;
    settings.reclick_schedule_diversity = false;
    settings.require_teacher_session_diversity = false;
    delete settings.avoid_teacher_session_signature;
    delete settings.avoid_teacher_session_signatures;
    delete settings.avoid_lesson_signature;
    delete settings.avoid_lesson_signatures;
    delete settings.quality_variant_seed;
  }

  function makeSolveRunId(){
    solveRunCounter = (solveRunCounter + 1) % 1000000;
    return `${VERSION}:${Date.now()}:${solveRunCounter}:${Math.random().toString(36).slice(2)}`;
  }

  function isCurrentSolveRun(runId){
    return String(window.__TKB_ACTIVE_SOLVE_RUN_ID || "") === String(runId || "");
  }

  function activeSolveSeedSalt(){
    const active = String(window.__TKB_ACTIVE_SOLVE_RUN_ID || "");
    if(active) return hashSeedText(active);
    return 0;
  }

  function stableSeedText(value, depth){
    if(value == null) return "";
    if(depth <= 0) return typeof value;
    if(Array.isArray(value)){
      return `[${value.map(item => stableSeedText(item, depth - 1)).join(",")}]`;
    }
    if(typeof value === "object"){
      return `{${Object.keys(value).sort().map(key => {
        if(["tkb","tkbSolverResult","tkbRustSolverResult","tkbSolverPayload","solverResult","solverMetrics"].includes(key)) return "";
        return `${key}:${stableSeedText(value[key], depth - 1)}`;
      }).filter(Boolean).join(",")}}`;
    }
    return String(value);
  }

  function hashSeedText(text){
    let hash = 2166136261;
    const raw = String(text || "");
    for(let i = 0; i < raw.length; i += 1){
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash || 1;
  }

  function schoolSeedSequence(data, count){
    const base = hashSeedText(stableSeedText(data || getData(), 5));
    const seeds = [];
    let state = (base ^ activeSolveSeedSalt()) >>> 0;
    if(!state) state = base;
    const wanted = Math.max(1, Math.round(Number(count || 1)));
    while(seeds.length < wanted){
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const seed = 1 + (state % 2147483646);
      if(!seeds.includes(seed)) seeds.push(seed);
    }
    return seeds;
  }

  function compactPortfolioSeedSequence(data, count){
    const basePreferred = [17, 23, 41, 101];
    const offset = activeSolveSeedSalt() % basePreferred.length;
    const preferred = basePreferred.slice(offset).concat(basePreferred.slice(0, offset));
    const seeds = [];
    const wanted = Math.max(1, Math.round(Number(count || 1)));
    preferred.concat(schoolSeedSequence(data, wanted + preferred.length)).forEach(seed => {
      const value = Math.max(1, Math.round(Number(seed || 0)));
      if(value > 0 && !seeds.includes(value) && seeds.length < wanted) seeds.push(value);
    });
    return seeds;
  }

  function preserveExistingMinRatio(settings){
    const raw = Number(settings?.preserve_existing_min_ratio ?? DEFAULT_SETTINGS.preserve_existing_min_ratio);
    if(!Number.isFinite(raw)) return DEFAULT_SETTINGS.preserve_existing_min_ratio;
    return Math.max(0, Math.min(1, raw));
  }

  function normalizeSolveTimeLimits(next, data){
    const activeConstraints = hasActiveConstraintData(data);
    const aggressive = !isFalseSetting(next.aggressive_fast_mode);
    const sessionLimit = Number(next.session_time_limit || DEFAULT_SETTINGS.session_time_limit);
    const periodLimit = Number(next.period_time_limit || DEFAULT_SETTINGS.period_time_limit);
    const requestedSessionLimit = Number.isFinite(sessionLimit) && sessionLimit > 0
      ? Math.round(sessionLimit)
      : DEFAULT_SETTINGS.session_time_limit;
    const requestedPeriodLimit = Number.isFinite(periodLimit) && periodLimit > 0
      ? Math.round(periodLimit)
      : DEFAULT_SETTINGS.period_time_limit;
    const sessionFloor = activeConstraints ? 8 : 8;
    if(aggressive){
      const sessionCeiling = activeConstraints
        ? Math.max(DEFAULT_SETTINGS.session_time_limit, Math.min(requestedSessionLimit, 18))
        : DEFAULT_SETTINGS.session_time_limit;
      next.session_time_limit = activeConstraints
        ? Math.max(sessionFloor, Math.min(Math.max(requestedSessionLimit, sessionCeiling), sessionCeiling))
        : Math.max(sessionFloor, Math.min(requestedSessionLimit, sessionCeiling));
      next.period_time_limit = Math.max(15, Math.min(requestedPeriodLimit, DEFAULT_SETTINGS.period_time_limit));
      next.period_fast_time_limit = Math.max(2, Math.min(
        Number(next.period_fast_time_limit || DEFAULT_SETTINGS.period_fast_time_limit),
        DEFAULT_SETTINGS.period_fast_time_limit
      ));
      next.period_retry_time_limit = Math.max(4, Math.min(
        Number(next.period_retry_time_limit || DEFAULT_SETTINGS.period_retry_time_limit),
        DEFAULT_SETTINGS.period_retry_time_limit
      ));
      return;
    }

    next.session_time_limit = Math.max(sessionFloor, requestedSessionLimit);
    next.period_time_limit = Math.max(15, requestedPeriodLimit);
    const fastRaw = Number(next.period_fast_time_limit || 0);
    const retryRaw = Number(next.period_retry_time_limit || 0);
    next.period_fast_time_limit = fastRaw > DEFAULT_SETTINGS.period_fast_time_limit
      ? Math.max(DEFAULT_SETTINGS.period_fast_time_limit, Math.min(Math.round(fastRaw), next.period_time_limit))
      : next.period_time_limit;
    next.period_retry_time_limit = retryRaw > DEFAULT_SETTINGS.period_retry_time_limit
      ? Math.max(next.period_fast_time_limit, Math.min(Math.round(retryRaw), next.period_time_limit))
      : next.period_time_limit;
  }

  function shouldPreserveExistingSchedule(scheduled, expected, settings){
    const placed = Number(scheduled || 0);
    const total = Number(expected || 0);
    if(!Number.isFinite(placed) || placed <= 0) return false;
    if(!Number.isFinite(total) || total <= 0) return true;
    if(placed >= total) return true;
    return placed / total >= preserveExistingMinRatio(settings);
  }

  function repairFillFirstMaxMissing(settings){
    const raw = Number(settings?.repair_fill_first_max_missing ?? 96);
    if(!Number.isFinite(raw)) return 96;
    return Math.max(0, Math.round(raw));
  }

  function partialExistingRepairState(data, settings){
    const completionStats = cheapSchoolCompletionStats(data) || {};
    const physicalExpected = Math.max(0, Number(expectedLessonCount(data) || 0) || 0);
    const physicalScheduled = Math.max(0, Number(countScheduledLessons(data) || 0) || 0);
    const statsExpected = Math.max(0, Number(completionStats.expected || 0) || 0);
    const expected = physicalExpected > 0 ? physicalExpected : statsExpected;
    const statsScheduled = Number.isFinite(Number(completionStats.scheduled))
      ? Math.max(0, Number(completionStats.scheduled) || 0)
      : physicalScheduled;
    const scheduled = Math.min(expected > 0 ? expected : physicalScheduled, physicalScheduled, statsScheduled);
    const reportedMissing = statsExpected === expected
      ? Math.max(0, Number(completionStats.unassigned || 0) || 0)
      : 0;
    const missing = Math.max(reportedMissing, Math.max(0, Number(expected || 0) - scheduled));
    const flexibleScheduled = Math.min(
      scheduled,
      Math.max(0, Number(countScheduledLessons(data, {flexibleOnly:true}) || 0) || 0)
    );
    const maxMissing = repairFillFirstMaxMissing(settings);
    const ratio = expected > 0 ? scheduled / expected : 0;
    const knownConstraintViolations = Number(settings?.ui_preflight_constraint_violation_count);
    const hasKnownConstraintViolations = Number.isFinite(knownConstraintViolations)
      && knownConstraintViolations > 0;
    const completeConstraintRepair = settings?.ui_constraint_change_repair === true
      && expected > 0
      && scheduled >= expected
      && missing === 0
      && hasKnownConstraintViolations;
    const fewLessons = completeConstraintRepair
      || (missing > 0 && (missing <= 6 || (maxMissing > 0 && missing <= maxMissing)));
    const closeEnough = expected > 0 && scheduled > 0 && (
      shouldPreserveExistingSchedule(scheduled, expected, settings) ||
      (missing <= 6 && ratio >= 0.5)
    );
    return {
      expected,
      scheduled,
      flexibleScheduled,
      missing,
      maxMissing,
      ratio,
      source: String(completionStats.source || "bridge_count"),
      eligible: expected > 0 && scheduled > 0 && fewLessons && closeEnough
    };
  }

  function applyPartialExistingRepairSettings(settings, data, reason){
    if(
      settings?.ui_disable_staged_existing_repair === true
      || settings?.ui_disable_partial_existing_repair === true
      || settings?.ui_default_fresh_sort === true
      || settings?.ui_local_repair_needs_rearrange === true
      || isCapacityShortageAccepted(settings)
    ) return null;
    if(shouldUseFixedOffValidatedQualityBank(data, settings)) return null;
    const state = partialExistingRepairState(data, settings);
    if(!state.eligible) return null;
    settings.auto_sort_mode = "fast";
    settings.auto_sort_strategy = "preserve_existing";
    settings.preserve_existing_tkb = true;
    settings.preserve_fixed_lessons_only = true;
    settings.allow_optimize_with_fixed_lessons = true;
    settings.force_preserve_partial_existing = true;
    settings.partial_existing_rebuild = true;
    settings.repair_fill_first = true;
    settings.repair_partial_existing = true;
    settings.repair_partial_existing_reason = reason || "few_unassigned_existing_tkb";
    settings.repair_existing_missing_periods = state.missing;
    settings.repair_fill_first_max_missing = state.maxMissing;
    settings.best_effort_on_timeout = true;
    settings.fresh_randomize = false;
    settings.randomize_search = false;
    settings.existing_scheduled_periods = state.scheduled;
    settings.existing_flexible_scheduled_periods = state.flexibleScheduled;
    settings.expected_scheduled_periods = state.expected;
    delete settings.max_teacher_sessions;
    delete settings.requested_max_teacher_sessions;
    delete settings.target_teacher_sessions;
    delete settings.target_gap1_sessions;
    delete settings.random_seed;
    return state;
  }

  function applyFixedLessonPreserveSettings(settings, data){
    if(settings?.ui_capacity_safe_fresh_probe === true) return 0;
    const fixedCount = countFixedScheduledLessons(data);
    if(fixedCount <= 0 || isTruthySetting(settings?.preserve_existing_tkb)) return 0;
    const keepRandomSearch = settings?.zero_one_quality_retry === true
      || settings?.teacher_session_fast_portfolio === true
      || settings?.ui_compact_first_pass === true
      || settings?.ui_no_hint_randomized_solve === true;
    settings.preserve_fixed_lessons_only = true;
    settings.existing_fixed_scheduled_periods = fixedCount;
    settings.force_preserve_partial_existing = true;
    settings.partial_existing_rebuild = true;
    settings.repair_fill_first = true;
    const completionStats = cheapSchoolCompletionStats(data);
    settings.repair_existing_missing_periods = completionStats
      ? Math.max(0, Number(completionStats.unassigned || 0) || 0)
      : Math.max(0, expectedLessonCount(data) - countScheduledLessons(data));
    settings.best_effort_on_timeout = true;
    if(!keepRandomSearch){
      settings.fresh_randomize = false;
      settings.randomize_search = false;
      delete settings.random_seed;
    }
    return fixedCount;
  }

  function settingsForAutoSort(baseSettings){
    const data = getData();
    const scheduled = countScheduledLessons(data);
    const flexibleScheduled = countScheduledLessons(data, {flexibleOnly:true});
    const expected = expectedLessonCount(data);
    const next = Object.assign({}, baseSettings || readSettings());
    clearPostRollbackSettings(next);
    next.force_fresh_backend_solve = true;
    next.allow_backend_cache = false;
    next.disable_native_hint_solver = true;
    next.disable_solver_hints = true;
    next.allow_solver_warm_start = false;
    next.native_disable_cached_hint_candidate = true;
    next.native_disable_static_hint_candidate = true;
    next.native_hint_bank_max_entries = 0;
    next.native_hint_bank_time_limit_ms = 0;
    next.native_hint_bank_cleanup_validation_limit = 0;
    next.native_hint_bank_candidate_cleanup_time_ms = 0;
    next.native_hint_bank_hard_repair_violation_cap = 0;
    next.native_overlay_hard_repair_time_ms = 2200;
    next.native_teacher_session_compact_time_limit_ms = 3000;
    next.native_rehome_swap_row_limit = 180;
    next.native_rehome_swap_check_limit = 90000;
    next.native_rehome_swap_pair_candidate_limit = 72;
    next.native_rehome_swap_triple_candidate_limit = 24;
    next.native_rehome_swap_first_session_improvement = true;
    const fixedLessonCount = countFixedScheduledLessons(data);
    if(fixedLessonCount > 0 || expected >= 600){
      next.native_fresh_empty_moves = true;
      next.native_fresh_time_limit_ms = Math.max(
        150000,
        Number(next.native_fresh_time_limit_ms || 0) || 0
      );
      next.native_fresh_attempts = 6;
      next.native_fresh_per_attempt_time_limit_ms = Math.max(
        25000,
        Number(next.native_fresh_per_attempt_time_limit_ms || 0) || 0
      );
      next.native_fresh_max_iters = Math.max(
        360000,
        Number(next.native_fresh_max_iters || 0) || 0
      );
      next.native_one_period_chain_check_limit = Math.max(
        300000,
        Number(next.native_one_period_chain_check_limit || 0) || 0
      );
      next.native_one_period_deep_cycle_depth = Math.max(
        12,
        Number(next.native_one_period_deep_cycle_depth || 0) || 0
      );
      next.native_one_period_deep_cycle_branch = Math.max(
        40,
        Number(next.native_one_period_deep_cycle_branch || 0) || 0
      );
      next.native_teacher_lns_group_limit = 0;
      next.native_stochastic_class_swap_time_limit_ms = Math.max(
        30000,
        Number(next.native_stochastic_class_swap_time_limit_ms || 0) || 0
      );
      next.native_stochastic_class_swap_max_iters = Math.max(
        900000,
        Number(next.native_stochastic_class_swap_max_iters || 0) || 0
      );
      next.native_stochastic_class_swap_restarts = Math.max(
        12,
        Number(next.native_stochastic_class_swap_restarts || 0) || 0
      );
      next.native_subject_session_repair_time_limit_ms = Math.max(
        45000,
        Number(next.native_subject_session_repair_time_limit_ms || 0) || 0
      );
      next.native_subject_session_repair_check_limit = Math.max(
        160000,
        Number(next.native_subject_session_repair_check_limit || 0) || 0
      );
      next.native_stochastic_class_swap_repair_reserve_ms = Math.max(
        25000,
        Number(next.native_stochastic_class_swap_repair_reserve_ms || 0) || 0
      );
    }
    next.native_quality_cleanup_max_iters = Math.max(
      fixedLessonCount > 0 || expected >= 600 ? 640 : 48,
      Number(next.native_quality_cleanup_max_iters || 0) || 0
    );
    next.native_fresh_cleanup_time_limit_ms = Math.max(
      fixedLessonCount > 0 || expected >= 600 ? 45000 : 14000,
      Number(next.native_fresh_cleanup_time_limit_ms || 0) || 0
    );
    next.native_hint_quality_cleanup_time_limit_ms = 0;
    next.fast_repair_period_hint = false;
    next.fast_validated_period_hint = false;
    next.minimize_sessions = true;
    next.allow_one_period_gaps = true;
    next.minimize_one_period_sessions = true;
    next.max_one_period_sessions = 0;
    next.one_period_priority_absolute = true;
    next.minimize_teacher_gaps = true;
    next.period_max_teacher_gap = 1;
    next.require_complete_schedule = true;
    if(next.aggressive_fast_mode == null) next.aggressive_fast_mode = true;
    next.overall_time_limit_seconds = normalizeOverallTimeLimit(next.overall_time_limit_seconds ?? DEFAULT_SETTINGS.overall_time_limit_seconds);
    if((hasActiveConstraintData(data) || expected >= 300) && next.overall_time_limit_seconds <= 0){
      next.overall_time_limit_seconds = DEFAULT_SETTINGS.overall_time_limit_seconds;
    }
    next.best_effort_on_timeout = true;
    next.relax_period_teacher_gap_on_failure = false;
    next.deep_session_rescue = isFalseSetting(next.aggressive_fast_mode) ? !!next.deep_session_rescue : false;
    next.preserve_existing_min_ratio = preserveExistingMinRatio(next);
    const tightClassFixedOff = applyTightClassFixedOffSettings(next, data);
    next.num_workers = hardwareWorkerCount();
    normalizeSolveTimeLimits(next, data);
    next.exact_teacher_sessions = false;
    next.search_teacher_sessions = true;
    if(next.ui_local_repair_needs_rearrange !== true && shouldPreserveExistingSchedule(flexibleScheduled, expected, next)){
      next.auto_sort_strategy = "preserve_existing";
      next.preserve_existing_tkb = true;
      next.fresh_randomize = false;
      delete next.random_seed;
      next.existing_scheduled_periods = scheduled;
      next.existing_flexible_scheduled_periods = flexibleScheduled;
    }else{
      next.auto_sort_strategy = "fresh_quality_search";
      next.preserve_existing_tkb = false;
      if(scheduled > 0) next.partial_existing_rebuild = true;
      const randomizeFresh = next.randomize_search == null ? false : !isFalseSetting(next.randomize_search);
      next.fresh_randomize = randomizeFresh;
      if(!randomizeFresh){
        if(next.random_seed == null || next.random_seed === "") delete next.random_seed;
      }else{
        next.fresh_randomize_strategy = next.fresh_randomize_strategy || DEFAULT_SETTINGS.fresh_randomize_strategy;
        next.random_seed = makeRandomSeed();
      }
      next.existing_scheduled_periods = scheduled;
      next.existing_flexible_scheduled_periods = flexibleScheduled;
    }
    if(!tightClassFixedOff){
      applyPartialExistingRepairSettings(next, data, "few_unassigned_auto_sort");
    }
    if(tightClassFixedOff){
      next.auto_sort_strategy = "fresh_tight_class_fixed_off";
      next.preserve_existing_tkb = false;
      next.fresh_randomize = false;
      next.randomize_search = false;
      delete next.random_seed;
    }
    next.expected_scheduled_periods = expected;
    if(!isTruthySetting(next.preserve_existing_tkb) && shouldUseScheduleDiversity(next)){
      applyScheduleDiversitySettings(next, data);
    }else{
      disableScheduleDiversitySettings(next);
    }
    return enforceNoHintFreshSolveSettings(next);
  }

  function settingsForTeacherSessionOpt(baseSettings){
    const data = getData();
    const expected = expectedLessonCount(data);
    const next = settingsForAutoSort(baseSettings || readSettings());
    const optLimit = Math.max(60, Math.round(Number(DEFAULT_SETTINGS.optimization_time_limit_seconds || 300)));
    const startCap = positiveNumberSetting(adaptiveTeacherSessionStartCap(data));
    clearPostRollbackSettings(next);
    next.auto_sort_mode = "teacher_session_opt";
    next.allow_backend_cache = false;
    next.force_fresh_backend_solve = true;
    next.disable_native_hint_solver = true;
    next.disable_solver_hints = true;
    next.allow_solver_warm_start = false;
    delete next.target_teacher_sessions;
    delete next.target_gap1_sessions;
    delete next.max_teacher_sessions;
    delete next.requested_max_teacher_sessions;
    if(startCap > 0) next.optimization_start_teacher_sessions = startCap;
    else delete next.optimization_start_teacher_sessions;
    next.optimization_time_limit_seconds = optLimit;
    next.optimization_direct_first = false;
    const acceptCap = positiveNumberSetting(DEFAULT_SETTINGS.optimization_accept_teacher_sessions)
      || (startCap > 1 ? startCap - 1 : startCap)
      || positiveNumberSetting(teacherSessionLoadLowerCap(data));
    if(acceptCap > 0) next.optimization_accept_teacher_sessions = acceptCap;
    else delete next.optimization_accept_teacher_sessions;
    const defaultGapTarget = nonnegativeNumberSetting(DEFAULT_SETTINGS.optimization_accept_gap1_sessions);
    if(defaultGapTarget != null) next.optimization_accept_gap1_sessions = defaultGapTarget;
    else delete next.optimization_accept_gap1_sessions;
    next.optimization_first_cap_time_limit_seconds = Math.max(
      60,
      Math.min(optLimit, Math.round(Number(DEFAULT_SETTINGS.optimization_first_cap_time_limit_seconds || optLimit)))
    );
    next.optimization_session_time_limit = Math.max(60, Math.round(Number(DEFAULT_SETTINGS.optimization_session_time_limit || 120)));
    next.optimization_period_retry_time_limit = Math.max(30, Math.round(Number(DEFAULT_SETTINGS.optimization_period_retry_time_limit || 45)));
    next.overall_time_limit_seconds = optLimit;
    next.solver_mode = "auto";
    next.exact_teacher_sessions = false;
    next.search_teacher_sessions = true;
    next.minimize_sessions = true;
    next.allow_one_period_gaps = true;
    next.minimize_one_period_sessions = true;
    next.max_one_period_sessions = 0;
    next.one_period_priority_absolute = true;
    next.minimize_teacher_gaps = true;
    next.period_max_teacher_gap = 1;
    next.best_effort_on_timeout = true;
    next.relax_period_teacher_gap_on_failure = false;
    next.aggressive_fast_mode = false;
    next.deep_session_rescue = true;
    next.preserve_existing_tkb = false;
    next.auto_sort_strategy = "fresh_teacher_session_opt";
    next.fresh_randomize = false;
    next.randomize_search = false;
    next.session_time_limit = Math.max(60, Number(next.session_time_limit || 0) || 0);
    next.period_time_limit = Math.max(90, Number(next.period_time_limit || 0) || 0);
    next.period_fast_time_limit = next.period_time_limit;
    next.period_retry_time_limit = Math.max(next.period_time_limit, Number(next.period_retry_time_limit || 0) || 0);
    next.integrated_time_limit = Math.max(optLimit, Number(next.integrated_time_limit || 0) || 0);
    next.progress_estimate_seconds = optLimit;
    next.expected_scheduled_periods = expected;
    next.num_workers = hardwareWorkerCount();
    delete next.random_seed;
    return enforceNoHintFreshSolveSettings(next);
  }

  function settingsForFastQualityAutoSort(baseSettings){
    const data = getData();
    const expected = expectedLessonCount(data);
    const qualityTargets = practicalTeacherQualityTargets(data);
    const next = settingsForAutoSort(baseSettings || readSettings());
    const budgets = constraintAwareFastQualityBudgets(expected, data);
    let speedCap = Math.max(
      positiveNumberSetting(next.max_teacher_sessions),
      positiveNumberSetting(DEFAULT_SETTINGS.max_teacher_sessions),
      positiveNumberSetting(adaptiveTeacherSessionFastCap(data)),
      positiveNumberSetting(adaptiveTeacherSessionStartCap(data))
    );
    const explicitTeacherCap = next.teacher_session_target_explicit === true
      || positiveNumberSetting(next.target_teacher_sessions) > 0;
    if(expected >= 600 && !explicitTeacherCap){
      speedCap = positiveNumberSetting(adaptiveTeacherSessionFastCap(data))
        || positiveNumberSetting(adaptiveTeacherSessionStartCap(data))
        || speedCap;
    }
    const qualityCap = positiveNumberSetting(next.optimization_accept_teacher_sessions)
      || positiveNumberSetting(qualityTargets.teacherTarget)
      || positiveNumberSetting(DEFAULT_SETTINGS.optimization_accept_teacher_sessions)
      || positiveNumberSetting(DEFAULT_SETTINGS.max_teacher_sessions)
      || positiveNumberSetting(adaptiveTeacherSessionStartCap(data))
      || speedCap;
    clearPostRollbackSettings(next);
    next.auto_sort_mode = "fast";
    next.allow_backend_cache = false;
    next.force_fresh_backend_solve = true;
    next.disable_native_hint_solver = true;
    next.disable_solver_hints = true;
    next.allow_solver_warm_start = false;
    next.native_disable_cached_hint_candidate = true;
    next.native_disable_static_hint_candidate = true;
    next.native_hint_bank_max_entries = 0;
    next.native_hint_bank_time_limit_ms = 0;
    next.fast_repair_period_hint = false;
    next.fast_validated_period_hint = false;
    next.require_complete_schedule = true;
    next.auto_sort_strategy = "fresh_fast_quality";
    next.solver_mode = "auto";
    next.exact_teacher_sessions = false;
    next.search_teacher_sessions = true;
    if(speedCap > 0){
      next.max_teacher_sessions = speedCap;
      next.requested_max_teacher_sessions = speedCap;
    }
    next.minimize_sessions = true;
    next.allow_one_period_gaps = true;
    next.minimize_one_period_sessions = true;
    next.max_one_period_sessions = 0;
    next.one_period_priority_absolute = true;
    next.minimize_teacher_gaps = true;
    next.period_max_teacher_gap = 1;
    next.disable_period_feasibility_bridge = false;
    const fixedPressure = hasFixedOffPressure(data);
    const useQualityFirstSessionBudget = fixedPressure && expected >= 900;
    next.speed_first_complete = useQualityFirstSessionBudget ? false : true;
    next.period_retry_session_time_limit = budgets.retrySession || budgets.session;
    next.one_period_zero_probe_time_limit = budgets.probe;
    next.one_period_gap0_probe_time_limit = budgets.probe;
    next.session_priority_rescue_time_limit = budgets.probe;
    next.session_priority_period_time_limit = Math.min(8, budgets.probe);
    next.local_one_period_cleanup_time_limit = budgets.cleanup;
    next.one_period_cluster_repair_time_limit = budgets.cleanup;
    next.native_fresh_time_limit_ms = fixedPressure
      ? Math.max(135000, Math.round((budgets.overall || 180) * 1000 * 0.75))
      : Math.max(26000, Math.min(45000, Math.round((budgets.overall || 48) * 1000 * 0.62)));
    if(fixedPressure){
      next.native_fresh_cleanup_time_limit_ms = Math.max(
        42000,
        Number(next.native_fresh_cleanup_time_limit_ms || 0) || 0
      );
    }
    next.native_fresh_attempts = 32;
    next.native_fresh_max_iters = 60000;
    next.allow_teacher_session_deep_retry = false;
    next.allow_teacher_session_fast_portfolio = true;
    next.fast_quality_retry_time_limit_seconds = budgets.qualityRetry;
    next.best_effort_on_timeout = true;
    next.allow_quality_debt = true;
    next.allow_strict_quality_solution_bank = false;
    next.relax_period_teacher_gap_on_failure = false;
    next.aggressive_fast_mode = false;
    next.deep_session_rescue = false;
    next.preserve_existing_tkb = false;
    next.fresh_randomize = false;
    next.randomize_search = false;
    delete next.target_teacher_sessions;
    delete next.target_gap1_sessions;
    Object.keys(next).forEach(key => {
      if(key.startsWith("optimization_")) delete next[key];
    });
    if(useQualityFirstSessionBudget){
      next.auto_sort_strategy = "fresh_fast_quality_session_quality_budget";
      next.allow_teacher_session_deep_retry = false;
      next.allow_teacher_session_fast_portfolio = true;
      next.allow_quality_debt = false;
      if(!explicitTeacherCap && qualityTargets.teacherTarget > 0){
        next.target_teacher_sessions = qualityTargets.teacherTarget;
        next.optimization_accept_teacher_sessions = qualityTargets.teacherTarget;
        next.max_teacher_sessions = Math.max(
          positiveNumberSetting(next.max_teacher_sessions),
          qualityTargets.speedTeacherCap
        );
        next.requested_max_teacher_sessions = next.max_teacher_sessions;
        next.teacher_session_target_explicit = true;
      }else if(qualityCap > 0){
        next.optimization_accept_teacher_sessions = qualityCap;
      }else{
        delete next.optimization_accept_teacher_sessions;
      }
      if(qualityTargets.gap1Target != null){
        next.optimization_accept_gap1_sessions = qualityTargets.gap1Target;
        next.target_gap1_sessions = qualityTargets.gap1Target;
        next.optimization_default_accept_gap1_sessions = qualityTargets.gap1Target;
        next.gap1_quality_target_explicit = true;
      }else{
        delete next.optimization_accept_gap1_sessions;
        delete next.target_gap1_sessions;
        delete next.optimization_default_accept_gap1_sessions;
        next.gap1_quality_target_explicit = false;
      }
    }else if(!explicitTeacherCap && qualityTargets.teacherTarget > 0){
      next.target_teacher_sessions = qualityTargets.teacherTarget;
      next.optimization_accept_teacher_sessions = qualityTargets.teacherTarget;
      next.max_teacher_sessions = Math.max(
        positiveNumberSetting(next.max_teacher_sessions),
        qualityTargets.speedTeacherCap
      );
      next.requested_max_teacher_sessions = next.max_teacher_sessions;
      next.teacher_session_target_explicit = true;
    }else if(qualityCap > 0){
      next.optimization_accept_teacher_sessions = qualityCap;
    }else{
      delete next.optimization_accept_teacher_sessions;
    }
    if(!useQualityFirstSessionBudget && qualityTargets.gap1Target != null){
      next.optimization_accept_gap1_sessions = qualityTargets.gap1Target;
      next.target_gap1_sessions = qualityTargets.gap1Target;
      next.gap1_quality_target_explicit = true;
    }else{
      delete next.optimization_accept_gap1_sessions;
      delete next.target_gap1_sessions;
      next.gap1_quality_target_explicit = false;
    }
    next.session_time_limit = budgets.session;
    next.period_time_limit = budgets.period;
    next.period_fast_time_limit = budgets.periodFast || budgets.period;
    next.period_retry_time_limit = next.period_time_limit;
    next.integrated_time_limit = budgets.overall;
    next.overall_time_limit_seconds = budgets.overall;
    next.progress_estimate_seconds = Math.min(90, next.overall_time_limit_seconds);
    applyCompactFirstTimeBudget(next, expected);
    next.expected_scheduled_periods = expected;
    if(countFixedScheduledLessons(data) > 0){
      next.fixed_lesson_session_time_limit = Math.max(
        45,
        Math.min(60, Number(next.fixed_lesson_session_time_limit || 60) || 60)
      );
      next.fixed_lesson_period_time_limit = Math.max(
        30,
        Math.min(45, Number(next.fixed_lesson_period_time_limit || 45) || 45)
      );
      next.native_fresh_empty_moves = true;
      next.native_hint_quality_cleanup_time_limit_ms = 0;
      next.native_hint_bank_candidate_cleanup_time_ms = Math.max(
        6500,
        Number(next.native_hint_bank_candidate_cleanup_time_ms || 0) || 0
      );
      next.native_hint_bank_hard_repair_violation_cap = Math.max(
        64,
        Number(next.native_hint_bank_hard_repair_violation_cap || 0) || 0
      );
      next.native_overlay_hard_repair_time_ms = Math.max(
        3500,
        Number(next.native_overlay_hard_repair_time_ms || 0) || 0
      );
      next.native_teacher_session_compact_time_limit_ms = Math.max(
        5000,
        Number(next.native_teacher_session_compact_time_limit_ms || 0) || 0
      );
      next.native_rehome_swap_row_limit = Math.max(
        260,
        Number(next.native_rehome_swap_row_limit || 0) || 0
      );
      next.native_rehome_swap_check_limit = Math.max(
        180000,
        Number(next.native_rehome_swap_check_limit || 0) || 0
      );
      next.native_rehome_swap_pair_candidate_limit = Math.max(
        96,
        Number(next.native_rehome_swap_pair_candidate_limit || 0) || 0
      );
      next.native_rehome_swap_triple_candidate_limit = Math.max(
        28,
        Number(next.native_rehome_swap_triple_candidate_limit || 0) || 0
      );
      next.native_quality_cleanup_max_iters = Math.max(
        120,
        Number(next.native_quality_cleanup_max_iters || 0) || 0
      );
      next.local_one_period_cleanup_time_limit = Math.max(
        18,
        Number(next.local_one_period_cleanup_time_limit || 0) || 0
      );
      next.one_period_cluster_repair_time_limit = Math.max(
        18,
        Number(next.one_period_cluster_repair_time_limit || 0) || 0
      );
      next.session_priority_rescue_time_limit = Math.max(
        18,
        Number(next.session_priority_rescue_time_limit || 0) || 0
      );
    }
    next.num_workers = hardwareWorkerCount();
    const partialRepairState = applyPartialExistingRepairSettings(next, data, "few_unassigned_fast_quality");
    if(!partialRepairState && shouldUseScheduleDiversity(next)){
      applyScheduleDiversitySettings(next, data);
    }else{
      disableScheduleDiversitySettings(next);
    }
    return enforceNoHintFreshSolveSettings(next);
  }

  function classIdForLesson(payload, lesson){
    if(lesson.classId) return String(lesson.classId);
    const found = (payload.classes || []).find(item => item.name === lesson.className);
    return found ? String(found.id) : String(lesson.className || "");
  }

  function subjectKey(value){
    const raw = String(value == null ? "" : value);
    try{
      if(typeof normKey === "function") return normKey(raw);
    }catch(_){}
    try{
      return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
    }catch(_){
      return raw.trim().toLowerCase();
    }
  }

  function addSubjectAliases(set, value){
    const raw = String(value == null ? "" : value).trim();
    if(!raw) return;
    set.add(subjectKey(raw));
    try{
      if(typeof findMonHoc === "function"){
        const meta = findMonHoc(raw);
        ["ten", "ma", "ma2", "id"].forEach(key => {
          const item = String(meta?.[key] || "").trim();
          if(item) set.add(subjectKey(item));
        });
      }
    }catch(_){}
  }

  function makeUiSubjectResolver(data){
    const cache = new Map();
    return (classId, rawSubject) => {
      const subject = String(rawSubject || "").trim();
      if(!subject) return "";
      const cacheKey = `${String(classId || "")}|${subject}`;
      if(cache.has(cacheKey)) return cache.get(cacheKey);
      let resolved = subject;
      try{
        const lop = (data?.lop || []).find(item => String(item.id) === String(classId));
        const canon = typeof getLopCanonById === "function"
          ? getLopCanonById(classId)
          : String(lop?.ten2 || lop?.ten || classId || "").trim();
        const khoiNum = typeof extractKhoiNumber === "function"
          ? (extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || "")
          : "";
        const uiSubjects = typeof computeMonsForClass === "function"
          ? (computeMonsForClass(khoiNum, canon) || []).map(item => String(item?.ten || "").trim()).filter(Boolean)
          : [];
        const rawAliases = new Set();
        addSubjectAliases(rawAliases, subject);
        const match = uiSubjects.find(item => {
          const aliases = new Set();
          addSubjectAliases(aliases, item);
          return Array.from(rawAliases).some(key => aliases.has(key));
        });
        if(match) resolved = match;
      }catch(_){}
      cache.set(cacheKey, resolved);
      return resolved;
    };
  }

  function parseOffKey(key){
    const parts = String(key || "").split("|");
    if(parts.length !== 3) return null;
    const thu = parts[0];
    const buoi = parts[1];
    const ti = Number(parts[2]);
    if(!thu || (buoi !== "sang" && buoi !== "chieu") || !Number.isFinite(ti)) return null;
    return {thu, buoi, ti, key: `${thu}|${buoi}|${ti}`};
  }

  function ensureFixedOffModel(data){
    data.tkbConstraints = data.tkbConstraints && typeof data.tkbConstraints === "object" ? data.tkbConstraints : {};
    const c = data.tkbConstraints;
    c.fixedOff = c.fixedOff && typeof c.fixedOff === "object" ? c.fixedOff : {};
    ["class","teacher","subject","room","subjectGroup"].forEach(type => {
      c.fixedOff[type] = c.fixedOff[type] && typeof c.fixedOff[type] === "object" ? c.fixedOff[type] : {};
    });
    return c.fixedOff.class;
  }

  function collectOffLocks(data){
    const locks = {};
    const add = (classId, key) => {
      const parsed = parseOffKey(key);
      const id = String(classId || "");
      if(!id || !parsed) return;
      if(!locks[id]) locks[id] = new Set();
      locks[id].add(parsed.key);
    };

    Object.entries(data.tkbUserOff || {}).forEach(([classId, raw]) => {
      if(Array.isArray(raw)) raw.forEach(key => add(classId, key));
      else if(raw && typeof raw === "object") Object.keys(raw).forEach(key => { if(raw[key]) add(classId, key); });
    });
    Object.entries(data.tkbConstraints?.fixedOff?.class || {}).forEach(([classId, raw]) => {
      if(raw && typeof raw === "object") Object.keys(raw).forEach(key => { if(raw[key]) add(classId, key); });
    });
    return locks;
  }

  function syncOffLocksToData(data, locks){
    data.tkbUserOff = data.tkbUserOff && typeof data.tkbUserOff === "object" ? data.tkbUserOff : {};
    const fixedClass = ensureFixedOffModel(data);
    Object.entries(locks || {}).forEach(([classId, set]) => {
      const keys = Array.from(set || []);
      data.tkbUserOff[classId] = keys;
      fixedClass[classId] = fixedClass[classId] || {};
      keys.forEach(key => { fixedClass[classId][key] = true; });
      if(Object.keys(fixedClass[classId]).length === 0) delete fixedClass[classId];
    });
  }

  function applyOffLocks(nextTkb, locks){
    Object.entries(locks || {}).forEach(([classId, set]) => {
      if(!nextTkb[classId]) nextTkb[classId] = makeEmptyTKB();
      Array.from(set || []).forEach(key => {
        const parsed = parseOffKey(key);
        if(!parsed) return;
        const arr = nextTkb[classId]?.[parsed.thu]?.[parsed.buoi];
        if(arr && parsed.ti >= 0 && parsed.ti < arr.length) arr[parsed.ti] = "OFF";
      });
    });
  }

  function fixedOffSlotMapHas(raw, key){
    const sk = String(key || "");
    if(!sk || !raw) return false;
    if(Array.isArray(raw)) return raw.map(item => String(item || "")).includes(sk);
    if(typeof raw !== "object") return false;
    const value = raw[sk];
    return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
  }

  function fixedOffRootFirstMatch(root, ids, key){
    if(!root || typeof root !== "object") return "";
    const wanted = new Set((ids || []).map(id => String(id || "").trim()).filter(Boolean));
    if(!wanted.size) return "";
    for(const id of wanted){
      if(fixedOffSlotMapHas(root[id], key)) return id;
    }
    const wantedLower = new Set(Array.from(wanted).map(id => id.toLowerCase()));
    for(const [id, slots] of Object.entries(root)){
      const text = String(id || "").trim();
      if(text && wantedLower.has(text.toLowerCase()) && fixedOffSlotMapHas(slots, key)) return text;
    }
    return "";
  }

  function teacherCodesForLesson(data, classId, subject, lesson){
    const seen = new Set();
    const out = [];
    const addList = raw => {
      rescueTeacherList(raw).forEach(code => {
        const text = String(code || "").trim();
        const key = text.toLowerCase();
        if(!text || seen.has(key)) return;
        seen.add(key);
        out.push(text);
      });
    };
    addList(lesson?.teacher);
    addList(rescueTeacherFor(data, classId, subject || lesson?.subject || ""));
    return out;
  }

  function teacherFixedOffViolationForLesson(data, payload, lesson, resolveSubject){
    const classId = classIdForLesson(payload, lesson);
    const d = dayKey(lesson?.day);
    const b = sessionKey(lesson?.session);
    const idx = Number(lesson?.period) - 1;
    if(!classId || !d || !b || !Number.isFinite(idx)) return null;
    const subject = resolveSubject ? resolveSubject(classId, lesson?.subject) : String(lesson?.subject || "").trim();
    const key = `${d}|${b}|${idx}`;
    const teacher = fixedOffRootFirstMatch(
      data?.tkbConstraints?.fixedOff?.teacher || {},
      teacherCodesForLesson(data, classId, subject, lesson),
      key
    );
    if(!teacher) return null;
    return {classId, subject, teacher, thu:d, buoi:b, ti:idx, key};
  }

  function rejectedTeacherFixedOffUnassignedItem(payload, lesson, violation){
    const cls = String(lesson?.className || lesson?.class || violation?.classId || "").trim();
    const subject = String(violation?.subject || lesson?.subject || "").trim();
    return {
      classId: String(violation?.classId || ""),
      className: cls,
      class: cls,
      subject,
      mon: subject,
      teacher: String(violation?.teacher || lesson?.teacher || "").trim(),
      periods: 1,
      count: 1,
      reason: "teacher_fixed_off",
      message: "Tiết rơi vào giờ nghỉ giáo viên nên được giữ ở Chưa phân."
    };
  }

  function filterTeacherFixedOffPayloadLessons(data, payload, resolveSubject){
    const lessons = [];
    const rejected = [];
    (Array.isArray(payload?.lessons) ? payload.lessons : []).forEach(lesson => {
      const violation = teacherFixedOffViolationForLesson(data, payload, lesson, resolveSubject);
      if(violation) rejected.push({lesson, violation});
      else lessons.push(lesson);
    });
    return {lessons, rejected};
  }

  function applyTeacherFixedOffPayloadFilter(payload, filtered){
    const rejected = Array.isArray(filtered?.rejected) ? filtered.rejected : [];
    if(!rejected.length) return 0;
    const lessons = Array.isArray(filtered?.lessons) ? filtered.lessons : [];
    payload.lessons = lessons;
    payload.unassignedLessons = [
      ...(Array.isArray(payload.unassignedLessons) ? payload.unassignedLessons : []),
      ...rejected.map(item => rejectedTeacherFixedOffUnassignedItem(payload, item.lesson, item.violation))
    ];
    payload.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    payload.warnings.push({
      kind: "teacher_fixed_off_rejected",
      count: rejected.length,
      message: `Đã đưa ${rejected.length} tiết trùng giờ nghỉ giáo viên về Tiết chưa phân.`
    });
    payload.metrics = payload.metrics && typeof payload.metrics === "object" ? Object.assign({}, payload.metrics) : {};
    const oldScheduled = metricNumber(payload.metrics.scheduled_periods, lessons.length + rejected.length);
    const oldUnassigned = metricNumber(payload.metrics.unassigned_periods, 0);
    payload.metrics.scheduled_periods = Math.max(0, oldScheduled - rejected.length);
    payload.metrics.unassigned_periods = oldUnassigned + rejected.length;
    const expected = metricNumber(payload.metrics.expected_periods, NaN);
    if(!Number.isFinite(expected)) payload.metrics.expected_periods = payload.metrics.scheduled_periods + payload.metrics.unassigned_periods;
    payload.metrics.best_effort = true;
    payload.bestEffort = true;
    try{
      payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
      payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
        ? payload.solver.runtime_settings
        : {};
      payload.solver.runtime_settings.teacher_fixed_off_rejected = rejected.length;
    }catch(_){}
    return rejected.length;
  }

  function normalizePayloadForUiConstraints(data, payload){
    if(!payload || typeof payload !== "object") return payload;
    try{
      const resolveSubject = makeUiSubjectResolver(data);
      const filtered = filterTeacherFixedOffPayloadLessons(data, payload, resolveSubject);
      applyTeacherFixedOffPayloadFilter(payload, filtered);
    }catch(err){
      console.warn(`[${VERSION}] payload UI constraint normalize failed`, err);
    }
    return payload;
  }

  function currentConstraintViolations(limit){
    const api = window.TKBConstraints || window.TKBConstraintsFull;
    if(!api || typeof api.validateAll !== "function") return [];
    try{
      return api.validateAll(Math.max(1, Number(limit || 3000))) || [];
    }catch(err){
      console.warn(`[${VERSION}] post-apply constraint validate failed`, err);
      return [];
    }
  }

  async function currentConstraintViolationsAsync(limit, options){
    const api = window.TKBConstraints || window.TKBConstraintsFull;
    const max = Math.max(1, Number(limit || 3000));
    const opts = options && typeof options === "object" ? options : {};
    const allowSyncFallback = opts.allowSyncFallback !== false;
    const ignoreStop = opts.ignoreStop === true;
    if(!api) return [];
    if(typeof api.validateAllAsync === "function"){
      try{
        const validate = () => api.validateAllAsync(max, {
          sliceBudgetMs:8,
          shouldCancel:() => ignoreStop ? false : isStopRequested()
        });
        let result = await validate() || [];
        if(result?.stale === true && (ignoreStop || !isStopRequested())) result = await validate() || [];
        if(result?.stale === true && (ignoreStop || !isStopRequested())){
          return allowSyncFallback ? currentConstraintViolations(max) : result;
        }
        return result;
      }catch(err){
        console.warn(`[${VERSION}] async constraint precheck failed`, err);
      }
    }
    return allowSyncFallback ? currentConstraintViolations(max) : [];
  }

  function payloadLessonsPresentInData(data, payload, lessons, resolveSubject){
    const list = Array.isArray(lessons) ? lessons : [];
    return list.filter(lesson => {
      const classId = classIdForLesson(payload, lesson);
      const d = dayKey(lesson?.day);
      const b = sessionKey(lesson?.session);
      const idx = Number(lesson?.period) - 1;
      if(!classId || !d || !b || !Number.isFinite(idx)) return false;
      const value = data?.tkb?.[classId]?.[d]?.[b]?.[idx];
      const placed = cellSubjectText(value);
      if(!placed || placed === "OFF") return false;
      const wanted = resolveSubject ? resolveSubject(classId, lesson?.subject) : String(lesson?.subject || "").trim();
      return fixedLessonCanonicalSubjectKey(placed) === fixedLessonCanonicalSubjectKey(wanted);
    });
  }

  function normalizePayloadMetricsFromData(data, payload, remainingViolations){
    if(!payload || typeof payload !== "object") return;
    payload.metrics = payload.metrics && typeof payload.metrics === "object" ? Object.assign({}, payload.metrics) : {};
    const scheduled = countScheduledLessons(data);
    const expectedFromUi = expectedLessonCount(data);
    const expectedFromPayload = metricNumber(payload.metrics.expected_periods, 0);
    const expected = expectedFromUi > 0 ? expectedFromUi : Math.max(expectedFromPayload, scheduled);
    const unassigned = Math.max(0, expected - scheduled);
    const violations = Math.max(0, Number(remainingViolations || 0) || 0);
    payload.metrics.scheduled_periods = scheduled;
    payload.metrics.expected_periods = expected;
    payload.metrics.unassigned_periods = unassigned;
    payload.metrics.app_constraint_violation_count = violations;
    payload.metrics.hard_ok = violations === 0;
    payload.metrics.core_hard_ok = violations === 0;
    payload.metrics.best_effort = unassigned > 0 || violations > 0;
    payload.bestEffort = payload.metrics.best_effort === true;
    payload.validation = payload.validation && typeof payload.validation === "object" ? Object.assign({}, payload.validation) : {};
    payload.validation.hard_ok = violations === 0;
  }

  function boundedDiagnosticScalars(value, maxEntries){
    const source = value && typeof value === "object" ? value : {};
    const limit = Math.max(1, Math.min(32, Number(maxEntries || 24) || 24));
    const result = {};
    for(const [key, raw] of Object.entries(source).slice(0, limit)){
      if(raw == null || typeof raw === "number" || typeof raw === "boolean"){
        result[key] = raw;
      }else if(typeof raw === "string"){
        result[key] = raw.slice(0, 160);
      }
    }
    return result;
  }

  function isApplyPayloadCandidateContractError(err){
    return err?.candidateContractError === true
      || String(err?.kind || err?.payload?.kind || "") === "apply_payload_candidate_contract_rejected";
  }

  function teacherReleaseIndexKey(value){
    return String(value || "").trim().toLocaleLowerCase("vi");
  }

  function addTeacherReleaseIndexCell(index, data, lopId, thu, buoi, ti, value){
    const subject = cellSubjectText(value);
    if(!subject || subject === "OFF") return;
    const teachers = rescueTeacherList(rescueTeacherFor(data, lopId, subject));
    if(!teachers.length) return;
    const cell = {
      lopId:String(lopId),
      thu,
      buoi,
      ti:Number(ti),
      fixed:!!(value && typeof value === "object" && value.fixed)
    };
    teachers.forEach(teacher => {
      const key = teacherReleaseIndexKey(teacher);
      if(!key) return;
      if(!index.has(key)) index.set(key, []);
      index.get(key).push(cell);
    });
  }

  function buildTeacherReleaseCellIndex(data){
    const index = new Map();
    const days = Array.isArray(window.DAYS) ? window.DAYS : ["thu2","thu3","thu4","thu5","thu6","thu7"];
    Object.entries(data?.tkb || {}).forEach(([lopId, tkb]) => {
      days.forEach(thu => {
        ["sang","chieu"].forEach(buoi => {
          (tkb?.[thu]?.[buoi] || []).forEach((value, ti) => {
            addTeacherReleaseIndexCell(index, data, lopId, thu, buoi, ti, value);
          });
        });
      });
    });
    return index;
  }

  async function buildTeacherReleaseCellIndexAsync(data, options){
    const opts = options && typeof options === "object" ? options : {};
    const shouldCancel = typeof opts.shouldCancel === "function" ? opts.shouldCancel : null;
    const requestedBudget = Number(opts.sliceBudgetMs || 8);
    const sliceBudgetMs = Math.max(4, Math.min(16, Number.isFinite(requestedBudget) ? requestedBudget : 8));
    const index = new Map();
    const days = Array.isArray(window.DAYS) ? window.DAYS : ["thu2","thu3","thu4","thu5","thu6","thu7"];
    const now = () => (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : Date.now();
    let sliceStarted = now();
    for(const [lopId, tkb] of Object.entries(data?.tkb || {})){
      for(const thu of days){
        for(const buoi of ["sang","chieu"]){
          const periods = tkb?.[thu]?.[buoi] || [];
          for(let ti = 0; ti < periods.length; ti += 1){
            if((shouldCancel && shouldCancel()) || getData() !== data){
              return {index, cancelled:true};
            }
            addTeacherReleaseIndexCell(index, data, lopId, thu, buoi, ti, periods[ti]);
            if(now() - sliceStarted >= sliceBudgetMs){
              await yieldResponsiveUi();
              sliceStarted = now();
              if((shouldCancel && shouldCancel()) || getData() !== data){
                return {index, cancelled:true};
              }
            }
          }
        }
      }
    }
    return {index, cancelled:false};
  }

  function releaseConstraintViolatingLessons(data, options){
    const opts = options && typeof options === "object" ? options : {};
    const api = window.TKBConstraints || window.TKBConstraintsFull;
    const seen = new Set();
    const releasedCells = Array.isArray(opts.releasedCells) ? opts.releasedCells : null;
    let released = 0;
    if(!data || !data.tkb) return 0;

    const releaseCell = (lopId, thu, buoi, ti) => {
      if(!lopId || !thu || (buoi !== "sang" && buoi !== "chieu") || !Number.isFinite(ti)) return false;
      const key = `${lopId}|${thu}|${buoi}|${ti}`;
      if(seen.has(key)) return false;
      seen.add(key);
      const arr = data.tkb?.[lopId]?.[thu]?.[buoi];
      if(!Array.isArray(arr) || ti < 0 || ti >= arr.length) return false;
      const current = arr[ti];
      if(!current || current === "OFF" || (current && typeof current === "object" && current.fixed)) return false;
      if(releasedCells && releasedCells.length < 16){
        releasedCells.push({
          lopId:String(lopId).slice(0, 80),
          thu:String(thu).slice(0, 16),
          buoi:String(buoi).slice(0, 16),
          ti:Number(ti),
          subject:String(cellSubjectText(current) || "").slice(0, 120)
        });
      }
      arr[ti] = "";
      released++;
      return true;
    };

    const getConstraintModel = () => {
      try{
        if(api && typeof api.get === "function") return api.get() || {};
      }catch(_){}
      return data?.tkbConstraints || {};
    };

    let teacherCellIndex = opts.teacherCellIndex && typeof opts.teacherCellIndex.get === "function"
      ? opts.teacherCellIndex
      : null;
    const collectTeacherCells = teacher => {
      if(!teacherCellIndex) teacherCellIndex = buildTeacherReleaseCellIndex(data);
      const teacherKey = teacherReleaseIndexKey(teacher);
      return (teacherCellIndex.get(teacherKey) || []).filter(cell => {
        const current = data.tkb?.[cell.lopId]?.[cell.thu]?.[cell.buoi]?.[cell.ti];
        const subject = cellSubjectText(current);
        if(!subject || subject === "OFF") return false;
        cell.fixed = !!(current && typeof current === "object" && current.fixed);
        return true;
      });
    };

    Object.entries(data?.tkbConstraints?.fixedOff?.teacher || {}).forEach(([teacher, slots]) => {
      Object.keys(slots || {}).forEach(key => {
        if(!fixedOffSlotMapHas(slots, key)) return;
        const parsed = parseOffKey(key);
        if(!parsed) return;
        collectTeacherCells(teacher)
          .filter(cell => cell.thu === parsed.thu && cell.buoi === parsed.buoi && Number(cell.ti) === Number(parsed.ti))
          .forEach(cell => releaseCell(cell.lopId, cell.thu, cell.buoi, cell.ti));
      });
    });

    const chooseAndReleaseTeacherGroups = (cells, limit, groupKey) => {
      const max = Math.max(0, Math.round(Number(limit || 0)));
      if(max <= 0) return 0;
      const groups = new Map();
      cells.forEach(cell => {
        const key = groupKey(cell);
        if(!key) return;
        if(!groups.has(key)) groups.set(key, []);
        groups.get(key).push(cell);
      });
      const overflow = groups.size - max;
      if(overflow <= 0) return 0;
      let count = 0;
      Array.from(groups.entries())
        .map(([key, group]) => ({
          key,
          group,
          fixedCount: group.filter(cell => cell.fixed).length,
          flexCount: group.filter(cell => !cell.fixed).length
        }))
        .sort((a, b) =>
          (a.fixedCount > 0 ? 1 : 0) - (b.fixedCount > 0 ? 1 : 0) ||
          a.flexCount - b.flexCount ||
          a.group.length - b.group.length ||
          String(a.key).localeCompare(String(b.key), "vi")
        )
        .slice(0, overflow)
        .forEach(item => {
          item.group.forEach(cell => {
            if(releaseCell(cell.lopId, cell.thu, cell.buoi, cell.ti)) count++;
          });
        });
      return count;
    };

    const releaseAggregateTeacherOverflows = () => {
      const constraints = getConstraintModel();
      const teacherRules = constraints?.teacher || {};
      let count = 0;
      Object.entries(teacherRules).forEach(([teacher, rule]) => {
        if(!teacher || !rule || typeof rule !== "object") return;
        let cells = collectTeacherCells(teacher);
        count += chooseAndReleaseTeacherGroups(cells, rule?.maxDaysSessions?.maxDays, cell => cell.thu);
        cells = collectTeacherCells(teacher);
        count += chooseAndReleaseTeacherGroups(cells, rule?.maxDaysSessions?.maxSessions, cell => `${cell.thu}|${cell.buoi}`);
        cells = collectTeacherCells(teacher).filter(cell => cell.buoi === "sang");
        count += chooseAndReleaseTeacherGroups(cells, rule?.maxMorningAfternoon?.morning, cell => `${cell.thu}|${cell.buoi}`);
        cells = collectTeacherCells(teacher).filter(cell => cell.buoi === "chieu");
        count += chooseAndReleaseTeacherGroups(cells, rule?.maxMorningAfternoon?.afternoon, cell => `${cell.thu}|${cell.buoi}`);
      });
      return count;
    };

    const isAggregateTeacherOverflowMessage = item => {
      const kind = String(item?.kind || "");
      if(["teacher.maxDays", "teacher.maxSessions", "teacher.maxMorning", "teacher.maxAfternoon"].includes(kind)) return true;
      const text = String(item?.message || item || "").toLowerCase();
      const plain = (() => {
        try{
          return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
        }catch(_){
          return text;
        }
      })();
      return text.includes("vượt giới hạn số ngày dạy/tuần") ||
        text.includes("vượt giới hạn số buổi dạy/tuần") ||
        text.includes("buổi sáng/tuần") ||
        text.includes("buổi chiều/tuần") ||
        plain.includes("vuot gioi han so ngay day/tuan") ||
        plain.includes("vuot gioi han so buoi day/tuan") ||
        plain.includes("buoi sang/tuan") ||
        plain.includes("buoi chieu/tuan");
    };

    const isFixedOffViolationMessage = item => {
      const kind = String(item?.kind || "");
      if(String(kind).startsWith("fixedOff.")) return true;
      const text = String(item?.message || item || "").toLowerCase();
      const plain = (() => {
        try{
          return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
        }catch(_){
          return text;
        }
      })();
      return text.includes("đã cố định") ||
        text.includes("nghỉ cố định") ||
        plain.includes("da co dinh") ||
        plain.includes("nghi co dinh");
    };

    const offLocks = collectOffLocks(data);
    Object.entries(offLocks || {}).forEach(([lopId, set]) => {
      Array.from(set || []).forEach(key => {
        const parsed = parseOffKey(key);
        if(parsed) releaseCell(String(lopId), parsed.thu, parsed.buoi, parsed.ti);
      });
    });

    // Aggregate teacher rules (maximum teaching days/sessions) do not point to
    // one concrete timetable cell.  Release the smallest non-fixed group so a
    // near-complete repair can move those lessons instead of rebuilding a good
    // timetable from scratch.
    releaseAggregateTeacherOverflows();

    if(api && (Array.isArray(opts.violations) || typeof api.validateAll === "function")){
      let violations = Array.isArray(opts.violations) ? opts.violations : [];
      if(!Array.isArray(opts.violations)){
        try{
          violations = api.validateAll(3000) || [];
        }catch(err){
          console.warn(`[${VERSION}] constraint precheck failed`, err);
          violations = [];
        }
      }
      violations.forEach(item => {
        if(isAggregateTeacherOverflowMessage(item)) return;
        if(!isFixedOffViolationMessage(item)) return;
        releaseCell(
          String(item?.lopId || ""),
          String(item?.thu || ""),
          String(item?.buoi || ""),
          Number(item?.ti)
        );
      });
    }
    if(released > 0){
      if(opts.persist !== false){
        try{ callMaybe("saveStore", [{force:true}]); }catch(_){}
      }
      if(opts.refresh !== false) scheduleUiRefresh();
      if(opts.silent !== true){
        setStatus(`Đã đưa ${released} tiết đang vi phạm ràng buộc về Chưa phân để xếp lại.`, "warning");
      }
    }
    return released;
  }

  function isQuickCompleteResult(payload, solveSettings){
    const runtime = payload?.solver?.runtime_settings && typeof payload.solver.runtime_settings === "object"
      ? payload.solver.runtime_settings
      : {};
    const explicitMode = String(solveSettings?.ui_requested_solve_mode || "").trim();
    if(explicitMode){
      return normalizeSolveRequestMode(explicitMode) === SOLVE_REQUEST_MODES.quickComplete;
    }
    const explicitFocus = String(solveSettings?.optimization_focus || "").trim();
    if(explicitFocus){
      return normalizeSolveRequestMode(explicitFocus) === SOLVE_REQUEST_MODES.quickComplete;
    }
    const candidates = [
      payload?.solveRequestMode,
      payload?.solve_request_mode,
      payload?.optimizationFocus,
      payload?.optimization_focus,
      runtime.ui_requested_solve_mode,
      runtime.optimization_focus,
      runtime.solveRequestMode,
      runtime.solve_request_mode
    ];
    return candidates.some(value => normalizeSolveRequestMode(value) === SOLVE_REQUEST_MODES.quickComplete);
  }

  async function applyPayload(payload, solveSettings){
    const data = getData();
    // Search-policy learning is durable even when this candidate is later
    // rejected and the visible timetable is restored.
    rememberRefinementLearning(data, payload, false);
    if(!data) throw new Error("Không tìm thấy DATA của giao diện.");
    const applyNow = () => {
      try{ return window.performance?.now?.() ?? Date.now(); }
      catch(_){ return Date.now(); }
    };
    let applySliceStarted = applyNow();
    const yieldApplySlice = async force => {
      if(force !== true && applyNow() - applySliceStarted < 8) return;
      await yieldResponsiveUi();
      applySliceStarted = applyNow();
    };
    traceSolveStep("solve:apply-start", {
      lessons:Array.isArray(payload?.lessons) ? payload.lessons.length : 0,
      classes:Array.isArray(payload?.classes) ? payload.classes.length : 0
    });
    await yieldApplySlice(true);
    const backendMetricsBeforeApply = payload?.metrics && typeof payload.metrics === "object"
      ? Object.assign({}, payload.metrics)
      : {};
    const backendRuntimeBeforeApply = boundedDiagnosticScalars(payload?.solver?.runtime_settings, 24);
    const backendScheduledBeforeApply = metricNumber(backendMetricsBeforeApply.scheduled_periods);
    const backendExpectedBeforeApply = metricNumber(backendMetricsBeforeApply.expected_periods);
    const backendUnassignedBeforeApply = metricNumber(backendMetricsBeforeApply.unassigned_periods);
    const backendWasCompleteBeforeApply = backendExpectedBeforeApply > 0
      && backendScheduledBeforeApply >= backendExpectedBeforeApply
      && backendUnassignedBeforeApply <= 0
      && payload?.bestEffort !== true
      && backendMetricsBeforeApply.best_effort !== true
      && backendMetricsBeforeApply.hard_ok !== false;
    if(!data.tkb || typeof data.tkb !== "object") data.tkb = {};
    const offLocks = collectOffLocks(data);
    const fixedLessonLocks = collectFixedLessonLocks(data);
    const resolveSubject = makeUiSubjectResolver(data);
    const teacherOffFiltered = filterTeacherFixedOffPayloadLessons(data, payload, resolveSubject);
    const teacherOffRejected = applyTeacherFixedOffPayloadFilter(payload, teacherOffFiltered);
    let payloadLessons = teacherOffFiltered.lessons;
    await yieldApplySlice(true);
    const fixedSubjectRemainders = new Map();
    for(const [key, lock] of fixedLessonLocks.entries()){
      const parts = String(key || "").split("|");
      if(parts.length !== 4) continue;
      const classId = String(parts[0] || "");
      const subject = fixedLessonLockSubject(lock);
      const subjectKeyValue = fixedLessonCanonicalSubjectKey(subject);
      if(!classId || !subjectKeyValue) continue;
      const countKey = `${classId}|${subjectKeyValue}`;
      fixedSubjectRemainders.set(countKey, Number(fixedSubjectRemainders.get(countKey) || 0) + 1);
      await yieldApplySlice(false);
    }
    const consumeFixedSubject = (classId, subject) => {
      const subjectKeyValue = fixedLessonCanonicalSubjectKey(subject);
      if(!classId || !subjectKeyValue) return false;
      const countKey = `${classId}|${subjectKeyValue}`;
      const remain = Number(fixedSubjectRemainders.get(countKey) || 0);
      if(remain <= 0) return false;
      fixedSubjectRemainders.set(countKey, remain - 1);
      return true;
    };

    const nextTkb = {};
    for(const cls of (payload.classes || [])){
      const classId = String(cls.id || cls.name || "");
      if(!classId) continue;
      nextTkb[classId] = makeEmptyTKB();
      await yieldApplySlice(false);
    }

    for(const lesson of payloadLessons){
      const classId = classIdForLesson(payload, lesson);
      if(!classId) continue;
      if(!nextTkb[classId]) nextTkb[classId] = makeEmptyTKB();
      const d = dayKey(lesson.day);
      const b = sessionKey(lesson.session);
      const idx = Number(lesson.period) - 1;
      const subject = resolveSubject(classId, lesson.subject);
      const fixedKey = fixedLessonLockKey(classId, d, b, idx);
      const fixedLock = fixedLessonLocks.get(fixedKey);
      if(fixedLock && !fixedLessonLockMatches(fixedLock, subject)) continue;
      if(!fixedLock && consumeFixedSubject(classId, subject)) continue;
      if(nextTkb[classId]?.[d]?.[b] && idx >= 0 && idx < nextTkb[classId][d][b].length){
        const keepFixed = fixedLessonLockMatches(fixedLock, subject);
        if(keepFixed) consumeFixedSubject(classId, subject);
        nextTkb[classId][d][b][idx] = keepFixed ? {mon: fixedLessonLockSubject(fixedLock, subject), fixed: true} : subject;
      }
      await yieldApplySlice(false);
    }
    applyOffLocks(nextTkb, offLocks);
    applyFixedLessonLocks(nextTkb, fixedLessonLocks);
    await yieldApplySlice(true);

    data.tkb = nextTkb;
    data.tkbLessonTeachers = {};
    data.tkbLessonRooms = {};
    for(const lesson of payloadLessons){
      const classId = classIdForLesson(payload, lesson);
      const subject = resolveSubject(classId, lesson.subject);
      const rawSubject = String(lesson.subject || "").trim();
      if(!classId || !subject) continue;
      data.tkbLessonTeachers[`${classId}|${subject}`] = String(lesson.teacher || "").trim();
      data.tkbLessonRooms[`${classId}|${subject}`] = String(lesson.room || "").trim();
      if(rawSubject && rawSubject !== subject){
        data.tkbLessonTeachers[`${classId}|${rawSubject}`] = String(lesson.teacher || "").trim();
        data.tkbLessonRooms[`${classId}|${rawSubject}`] = String(lesson.room || "").trim();
      }
      await yieldApplySlice(false);
    }
    syncOffLocksToData(data, offLocks);
    await yieldApplySlice(true);
    // Cloud Run/VPS server-owned capacity results already carry the canonical
    // accounting, placement and hard-conflict proof. Re-running the complete
    // browser constraint scanner over a 2,000+ period timetable here can block
    // the main thread for minutes and prevent the trusted result from being
    // saved. Keep the full defensive UI validation for every other candidate;
    // this narrow fast path is guarded by the server proof (or the explicit
    // capacity probe marker) and the unchanged-schedule apply fence above.
    const trustedServerOwnedCapacityPartial = (
      payloadIsSafeCapacityPartial(payload)
      && (
        String(solveSettings?.ui_agent_execution_policy || "").trim().toLowerCase() === "server_owned"
        || payload?.solver?.runtime_settings?.ui_capacity_safe_fresh_probe === true
      )
    );
    let teacherIndexResult = {index:new Map(), cancelled:false};
    let postApplyValidation = [];
    let postApplyViolations = [];
    let postApplyReleasedCells = [];
    let postApplyReleased = 0;
    if(!trustedServerOwnedCapacityPartial){
      teacherIndexResult = await buildTeacherReleaseCellIndexAsync(data, {
        sliceBudgetMs:8,
        shouldCancel:() => false
      });
      postApplyValidation = await currentConstraintViolationsAsync(3000, {
        allowSyncFallback:false,
        ignoreStop:true
      });
      postApplyViolations = Array.isArray(postApplyValidation) ? postApplyValidation : [];
      postApplyReleasedCells = [];
      postApplyReleased = releaseConstraintViolatingLessons(data, {
        violations:postApplyViolations,
        teacherCellIndex:teacherIndexResult?.index,
        releasedCells:postApplyReleasedCells,
        persist:false,
        refresh:false,
        silent:true
      });
      try{
        payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
        payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
          ? payload.solver.runtime_settings
          : {};
        payload.solver.runtime_settings.ui_post_apply_validation_skipped = false;
      }catch(_){ }
    }else{
      try{
        payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
        payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
          ? payload.solver.runtime_settings
          : {};
        payload.solver.runtime_settings.ui_post_apply_validation_skipped = true;
        payload.solver.runtime_settings.ui_post_apply_validation_reason = "server_owned_capacity_proof";
      }catch(_){ }
    }
    if(postApplyReleased > 0){
      payload.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      payload.warnings.push({
        kind: "ui_constraint_released_after_apply",
        count: postApplyReleased,
        message: `Đã đưa ${postApplyReleased} tiết vi phạm ràng buộc hiển thị về Tiết chưa phân.`
      });
    }
    const remainingValidation = postApplyReleased > 0
      ? await currentConstraintViolationsAsync(3000, {
          allowSyncFallback:false,
          ignoreStop:true
        })
      : postApplyViolations;
    payloadLessons = payloadLessonsPresentInData(data, payload, payloadLessons, resolveSubject);
    payload.lessons = payloadLessons;
    const remainingViolations = Array.isArray(remainingValidation) ? remainingValidation.length : 0;
    normalizePayloadMetricsFromData(data, payload, remainingViolations);
    await yieldApplySlice(true);
    if(backendWasCompleteBeforeApply){
      const appliedScheduled = metricNumber(payload?.metrics?.scheduled_periods);
      const appliedExpected = metricNumber(payload?.metrics?.expected_periods);
      const appliedUnassigned = metricNumber(payload?.metrics?.unassigned_periods);
      const appliedHardOk = payload?.metrics?.hard_ok !== false
        && payload?.metrics?.core_hard_ok !== false
        && payload?.validation?.hard_ok !== false
        && remainingViolations === 0;
      const rejectedCount = Math.max(0, teacherOffRejected) + Math.max(0, postApplyReleased);
      const candidateContractRejected = rejectedCount > 0
        || postApplyViolations.length > 0
        || remainingViolations > 0
        || appliedExpected <= 0
        || appliedScheduled < appliedExpected
        || appliedUnassigned > 0
        || !appliedHardOk;
      if(candidateContractRejected){
        const err = new Error(
          `Backend đã xếp đủ ${backendScheduledBeforeApply}/${backendExpectedBeforeApply} tiết, `
          + `nhưng khi áp dụng vào giao diện chỉ còn ${appliedScheduled}/${appliedExpected}. `
          + "Hệ thống đã từ chối nghiệm này để bảo toàn thời khóa biểu."
        );
        err.kind = "apply_payload_candidate_contract_rejected";
        err.candidateContractError = true;
        err.backendScheduled = backendScheduledBeforeApply;
        err.backendExpected = backendExpectedBeforeApply;
        err.appliedScheduled = appliedScheduled;
        err.appliedExpected = appliedExpected;
        err.rejectedCount = rejectedCount;
        err.releasedCount = postApplyReleased;
        err.remainingViolations = remainingViolations;
        err.payload = {
          ok:false,
          kind:err.kind,
          error:err.message,
          diagnostics:{
            rejected_periods:rejectedCount,
            released_periods:Math.max(0, postApplyReleased),
            released_cells:postApplyReleasedCells,
            post_apply_violation_count:postApplyViolations.length,
            post_apply_violations:postApplyViolations.slice(0, 8).map(item => ({
              kind:String(item?.kind || "").slice(0, 80),
              message:String(item?.message || item || "").slice(0, 200),
              lopId:String(item?.lopId || "").slice(0, 80),
              thu:String(item?.thu || "").slice(0, 16),
              buoi:String(item?.buoi || "").slice(0, 16),
              ti:Number.isFinite(Number(item?.ti)) ? Number(item.ti) : null
            })),
            remaining_violation_count:remainingViolations,
            backend_metrics:boundedDiagnosticScalars(backendMetricsBeforeApply, 24),
            applied_metrics:boundedDiagnosticScalars(payload?.metrics, 24),
            backend_runtime_settings:backendRuntimeBeforeApply
          }
        };
        throw err;
      }
    }
    const compactAppliedPayload = compactSolverResultForSnapshot(payload) || {};
    data.tkbSolverResult = Object.assign({}, compactAppliedPayload, {
      version: VERSION,
      generatedAt: payload.generatedAt || new Date().toISOString(),
      lessons: payloadLessons
    });
    if(teacherOffRejected > 0){
      data.tkbSolverResult.teacherFixedOffRejected = teacherOffRejected;
    }
    if(postApplyReleased > 0){
      data.tkbSolverResult.constraintReleasedAfterApply = postApplyReleased;
    }
    const automaticCycleIntent = automaticSortCycleIntentFromSettings(solveSettings)
      || automaticSortCycleIntentFromSettings(payload?.solver?.runtime_settings);
    if(automaticCycleIntent){
      // Commit the click marker into DATA and the compact solver payload before
      // the trusted timetable save. Result and click count therefore share one
      // serialized remote payload instead of racing as two independent writes.
      rememberAutomaticSortSuccess(
        data,
        automaticCycleIntent.previousState,
        automaticCycleIntent.planKind
      );
    }
    const quickResult = isQuickCompleteResult(payload, solveSettings);
    const quickCompletion = payloadCompletion(data.tkbSolverResult);
    const previousGapBaseline = Object.prototype.hasOwnProperty.call(data, GAP_PROGRESS_BASELINE_DATA_KEY)
      ? clonePlain(data[GAP_PROGRESS_BASELINE_DATA_KEY])
      : undefined;
    const shouldRememberQuickBaseline = quickResult && quickCompletion.complete;
    if(shouldRememberQuickBaseline){
      rememberQuickGapProgressBaseline(data, data.tkbSolverResult);
    }
    const appliedMetrics = payload?.metrics || {};
    const applySaveStartedAt = Date.now();
    const saveStoreFn = window.saveStore;
    let applySaveOutcome = {timedOut:false};
    try{
      if(typeof saveStoreFn === "function"){
        applySaveOutcome = await awaitTrustedSolverApplySave(
          saveStoreFn,
          {
            force:true,
            awaitRemote:true,
            trustedSolverApply:true,
            knownStats:{
              total:metricNumber(appliedMetrics.expected_periods),
              assigned:metricNumber(appliedMetrics.scheduled_periods),
              missing:metricNumber(appliedMetrics.unassigned_periods)
            }
          },
          payload
        );
      }
    }catch(err){
      if(shouldRememberQuickBaseline){
        if(previousGapBaseline === undefined) delete data[GAP_PROGRESS_BASELINE_DATA_KEY];
        else data[GAP_PROGRESS_BASELINE_DATA_KEY] = previousGapBaseline;
      }
      throw err;
    }
    traceSolveStep("solve:apply-save-done", {
      elapsedMs:Math.max(0, Date.now() - applySaveStartedAt),
      deferred:applySaveOutcome?.timedOut === true
    });
    if(applySaveOutcome?.timedOut === true){
      const runtime = data.tkbSolverResult?.solver?.runtime_settings;
      if(runtime && typeof runtime === "object"){
        runtime.ui_terminal_apply_save_pending = true;
        runtime.ui_terminal_apply_save_watchdog_ms = terminalApplySaveWatchdogMs();
      }
      try{
        window.__TKB_SOLVER_SAVE_PENDING = true;
        window.__TKB_SOLVER_SAVE_PENDING_JOB_ID = String(applySaveOutcome.jobId || "");
      }catch(_){ }
    }else{
      try{
        window.__TKB_SOLVER_SAVE_PENDING = false;
        window.__TKB_SOLVER_SAVE_PENDING_JOB_ID = "";
      }catch(_){ }
    }
    // Keep the canonical result recoverable until validation, DATA mutation,
    // and persistence have all succeeded. Mobile Safari may terminate the PWA
    // at any await above; settling before this commit point leaves a blank grid
    // while also hiding the completed server result on the next launch.
    if(applySaveOutcome?.timedOut !== true){
      settleDeferredBackendResultForPayload(payload);
    }
    scheduleUiRefresh();
    await yieldApplySlice(true);
    traceSolveStep("solve:apply-done", {
      lessons:payloadLessons.length,
      released:postApplyReleased,
      remainingViolations
    });
    return data.tkbSolverResult;
  }

  async function postSolve(settings, dataOverride, conflictRetry){
    const data = dataOverride || getData();
    if(
      window.__TKB_DEFER_SERVER_RESULT_SETTLEMENT_UNTIL_APPLY === true
      && deferredBackendResultJobId
    ){
      // A newer canonical request is taking over the one durable pending slot.
      // The current solve pipeline already owns the previous decoded payload.
      settleDeferredBackendResult(deferredBackendResultJobId);
    }
    if(!data) throw new Error("Không tìm thấy DATA của giao diện.");
    if(backendAuthRequired){
      throw serverJobAuthRequiredError(
        Number(window.__TKB_SOLVER_AUTH_REQUIRED?.status || 401) || 401
      );
    }
    const resumeLifecycleActive = window.__TKB_SERVER_JOB_RESUME_STARTED === true;
    const explicitResumeOnly = settings?.ui_resume_existing_server_job_only === true;
    const consumedResumeJobId = String(window.__TKB_SERVER_JOB_RESUME_CONSUMED_ID || "").trim();
    const resumeTarget = activeBackendResumeTarget && typeof activeBackendResumeTarget === "object"
      ? activeBackendResumeTarget
      : null;
    // Capture the durable source before solver-only normalization mutates DATA.
    // A reload restores this source, not transient default groups or duplicated
    // off-lock mirrors created only while preparing the solver request.
    const sourceScheduleFingerprint = durableScheduleFingerprint(data);
    let pendingBackendJob = readPendingBackendJob();
    // The owner tab may consume/remove the shared localStorage entry while a
    // foregrounded iPhone is still entering the resume path. The state probe
    // already authenticated this exact job, so retain a read-only synthetic
    // descriptor for this one poll instead of throwing or reposting it.
    if(
      !pendingBackendJob?.jobId
      && resumeLifecycleActive
      && resumeTarget?.jobId
    ){
      pendingBackendJob = Object.assign({}, resumeTarget, {
        scheduleFingerprint:String(resumeTarget.scheduleFingerprint || sourceScheduleFingerprint || ""),
        discoveredFromOwnerState:true,
        observeOnly:false
      });
    }
    // Resume mode is one-shot. Once its canonical response has been consumed,
    // any later request in the same click is a deliberate sequential fallback
    // and may submit a new job; it must not be mistaken for a duplicate poll.
    const resumeTargetMatches = !!(
      resumeLifecycleActive
      && resumeTarget?.jobId
      && pendingBackendJob?.jobId === String(resumeTarget.jobId)
    );
    const resumeExistingServerJobOnly = explicitResumeOnly
      || (
        resumeLifecycleActive
        && !consumedResumeJobId
        && !!pendingBackendJob?.jobId
        && (!resumeTarget?.jobId || resumeTargetMatches)
      );
    if(pendingBackendJob?.observeOnly === true){
      const err = new Error("Observer-only jobs cannot submit, cancel, or apply a solver result.");
      err.kind = "solver_observer_only";
      err.backendUnavailable = false;
      throw err;
    }
    if(
      pendingBackendJob?.scheduleFingerprint
      && !durableScheduleFingerprintMatches(pendingBackendJob.scheduleFingerprint, data)
    ){
      if(resumeExistingServerJobOnly){
        removePendingBackendJob(pendingBackendJob.jobId);
        const err = new Error("Lượt xếp đang theo dõi không còn khớp với thời khóa biểu hiện tại.");
        err.kind = "solver_resume_schedule_changed";
        throw err;
      }
      await cancelBackendSolver(pendingBackendJob.jobId);
      removePendingBackendJob(pendingBackendJob.jobId);
      pendingBackendJob = null;
    }
    const resumeLifecycleNeedsFirstJob = resumeLifecycleActive && !consumedResumeJobId;
    if(
      (resumeExistingServerJobOnly || resumeLifecycleNeedsFirstJob)
      && !pendingBackendJob?.jobId
    ){
      const err = new Error("Không còn lượt xếp máy chủ để tiếp tục theo dõi.");
      err.kind = "solver_resume_missing";
      throw err;
    }
    traceSolveStep("postSolve:start", {
      optimizeExisting: settings?.optimize_existing_schedule === true,
      preserveExisting: isTruthySetting(settings?.preserve_existing_tkb),
      skipPreRelease: settings?.ui_skip_pre_solve_constraint_release === true
    });
    if(!resumeExistingServerJobOnly){
      try{
        const rb = window.TKBConstraints || window.TKBConstraintsFull;
        if(rb && typeof rb.syncDefaultGroups === "function") rb.syncDefaultGroups();
      }catch(_){}
    }
    await yieldResponsiveUi();
    const optimizeExistingOnly = settings?.optimize_existing_schedule === true;
    const skipPreSolveRelease = settings?.ui_skip_pre_solve_constraint_release === true;
    const releasedViolatingLessons = resumeExistingServerJobOnly || optimizeExistingOnly || skipPreSolveRelease
      ? 0
      : releaseConstraintViolatingLessons(data);
    if(releasedViolatingLessons > 0){
      window.__TKB_SOLVE_RELEASED_CONSTRAINT_VIOLATIONS = Math.max(
        Number(window.__TKB_SOLVE_RELEASED_CONSTRAINT_VIOLATIONS || 0) || 0,
        releasedViolatingLessons
      );
    }
    await yieldResponsiveUi();
    if(!resumeExistingServerJobOnly){
      syncOffLocksToData(data, collectOffLocks(data));
    }
    const effectiveSettings = effectiveSettingsForSolve(settings, data);
    await yieldResponsiveUi();
    enforceCompleteScheduleForUi(effectiveSettings);
    if(!effectiveSettings.ui_capacity_safe_fresh_probe
      && !shouldRequireCompletePresetResult(effectiveSettings)
      && (isCapacityShortageAccepted(settings) || isCapacityShortageAccepted(effectiveSettings))){
      applyCapacityShortageAcceptedSettings(effectiveSettings);
    }
    enforceCompletePresetSolveSettings(effectiveSettings);
    clearPostRollbackSettings(effectiveSettings);
    const activeSolveRunId = String(window.__TKB_ACTIVE_SOLVE_RUN_ID || "");
    const requestApplyGuardFingerprint = durableScheduleFingerprint(data);
    const canonicalFocus = optimizationFocusForSolveRequestMode(
      effectiveSettings.ui_requested_solve_mode || effectiveSettings.optimization_focus
    );
    const hybridCloudRunRequest = String(effectiveSettings.ui_hybrid_executor || "")
      .trim().toLowerCase() === "cloud_run";
    const focusedRequest = ["singletons", "sessions", "gaps"].includes(canonicalFocus);
    effectiveSettings.ui_schedule_scope = hybridCloudRunRequest || focusedRequest
      ? backendHybridDedupeScope(effectiveSettings, data)
      : backendScheduleScope();
    if(sourceScheduleFingerprint){
      effectiveSettings.ui_schedule_fingerprint = sourceScheduleFingerprint;
    }else if(hybridCloudRunRequest || focusedRequest){
      // Focused/Hybrid requests need a durable incumbent key even when the
      // caller did not provide the old auto-sort source fingerprint.
      effectiveSettings.ui_schedule_fingerprint = durableScheduleFingerprint(data);
    }else{
      delete effectiveSettings.ui_schedule_fingerprint;
    }
    let solveRunId = pendingBackendJob?.jobId || (activeSolveRunId
      ? `${activeSolveRunId}:req:${Date.now()}:${Math.random().toString(36).slice(2)}`
      : makeSolveRunId());
    const partialRepairState = applyPartialExistingRepairSettings(effectiveSettings, data, "few_unassigned_before_post");
    if(partialRepairState){
      effectiveSettings.optimize_existing_schedule = effectiveSettings.ui_unified_partial_repair !== true;
      effectiveSettings.existing_fill_missing_schedule = true;
      effectiveSettings.force_fresh_backend_solve = true;
      effectiveSettings.solve_run_id = solveRunId;
      effectiveSettings.best_effort_on_timeout = true;
    }
    const expectedForExistingOptimize = expectedLessonCount(data);
    const scheduledForExistingOptimize = countScheduledLessons(data);
    const existingCompleteForOptimize = !partialRepairState
      && effectiveSettings.ui_allow_auto_existing_optimize === true
      && effectiveSettings.ui_default_fresh_sort !== true
      && !optimizeExistingOnly
      && expectedForExistingOptimize > 0
      && scheduledForExistingOptimize >= expectedForExistingOptimize
      && String(effectiveSettings.auto_sort_mode || "fast") === "fast";
    if(existingCompleteForOptimize){
      effectiveSettings.optimize_existing_schedule = true;
      effectiveSettings.existing_fill_missing_schedule = true;
      effectiveSettings.preserve_existing_tkb = true;
      effectiveSettings.force_preserve_partial_existing = true;
      effectiveSettings.preserve_existing_min_ratio = 1;
      effectiveSettings.force_fresh_backend_solve = true;
      effectiveSettings.allow_backend_cache = false;
      effectiveSettings.fresh_randomize = false;
      effectiveSettings.randomize_search = false;
      effectiveSettings.solve_run_id = solveRunId;
      delete effectiveSettings.random_seed;
    }
    let cacheEligible = (
      effectiveSettings.allow_backend_cache === true &&
      effectiveSettings.force_fresh_backend_solve !== true &&
      effectiveSettings.schedule_diversity !== true &&
      !isTruthySetting(effectiveSettings.fresh_randomize) &&
      !isTruthySetting(effectiveSettings.randomize_search)
    );
    if(cacheEligible){
      effectiveSettings.force_fresh_backend_solve = false;
      delete effectiveSettings.solve_run_id;
    }else{
      effectiveSettings.force_fresh_backend_solve = true;
      effectiveSettings.solve_run_id = solveRunId;
    }
    // Admission must keep one stable wire id even when result caching omits solve_run_id.
    effectiveSettings.ui_solve_run_id = solveRunId;
    effectiveSettings.ui_solver_fifo_admission = true;
    effectiveSettings.ui_solver_async_job = true;
    if(releasedViolatingLessons > 0){
      cacheEligible = false;
      effectiveSettings.force_fresh_backend_solve = true;
      effectiveSettings.solve_run_id = solveRunId;
      const scheduledAfterRelease = countScheduledLessons(data);
      const flexibleAfterRelease = countScheduledLessons(data, {flexibleOnly:true});
      effectiveSettings.released_constraint_violations = releasedViolatingLessons;
      effectiveSettings.existing_scheduled_periods = scheduledAfterRelease;
      effectiveSettings.existing_flexible_scheduled_periods = flexibleAfterRelease;
      if(scheduledAfterRelease > 0){
        effectiveSettings.auto_sort_mode = "fast";
        effectiveSettings.preserve_existing_tkb = true;
        effectiveSettings.force_preserve_partial_existing = true;
        effectiveSettings.auto_sort_strategy = "preserve_existing";
        effectiveSettings.partial_existing_rebuild = true;
        effectiveSettings.repair_released_constraint_violations = true;
        effectiveSettings.repair_fill_first = true;
        effectiveSettings.best_effort_on_timeout = true;
        effectiveSettings.fresh_randomize = false;
        effectiveSettings.randomize_search = false;
        delete effectiveSettings.max_teacher_sessions;
        delete effectiveSettings.requested_max_teacher_sessions;
        delete effectiveSettings.target_teacher_sessions;
        delete effectiveSettings.target_gap1_sessions;
        delete effectiveSettings.random_seed;
      }else{
        effectiveSettings.preserve_existing_tkb = false;
        effectiveSettings.auto_sort_strategy = "fresh";
        const randomizeFresh = effectiveSettings.randomize_search == null
          ? true
          : !isFalseSetting(effectiveSettings.randomize_search);
        effectiveSettings.fresh_randomize = randomizeFresh;
        if(randomizeFresh){
          effectiveSettings.fresh_randomize_strategy = effectiveSettings.fresh_randomize_strategy || DEFAULT_SETTINGS.fresh_randomize_strategy;
          effectiveSettings.random_seed = makeRandomSeed();
        }else{
          if(effectiveSettings.random_seed == null || effectiveSettings.random_seed === "") delete effectiveSettings.random_seed;
        }
      }
    }
    if(isNoHintSmartFreshSettings(effectiveSettings)){
      enforceNoHintFreshSolveSettings(effectiveSettings);
    }
    const fixedLessonPreserveCount = applyFixedLessonPreserveSettings(effectiveSettings, data);
    await yieldResponsiveUi();
    if(isNoHintSmartFreshSettings(effectiveSettings)){
      enforceNoHintFreshSolveSettings(effectiveSettings);
    }
    enforceCompletePresetSolveSettings(effectiveSettings);
    applyCustomSolveDurationSettings(effectiveSettings);
    const allowShortBackendDeadline = effectiveSettings.ui_allow_short_backend_deadline === true;
    const capacityShortageSolve = isCapacityShortageAccepted(effectiveSettings);
    effectiveSettings.best_effort_on_timeout = allowShortBackendDeadline
      || effectiveSettings.ui_allow_best_effort_on_timeout === true
      || effectiveSettings.ui_staged_existing_repair === true
      || capacityShortageSolve;
    if(!allowShortBackendDeadline && !capacityShortageSolve) applySchedulingPressureTimeFloor(effectiveSettings, data);
    if(!capacityShortageSolve) applyHeavyOnePeriodCleanupSettings(effectiveSettings, data);
    enforceRustRuntimeSafetySettings(effectiveSettings);
    if(isNoHintSmartFreshSettings(effectiveSettings)){
      enforceNoHintFreshSolveSettings(effectiveSettings);
    }
    applyCustomSolveDurationSettings(effectiveSettings);
    applyFocusedOptimizationCeiling(effectiveSettings);
    const customDurationSeconds = customSolveDurationFromSettings(effectiveSettings);
    const overallSeconds = normalizeOverallTimeLimit(effectiveSettings.overall_time_limit_seconds ?? DEFAULT_SETTINGS.overall_time_limit_seconds);
    const optimizationSeconds = positiveNumberSetting(effectiveSettings.optimization_time_limit_seconds);
    const cpsatSeconds =
      positiveNumberSetting(effectiveSettings.native_cpsat_quality_time_limit_seconds)
      +
      positiveNumberSetting(effectiveSettings.native_cpsat_time_limit_seconds)
      + positiveNumberSetting(effectiveSettings.native_cpsat_lns_time_limit_seconds)
      + Math.ceil(positiveNumberSetting(effectiveSettings.native_cpsat_relaxed_hint_time_limit_ms) / 1000)
      + Math.ceil(positiveNumberSetting(effectiveSettings.native_cpsat_relaxed_hint_cleanup_ms) / 1000);
    const rawBudgetSeconds = customDurationSeconds
      || Math.max(overallSeconds, optimizationSeconds, cpsatSeconds);
    const focusedCeilingSeconds = focusedOptimizationCeilingSeconds(effectiveSettings);
    // CP-SAT owns several internal phase budgets. Their sum is useful for the
    // general solver, but a focused action owns one absolute wall-clock budget:
    // no combination of non-zero sub-budgets may extend it beyond three minutes.
    let budgetSeconds = focusedCeilingSeconds > 0
      ? Math.min(focusedCeilingSeconds, rawBudgetSeconds)
      : rawBudgetSeconds;
    if(optimizationSeconds > overallSeconds){
      effectiveSettings.overall_time_limit_seconds = optimizationSeconds;
    }
    const minBackendDeadlineMs = allowShortBackendDeadline ? 1_000 : 20_000;
    let backendDeadlineMs = budgetSeconds > 0
      ? Math.max(minBackendDeadlineMs, Math.min(1_800_000, Math.round(budgetSeconds * 1000)))
      : 1_800_000;
    effectiveSettings.backend_deadline_ms = backendDeadlineMs;
    effectiveSettings.native_global_deadline_ms = backendDeadlineMs;
    effectiveSettings.native_deadline_reserve_ms = allowShortBackendDeadline
      ? Math.max(250, Math.min(1500, Number(effectiveSettings.native_deadline_reserve_ms || 500) || 500))
      : 1500;
    if(!allowShortBackendDeadline) alignNativeFreshToBackendDeadline(effectiveSettings, data, backendDeadlineMs);
    applySolverPresetQualityPolicy(effectiveSettings);
    effectiveSettings.allow_strict_quality_solution_bank = false;
    if(isNoHintSmartFreshSettings(effectiveSettings)){
      enforceNoHintFreshSolveSettings(effectiveSettings);
    }
    let uiProgressEstimateSeconds = estimateSolveSeconds(effectiveSettings, data);
    let uiProgressBudgetSeconds = progressBudgetSeconds(
      effectiveSettings,
      uiProgressEstimateSeconds
    );
    const uiProgressRunIndex = normalizePendingProgressRunIndex(
      effectiveSettings.ui_progress_run_index
      || progressState?.runIndex
      || 1
    );
    effectiveSettings.ui_progress_budget_seconds = uiProgressBudgetSeconds;
    effectiveSettings.ui_progress_run_index = uiProgressRunIndex;
    const localAgentAllowed = window.__TKB_CLIENT_AGENT_LANES_ENABLED !== false
      && localAgentRoleAllowed();
    const windowsWebAgentTrial = localAgentAllowed
      && window.__TKB_WINDOWS_WEB_AGENT_TRIAL === true;
    const windowsNativeAgentDevice = localAgentAllowed
      && isWindowsNativeAgentNavigator(window.navigator);
    const windowsAgentPolicy = windowsNativeAgentDevice
      && typeof window.nativeAgentSortPolicy === "function"
      ? window.nativeAgentSortPolicy()
      : null;
    if(!localAgentAllowed){
      // Ordinary school users never pair, probe, or hand a job to a native or
      // Browser Agent. Submit a normal asynchronous, server-owned request and
      // let the backend select Cloud Run/VPS according to its policy.
      effectiveSettings.ui_agent_execution_policy = "server_owned";
      effectiveSettings.ui_execution_mode = "server";
      effectiveSettings.ui_browser_agent_required = false;
      effectiveSettings.ui_native_agent_required = false;
      effectiveSettings.ui_agent_preference_enabled = false;
      delete effectiveSettings.ui_native_agent_id;
      delete effectiveSettings.ui_browser_wasm_ready;
      delete effectiveSettings.ui_browser_cpsat_ready;
    }else if(windowsNativeAgentDevice && windowsAgentPolicy?.mode === "vps"){
      // A Windows Agent previously seen on this device is intentionally OFF.
      // Keep Browser WASM out of the request and make this click explicitly
      // VPS-only; the native worker must not reclaim it if it comes online late.
      // The distinct policy lets the server verify that this exact paired
      // Windows Agent is alive but explicitly OFF before spending VPS CPU.
      effectiveSettings.ui_agent_execution_policy = "native_paused_vps";
      effectiveSettings.ui_execution_mode = "vps";
      effectiveSettings.ui_browser_agent_required = false;
      effectiveSettings.ui_native_agent_required = false;
      effectiveSettings.ui_agent_preference_enabled = false;
      const nativeAgentId = String(
        windowsAgentPolicy.agentId
          || window.nativeAgentStatusSnapshot?.().agentId
          || ""
      ).trim().slice(0, 80);
      if(nativeAgentId) effectiveSettings.ui_native_agent_id = nativeAgentId;
      else delete effectiveSettings.ui_native_agent_id;
      delete effectiveSettings.ui_browser_wasm_ready;
      delete effectiveSettings.ui_browser_cpsat_ready;
    }else if(windowsNativeAgentDevice){
      // Online Windows jobs are native-Agent-only. Missing/checking states are
      // blocked by the UI preflight; this defensive server fence prevents an
      // older cached planner from silently creating a VPS job.
      effectiveSettings.ui_agent_execution_policy = "native_required";
      effectiveSettings.ui_execution_mode = "local";
      effectiveSettings.ui_browser_agent_required = false;
      effectiveSettings.ui_native_agent_required = true;
      effectiveSettings.ui_agent_preference_enabled = true;
      const nativeAgentId = String(
        windowsAgentPolicy?.agentId
          || window.nativeAgentStatusSnapshot?.().agentId
          || ""
      ).trim().slice(0, 80);
      if(nativeAgentId) effectiveSettings.ui_native_agent_id = nativeAgentId;
      else delete effectiveSettings.ui_native_agent_id;
      delete effectiveSettings.ui_browser_wasm_ready;
      delete effectiveSettings.ui_browser_cpsat_ready;
    }else{
      // Browser devices use a strict two-mode contract. With Agent enabled the
      // current click must remain on the device; with Agent disabled it skips
      // every WASM probe and is explicitly VPS-only.
      effectiveSettings.ui_agent_execution_policy = "web_agent_required";
      effectiveSettings.ui_execution_mode = "local";
      effectiveSettings.ui_browser_agent_required = true;
      effectiveSettings.ui_native_agent_required = false;
      delete effectiveSettings.ui_native_agent_id;
      try{
        effectiveSettings.ui_agent_preference_enabled = windowsWebAgentTrial
          ? true
          : (
              typeof window.TKBBrowserWasmExecutor?.isEnabled === "function"
                ? window.TKBBrowserWasmExecutor.isEnabled() !== false
                : true
            );
      }catch(_){
        effectiveSettings.ui_agent_preference_enabled = true;
      }
      if(
        !windowsWebAgentTrial
        && effectiveSettings.ui_agent_preference_enabled !== true
      ){
        effectiveSettings.ui_agent_execution_policy = "vps_only";
        effectiveSettings.ui_execution_mode = "vps";
        effectiveSettings.ui_browser_agent_required = false;
      }
    }
    const browserLocalModeRequired =
      effectiveSettings.ui_agent_execution_policy === "web_agent_required"
      && effectiveSettings.ui_agent_preference_enabled === true;
    const browserRequiredCompleteResult = browserLocalModeRequired
      && effectiveSettings.require_complete_schedule === true
      && !isCapacityShortageAccepted(effectiveSettings);
    if(browserRequiredCompleteResult){
      // Internal draft/repair calls may use best-effort payloads as private
      // checkpoints, but a Browser-required terminal response must never expose
      // or apply an incomplete timetable. A failed quality pass may retain a
      // complete incumbent; it may not turn a partial payload into success.
      effectiveSettings.best_effort_on_timeout = false;
      effectiveSettings.ui_allow_best_effort_on_timeout = false;
      effectiveSettings.ui_accept_incomplete_best_effort = false;
    }
    // The final foreground settlement runs after postSolve() returns and uses
    // the caller's settings object. Keep the effective execution/quality
    // contract on that object too; otherwise a non-Windows request can be sent
    // as web_agent_required but later be accepted as ordinary VPS output.
    synchronizeBrowserSettlementSettings(settings, effectiveSettings);
    if(progressState){
      progressState.estimatedSeconds = uiProgressEstimateSeconds;
      progressState.progressBudgetSeconds = uiProgressBudgetSeconds;
      progressState.runIndex = uiProgressRunIndex;
    }
    await yieldResponsiveUi();
    let clientReserveMs = Math.max(
      0,
      Number(effectiveSettings.ui_client_timeout_reserve_ms ?? CLIENT_TIMEOUT_BACKEND_RESERVE_MS) || 0
    );
    let timeoutMs = backendDeadlineMs > 0
      ? Math.max(
          allowShortBackendDeadline ? 5_000 : 20_000,
          Math.min(1_890_000, backendDeadlineMs + clientReserveMs)
        )
      : 0;
    window.__TKB_RUST_LAST_REQUEST_DEBUG = {
      scheduled: countScheduledLessons(data),
      expected: expectedLessonCount(data),
      apiBase: "",
      requestBytes: 0,
      timeoutMs,
      backendDeadlineMs,
      budgetSeconds,
      fixedLessonPreserveCount,
      settings: effectiveSettings,
      schoolContext: window.__TKB_SCHOOL_CONTEXT || null,
      storeKey: window.__TKB_SCHOOL_CONTEXT?.storeKey || "",
      href: window.location.href
    };
    let queueTimeoutMs = Math.max(
      5_000,
      Math.min(
        SERVER_SOLVER_ACTIVE_WAIT_MAX_MS,
        Number(effectiveSettings.ui_solver_queue_timeout_ms ?? DEFAULT_SOLVER_QUEUE_TIMEOUT_MS)
          || DEFAULT_SOLVER_QUEUE_TIMEOUT_MS,
        timeoutMs > 0 ? timeoutMs : SERVER_SOLVER_ACTIVE_WAIT_MAX_MS
      )
    );
    const controller = new AbortController();
    bindActiveSolveAbortController(controller);
    let timer = 0;
    let browserWasmProbed = false;
    let browserWasmActivated = false;
    const disarmClientTimeout = () => {
      if(!timer) return;
      window.clearTimeout(timer);
      timer = 0;
    };
    const armClientTimeout = () => {
      disarmClientTimeout();
      if(timeoutMs > 0) timer = window.setTimeout(() => controller.abort(), timeoutMs);
    };
    let response;
    try{
      const apiBase = await rustApiBase();
      if(!apiBase) throw new Error("Chưa cấu hình dịch vụ xếp lịch.");
      traceSolveStep("postSolve:before-request-data", {
        scheduled: countScheduledLessons(data),
        expected: expectedLessonCount(data)
      });
      await yieldResponsiveUi();
      const requestData = dataForSolverRequest(data, effectiveSettings);
      const clientFastSeed = await buildClientFastSeed(
        requestData,
        effectiveSettings,
        controller.signal
      );
      if(clientFastSeed){
        requestData.__tkbClientFastSeedV1 = clientFastSeed;
        effectiveSettings.client_fast_seed_hint = true;
        traceSolveStep("postSolve:client-fast-seed", {
          scheduled:clientFastSeed.clientScheduledPeriods,
          expected:clientFastSeed.clientExpectedPeriods,
          elapsedMs:clientFastSeed.elapsedMs,
          attempts:clientFastSeed.attempts
        });
      }else{
        delete requestData.__tkbClientFastSeedV1;
        delete effectiveSettings.client_fast_seed_hint;
      }
      await yieldResponsiveUi();
      if(!cacheEligible) requestData.__tkbSolverRequestNonce = solveRunId;
      const browserWasmRequest = {data: requestData, settings: effectiveSettings};
      let body = "";
      await yieldResponsiveUi();
      const browserWasmEligible = !!(
        localAgentAllowed
        && !windowsNativeAgentDevice
        && effectiveSettings.ui_agent_preference_enabled === true
        &&
        window.TKBBrowserWasmExecutor
        && typeof window.TKBBrowserWasmExecutor.canHandleRequest === "function"
        && window.TKBBrowserWasmExecutor.canHandleRequest(browserWasmRequest) === true
      );
      let browserWasmReclaimPromise = null;
      const reclaimBrowserWasmJob = async (jobId, reclaimOptions) => {
        const canonicalJobId = String(jobId || "").trim();
        if(
          !canonicalJobId
          || !browserWasmEligible
          || effectiveSettings.ui_agent_preference_enabled !== true
          || controller.signal.aborted
          || typeof window.TKBBrowserWasmExecutor?.probe !== "function"
          || typeof window.TKBBrowserWasmExecutor?.activate !== "function"
        ) return false;
        const mobileBrowserAgent = isMobileBrowserAgentNavigator(window.navigator);
        if(mobileBrowserAgent && reclaimOptions?.allowMobile !== true) return false;
        // The phone's first same-page admission is a normal request-backed
        // activation, not a reload-style resume. Desktop may reclaim a known
        // canonical job; mobile must never cross back from VPS ownership.
        const resumeKnownJob = !mobileBrowserAgent;
        let runtimeState = {};
        try{ runtimeState = window.TKBBrowserWasmExecutor.state?.() || {}; }
        catch(_){ runtimeState = {}; }
        if(runtimeState.active === true && String(runtimeState.jobId || "") === canonicalJobId){
          browserWasmActivated = true;
          return true;
        }
        if(browserWasmReclaimPromise) return browserWasmReclaimPromise;
        browserWasmReclaimPromise = (async () => {
          let ready = browserWasmProbed === true || (
            runtimeState.probed === true
            && (
              runtimeState.cpSatReady === true
              || (
                runtimeState.hasWorker !== false
                && Number(runtimeState.workerCount || 0) > 0
              )
            )
          );
          if(!ready){
            ready = await window.TKBBrowserWasmExecutor.probe({
              apiBase,
              jobId:canonicalJobId,
              resumeKnownJob,
              preferNativeAgent:true,
              request:browserWasmRequest,
              signal:controller.signal
            }).catch(() => false);
          }
          if(!ready) return false;
          browserWasmProbed = true;
          const activated = await window.TKBBrowserWasmExecutor.activate({
            apiBase,
            jobId:canonicalJobId,
            resumeKnownJob,
            preferNativeAgent:true,
            request:browserWasmRequest,
            signal:controller.signal
          }).catch(() => false);
          browserWasmActivated = activated === true;
          try{
            window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign(
              {},
              window.__TKB_RUST_LAST_REQUEST_DEBUG || {},
              {
                browserWasmActivated,
                browserWasmReclaimJobId:canonicalJobId,
                browserWasmState:typeof window.TKBBrowserWasmExecutor?.state === "function"
                  ? window.TKBBrowserWasmExecutor.state()
                  : null
              }
            );
          }catch(_){ }
          return browserWasmActivated;
        })().finally(() => {
          browserWasmReclaimPromise = null;
        });
        return browserWasmReclaimPromise;
      };
      if(
        effectiveSettings.ui_solver_async_job === true
        && effectiveSettings.ui_agent_preference_enabled === true
        && browserWasmEligible
        && typeof window.TKBBrowserWasmExecutor.probe === "function"
      ){
        // Compile before a new POST. For poll-only reconnect, the canonical
        // job already exists and can be handed back to the foreground Agent.
        browserWasmProbed = await window.TKBBrowserWasmExecutor.probe({
          apiBase,
          preferNativeAgent:true,
          request:browserWasmRequest,
          signal:controller.signal
        }).catch(() => false);
      }
      let exactBrowserCpSatReady = false;
      if(browserWasmProbed){
        effectiveSettings.ui_browser_wasm_ready = true;
        try{
          const exactState = window.TKBBrowserWasmExecutor?.state?.() || {};
          exactBrowserCpSatReady = exactState.cpSatReady === true
            && exactState.highsReady === true;
        }catch(_){ }
        if(exactBrowserCpSatReady){
          effectiveSettings.ui_browser_cpsat_ready = true;
        }else{
          delete effectiveSettings.ui_browser_cpsat_ready;
        }
      }else{
        delete effectiveSettings.ui_browser_wasm_ready;
        delete effectiveSettings.ui_browser_cpsat_ready;
      }
      if(
        effectiveSettings.ui_agent_execution_policy === "web_agent_required"
        && effectiveSettings.ui_agent_preference_enabled === true
        && (!browserWasmEligible || !browserWasmProbed)
      ){
        const localError = new Error(
          !browserWasmEligible
            ? "Lượt này không phù hợp với solver Local trên trình duyệt hiện tại."
            : "Không khởi động được solver Local trên thiết bị này trước khi gửi lượt xếp."
        );
        localError.kind = "local_agent_unavailable";
        localError.backendUnavailable = false;
        localError.localModeRequired = true;
        localError.executionMode = "local";
        throw localError;
      }
      const pollOnlyServerJob = pendingBackendJob?.jobId === solveRunId
        && (
          pendingBackendJob?.discoveredFromOwnerState === true
          || resumeExistingServerJobOnly
        );
      let browserFullReferenceDeadlineExtended = false;
      let browserStrictAutomaticDeadlineExtended = false;
      if(
        browserWasmProbed
        && !pollOnlyServerJob
        && effectiveSettings.ui_custom_solve_duration_override !== true
        && typeof window.TKBBrowserWasmExecutor?.fullReferenceRefineCapable === "function"
      ){
        try{
          browserFullReferenceDeadlineExtended =
            window.TKBBrowserWasmExecutor.fullReferenceRefineCapable(browserWasmRequest) === true;
        }catch(_){
          browserFullReferenceDeadlineExtended = false;
        }
      }
      if(
        browserWasmProbed
        && exactBrowserCpSatReady
        && browserLocalModeRequired
        && !pollOnlyServerJob
        && effectiveSettings.ui_custom_solve_duration_override !== true
        && typeof window.TKBBrowserWasmExecutor?.strictFreshAutomaticCapable === "function"
      ){
        try{
          browserStrictAutomaticDeadlineExtended =
            window.TKBBrowserWasmExecutor.strictFreshAutomaticCapable(browserWasmRequest) === true;
        }catch(_){
          browserStrictAutomaticDeadlineExtended = false;
        }
      }
      if(browserFullReferenceDeadlineExtended || browserStrictAutomaticDeadlineExtended){
        // This gate is evaluated only after CP-SAT/HiGHS probing, so mobile,
        // Fresh, focused commands, small worker pools, and sub-1-GiB runtimes
        // retain the ordinary 180-second ceiling. Extend the canonical wire
        // before serialization so the server watchdog and local exact stream
        // share one honest 270-second compute budget.
        budgetSeconds = browserStrictAutomaticDeadlineExtended
          ? applyDesktopStrictAutomaticCeiling(effectiveSettings)
          : applyDesktopFullReferenceRefineCeiling(effectiveSettings);
        backendDeadlineMs = effectiveSettings.backend_deadline_ms;
        uiProgressEstimateSeconds = effectiveSettings.progress_estimate_seconds;
        uiProgressBudgetSeconds = effectiveSettings.ui_progress_budget_seconds;
        clientReserveMs = Math.max(
          0,
          Number(
            effectiveSettings.ui_client_timeout_reserve_ms
              ?? CLIENT_TIMEOUT_BACKEND_RESERVE_MS
          ) || 0
        );
        timeoutMs = Math.max(
          20_000,
          Math.min(1_890_000, backendDeadlineMs + clientReserveMs)
        );
        queueTimeoutMs = Math.max(
          5_000,
          Math.min(
            SERVER_SOLVER_ACTIVE_WAIT_MAX_MS,
            Number(
              effectiveSettings.ui_solver_queue_timeout_ms
                ?? DEFAULT_SOLVER_QUEUE_TIMEOUT_MS
            ) || DEFAULT_SOLVER_QUEUE_TIMEOUT_MS,
            timeoutMs
          )
        );
        if(progressState){
          progressState.estimatedSeconds = uiProgressEstimateSeconds;
          progressState.progressBudgetSeconds = uiProgressBudgetSeconds;
        }
        try{
          window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign(
            {},
            window.__TKB_RUST_LAST_REQUEST_DEBUG || {},
            {
              timeoutMs,
              backendDeadlineMs,
              budgetSeconds,
              browserFullReferenceDeadlineExtended:true,
              browserStrictAutomaticDeadlineExtended,
              settings:effectiveSettings
            }
          );
        }catch(_){ }
      }
      body = JSON.stringify(browserWasmRequest);
      traceSolveStep("postSolve:before-fetch", {
        requestBytes: body.length,
        timeoutMs,
        backendDeadlineMs,
        browserWasmEligible,
        browserWasmProbed
      });
      try{
        window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign({}, window.__TKB_RUST_LAST_REQUEST_DEBUG || {}, {
          apiBase,
          requestBytes: body.length,
          requestNonce: requestData.__tkbSolverRequestNonce || "",
          cacheEligible,
          solveRunId,
          resumedServerJob:pendingBackendJob?.jobId === solveRunId,
          requestScheduleFingerprint:sourceScheduleFingerprint,
          requestApplyGuardFingerprint,
          scheduleDiversity: effectiveSettings.schedule_diversity === true,
          qualityVariantSeed: effectiveSettings.quality_variant_seed || "",
          browserWasmEligible,
          browserWasmProbed,
          browserFullReferenceDeadlineExtended,
          browserCpSatReady:effectiveSettings.ui_browser_cpsat_ready === true,
          browserWasmActivated:false,
          browserWasmState:localAgentAllowed
            && typeof window.TKBBrowserWasmExecutor?.state === "function"
            ? window.TKBBrowserWasmExecutor.state()
            : null,
          strippedSolverResult: !!data?.tkbSolverResult,
          strippedSchedule: !!requestData?.__tkbRequestStrippedSchedule,
          startedAt: new Date().toISOString()
        });
      }catch(_){}
      // Stop can arrive while request serialization or API discovery is
      // yielding. Check immediately before publishing the durable wire id so a
      // pre-admission Stop cannot leave an unknown job that F5 would replay.
      throwIfStopRequested(activeSolveRunId);
      setActiveBackendJobId(solveRunId, sourceScheduleFingerprint, {
        qualityDebtFreshRebuild:effectiveSettings.ui_quality_debt_fresh_rebuild === true,
        trialLocal:browserLocalModeRequired && windowsWebAgentTrial,
        strictBrowserAutomatic:strictBrowserAutomaticRequired(effectiveSettings),
        optimizationFocus:effectiveSettings.optimization_focus,
        optimizationGapTarget:effectiveSettings.optimization_gap_target,
        solveRequestMode:effectiveSettings.ui_requested_solve_mode
      });
      let queueDeadline = Date.now() + queueTimeoutMs;
      let lastFetchError = null;
      let queueAttempt = 0;
      let knownRequiredWorkers = 0;
      let transientPostFailures = 0;
      let queueWaitExtensions = 0;
      if(pollOnlyServerJob){
        // Every reload/cross-device resume is poll-only, including a job first
        // created by this same tab. Re-POSTing a locally-created pending job
        // used to start a brand-new solve after the previous result completed.
        window.__TKB_SOLVE_BACKEND_POSTED = false;
        if(browserWasmProbed && !browserWasmActivated){
          await reclaimBrowserWasmJob(solveRunId);
        }
        setStatus("Äang sáº¯p xáº¿p...", "info");
        response = await waitForServerOwnedSolverResult(
          apiBase,
          solveRunId,
          activeSolveRunId,
          serverOwnedResultWaitMs(timeoutMs, pendingBackendJob),
          700,
          controller.signal,
          {
            localModeRequired:browserLocalModeRequired,
            vpsReclaimAttempted:browserWasmActivated,
            onVpsFallback:browserLocalModeRequired
              ? null
              : () => reclaimBrowserWasmJob(solveRunId)
          }
        );
      }else{
        while(Date.now() < queueDeadline){
          throwIfStopRequested(activeSolveRunId);
        queueAttempt += 1;
        window.__TKB_SOLVE_BACKEND_POSTED = true;
        response = null;
        lastFetchError = null;
        let nonRetryablePostPayload = null;
        for(let attempt = 1; attempt <= 2; attempt++){
          try{
            armClientTimeout();
            response = await fetch(`${apiBase}/api/solve-data`, {
              method: "POST",
              headers: solverRequestHeaders({"Content-Type": "application/json"}),
              body,
              signal: controller.signal
            });
            disarmClientTimeout();
            try{
              const attempts = Array.isArray(window.__TKB_RUST_LAST_REQUEST_DEBUG?.attempts)
                ? window.__TKB_RUST_LAST_REQUEST_DEBUG.attempts.slice()
                : [];
              attempts.push({queueAttempt, attempt, status: response.status, at: new Date().toISOString()});
              window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign({}, window.__TKB_RUST_LAST_REQUEST_DEBUG || {}, {attempts});
            }catch(_){}
            if([502, 503].includes(Number(response.status || 0))){
              let structuredPayload = null;
              try{ structuredPayload = await response.clone().json(); }catch(_){ }
              const structuredKind = String(
                structuredPayload?.kind || structuredPayload?.error || ""
              ).trim().toLowerCase();
              if(
                structuredPayload?.retryable === false
                || structuredKind === "trial_solve_quota_unavailable"
                || structuredKind === "solver_plan_unavailable"
              ){
                nonRetryablePostPayload = structuredPayload || {};
                break;
              }
            }
            if(attempt === 1 && [502, 503].includes(Number(response.status || 0))){
              await sleep(800);
              continue;
            }
            break;
          }catch(fetchErr){
            disarmClientTimeout();
            lastFetchError = fetchErr;
            if(fetchErr && fetchErr.name === "AbortError") throw fetchErr;
            try{
              const attempts = Array.isArray(window.__TKB_RUST_LAST_REQUEST_DEBUG?.attempts)
                ? window.__TKB_RUST_LAST_REQUEST_DEBUG.attempts.slice()
                : [];
              attempts.push({queueAttempt, attempt, error: String(fetchErr && (fetchErr.message || fetchErr) || fetchErr).slice(0, 120), at: new Date().toISOString()});
              window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign({}, window.__TKB_RUST_LAST_REQUEST_DEBUG || {}, {attempts});
            }catch(_){}
            if(attempt === 1){
              await sleep(800);
              continue;
            }
          }
        }
        if(!response && lastFetchError) throw lastFetchError;
        if(nonRetryablePostPayload){
          clearActiveBackendJobId(solveRunId);
          const nonRetryableError = new Error(
            nonRetryablePostPayload.message
            || nonRetryablePostPayload.error
            || `HTTP ${Number(response?.status || 503) || 503}`
          );
          nonRetryableError.kind = String(
            nonRetryablePostPayload.kind || nonRetryablePostPayload.error || "solver_post_rejected"
          );
          nonRetryableError.payload = nonRetryablePostPayload;
          nonRetryableError.status = Number(response?.status || 503) || 503;
          nonRetryableError.backendUnavailable = false;
          nonRetryableError.retryable = false;
          throw nonRetryableError;
        }
        if(Number(response?.status || 0) === 202){
          let queuedPayload = {};
          try{ queuedPayload = await response.clone().json(); }catch(_){}
          if(browserLocalModeRequired && serverPayloadIsVpsOwned(queuedPayload)){
            const rejectedJobId = String(queuedPayload?.jobId || solveRunId || "").trim();
            if(rejectedJobId) await cancelBackendSolver(rejectedJobId).catch(() => null);
            throw localRequiredVpsError(response.status, queuedPayload);
          }
          recordBackendLiveProgress(queuedPayload?.progress);
          publishCurrentSolveExecutorState(queuedPayload, solveRunId);
          const pendingKind = String(queuedPayload?.kind || queuedPayload?.error || "").toLowerCase();
          const serverExecutor = normalizedSolveExecutor(
            queuedPayload?.executor,
            queuedPayload?.executionPhase
          );
          const serverOwnedJob = queuedPayload?.serverOwned === true
            || pendingKind === "solver_started"
            || pendingKind === "solver_running";
          const responseJobId = String(queuedPayload?.jobId || "").trim();
          if(serverOwnedJob && responseJobId && responseJobId !== solveRunId){
            const duplicateRequestJobId = solveRunId;
            removePendingBackendJob(duplicateRequestJobId);
            solveRunId = responseJobId;
            setActiveBackendJobId(solveRunId, sourceScheduleFingerprint, {
              qualityDebtFreshRebuild:effectiveSettings.ui_quality_debt_fresh_rebuild === true,
              trialLocal:browserLocalModeRequired && windowsWebAgentTrial,
              optimizationFocus:effectiveSettings.optimization_focus,
              optimizationGapTarget:effectiveSettings.optimization_gap_target,
              solveRequestMode:effectiveSettings.ui_requested_solve_mode
            });
            try{
              window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign(
                {},
                window.__TKB_RUST_LAST_REQUEST_DEBUG || {},
                {
                  deduplicatedServerJob:true,
                  duplicateRequestJobId,
                  serverJobId:solveRunId
                }
              );
            }catch(_){ }
          }
          if(pendingKind === "solver_started" || pendingKind === "solver_running"){
            recordBackendJobStarted(solveRunId, queuedPayload?.startedAtMs, {
              authoritativeRunning:true,
              progressBudgetSeconds:queuedPayload?.progressBudgetSeconds,
              progressRunIndex:queuedPayload?.progressRunIndex
            });
          }else if(pendingKind === "solver_queued"){
            markBackendJobQueued(solveRunId, {
              progressBudgetSeconds:queuedPayload?.progressBudgetSeconds,
              progressRunIndex:queuedPayload?.progressRunIndex
            });
          }
          if(serverOwnedJob){
            window.__TKB_SOLVE_BACKEND_POSTED = false;
            try{
              window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign(
                {},
                window.__TKB_RUST_LAST_REQUEST_DEBUG || {},
                {serverExecutor}
              );
            }catch(_){ }
            if(
              !browserWasmActivated
              && !controller.signal.aborted
              && (!serverExecutor || serverExecutor === "agent" || serverExecutor === "vps")
            ){
              // A VPS response can be a deduplicated older job, a transient
              // lease loss, or a stale Native-Agent observation. Reclaim that
              // exact canonical job instead of closing the ready local pool.
              await reclaimBrowserWasmJob(solveRunId, {
                // Initial Agent admission may activate the phone's bounded
                // completion seed. Once the server reports VPS ownership the
                // transition is one-way on mobile.
                allowMobile:serverExecutor !== "vps"
              });
            }
            knownRequiredWorkers = Math.max(
              knownRequiredWorkers,
              Number(queuedPayload?.requiredWorkers || 0) || 0
            );
            try{
              window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign({}, window.__TKB_RUST_LAST_REQUEST_DEBUG || {}, {
                serverOwnedJob:true,
                serverJobKind:pendingKind,
                queuePosition:Number(queuedPayload?.queuePosition || 0) || 0,
                requiredWorkers:knownRequiredWorkers
              });
            }catch(_){ }
            setStatus("Đang sắp xếp...", "info");
            response = await waitForServerOwnedSolverResult(
              apiBase,
              solveRunId,
              activeSolveRunId,
              serverOwnedResultWaitMs(timeoutMs, queuedPayload),
              Number(queuedPayload?.retryAfterMs || 700) || 700,
              controller.signal,
              {
                localModeRequired:browserLocalModeRequired,
                vpsReclaimAttempted:serverExecutor === "vps" && browserWasmActivated,
                onVpsFallback:browserLocalModeRequired
                  ? null
                  : () => reclaimBrowserWasmJob(solveRunId)
              }
            );
            break;
          }
          if(pendingKind === "solver_queued"){
            window.__TKB_SOLVE_BACKEND_POSTED = false;
            try{
              window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign({}, window.__TKB_RUST_LAST_REQUEST_DEBUG || {}, {
                queuePosition: Number(queuedPayload?.queuePosition || 0) || 0,
                queuedJobs: Number(queuedPayload?.queuedJobs || 0) || 0,
                queuedAtMs: Number(queuedPayload?.queuedAtMs || 0) || 0,
                requiredWorkers: Number(queuedPayload?.requiredWorkers || 0) || 0
              });
            }catch(_){}
            setStatus("Đang sắp xếp...", "info");
            response = null;
            const retryAfterMs = Math.max(250, Math.min(2000, Number(queuedPayload?.retryAfterMs || 700) || 700));
            knownRequiredWorkers = Math.max(
              knownRequiredWorkers,
              Number(queuedPayload?.requiredWorkers || 0) || 0
            );
            let turnReady = false;
            while(!turnReady){
              turnReady = await waitForBackendSolverTurn(
                activeSolveRunId,
                queueDeadline - Date.now(),
                retryAfterMs,
                solveRunId,
                knownRequiredWorkers
              );
              if(!turnReady){
                if(queueWaitExtensions >= 1){
                  const queueErr = new Error("Máy chủ xếp lịch đang bận quá lâu; lượt này đã được dừng.");
                  queueErr.kind = "solver_queue_timeout";
                  queueErr.backendUnavailable = false;
                  throw queueErr;
                }
                // Allow one bounded admission retry for a FIFO head that is
                // just releasing its worker ticket, but never restart the
                // queue clock indefinitely.
                queueWaitExtensions += 1;
                queueDeadline = Date.now() + queueTimeoutMs;
              }
            }
            continue;
          }
        }
        const responseStatus = Number(response?.status || 0) || 0;
        if(responseStatus === 429){
          let capacityPayload = {};
          try{ capacityPayload = await response.clone().json(); }catch(_){ }
          const capacityKind = String(capacityPayload?.kind || capacityPayload?.error || "").toLowerCase();
          if(
            capacityKind === "solver_server_job_capacity"
            || capacityKind === "solver_owner_job_capacity"
            || capacityKind === "solver_queue_full"
            || !capacityKind
          ){
            window.__TKB_SOLVE_BACKEND_POSTED = false;
            markBackendJobQueued(solveRunId);
            setStatus("Đang sắp xếp...", "info");
            response = null;
            await sleep(Math.max(250, Math.min(2_000, Number(capacityPayload?.retryAfterMs || 700) || 700)));
            continue;
          }
        }
        if(responseStatus === 401 || responseStatus === 403){
          suspendBackendResumeForAuth(responseStatus, null, "solve-data");
          throw serverJobAuthRequiredError(responseStatus);
        }
        if(responseStatus === 408 || responseStatus === 425 || responseStatus >= 500){
          transientPostFailures += 1;
          if(transientPostFailures >= 5){
            throw detachedServerJobError("solver_post_transport_unavailable", responseStatus);
          }
          window.__TKB_SOLVE_BACKEND_POSTED = false;
          response = null;
          await sleep(Math.min(2_000, 500 * transientPostFailures));
          continue;
        }
        transientPostFailures = 0;
        if(Number(response.status || 0) === 409){
          let busyPayload = {};
          try{ busyPayload = await response.clone().json(); }catch(_){}
          const busyKind = String(busyPayload?.kind || busyPayload?.error || "").toLowerCase();
          if(busyKind === "solver_schedule_busy"){
            const existingJobId = String(busyPayload?.existingJobId || "").trim();
            const existingFingerprint = String(busyPayload?.existingScheduleFingerprint || "").trim();
            if(
              existingJobId
              && existingFingerprint
              && sourceScheduleFingerprint
              && existingFingerprint === sourceScheduleFingerprint
            ){
              window.__TKB_SOLVE_BACKEND_POSTED = false;
              setActiveBackendJobId(existingJobId, existingFingerprint, {
                qualityDebtFreshRebuild:effectiveSettings.ui_quality_debt_fresh_rebuild === true,
                optimizationFocus:effectiveSettings.optimization_focus,
                optimizationGapTarget:effectiveSettings.optimization_gap_target,
                solveRequestMode:effectiveSettings.ui_requested_solve_mode
              });
              setStatus("\u0110ang s\u1eafp x\u1ebfp...", "info");
              response = await waitForServerOwnedSolverResult(
                apiBase,
                existingJobId,
                activeSolveRunId,
                serverOwnedResultWaitMs(timeoutMs, busyPayload),
                Number(busyPayload?.retryAfterMs || 700) || 700,
                controller.signal
              );
              break;
            }
            const scheduleBusyError = new Error(
              "Lịch này đang được xếp ở phiên khác; lượt mới đã bị chặn để tránh chạy trùng."
            );
            scheduleBusyError.kind = "solver_schedule_busy";
            scheduleBusyError.backendUnavailable = false;
            scheduleBusyError.payload = busyPayload;
            scheduleBusyError.status = responseStatus;
            throw scheduleBusyError;
          }
          if(busyKind === "solver_job_id_conflict" && Number(conflictRetry || 0) < 1){
            clearActiveBackendJobId(solveRunId);
            disarmClientTimeout();
            return await postSolve(settings, dataOverride, Number(conflictRetry || 0) + 1);
          }
          if(busyKind === "solver_busy" || busyKind === "solver_job_already_running"){
            window.__TKB_SOLVE_BACKEND_POSTED = false;
            setStatus("Đang sắp xếp...", "info");
            response = null;
            queueDeadline = Date.now() + queueTimeoutMs;
            if(busyKind === "solver_job_already_running"){
              let existingJobFinished = false;
              while(!existingJobFinished){
                existingJobFinished = await waitForBackendSolverTurn(
                  activeSolveRunId,
                  queueDeadline - Date.now(),
                  Number(busyPayload?.retryAfterMs || 700) || 700,
                  solveRunId,
                  knownRequiredWorkers
                );
                queueDeadline = Date.now() + queueTimeoutMs;
              }
            }else{
              await sleep(700);
            }
            continue;
          }
        }
          break;
        }
      }
      if(!response){
        const queueErr = new Error("Không thể tiếp tục lượt sắp xếp hiện tại.");
        queueErr.kind = "solver_queue_interrupted";
        queueErr.backendUnavailable = false;
        throw queueErr;
      }
      try{
        window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign({}, window.__TKB_RUST_LAST_REQUEST_DEBUG || {}, {
          responseStatus: response.status,
          responseOk: response.ok,
          browserWasmActivated,
          browserWasmFinalState:localAgentAllowed
            && typeof window.TKBBrowserWasmExecutor?.state === "function"
            ? window.TKBBrowserWasmExecutor.state()
            : null,
          finishedAt: new Date().toISOString()
        });
      }catch(_){}
    }catch(err){
      if(err && err.name === "AbortError"){
        if(isStopRequested() || !isCurrentSolveRun(activeSolveRunId)){
          throw makeUserCancelError();
        }
        const timeoutErr = new Error(`Dịch vụ xếp lịch chưa phản hồi trước giới hạn chờ của trình duyệt (${Math.round(timeoutMs / 1000)} giây). Vui lòng chờ lượt hiện tại kết thúc hoặc thử lại.`);
        timeoutErr.kind = "client_timeout";
        timeoutErr.backendUnavailable = false;
        timeoutErr.keepPendingServerJob = true;
        schedulePendingBackendResume(0, SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
        throw timeoutErr;
      }
      rethrowCancelledSolve(err, activeSolveRunId);
      if(err?.kind === "solver_result_auth_required" || err?.authRequired === true){
        suspendBackendResumeForAuth(err?.status, err?.payload, "solver-request");
        throw err;
      }
      if(err?.kind === "solver_result_wait_timeout"){
        // iOS suspends JavaScript timers while the user switches apps. When
        // the page returns, the local wait deadline may already be past even
        // though the VPS job completed normally. Keep the durable job id and
        // reconnect; only an explicit Stop or a terminal server result may
        // cancel a server-owned solve.
        err.backendUnavailable = false;
        err.keepPendingServerJob = true;
        schedulePendingBackendResume(0, 2_000);
        throw err;
      }
      if(err?.kind === "solver_queue_timeout"){
        throw err;
      }
      if(err?.retryable === false && err?.backendUnavailable === false){
        throw err;
      }
      if(
        err?.localModeRequired === true
        || [
          "local_agent_unavailable",
          "browser_agent_required",
          "browser_agent_requires_async_job",
          "web_agent_required",
          "browser_agent_start_failed",
          "browser_agent_disconnected",
          "browser_agent_stopped",
          "browser_agent_failed",
          "browser_agent_quality_unmet"
        ].includes(String(err?.kind || "").trim().toLowerCase())
      ){
        // This is an intentional Local-mode terminal result, not a failed VPS
        // POST. Preserve its kind so the UI can explain that no silent VPS
        // fallback occurred and the user may explicitly turn Agent off.
        throw err;
      }
      if(err?.keepPendingServerJob === true){
        schedulePendingBackendResume(0, SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
        throw err;
      }
      if(
        isBackendUnavailableError(err)
        && readPendingBackendJob()?.jobId === solveRunId
      ){
        const detachedErr = detachedServerJobError("solver_post_network_detached", 0);
        schedulePendingBackendResume(0, SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
        throw detachedErr;
      }
      try{
        const d = window.__TKB_RUST_LAST_REQUEST_DEBUG || {};
        const apiBase = d.apiBase || await rustApiBase();
        if(apiBase){
          const health = await fetch(`${apiBase}/api/health`, {cache:"no-store"});
          window.__TKB_RUST_LAST_REQUEST_DEBUG = Object.assign({}, d, {
            healthStatus: health.status,
            healthOk: health.ok,
            healthCheckedAt: new Date().toISOString()
          });
          if(health.ok){
            const postErr = new Error(`Server health OK nhưng POST /api/solve-data thất bại: ${err && (err.message || err) || err}. ${solveDiagnosticText()}`);
            postErr.backendUnavailable = false;
            postErr.kind = "solve_post_failed";
            throw postErr;
          }
        }
      }catch(probeErr){
        if(probeErr && probeErr.kind === "solve_post_failed") throw probeErr;
      }
      throw err;
    }finally{
      disarmClientTimeout();
      clearActiveSolveAbortController(controller);
      window.__TKB_SOLVE_BACKEND_POSTED = false;
      window.__TKB_SOLVE_QUEUE_WAITING = false;
      if(
        (browserWasmProbed || browserWasmActivated)
        && typeof window.TKBBrowserWasmExecutor?.close === "function"
      ){
        // The canonical result (or terminal failure) is already server-owned
        // here. Revoke this short-lived browser registration so another tab or
        // device cannot wait behind an idle web worker on its next click.
        Promise.resolve(window.TKBBrowserWasmExecutor.close("solve_finished", {
          failLease:true
        })).catch(() => null);
      }
    }
    throwIfStopRequested(activeSolveRunId);
    const currentScheduleFingerprint = durableScheduleFingerprint(data);
    if(
      requestApplyGuardFingerprint
      && currentScheduleFingerprint
      && !durableScheduleFingerprintMatches(requestApplyGuardFingerprint, data)
    ){
      const consumedResumeTarget = consumeActiveBackendResumeTarget(solveRunId);
      clearActiveBackendJobId(solveRunId, {force:consumedResumeTarget});
      const staleErr = new Error("Lịch đã thay đổi trong khi server đang xếp; kết quả cũ không được áp dụng.");
      staleErr.kind = "solver_stale_result";
      staleErr.backendUnavailable = false;
      throw staleErr;
    }
    let rawPayload = null;
    try{
      if(parsedSolverResponsePayloads.has(response)){
        rawPayload = parsedSolverResponsePayloads.get(response);
        parsedSolverResponsePayloads.delete(response);
      }
    }catch(_){ }
    if(!rawPayload || typeof rawPayload !== "object"){
      rawPayload = await response.json().catch(() => ({}));
    }
    const payload = normalizePayloadForUiConstraints(data, rawPayload);
    if(payloadIsSafeCapacityPartial(payload) && !browserRequiredCompleteResult){
      // The backend is authoritative for capacity analysis.  This also covers
      // large/async requests where the browser deliberately skipped its local
      // scan: accept and apply every hard-valid placed lesson, while the
      // reported remainder stays in Chưa phân.
      applyCapacityShortageAcceptedSettings(settings);
      applyCapacityShortageAcceptedSettings(effectiveSettings);
      settings.ui_capacity_shortage_accepted_after_solve = true;
      effectiveSettings.ui_capacity_shortage_accepted_after_solve = true;
    }
    if(response?.status === 401 || response?.status === 403){
      suspendBackendResumeForAuth(response.status, payload, "solve-response");
      throw serverJobAuthRequiredError(response.status, payload);
    }
    if(transientServerJobStatus(response?.status) && !terminalServerJobFailure(response?.status, payload)){
      throw detachedServerJobError("solver_result_transport_unavailable", response?.status, payload);
    }
    if(
      resumeExistingServerJobOnly
      && resumeTarget?.jobId
      && String(resumeTarget.jobId) === String(solveRunId)
    ){
      // Mark only the canonical poll as consumed. A later sequential fallback
      // in this same click may submit a fresh job, but it must never repost the
      // already-consumed VPS job.
      consumeActiveBackendResumeTarget(solveRunId);
    }
    if(!response.ok){
      clearActiveBackendJobId(solveRunId, {force:resumeExistingServerJobOnly});
      window.__TKB_SOLVER_LAST_ERROR_PAYLOAD = payload;
      const busy = Number(response.status || 0) === 409 && String(payload?.error || "") === "solver_busy";
      const incompleteKind = String(payload?.kind || "").toLowerCase();
      const noComplete = Number(response.status || 0) === 422
        && (
          incompleteKind === "no_complete_schedule_before_deadline"
          || incompleteKind === "incomplete_schedule"
        );
      const partialScheduled = metricNumber(payload?.metrics?.scheduled_periods, 0) > 0
        || (Array.isArray(payload?.lessons) && payload.lessons.length > 0);
      const capacityBestEffortRequested = payloadHasCapacityShortage(payload)
        || settings?.ui_capacity_shortage_confirmed === true
        || settings?.ui_capacity_shortage_accepted === true
        || settings?.ui_capacity_shortage_accepted_after_solve === true;
      const allowIncompleteBestEffort = !browserRequiredCompleteResult
        && !shouldRequireCompletePresetResult(settings)
        && (
          capacityBestEffortRequested
          || settings?.ui_staged_existing_repair === true
          || settings?.ui_accept_incomplete_best_effort === true
        );
      const acceptableIncompleteBestEffort = capacityBestEffortRequested
        ? payloadIsSafeCapacityPartial(payload)
        : (partialScheduled || payloadAcceptableWithUnassigned(payload) || payloadAcceptableForUiCleanup(payload));
      if(noComplete && allowIncompleteBestEffort && acceptableIncompleteBestEffort){
        payload.ok = true;
        payload.kind = partialScheduled ? "best_effort_partial_before_deadline" : "best_effort_unassigned_accepted";
        payload.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
        payload.warnings.push({
          kind: "backend_422_best_effort_accepted",
          message: partialScheduled
            ? "Hết thời gian nhưng đã xếp được một phần; hệ thống giữ phần hợp lệ, phần còn lại ở Tiết chưa phân."
            : "Lịch chưa đủ tiết; hệ thống giữ phần hợp lệ, phần còn lại ở Tiết chưa phân."
        });
        return payload;
      }
      const err = new Error(busy
        ? "Đang có lượt xếp khác, vui lòng chờ lượt hiện tại hoàn tất rồi bấm Sắp xếp lại."
        : (noComplete
          ? (payload.error || incompleteSolveMessage(payload, { requireComplete: true }))
          : (payload.message || payload.error || `HTTP ${response.status}`)));
      err.payload = payload;
      err.status = response.status;
      err.settings = settings;
      if(payload?.retryable === false) err.retryable = false;
      if(payload && payload.kind) err.kind = String(payload.kind);
      if(busy) err.kind = "solver_busy";
      if(noComplete) err.kind = "no_complete_schedule_before_deadline";
      if(payload && payload.kind) err.backendUnavailable = false;
      throw err;
    }
    const completion = payloadCompletion(payload);
    if(browserRequiredCompleteResult && !completion.complete){
      clearActiveBackendJobId(solveRunId, {force:resumeExistingServerJobOnly});
      const err = new Error(incompleteSolveMessage(payload, {requireComplete:true}));
      err.kind = "no_complete_schedule_before_deadline";
      err.payload = payload;
      err.settings = effectiveSettings;
      err.backendUnavailable = false;
      throw err;
    }
    const deferSettlement = window.__TKB_DEFER_SERVER_RESULT_SETTLEMENT_UNTIL_APPLY === true
      && effectiveSettings.ui_solver_async_job === true
      && completion.complete
      && payloadHasUsableSchedule(payload);
    if(deferSettlement){
      deferBackendResultSettlement(solveRunId, payload);
    }else{
      clearActiveBackendJobId(solveRunId, {force:resumeExistingServerJobOnly});
    }
    return payload;
  }

  function publishE2EState(status, payload, extra){
    try{
      if(!location.search.includes("e2e=1")) return;
      let el = document.getElementById("tkb-e2e-state");
      if(!el){
        el = document.createElement("script");
        el.id = "tkb-e2e-state";
        el.type = "application/json";
        document.documentElement.appendChild(el);
      }
      const data = getData() || {};
      const metrics = payload?.metrics || data.tkbSolverResult?.metrics || {};
      const validation = payload?.validation || data.tkbSolverResult?.validation || {};
      const lessons = Array.isArray(payload?.lessons) ? payload.lessons : [];
      const fixed = data.tkbConstraints?.fixedOff || {};
      const groups = data.tkbConstraints?.groups?.subject || {};
      const truthy = value => value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
      const hasSlot = (root, id, key) => !!(root && root[id] && truthy(root[id][key]));
      const lessonKey = lesson => {
        const day = Number(lesson.day);
        const period = Number(lesson.period);
        const session = String(lesson.session || "").toUpperCase() === "AM" ? "sang" : "chieu";
        return `thu${day}|${session}|${Math.max(0, period - 1)}`;
      };
      const violations = [];
      const addViolation = (kind, id, lesson, key) => violations.push({
        kind,
        id,
        key,
        class: lesson.class,
        subject: lesson.subject,
        teacher: lesson.teacher,
        room: lesson.room || ""
      });
      for(const lesson of lessons){
        const key = lessonKey(lesson);
        if(hasSlot(fixed.class, lesson.class, key)) addViolation("class", lesson.class, lesson, key);
        if(hasSlot(fixed.teacher, lesson.teacher, key)) addViolation("teacher", lesson.teacher, lesson, key);
        if(hasSlot(fixed.subject, lesson.subject, key)) addViolation("subject", lesson.subject, lesson, key);
        if(lesson.room && hasSlot(fixed.room, lesson.room, key)) addViolation("room", lesson.room, lesson, key);
        for(const [groupId, slots] of Object.entries(fixed.subjectGroup || {})){
          const items = groups[groupId]?.items || [];
          if(Array.isArray(items) && items.includes(lesson.subject) && truthy(slots?.[key])){
            addViolation("subjectGroup", groupId, lesson, key);
          }
        }
      }
      const userOff = data.tkbUserOff || {};
      for(const lesson of lessons){
        const key = lessonKey(lesson);
        const raw = userOff[lesson.class];
        if(Array.isArray(raw) && raw.includes(key)) addViolation("tkbUserOff", lesson.class, lesson, key);
        else if(raw && typeof raw === "object" && truthy(raw[key])) addViolation("tkbUserOff", lesson.class, lesson, key);
      }
      let uiConstraintViolations = [];
      try{
        const api = window.TKBConstraints || window.TKBConstraintsFull;
        if(api && typeof api.validateAll === "function") uiConstraintViolations = api.validateAll(10000) || [];
      }catch(err){
        uiConstraintViolations = [{message: String(err && err.message || err)}];
      }
      const fixedChaoCo = (() => {
        const conf = data.__e2eFixedChaoCo;
        if(!conf || !Array.isArray(conf.classes)) return null;
        const cellSubject = value => {
          if(!value) return "";
          if(typeof value === "string") return value;
          if(value && typeof value === "object") return String(value.mon || value.subject || value.ten || "").trim();
          return "";
        };
        const isFixed = value => !!(value && typeof value === "object" && value.fixed === true);
        const teacherFor = (classId, subject) => {
          try{
            if(typeof getTeacherForClassMon === "function") return String(getTeacherForClassMon(classId, subject) || "").trim();
          }catch(_){}
          return String(data.pccmMatrix?.[`${classId}|${subject}`] || "").trim();
        };
        const rows = conf.classes.map(classId => {
          const value = data.tkb?.[classId]?.thu2?.sang?.[0];
          const subject = cellSubject(value);
          const fixed = isFixed(value);
          const teacher = teacherFor(classId, subject || "ChCờ");
          const ok = fixed && (subject === "ChCờ" || subject === "Chào cờ");
          return {classId, subject, fixed, teacher, ok};
        });
        const teacherBuckets = new Map();
        rows.forEach(row => {
          if(!row.teacher) return;
          const list = teacherBuckets.get(row.teacher) || [];
          list.push(row.classId);
          teacherBuckets.set(row.teacher, list);
        });
        const teacherConflicts = Array.from(teacherBuckets.entries())
          .filter(([, classes]) => classes.length > 1)
          .map(([teacher, classes]) => ({teacher, classes}));
        return {
          enabled: true,
          expected: conf.classes.length,
          okCount: rows.filter(row => row.ok).length,
          problemCount: rows.filter(row => !row.ok).length,
          teacherConflictCount: teacherConflicts.length,
          problems: rows.filter(row => !row.ok).slice(0, 20),
          teacherConflicts: teacherConflicts.slice(0, 20),
          rows: rows.slice(0, 30)
        };
      })();
      el.textContent = JSON.stringify({
        status,
        at: new Date().toISOString(),
        running: window.__TKB_RUST_SOLVER_RUNNING === true,
        rustBridgeVersion: VERSION,
        legacyPythonBridgePresent: !!window.TKBPythonOptimizer,
        requestDebug: window.__TKB_RUST_LAST_REQUEST_DEBUG || null,
        metrics,
        validation,
        solver: payload?.solver || null,
        fixedOffViolationCount: violations.length,
        fixedOffViolations: violations.slice(0, 20),
        fixedChaoCo,
        uiConstraintViolationCount: uiConstraintViolations.length,
        uiConstraintViolations: uiConstraintViolations.slice(0, 20),
        hasPayload: !!payload,
        error: window.__TKB_SOLVER_LAST_ERROR || "",
        statusText: document.querySelector("#statusMsg")?.textContent || "",
        extra: extra || null
      });
    }catch(err){
      console.warn(`[${VERSION}] publish e2e state failed`, err);
    }
  }

  function shuffleOnlySettings(rawSettings){
    const settings = Object.assign({}, rawSettings || {});
    Object.keys(settings).forEach(key => {
      const lower = key.toLowerCase();
      if(
        lower.startsWith("optimization_")
        || lower.includes("quality")
        || lower.includes("teacher_session")
        || lower.includes("gap")
        || lower.includes("cpsat")
        || lower.includes("hint_bank")
      ){
        delete settings[key];
      }
    });
    settings.solver_mode = "auto";
    settings.auto_sort_mode = "fast";
    settings.auto_sort_strategy = "reference_from_shuffle_fill";
    settings.reference_solver_mode_normalized_from = "shuffle_fill";
    settings.force_fresh_backend_solve = true;
    settings.allow_backend_cache = false;
    settings.disable_native_hint_solver = true;
    settings.disable_solver_hints = true;
    settings.allow_solver_warm_start = false;
    settings.native_disable_cached_hint_candidate = true;
    settings.native_disable_static_hint_candidate = true;
    settings.preserve_existing_tkb = false;
    settings.force_preserve_partial_existing = false;
    settings.partial_existing_rebuild = false;
    settings.randomize_search = true;
    settings.fresh_randomize = true;
    settings.schedule_diversity = true;
    settings.random_seed = makeRandomSeed();
    settings.best_effort_on_timeout = true;
    settings.require_complete_schedule = true;
    delete settings.max_teacher_sessions;
    delete settings.requested_max_teacher_sessions;
    delete settings.target_teacher_sessions;
    delete settings.target_gap1_sessions;
    delete settings.max_one_period_sessions;
    delete settings.one_period_priority_absolute;
    delete settings.minimize_teacher_gaps;
    delete settings.period_max_teacher_gap;
    return settings;
  }

  function recentOffRestoreFlag(data){
    const flag = data?.tkbOffRestoreLast;
    if(!flag || typeof flag !== "object") return null;
    if(flag.consumedAt) return null;
    if(Math.max(0, Number(flag.restored || 0) || 0) <= 0) return null;
    const at = Number(flag.at || 0) || 0;
    if(!at || Date.now() - at > 5 * 60 * 1000) return null;
    return flag;
  }

  function localOffRestorePayload(data, detail){
    const scheduled = countScheduledLessons(data);
    const expected = expectedLessonCount(data);
    const unassigned = Math.max(0, expected - scheduled);
    const violations = currentConstraintViolations(3000).length;
    const hardOk = unassigned === 0 && violations === 0;
    return {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      metrics: {
        scheduled_periods: scheduled,
        expected_periods: expected,
        unassigned_periods: unassigned,
        app_constraint_violation_count: violations,
        hard_ok: hardOk,
        core_hard_ok: hardOk,
        best_effort: !hardOk
      },
      validation: {
        hard_ok: hardOk,
        violations: []
      },
      solver: {
        name: "local_off_restore_fast",
        runtime_settings: Object.assign({
          phase: "off_restore_fast",
          ui_local_off_restore_fast: true,
          elapsed_seconds: 0
        }, detail || {})
      },
      lessons: Array.isArray(data?.tkbSolverResult?.lessons) ? data.tkbSolverResult.lessons : [],
      warnings: [],
      unassignedLessons: []
    };
  }

  function optimizationPlateauState(data){
    const safeData = data || getData();
    const state = safeData?.tkbOptimizationPlateau;
    if(!state || typeof state !== "object") return null;
    const fingerprint = durableScheduleFingerprint(safeData);
    if(!fingerprint || String(state.fingerprint || "") !== fingerprint) return null;
    if(Math.max(0, Number(state.noImprovementSlices || 0) || 0) < 1) return null;
    return state;
  }

  function automaticSortRefinementRound(data){
    const payload = data?.tkbSolverResult || data?.tkbRustSolverResult || null;
    return Math.max(
      0,
      Math.round(metricNumber(payload?.metrics?.optimization_refinement_round, 0)),
      Math.round(metricNumber(
        payload?.solver?.runtime_settings?.optimization_refinement_round,
        0
      ))
    );
  }

  function embeddedAutomaticSortCycleState(data, fingerprint){
    const safeData = data || getData();
    const currentFingerprint = String(fingerprint || durableScheduleFingerprint(safeData));
    const payload = safeData?.tkbSolverResult || safeData?.tkbRustSolverResult || null;
    const embedded = payload?.solver?.runtime_settings?.ui_automatic_sort_cycle;
    if(!embedded || typeof embedded !== "object") return null;
    if(!currentFingerprint || String(embedded.fingerprint || "") !== currentFingerprint) return null;
    return {
      version:1,
      fingerprint:currentFingerprint,
      successfulClicks:Math.max(
        0,
        Math.round(Number(embedded.successfulClicks || 0) || 0)
      ),
      updatedAt:String(embedded.updatedAt || "")
    };
  }

  function attachAutomaticSortCycleToPayload(data, state){
    const safeData = data || getData();
    const payload = safeData?.tkbSolverResult || safeData?.tkbRustSolverResult || null;
    if(!payload || typeof payload !== "object" || !state) return false;
    payload.solver = payload.solver && typeof payload.solver === "object"
      ? payload.solver
      : {};
    payload.solver.runtime_settings = payload.solver.runtime_settings
      && typeof payload.solver.runtime_settings === "object"
      ? payload.solver.runtime_settings
      : {};
    payload.solver.runtime_settings.ui_automatic_sort_cycle = {
      version:1,
      fingerprint:String(state.fingerprint || ""),
      successfulClicks:Math.max(0, Math.round(Number(state.successfulClicks || 0) || 0)),
      updatedAt:String(state.updatedAt || "")
    };
    return true;
  }

  function automaticSortCycleState(data){
    const safeData = data || getData();
    const fingerprint = durableScheduleFingerprint(safeData);
    const complete = !!currentScheduleAppearsComplete(safeData);
    const saved = safeData?.[AUTO_SORT_CYCLE_DATA_KEY];
    const embedded = embeddedAutomaticSortCycleState(safeData, fingerprint);
    if(saved && typeof saved === "object"){
      if(fingerprint && String(saved.fingerprint || "") === fingerprint){
        return {
          fingerprint,
          successfulClicks:Math.max(
            0,
            Math.round(Number(saved.successfulClicks || 0) || 0),
            Math.round(Number(embedded?.successfulClicks || 0) || 0)
          ),
          complete,
          inferred:false
        };
      }
      if(embedded){
        return Object.assign({}, embedded, {
          complete,
          inferred:true,
          recoveredFromPayload:true
        });
      }
      // A delete, manual edit, or changed requirement starts a new cycle. A
      // still-complete edited timetable is treated as the first successful
      // state, so the user receives one new optimization click.
      return {
        fingerprint,
        successfulClicks:complete ? 1 : 0,
        complete,
        inferred:true,
        resetByFingerprint:true
      };
    }
    if(!complete){
      return {fingerprint, successfulClicks:0, complete:false, inferred:true};
    }
    if(embedded){
      return Object.assign({}, embedded, {
        complete:true,
        inferred:true,
        recoveredFromPayload:true
      });
    }
    // Backward-compatible inference for schedules saved before the cycle marker
    // existed: a completed refinement round means the first two clicks already
    // happened; a fresh complete result has consumed only the first click.
    return {
      fingerprint,
      successfulClicks:automaticSortRefinementRound(safeData) >= 1 ? 2 : 1,
      complete:true,
      inferred:true
    };
  }

  function ordinaryAutomaticSortLimitReached(data, requestedMode){
    // Retained as a compatibility hook for cached callers/tests. Automatic is
    // now a progressive optimizer: every click on a complete, hard-valid
    // incumbent may request another bounded, fail-closed refinement slice.
    void data;
    void requestedMode;
    return false;
  }

  function rememberAutomaticSortSuccess(data, previousState, planKind){
    const safeData = data || getData();
    if(!safeData || !currentScheduleAppearsComplete(safeData)) return null;
    const previousClicks = Math.max(
      0,
      Math.round(Number(previousState?.successfulClicks || 0) || 0)
    );
    const refining = String(planKind || "").trim().toLowerCase() === "refine_complete";
    const successfulClicks = refining
      ? Math.max(2, previousClicks + 1)
      : 1;
    const previousSaved = safeData?.[AUTO_SORT_CYCLE_DATA_KEY];
    const sameSavedState = previousSaved
      && typeof previousSaved === "object"
      && String(previousSaved.fingerprint || "") === durableScheduleFingerprint(safeData)
      && Math.max(0, Math.round(Number(previousSaved.successfulClicks || 0) || 0)) === successfulClicks;
    const state = {
      version:1,
      fingerprint:durableScheduleFingerprint(safeData),
      successfulClicks,
      updatedAt:sameSavedState && previousSaved.updatedAt
        ? String(previousSaved.updatedAt)
        : new Date().toISOString()
    };
    safeData[AUTO_SORT_CYCLE_DATA_KEY] = state;
    attachAutomaticSortCycleToPayload(safeData, state);
    return state;
  }

  function automaticSortCycleIntentFromSettings(settings){
    if(!settings || settings.ui_track_automatic_sort_cycle !== true) return null;
    return {
      previousState:{
        successfulClicks:Math.max(
          0,
          Math.round(Number(settings.ui_automatic_sort_previous_successful_clicks || 0) || 0)
        )
      },
      planKind:String(settings.ui_automatic_sort_plan_kind || "")
    };
  }

  async function persistAutomaticSortSuccess(data, previousState, planKind){
    const safeData = data || getData();
    if(!safeData) return null;
    const before = JSON.stringify({
      state:safeData[AUTO_SORT_CYCLE_DATA_KEY] || null,
      embedded:safeData?.tkbSolverResult?.solver?.runtime_settings?.ui_automatic_sort_cycle || null
    });
    const state = rememberAutomaticSortSuccess(safeData, previousState, planKind);
    if(!state) return null;
    const after = JSON.stringify({
      state:safeData[AUTO_SORT_CYCLE_DATA_KEY] || null,
      embedded:safeData?.tkbSolverResult?.solver?.runtime_settings?.ui_automatic_sort_cycle || null
    });
    if(before === after) return state;
    try{
      const saveStoreFn = window.saveStore;
      if(typeof saveStoreFn === "function"){
        await Promise.resolve(saveStoreFn.call(window, {
          force:true,
          awaitRemote:true,
          trustedSolverApply:true,
          suppressHistory:true,
          replaceHistoryCurrent:true,
          skipIfUnchanged:true
        }));
      }
    }catch(err){
      try{ console.warn(`[${VERSION}] automatic sort cycle persistence failed`, err); }catch(_){ }
    }
    return state;
  }

  function setOptimizationLockedUi(locked){
    const btn = document.getElementById("btnAutoSort");
    if(!btn) return;
    const on = locked === true;
    btn.dataset.optimizedLocked = on ? "1" : "";
    btn.classList?.toggle?.("is-optimized-locked", on);
    if(on){
      btn.disabled = true;
      btn.setAttribute?.("aria-disabled", "true");
      btn.title = SOLVE_COMPLETE_MESSAGE;
    }else if(
      window.__TKB_RUST_SOLVER_RUNNING !== true
      && window.__TKB_SOLVE_UI_BUSY !== true
      && !autoSortPreflightActive()
    ){
      btn.disabled = false;
      btn.removeAttribute?.("aria-disabled");
      if(btn.title === SOLVE_COMPLETE_MESSAGE) btn.title = "";
    }
  }

  function syncOptimizationLockState(){
    const data = getData();
    const state = optimizationPlateauState(data);
    if(data?.tkbOptimizationPlateau && !state){
      delete data.tkbOptimizationPlateau;
    }
    // A no-improvement slice is useful history, not a reason to block Play.
    // Users may always request another adaptive incumbent-safe refinement.
    setOptimizationLockedUi(false);
    if(!state) return null;
    return Object.assign({}, state, {
      locked:false,
      rerunAllowed:true,
      customDurationOverride:customSolveDurationOverrideActive()
    });
  }

  function installOptimizationLockSaveHook(){
    try{
      const current = window.saveStore;
      if(typeof current !== "function" || current.__tkbOptimizationLockWrapped) return false;
      const wrapped = function(){
        const result = current.apply(this, arguments);
        try{ window.setTimeout(syncOptimizationLockState, 0); }catch(_){}
        return result;
      };
      wrapped.__tkbOptimizationLockWrapped = true;
      window.saveStore = wrapped;
      return true;
    }catch(_){
      return false;
    }
  }

  function clearOptimizationPlateau(data, persist){
    const safeData = data || getData();
    if(!safeData || !Object.prototype.hasOwnProperty.call(safeData, "tkbOptimizationPlateau")) return false;
    delete safeData.tkbOptimizationPlateau;
    setOptimizationLockedUi(false);
    if(persist !== false){
      try{
        callMaybe("saveStore", [{
          force:true,
          trustedSolverApply:true,
          suppressHistory:true,
          replaceHistoryCurrent:true,
          skipIfUnchanged:true
        }]);
      }catch(_){}
    }
    return true;
  }

  function rememberOptimizationPlateau(data, previousState, locked){
    const safeData = data || getData();
    if(!safeData) return null;
    const fingerprint = durableScheduleFingerprint(safeData);
    if(!fingerprint) return null;
    const previous = previousState && typeof previousState === "object" ? previousState : {};
    const state = {
      fingerprint,
      noImprovementSlices:Math.max(1, Math.max(0, Number(previous.noImprovementSlices || 0) || 0) + 1),
      locked:locked === true,
      updatedAt:new Date().toISOString()
    };
    safeData.tkbOptimizationPlateau = state;
    setOptimizationLockedUi(state.locked === true && !customSolveDurationOverrideActive());
    try{
      callMaybe("saveStore", [{
        force:true,
        trustedSolverApply:true,
        suppressHistory:true,
        replaceHistoryCurrent:true,
        skipIfUnchanged:true
      }]);
    }catch(_){}
    return state;
  }

  function hasComparableOptimizationStats(payload){
    const metrics = payload?.metrics;
    if(!metrics || typeof metrics !== "object") return false;
    const expected = metricNumber(metrics.expected_periods, 0);
    const scheduled = metricNumber(metrics.scheduled_periods, 0);
    return expected > 0
      && scheduled >= expected
      && Object.prototype.hasOwnProperty.call(metrics, "teacher_sessions")
      && Object.prototype.hasOwnProperty.call(metrics, "one_period_teacher_sessions");
  }

  function refinementStatisticsImproved(candidate, incumbent, fingerprintChanged, settings){
    if(hasComparableOptimizationStats(candidate) && hasComparableOptimizationStats(incumbent)){
      return payloadStrictlyBetterTeacherQuality(candidate, incumbent, settings);
    }
    return fingerprintChanged === true;
  }

  function completeScheduleStateForExistingOptimize(data, knownConstraintViolationCount, knownExpectedCount){
    if(!data) return null;
    // Fresh/partial schedules cannot be refinement candidates. Check the
    // lightweight counters first so Delete -> Play never triggers the much
    // heavier whole-school UI statistics scan on the critical click path.
    const suppliedExpected = Number(knownExpectedCount);
    const quickExpected = Math.max(
      0,
      Number.isFinite(suppliedExpected) && suppliedExpected >= 0
        ? Math.round(suppliedExpected)
        : expectedLessonCount(data)
    );
    const quickScheduled = Math.max(0, countScheduledLessons(data));
    if(quickExpected <= 0 || quickScheduled < quickExpected) return null;
    const stats = cheapSchoolCompletionStats(data) || {};
    const expected = Math.max(0, metricNumber(stats.expected, quickExpected));
    const scheduled = Math.max(0, metricNumber(stats.scheduled, quickScheduled));
    const unassigned = Math.max(
      0,
      metricNumber(
        stats.unassigned,
        expected > 0 ? Math.max(0, expected - scheduled) : 0
      )
    );
    if(expected <= 0 || scheduled < expected || unassigned > 0) return null;
    const knownViolations = Number(knownConstraintViolationCount);
    const violations = Number.isFinite(knownViolations) && knownViolations >= 0
      ? Math.round(knownViolations)
      : currentConstraintViolations(3000).length;
    if(violations > 0) return null;
    return {
      expected,
      scheduled,
      unassigned,
      violations,
      flexibleScheduled: Math.max(0, countScheduledLessons(data, {flexibleOnly:true}))
    };
  }

  function settingsForCompleteExistingOptimize(baseSettings, data, state){
    const next = settingsForFastQualityAutoSort(baseSettings || readSettings());
    const expected = Math.max(0, Number(state?.expected || expectedLessonCount(data)) || 0);
    const seconds = expected >= 900 ? 45 : 28;
    next.ui_complete_schedule_existing_optimize = true;
    next.ui_default_fresh_sort = false;
    next.ui_skip_pre_solve_constraint_release = true;
    next.ui_skip_capacity_precheck = true;
    next.ui_fast_auto_sort_no_capacity_precheck = true;
    next.ui_keep_better_existing_on_resort = true;
    next.ui_return_complete_incumbent_on_existing_optimize_failure = true;
    next.allow_native_existing_optimize_for_hybrid = false;
    next.native_force_rust_solver = false;
    next.disable_reference_solver = false;
    next.disable_hybrid_reference_solver = false;
    next.auto_sort_mode = "fast";
    next.auto_sort_strategy = "complete_existing_teacher_quality";
    next.optimize_existing_schedule = true;
    next.existing_fill_missing_schedule = false;
    next.preserve_existing_tkb = true;
    next.force_preserve_partial_existing = true;
    next.partial_existing_rebuild = false;
    next.repair_fill_first = false;
    next.repair_partial_existing = false;
    next.preserve_existing_min_ratio = 1;
    next.force_fresh_backend_solve = true;
    next.allow_backend_cache = false;
    next.allow_solver_warm_start = true;
    next.fresh_randomize = false;
    next.randomize_search = false;
    next.schedule_diversity = false;
    next.reclick_schedule_diversity = false;
    next.require_teacher_session_diversity = false;
    next.allow_zero_one_quality_retry = false;
    next.allow_teacher_session_deep_retry = false;
    next.allow_teacher_session_fast_portfolio = false;
    next.complete_schedule_seed_retry = false;
    next.allow_quality_debt = false;
    next.require_complete_schedule = true;
    next.best_effort_on_timeout = true;
    next.minimize_teacher_gaps = true;
    next.period_max_teacher_gap = 1;
    next.relax_period_teacher_gap_on_failure = false;
    next.expected_scheduled_periods = expected;
    next.existing_scheduled_periods = Math.max(0, Number(state?.scheduled || 0) || 0);
    next.existing_flexible_scheduled_periods = Math.max(0, Number(state?.flexibleScheduled || 0) || 0);
    next.gap_existing_optimize_attempts = Math.max(
      expected >= 900 ? 5 : 4,
      Number(next.gap_existing_optimize_attempts || 0) || 0
    );
    next.overall_time_limit_seconds = seconds;
    next.integrated_time_limit = seconds;
    next.progress_estimate_seconds = seconds;
    next.backend_deadline_ms = seconds * 1000;
    next.native_global_deadline_ms = seconds * 1000;
    next.native_deadline_reserve_ms = 750;
    next.random_seed = makeRandomSeed();
    return next;
  }

  function uiTeacherQualityMetrics(data){
    const safeData = data || getData();
    const memo = activeAutoSortPlanningMemo(safeData);
    if(memo?.uiTeacherQualityMetrics){
      return Object.assign({}, memo.uiTeacherQualityMetrics, {
        gap_distribution:Object.assign({}, memo.uiTeacherQualityMetrics.gap_distribution || {})
      });
    }
    try{
      const statsFn = typeof window.calcTeacherTKBStats === "function"
        ? window.calcTeacherTKBStats
        : (typeof calcTeacherTKBStats === "function" ? calcTeacherTKBStats : null);
      if(typeof statsFn !== "function") return {};
      const stats = statsFn() || {};
      const teacherSessions = Number(stats.tsBuoiDay);
      if(!Number.isFinite(teacherSessions) || teacherSessions <= 0) return {};
      const onePeriod = metricNumber(stats.soBuoiDay1, 0);
      const gap1 = metricNumber(stats.soBuoiTrong1, 0);
      const gap2 = metricNumber(stats.soBuoiTrong2, 0);
      const result = {
        teacher_sessions: teacherSessions,
        one_period_teacher_sessions: onePeriod,
        teacher_gap2_sessions: gap2,
        gap_distribution: {
          "1": gap1,
          "2": gap2
        }
      };
      const savedMetrics = safeData?.tkbSolverResult?.metrics
        || safeData?.tkbRustSolverResult?.metrics
        || {};
      if(Object.prototype.hasOwnProperty.call(
        savedMetrics,
        "one_period_teacher_sessions_lower_bound"
      )){
        result.one_period_teacher_sessions_lower_bound = Math.max(
          0,
          Math.min(
            onePeriod,
            Math.round(metricNumber(
              savedMetrics.one_period_teacher_sessions_lower_bound,
              0
            ))
          )
        );
        if(Array.isArray(savedMetrics.one_period_teacher_sessions_lower_bound_evidence)){
          result.one_period_teacher_sessions_lower_bound_evidence = clonePlain(
            savedMetrics.one_period_teacher_sessions_lower_bound_evidence
          );
        }
      }
      if(memo) memo.uiTeacherQualityMetrics = clonePlain(result);
      return result;
    }catch(_){
      return {};
    }
  }

  function visibleCompleteIncumbentQualityPayload(data, basePayload){
    const safeData = data || getData();
    const completion = cheapSchoolCompletionStats(safeData);
    const quality = uiTeacherQualityMetrics(safeData);
    if(
      !completion
      || Number(completion.expected || 0) <= 0
      || Number(completion.scheduled || 0) < Number(completion.expected || 0)
      || Number(completion.unassigned || 0) > 0
      || metricNumber(quality.teacher_sessions, 0) <= 0
    ){
      return basePayload && typeof basePayload === "object" ? basePayload : null;
    }
    const payload = clonePlain(basePayload && typeof basePayload === "object" ? basePayload : {}) || {};
    payload.ok = true;
    payload.metrics = Object.assign({}, payload.metrics || {}, quality, {
      scheduled_periods:Number(completion.scheduled || 0),
      expected_periods:Number(completion.expected || 0),
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      best_effort:false
    });
    payload.validation = Object.assign({}, payload.validation || {}, {
      hard_ok:true,
      violations:[]
    });
    payload.solver = payload.solver && typeof payload.solver === "object"
      ? payload.solver
      : {runtime_settings:{}};
    if(!payload.solver.runtime_settings || typeof payload.solver.runtime_settings !== "object"){
      payload.solver.runtime_settings = {};
    }
    payload.bestEffort = false;
    payload.unassignedLessons = [];
    return payload;
  }

  function localUnassignedRepairPayload(data, repairResult, detail){
    const scheduled = countScheduledLessons(data);
    const expected = expectedLessonCount(data);
    const unassigned = Math.max(0, expected - scheduled);
    const violationsList = currentConstraintViolations(3000);
    const violations = violationsList.length;
    const hardOk = unassigned === 0 && violations === 0;
    const quality = uiTeacherQualityMetrics();
    return {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      metrics: Object.assign({
        scheduled_periods: scheduled,
        expected_periods: expected,
        unassigned_periods: unassigned,
        app_constraint_violation_count: violations,
        hard_ok: hardOk,
        core_hard_ok: hardOk,
        best_effort: !hardOk
      }, quality),
      validation: {
        hard_ok: hardOk,
        violations: violationsList.slice(0, 100)
      },
      solver: {
        name: "local_unassigned_repair_fast",
        runtime_settings: Object.assign({
          phase: "local_unassigned_repair_fast",
          ui_local_unassigned_repair_fast: true,
          elapsed_seconds: 0,
          repair_result: repairResult || null
        }, detail || {})
      },
      lessons: currentScheduleLessonsFromData(data),
      warnings: [],
      unassignedLessons: []
    };
  }

  function finishLocalUnassignedRepairPayload(data, payload){
    data.tkbSolverResult = payload;
    window.__TKB_SOLVER_LAST_PAYLOAD = payload;
    window.__TKB_SOLVER_LAST_RESULT = payload;
    window.__TKB_SOLVER_LAST_ERROR = "";
    // Keep the terminal success notice intentionally short.  The detailed
    // repair diagnostics remain available in the solver payload/E2E state.
    window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = SOLVE_COMPLETE_MESSAGE;
    try{ callMaybe("saveStore", [{force:true}]); }catch(_){}
    scheduleUiRefresh();
    schedulePostSolveUi(payload, payload);
    setStatus(SOLVE_COMPLETE_MESSAGE, "ok");
    finishProgress("100%", "ok");
    releaseAutoSortButtonSoon();
    publishE2EState("done", payload, {message: window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE, localUnassignedRepairFast: true});
    return payload;
  }

  function maybeFinishLocalUnassignedRepairSolve(settings){
    if(settings?.force_full_solve === true) return null;
    const data = getData();
    if(!data) return null;
    const before = cheapSchoolCompletionStats(data);
    if(!before || Number(before.unassigned || 0) <= 0) return null;
    if(!shouldAutoPlaceUnassignedFromUi(before, {maxPlace: 48, nearCompleteMaxMissing: 48})){
      return null;
    }
    const snapshot = snapshotScheduleData(data);
    const repairResult = autoPlaceUnassignedFromUi("before_solve", {
      maxPlace: 48,
      nearCompleteMaxMissing: 48,
      render: true
    });
    if(!repairResult || Number(repairResult.placed || 0) <= 0) return null;

    const payload = localUnassignedRepairPayload(data, repairResult, {
      before_completion: before,
      placed_periods: Number(repairResult.placed || 0) || 0
    });
    const completion = payloadCompletion(payload);
    if(!completion.complete){
      restoreScheduleData(data, snapshot);
      setStatus("Đang sắp xếp...", "info");
      return null;
    }
    if(!completion.hardOk){
      restoreScheduleData(data, snapshot);
      setStatus("Đang sắp xếp...", "info");
      return null;
    }

    data.tkbSolverResult = payload;
    try{ callMaybe("saveStore", [{force:true}]); }catch(_){}
    if(needsStrictTeacherQualityCleanup(payload)){
      window.__TKB_LAST_LOCAL_UNASSIGNED_REPAIR = Object.assign({}, repairResult, {
        needsOptimize: true,
        payload
      });
      if(settings && typeof settings === "object"){
        settings.ui_local_unassigned_repair_needs_optimize = true;
        settings.optimize_existing_schedule = true;
        settings.existing_fill_missing_schedule = true;
        settings.preserve_existing_tkb = true;
        settings.force_preserve_partial_existing = true;
        settings.preserve_existing_min_ratio = 1;
        settings.force_fresh_backend_solve = true;
        settings.allow_zero_one_quality_retry = true;
        settings.allow_teacher_session_deep_retry = true;
        settings.allow_teacher_session_fast_portfolio = true;
      }
      setStatus("Đang sắp xếp...", "info");
      return null;
    }

    return finishLocalUnassignedRepairPayload(data, payload);
  }

  function maybeFinishFastOffRestoreSolve(settings){
    if(settings?.force_full_solve === true) return null;
    const data = getData();
    if(!data) return null;
    let restoreResult = null;
    try{
      const restoreFn = window.__tkbRestorePendingOffDisplacedLessons;
      if(typeof restoreFn === "function"){
        restoreResult = restoreFn({reason:"before_solve", render:true, maxRestore:12});
      }
    }catch(err){
      console.warn(`[${VERSION}] off restore before solve failed`, err);
    }
    const flag = recentOffRestoreFlag(data);
    const restored = Math.max(
      0,
      Number(restoreResult?.restored || 0) || 0,
      Number(flag?.restored || 0) || 0
    );
    if(restored <= 0) return null;
    const expected = expectedLessonCount(data);
    const scheduled = countScheduledLessons(data);
    if(expected <= 0 || scheduled < expected) return null;
    const violations = currentConstraintViolations(3000).length;
    if(violations > 0) return null;
    const payload = localOffRestorePayload(data, {
      restored_periods: restored,
      restored_detail: restoreResult || flag || null
    });
    data.tkbOffRestoreLast = Object.assign({}, data.tkbOffRestoreLast || flag || {}, {
      consumedAt: Date.now()
    });
    data.tkbSolverResult = payload;
    window.__TKB_SOLVER_LAST_PAYLOAD = payload;
    window.__TKB_SOLVER_LAST_RESULT = payload;
    window.__TKB_SOLVER_LAST_ERROR = "";
    window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = SOLVE_COMPLETE_MESSAGE;
    try{ callMaybe("saveStore", [{force:true}]); }catch(_){}
    scheduleUiRefresh();
    schedulePostSolveUi(payload, payload);
    setStatus(SOLVE_COMPLETE_MESSAGE, "ok");
    finishProgress("100%", "ok");
    releaseAutoSortButtonSoon();
    publishE2EState("done", payload, {message: window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE, localOffRestoreFast: true});
    return payload;
  }

  async function solveWithRustApi(options){
    traceSolveStep("solve:start", {
      singlePass: options?.singlePass === true,
      shuffleOnly: options?.shuffleOnly === true
    });
    if(options?.fromHybridCaller !== true && (window.__TKB_SOLVE_UI_BUSY === true || window.__TKB_RUST_SOLVER_RUNNING === true)){
      setStatus("Đang có lượt xếp chạy, vui lòng chờ hoàn tất.", "info");
      return null;
    }
    const lockedState = syncOptimizationLockState();
    if(lockedState?.locked === true){
      setStatus(noBetterScheduleStatus(getData()?.tkbSolverResult || null), "ok");
      return null;
    }
    prepareManualSolveIntent();
    const [, scheduleMutationPersisted] = await Promise.all([
      waitForScheduleMutationCancellation(),
      waitForScheduleMutationPersistence()
    ]);
    if(!scheduleMutationPersisted){
      releaseAutoSortButtonSoon();
      setStatus(
        "Chưa lưu được thao tác Xóa lên máy chủ. Vui lòng kiểm tra kết nối rồi bấm Xếp lại.",
        "warning"
      );
      return null;
    }
    const requestedSettings = Object.assign({}, options?.settings || readSettings());
    const isHybridFocusedCall = options?.fromHybridCaller === true
      && options?.mode
      && options.mode !== "fast"
      && options.mode !== "auto";
    if(isHybridFocusedCall){
      // Never persist/carry caller aliases into a Hybrid solve.  A focused
      // mode is canonicalized exactly once below by the bridge.
      [
        "mode",
        "optimization_focus_mode",
        "optimization_focus",
        "optimization_gap_target",
        "ui_requested_solve_mode"
      ].forEach(key => delete requestedSettings[key]);
    }
    if((isHybridFocusedCall || (options?.mode && options.mode !== "fast" && options.mode !== "auto" && !requestedSettings.optimization_focus))){
      try{
        const configuredPlan = settingsForSolveRequestMode(
          options.mode,
          requestedSettings,
          getData()
        );
        if(configuredPlan?.settings){
          Object.assign(requestedSettings, configuredPlan.settings);
        }
      }catch(_){}
    }
    const settings = options?.shuffleOnly === true
      ? shuffleOnlySettings(requestedSettings)
      : requestedSettings;
    applyHybridCloudRunBudget(settings);
    enforceCompleteScheduleForUi(settings);
    if(options?.shuffleOnly !== true && isNoHintSmartFreshSettings(settings)){
      enforceNoHintFreshSolveSettings(settings);
    }
    await yieldResponsiveUi();
    if(options?.shuffleOnly !== true && settings?.ui_allow_presolve_local_fast_finish === true){
      traceSolveStep("solve:presolve-fast-start");
      const fastOffRestorePayload = maybeFinishFastOffRestoreSolve(settings);
      if(fastOffRestorePayload) return fastOffRestorePayload;
      const localUnassignedRepairPayload = maybeFinishLocalUnassignedRepairSolve(settings);
      if(localUnassignedRepairPayload) return localUnassignedRepairPayload;
      traceSolveStep("solve:presolve-fast-done");
    }
    const singlePassAutoSort = options?.singlePass === true || settings?.ui_single_pass_auto_sort === true;
    let allowSinglePassQuality = false;
    if(singlePassAutoSort){
      const localRepairNeedsOptimize = settings?.ui_local_unassigned_repair_needs_optimize === true;
      const requestedQualityRetry = localRepairNeedsOptimize
        || settings?.allow_zero_one_quality_retry === true
        || settings?.allow_teacher_session_deep_retry === true
        || settings?.allow_teacher_session_fast_portfolio === true
        || settings?.gap1_quality_target_explicit === true
        || nonnegativeNumberSetting(settings?.target_gap1_sessions) != null
        || nonnegativeNumberSetting(settings?.optimization_accept_gap1_sessions) != null;
      settings.ui_single_pass_auto_sort = true;
      settings.complete_schedule_seed_retry = false;
      settings.allow_zero_one_quality_retry = requestedQualityRetry ? true : false;
      settings.allow_teacher_session_deep_retry = settings?.allow_teacher_session_deep_retry === true;
      settings.allow_teacher_session_fast_portfolio = requestedQualityRetry ? true : false;
      allowSinglePassQuality = requestedQualityRetry
        && settings?.ui_allow_quality_after_single_pass === true
        && settings?.ui_compact_first_pass !== true;
      settings.schedule_diversity = false;
      settings.reclick_schedule_diversity = false;
      settings.require_teacher_session_diversity = false;
      delete settings.avoid_teacher_session_signature;
      delete settings.avoid_teacher_session_signatures;
      delete settings.avoid_lesson_signature;
      delete settings.avoid_lesson_signatures;
    }
    const dataForProgress = getData();
    traceSolveStep("solve:capacity-precheck-start");
    await yieldResponsiveUi();
    const capacityPrecheck = await confirmCapacityPrecheckBeforeSolve(settings);
    traceSolveStep("solve:capacity-precheck-done", {
      ok: capacityPrecheck.ok,
      capacityShortage: capacityPrecheck.capacityShortage
    });
    await yieldResponsiveUi();
    if(!capacityPrecheck.ok){
      window.__TKB_SOLVER_PRECHECK_WARNING = capacityPrecheck.warning || "";
      setStatus(
        capacityPrecheck.blockingMessage || "Đã hủy sắp xếp. Bạn có thể mở bớt tiết nghỉ/ràng buộc rồi bấm sắp xếp lại.",
        capacityPrecheck.blocked ? "warning" : "info"
      );
      return null;
    }
    if(isStopRequested()){
      setAutoSortButtonBusy(false);
      setStatus("Đã dừng sắp xếp theo yêu cầu.", "info");
      return null;
    }
    const hasSourceScheduleFingerprint = Object.prototype.hasOwnProperty.call(
      options || {},
      "sourceScheduleFingerprint"
    );
    const sourceScheduleFingerprint = String(options?.sourceScheduleFingerprint || "");
    if(
      hasSourceScheduleFingerprint
      && !autoSortPreparationMatches(dataForProgress, sourceScheduleFingerprint)
    ){
      reportAutoSortPreparationChanged();
      return null;
    }
    if(capacityPrecheck.capacityShortage){
      applyCapacityShortageAcceptedSettings(settings);
    }
    await yieldResponsiveUi();
    const knownPreflightViolationCount = Number(settings?.ui_preflight_constraint_violation_count);
    const incumbentSatisfiesCurrentConstraints = Number.isFinite(knownPreflightViolationCount)
      && knownPreflightViolationCount >= 0
      ? knownPreflightViolationCount === 0
      : currentConstraintViolations(1).length === 0;
    const protectVisibleCompleteIncumbent = (
        settings?.ui_use_existing_complete_incumbent === true
        || settings?.ui_unified_solve_kind === "refine_complete"
        || settings?.ui_quality_debt_fresh_rebuild === true
      )
      && incumbentSatisfiesCurrentConstraints;
    const scheduleSnapshot = snapshotScheduleData(dataForProgress);
    if(protectVisibleCompleteIncumbent && scheduleSnapshot){
      const visibleIncumbent = visibleCompleteIncumbentQualityPayload(
        dataForProgress,
        scheduleSnapshot.tkbSolverResult
      );
      if(visibleIncumbent){
        scheduleSnapshot.tkbSolverResult = clonePlain(visibleIncumbent);
      }
    }
    traceSolveStep("solve:snapshot-ready", {
      scheduled: snapshotScheduledLessonCount(scheduleSnapshot),
      incumbentSatisfiesCurrentConstraints
    });
    await yieldResponsiveUi();
    const scheduleBeforeFingerprint = scheduleFingerprintFromSnapshot(scheduleSnapshot);
    const progressStartedAt = Date.now();
    const activeSolveRunId = makeSolveRunId();
    window.__TKB_RUST_SOLVER_RUNNING = true;
    window.__TKB_SOLVE_UI_BUSY = true;
    setAutoSortButtonBusy(true);
    window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = "";
    window.__TKB_SOLVER_LAST_ERROR = "";
    window.__TKB_SOLVER_LAST_ERROR_PAYLOAD = null;
    window.__TKB_SOLVER_LAST_FAILURE_RETRYABLE = false;
    window.__TKB_SOLVER_LAST_REJECTED_CANDIDATE = null;
    window.__TKB_ACTIVE_SOLVE_RUN_ID = activeSolveRunId;
    window.__TKB_DEFER_SERVER_RESULT_SETTLEMENT_UNTIL_APPLY = true;
    window.__TKB_SOLVE_BACKEND_POSTED = false;
    window.__TKB_SOLVE_QUEUE_WAITING = false;
    window.__TKB_SOLVE_RELEASED_CONSTRAINT_VIOLATIONS = 0;
    publishE2EState("running", null, {runId: activeSolveRunId});
    dismissCompletionPopup(true);
    const teacherCapacityWarning = capacityPrecheck.warning || "";
    if(teacherCapacityWarning){
      try{ console.warn(`[${VERSION}] ${teacherCapacityWarning}`); }catch(_){}
      window.__TKB_SOLVER_PRECHECK_WARNING = teacherCapacityWarning;
      if(isCapacityShortageAccepted(settings)){
        setStatus("Thiếu ô xếp; phần dư sẽ nằm ở Chưa phân. Đang xếp phần còn lại...", "info");
      }else{
        setStatus(teacherCapacityWarning, "warning");
      }
    }else{
      window.__TKB_SOLVER_PRECHECK_WARNING = "";
      setStatus("Đang sắp xếp...", "info");
    }
    startProgressTicker(settings, dataForProgress);
    await yieldResponsiveUi();
    const finishWatchdog = installFinishWatchdog();
    const stagedExistingRepairState = shouldUseStagedExistingRepair(settings, dataForProgress);
    try{
      let payload;
      let acceptedCapacityPartial = false;
      const acceptSafeCapacityPartial = candidate => {
        // The zero-slack probe is a server-owned, canonical capacity proof.
        // Its result has already passed accounting, placement and hard
        // validation, so a stale browser-Agent requirement inherited by the
        // outer click must not discard it and start the 180-second fallback.
        // Keep the strict browser gate for ordinary incomplete candidates.
        const serverCapacityProbe = candidate?.solver?.runtime_settings
          ?.ui_capacity_safe_fresh_probe === true;
        const safe = (serverCapacityProbe || !strictBrowserAutomaticRequired(settings))
          && payloadIsSafeCapacityPartial(candidate);
        acceptedCapacityPartial = safe;
        if(!safe) return false;
        applyCapacityShortageAcceptedSettings(settings);
        try{
          candidate.solver = candidate.solver && typeof candidate.solver === "object" ? candidate.solver : {};
          candidate.solver.runtime_settings = candidate.solver.runtime_settings && typeof candidate.solver.runtime_settings === "object"
            ? candidate.solver.runtime_settings
            : {};
          candidate.solver.runtime_settings.ui_capacity_shortage_detected_from_payload = true;
          candidate.solver.runtime_settings.ui_capacity_shortage_accepted_after_solve = true;
        }catch(_){}
        candidate.warnings = Array.isArray(candidate.warnings) ? candidate.warnings : [];
        if(!candidate.warnings.some(item => item?.kind === "capacity_shortage_best_effort_accepted")){
          candidate.warnings.push({
            kind: "capacity_shortage_best_effort_accepted",
            message: "Hệ thống áp dụng phần lịch xếp được vì số ô học hợp lệ không đủ; tiết dư nằm trong Tiết chưa phân."
          });
        }
        return true;
      };
      let firstCompleteSeedAttemptsUsed = 0;
      try{
        if(stagedExistingRepairState){
          payload = await solveStagedExistingRepair(
            settings,
            dataForProgress,
            stagedExistingRepairState,
            activeSolveRunId
          );
        }else{
          payload = await solveCapacitySafeFreshProbe(
            settings,
            dataForProgress,
            activeSolveRunId
          );
          if(!payload){
            payload = await solveInitialFastDraft(settings, dataForProgress, activeSolveRunId);
          }
          if(!payload){
            if(settings?.ui_unified_initial_fast_draft === true){
              delete settings.ui_unified_initial_fast_draft;
              delete settings.ui_unified_initial_draft_ceiling_seconds;
              settings.ui_disable_initial_fast_draft = true;
              setStatus("Äang sáº¯p xáº¿p...", "info");
              restartProgressForRetry(settings, dataForProgress);
            }
            payload = await postSolve(settings);
          }
        }
        if(!isCurrentSolveRun(activeSolveRunId)) return null;
      }catch(firstErr){
        rethrowAuthRequiredSolve(firstErr);
        if(firstErr?.kind === "solver_busy"){
          throw firstErr;
        }else if(!shouldRetrySolveError(settings, firstErr)){
          throw firstErr;
        }else{
          const retried = await postRobustFirstCompleteRetry(
            settings,
            dataForProgress,
            activeSolveRunId,
            firstCompleteSeedAttemptsUsed
          );
          payload = retried.payload;
          firstCompleteSeedAttemptsUsed = retried.seedAttemptsUsed;
          if(!isCurrentSolveRun(activeSolveRunId)) return null;
        }
      }
      acceptSafeCapacityPartial(payload);
      let completion = payloadCompletion(payload);
      let skipFurtherRetries = completion.complete && payloadReturnedCompleteIncumbentNearDeadline(payload);
      let capacityShortageRun = acceptedCapacityPartial;
      let skipRetryLoops = (
          singlePassAutoSort
          && (
            completion.complete
              ? !allowSinglePassQuality
              : settings?.ui_allow_incomplete_retry_after_single_pass !== true
          )
        )
        || skipFurtherRetries
        || payload?.solver?.runtime_settings?.ui_staged_existing_repair === true
        || (capacityShortageRun && !completion.complete);
      if(!skipRetryLoops && !completion.complete && shouldRetryIncompleteSolve(settings, payload)){
        const retried = await postRobustFirstCompleteRetry(
          settings,
          dataForProgress,
          activeSolveRunId,
          firstCompleteSeedAttemptsUsed
        );
        payload = retried.payload;
        firstCompleteSeedAttemptsUsed = retried.seedAttemptsUsed;
        if(!isCurrentSolveRun(activeSolveRunId)) return null;
        acceptSafeCapacityPartial(payload);
        capacityShortageRun = acceptedCapacityPartial;
        completion = payloadCompletion(payload);
        skipFurtherRetries = completion.complete && payloadReturnedCompleteIncumbentNearDeadline(payload);
        skipRetryLoops = (
            singlePassAutoSort
            && (
              completion.complete
                ? !allowSinglePassQuality
                : settings?.ui_allow_incomplete_retry_after_single_pass !== true
            )
          )
          || skipFurtherRetries
          || payload?.solver?.runtime_settings?.ui_staged_existing_repair === true
          || (capacityShortageRun && !completion.complete);
      }
      if(
        !skipRetryLoops
        && positiveNumberSetting(settings?.complete_schedule_seed_retry_max_runs) > 0
        && settings?.complete_schedule_seed_retry !== true
      ){
        const requestedSeedCount = positiveNumberSetting(settings?.complete_schedule_seed_retry_max_runs);
        const seedCount = Math.min(12, requestedSeedCount);
        const seeds = schoolSeedSequence(dataForProgress, seedCount);
        let completeQualityAttempts = 0;
        for(let index = firstCompleteSeedAttemptsUsed; index < seeds.length; index += 1){
          if(completion.complete && settings?.ui_stop_after_first_complete_schedule === true) break;
          if(completion.complete && (hasHardFixedLessons(dataForProgress) || !needsStrictTeacherQualityCleanup(payload))) break;
          if(completion.complete && completeQualityAttempts >= 4) break;
          const seedSettings = completeScheduleSeedRetrySettings(
            settings,
            dataForProgress,
            seeds[index],
            index + 1
          );
          setStatus("Đang sắp xếp...", "info");
          restartProgressForRetry(seedSettings, dataForProgress);
          try{
            const seedPayload = await postSolve(seedSettings);
            if(!isCurrentSolveRun(activeSolveRunId)) return null;
            const seedCompletion = payloadCompletion(seedPayload);
            if(seedCompletion.complete){
              completeQualityAttempts += 1;
              if(!completion.complete || payloadBetterOrEqualTeacherQuality(seedPayload, payload, settings)){
                payload = seedPayload;
                completion = seedCompletion;
                acceptSafeCapacityPartial(payload);
                capacityShortageRun = acceptedCapacityPartial;
              }
              if(settings?.ui_stop_after_first_complete_schedule === true) break;
            }else if(!completion.complete && payloadBetterIncompleteSchedule(seedPayload, payload)){
              payload = seedPayload;
              completion = seedCompletion;
              acceptSafeCapacityPartial(payload);
              capacityShortageRun = acceptedCapacityPartial;
            }
          }catch(seedErr){
            rethrowCancelledSolve(seedErr, activeSolveRunId);
            rethrowAuthRequiredSolve(seedErr);
            console.warn(`[${VERSION}] complete schedule seed ${seeds[index]} skipped`, seedErr);
          }
        }
        if(completion.complete && settings?.ui_stop_after_first_complete_schedule === true){
          skipRetryLoops = true;
        }
      }
      if(!skipRetryLoops && completion.complete && String(settings?.auto_sort_mode || "") === "shuffle_fill" && !payloadFromExistingOptimize(payload)){
        const seeds = schoolSeedSequence(
          dataForProgress,
          hasFixedOffPressure(dataForProgress) || hasActiveConstraintData(dataForProgress) ? 4 : 6
        );
        for(const seed of seeds){
          const currentQuality = teacherSessionQuality(payload);
          if(currentQuality[0] === 0) break;
          const shuffleRetrySettings = Object.assign({}, settings, {
            random_seed: seed,
            solve_run_id: `${activeSolveRunId}-teacher-compact-${seed}`,
            force_fresh_backend_solve: true,
            allow_backend_cache: false
          });
          setStatus("Đang sắp xếp...", "info");
          restartProgressForRetry(shuffleRetrySettings, dataForProgress);
          try{
            const seedPayload = await postSolve(shuffleRetrySettings);
            if(!isCurrentSolveRun(activeSolveRunId)) return null;
            const seedCompletion = payloadCompletion(seedPayload);
            if(seedCompletion.complete && payloadBetterOrEqualTeacherQuality(seedPayload, payload, shuffleRetrySettings)){
              payload = seedPayload;
              completion = seedCompletion;
            }
          }catch(seedErr){
            rethrowCancelledSolve(seedErr, activeSolveRunId);
            rethrowAuthRequiredSolve(seedErr);
            console.warn(`[${VERSION}] shuffle teacher compact seed ${seed} skipped`, seedErr);
          }
        }
      }
      if(
        !skipRetryLoops
        && completion.complete
        && !payloadFromExistingOptimize(payload)
      ){
        const portfolioPlan = fastTeacherSessionPortfolioPlan(settings, dataForProgress, payload);
        if(portfolioPlan){
          const seeds = compactPortfolioSeedSequence(dataForProgress, portfolioPlan.maxAttempts);
          for(let index = 0; index < seeds.length; index += 1){
            if(fastTeacherSessionPortfolioSatisfied(payload, portfolioPlan)) break;
            const cap = fastTeacherSessionPortfolioCap(portfolioPlan, payload, index + 1);
            if(cap <= 0) break;
            const seed = seeds[index];
            const portfolioSettings = teacherSessionFastPortfolioSettings(settings, portfolioPlan, seed, cap, index + 1);
            setStatus("Đang sắp xếp...", "info");
            restartProgressForRetry(portfolioSettings, dataForProgress);
            try{
              const seedPayload = await postSolve(portfolioSettings);
              if(!isCurrentSolveRun(activeSolveRunId)) return null;
              const seedCompletion = payloadCompletion(seedPayload);
              if(seedCompletion.complete && payloadBetterOrEqualTeacherQuality(seedPayload, payload, portfolioSettings)){
                payload = seedPayload;
                completion = seedCompletion;
              }
            }catch(seedErr){
              rethrowCancelledSolve(seedErr, activeSolveRunId);
              rethrowAuthRequiredSolve(seedErr);
              console.warn(`[${VERSION}] teacher-session fast portfolio seed ${seed} skipped`, seedErr);
            }
          }
        }
      }
      if(!skipRetryLoops && completion.complete && shouldRetryZeroOneQuality(settings, dataForProgress, payload)){
        const seeds = schoolSeedSequence(dataForProgress, hasFixedOffPressure(dataForProgress) ? 10 : 6);
        let zeroOneRetryAttempted = false;
        for(let index = 0; index < seeds.length; index += 1){
          const currentQuality = teacherSessionQuality(payload);
          if(currentQuality[0] === 0 && currentQuality[1] === 0) break;
          zeroOneRetryAttempted = true;
          const zeroOneSettings = zeroOneQualityRetrySettings(
            settings,
            dataForProgress,
            payload,
            seeds[index],
            index + 1
          );
          setStatus("Đang sắp xếp...", "info");
          restartProgressForRetry(zeroOneSettings, dataForProgress);
          try{
            const zeroOnePayload = await postSolve(zeroOneSettings);
            if(!isCurrentSolveRun(activeSolveRunId)) return null;
            const zeroOneCompletion = payloadCompletion(zeroOnePayload);
            if(zeroOneCompletion.complete && payloadBetterOrEqualTeacherQuality(zeroOnePayload, payload, zeroOneSettings)){
              payload = zeroOnePayload;
              completion = zeroOneCompletion;
            }
          }catch(zeroOneErr){
            rethrowCancelledSolve(zeroOneErr, activeSolveRunId);
            rethrowAuthRequiredSolve(zeroOneErr);
            console.warn(`[${VERSION}] zero-one quality retry seed ${seeds[index]} skipped`, zeroOneErr);
          }
        }
        if(zeroOneRetryAttempted && (teacherSessionQuality(payload)[0] > 0 || teacherSessionQuality(payload)[1] > 0)){
          payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
          payload.solver.zero_one_quality_retry_exhausted = true;
        }
      }
      if(completion.complete && !skipRetryLoops && shouldRetryTeacherSessionQuality(settings, dataForProgress, payload)){
        const expectedForQuality = expectedLessonCount(dataForProgress);
        const requestedQualityAttempts = Number(settings?.teacher_session_quality_retry_attempts || 0) || 0;
        const maxQualityAttempts = Math.max(
          1,
          Math.min(
            5,
            requestedQualityAttempts || (expectedForQuality >= 900 ? 3 : 2)
          )
        );
        let qualityNoImproveAttempts = 0;
        for(let qualityAttempt = 0; qualityAttempt < maxQualityAttempts; qualityAttempt += 1){
          if(!completion.complete || !shouldRetryTeacherSessionQuality(settings, dataForProgress, payload)) break;
          const retrySettings = teacherSessionQualityRetrySettings(settings, dataForProgress, payload);
          if(!retrySettings) break;
          retrySettings.teacher_session_quality_retry_attempt = qualityAttempt + 1;
          retrySettings.solve_run_id = `${activeSolveRunId}-teacher-quality-${qualityAttempt + 1}`;
          setStatus("Đang sắp xếp...", "info");
          restartProgressForRetry(retrySettings, dataForProgress);
          try{
            const qualityPayload = await postSolve(retrySettings);
            if(!isCurrentSolveRun(activeSolveRunId)) return null;
            const qualityCompletion = payloadCompletion(qualityPayload);
            if(qualityCompletion.complete && payloadBetterOrEqualTeacherQuality(qualityPayload, payload, retrySettings)){
              const improved = payloadStrictlyBetterTeacherQuality(qualityPayload, payload, retrySettings);
              if(improved){
                payload = qualityPayload;
                completion = qualityCompletion;
                qualityNoImproveAttempts = 0;
                continue;
              }
              qualityNoImproveAttempts += 1;
            }else{
              qualityNoImproveAttempts += 1;
            }
            if(qualityNoImproveAttempts >= 1) break;
          }catch(qualityErr){
            rethrowCancelledSolve(qualityErr, activeSolveRunId);
            rethrowAuthRequiredSolve(qualityErr);
            console.warn(`[${VERSION}] teacher-session quality retry ${qualityAttempt + 1} skipped`, qualityErr);
            break;
          }
        }
      }
      if(!skipRetryLoops && !settings?.ui_skip_final_existing_teacher_gap_optimize && !settings?.optimize_existing_schedule && completion.complete && teacherQualityNeedsCleanup(payload, settings, dataForProgress) && !payloadFromExistingOptimize(payload)){
        if(!hasHardFixedLessons(dataForProgress) || settings?.allow_optimize_with_fixed_lessons === true){
          setStatus("Đang sắp xếp...", "info");
          try{
            const optimizedPayload = await optimizeExistingPayloadForTeacherGaps(
              payload,
              settings,
              dataForProgress,
              activeSolveRunId
            );
            if(!isCurrentSolveRun(activeSolveRunId)) return null;
            const optimizedCompletion = payloadCompletion(optimizedPayload);
            if(optimizedCompletion.complete && payloadBetterOrEqualTeacherQuality(optimizedPayload, payload, settings)){
              payload = optimizedPayload;
              completion = optimizedCompletion;
            }
          }catch(optimizeErr){
            rethrowCancelledSolve(optimizeErr, activeSolveRunId);
            rethrowAuthRequiredSolve(optimizeErr);
            console.warn(`[${VERSION}] final teacher gap optimize skipped`, optimizeErr);
            try{
              payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
              payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
                ? payload.solver.runtime_settings
                : {};
              payload.solver.runtime_settings.ui_final_teacher_gap_optimize_error = String(optimizeErr && (optimizeErr.message || optimizeErr) || optimizeErr).slice(0, 180);
            }catch(_){}
          }
        }
      }
      if(settings?.ui_enable_afternoon_fill_pass === true && needsAfternoonFillPass(payload, dataForProgress)){
        try{
          setStatus("Đang tính toán tổng thể...", "info");
          const fillData = dataForProgress || getData();
          const fillSettings = afternoonFillRetrySettings(settings, fillData, activeSolveRunId);
          restartProgressForRetry(fillSettings, fillData);
          const fillPayload = await postSolve(fillSettings, fillData);
          if(!isCurrentSolveRun(activeSolveRunId)) return null;
          const fillCompletion = payloadCompletion(fillPayload);
          if(
            fillCompletion.scheduled > completion.scheduled
            || payloadBetterIncompleteSchedule(fillPayload, payload)
          ){
            payload = fillPayload;
            completion = fillCompletion;
          }
        }catch(afternoonFillErr){
          rethrowCancelledSolve(afternoonFillErr, activeSolveRunId);
          rethrowAuthRequiredSolve(afternoonFillErr);
          console.warn(`[${VERSION}] afternoon fill pass skipped`, afternoonFillErr);
        }
      }
      throwIfStopRequested(activeSolveRunId);
      const runtimeElapsed = metricNumber(payload?.solver?.runtime_settings?.elapsed_seconds, NaN);
      const optimizationElapsed = metricNumber(payload?.solver?.teacher_session_optimization?.elapsed_seconds, NaN);
      const serverStartedAtMs = Math.max(0, Number(progressState?.serverStartedAtMs || 0) || 0);
      const computeStartedAtMs = serverStartedAtMs > 0 ? serverStartedAtMs : progressStartedAt;
      const completedDirectlyFromQueue = serverStartedAtMs <= 0 && progressState?.backendQueued === true;
      const reportedComputeElapsed = Math.max(
        Number.isFinite(runtimeElapsed) ? runtimeElapsed : 0,
        Number.isFinite(optimizationElapsed) ? optimizationElapsed : 0
      );
      const wallElapsed = completedDirectlyFromQueue
        ? Math.max(0.1, reportedComputeElapsed)
        : Math.max(0.1, (Date.now() - computeStartedAtMs) / 1000);
      const replayedFromCache = wallElapsed < 5 && Math.max(
        Number.isFinite(runtimeElapsed) ? runtimeElapsed : 0,
        Number.isFinite(optimizationElapsed) ? optimizationElapsed : 0
      ) > Math.max(10, wallElapsed * 8);
      const displayElapsed = replayedFromCache
        ? wallElapsed
        : Math.max(
            wallElapsed,
            Number.isFinite(runtimeElapsed) ? runtimeElapsed : 0,
            Number.isFinite(optimizationElapsed) ? optimizationElapsed : 0
          );
      try{
        payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
        payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
          ? payload.solver.runtime_settings
          : {};
        if(replayedFromCache){
          payload.solver.runtime_settings.cached_replay = true;
          if(Number.isFinite(runtimeElapsed)) payload.solver.runtime_settings.cached_original_elapsed_seconds = runtimeElapsed;
          if(Number.isFinite(optimizationElapsed)) payload.solver.runtime_settings.cached_original_optimization_elapsed_seconds = optimizationElapsed;
        }
        payload.solver.runtime_settings.ui_wall_elapsed_seconds = Number(wallElapsed.toFixed(1));
        payload.solver.runtime_settings.display_elapsed_seconds = Number(displayElapsed.toFixed(1));
        payload.solver.runtime_settings.ui_solve_run_id = activeSolveRunId;
      }catch(_){}
      const learnedComputeElapsed = Math.max(
        wallElapsed,
        Number.isFinite(runtimeElapsed) ? runtimeElapsed : 0,
        Number.isFinite(optimizationElapsed) ? optimizationElapsed : 0
      );
      rememberRefinementLearning(dataForProgress || getData(), payload, false);
      rememberSolveTiming(settings, dataForProgress, learnedComputeElapsed);
      // Receiving a result must not manufacture a late jump to 99%. Preserve
      // the canonical time-based value, then move to 100% only after the result
      // has actually been accepted and applied.
      const prepPercent = Math.min(
        RESULT_APPLY_PROGRESS_CAP,
        Math.max(4, metricNumber(progressState?.lastPercent, 0))
      );
      if(progressState) progressState.phase = "result_apply";
      setProgress(
        Math.min(RESULT_APPLY_PROGRESS_CAP, prepPercent),
        progressLabel(
          "result_apply",
          displayElapsed
        ),
        {replaceLocalPercent:true, phase:"result_apply"}
      );
      const releasedDuringSolve = Number(window.__TKB_SOLVE_RELEASED_CONSTRAINT_VIOLATIONS || 0) > 0;
      if(!completion.complete){
        const capacityWasClaimed = isCapacityShortageAccepted(settings)
          || payloadHasCapacityShortage(payload);
        const capacityShortageAccepted = acceptSafeCapacityPartial(payload);
        capacityShortageRun = capacityShortageAccepted;
        const unsafeCapacityPartial = capacityWasClaimed && !capacityShortageAccepted;
        const incumbentPayloadForIncomplete = scheduleSnapshot?.tkbSolverResult || null;
        const incumbentExpectedForIncomplete = expectedLessonCount(dataForProgress || getData());
        const incumbentScheduledForIncomplete = snapshotScheduledLessonCount(scheduleSnapshot);
        const incumbentVisibleComplete = incumbentExpectedForIncomplete > 0
          && incumbentScheduledForIncomplete >= incumbentExpectedForIncomplete;
        if(
          !releasedDuringSolve
          && incumbentVisibleComplete
          && incumbentSatisfiesCurrentConstraints
          && (
            !strictBrowserAutomaticRequired(settings)
            || !strictBrowserAutomaticQualityMessage(
              incumbentPayloadForIncomplete,
              settings
            )
          )
        ){
          const restoredData = dataForProgress || getData();
          restoreScheduleData(restoredData, scheduleSnapshot);
          const restoredPayload = restoredData?.tkbSolverResult || incumbentPayloadForIncomplete;
          syncVisibleCompletionMetrics(incumbentPayloadForIncomplete, restoredPayload);
          window.__TKB_SOLVER_LAST_PAYLOAD = restoredPayload || incumbentPayloadForIncomplete;
          window.__TKB_SOLVER_LAST_RESULT = restoredPayload || incumbentPayloadForIncomplete;
          finishProgress("100%", "ok");
          window.__TKB_RUST_SOLVER_RUNNING = false;
          window.__TKB_SOLVE_UI_BUSY = false;
          // A complete incumbent is a successful solve result. Keep the
          // visible terminal notice consistent across fresh, repair, and
          // incumbent-restore paths; diagnostics stay in E2E metadata.
          const message = SOLVE_COMPLETE_MESSAGE;
          window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = message;
          setStatus(message, "ok");
          publishE2EState("done", restoredPayload || incumbentPayloadForIncomplete, {
            message,
            keptIncumbent: true,
            rejectedIncomplete: true
          });
          refreshStatsPopoverIfOpen();
          return restoredPayload || incumbentPayloadForIncomplete;
        }
        const message = incompleteSolveMessage(payload, {
          requireComplete: settings?.require_complete_schedule === true && !capacityShortageAccepted
        });
        const acceptableWithUnassigned = payloadAcceptableWithUnassigned(payload);
        const acceptableForUiCleanup = payloadAcceptableForUiCleanup(payload);
        if(unsafeCapacityPartial){
          if(!releasedDuringSolve) restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
          window.__TKB_SOLVER_LAST_PAYLOAD = payload;
          window.__TKB_SOLVER_LAST_RESULT = null;
          window.__TKB_SOLVER_LAST_ERROR = message;
          const displayedPercent = completion.expected > 0
            ? Math.round((completion.scheduled / completion.expected) * 100)
            : 99;
          finishProgress(`${Math.max(1, Math.min(99, displayedPercent))}%`, "warning");
          window.__TKB_RUST_SOLVER_RUNNING = false;
          window.__TKB_SOLVE_UI_BUSY = false;
          setStatus(message, "warning");
          publishE2EState("incomplete", payload, {
            message,
            rejectedIncomplete:true,
            unsafeCapacityPartial:true
          });
          showCompletionPopup(message, "info");
          refreshStatsPopoverIfOpen();
          return null;
        }
        if(
          settings?.require_complete_schedule === true
          && !capacityShortageAccepted
          && !settings?.ui_staged_existing_repair
          && !acceptableWithUnassigned
          && !acceptableForUiCleanup
        ){
          if(!releasedDuringSolve) restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
          window.__TKB_SOLVER_LAST_PAYLOAD = payload;
          window.__TKB_SOLVER_LAST_RESULT = null;
          window.__TKB_SOLVER_LAST_ERROR = message;
          const displayedPercent = completion.expected > 0
            ? Math.round((completion.scheduled / completion.expected) * 100)
            : 99;
          finishProgress(`${Math.max(1, Math.min(99, displayedPercent))}%`, "warning");
          window.__TKB_RUST_SOLVER_RUNNING = false;
          window.__TKB_SOLVE_UI_BUSY = false;
          setStatus(message, "warning");
          publishE2EState("incomplete", payload, {message, rejectedIncomplete: true});
          showCompletionPopup(message, "info");
          refreshStatsPopoverIfOpen();
          return null;
        }
        if(settings?.require_complete_schedule === true && !acceptableWithUnassigned && !acceptableForUiCleanup){
          if(!releasedDuringSolve) restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
          window.__TKB_SOLVER_LAST_PAYLOAD = payload;
          window.__TKB_SOLVER_LAST_RESULT = null;
          window.__TKB_SOLVER_LAST_ERROR = message;
          const displayedPercent = completion.expected > 0
            ? Math.round((completion.scheduled / completion.expected) * 100)
            : 99;
          finishProgress(`${Math.max(1, Math.min(99, displayedPercent))}%`, "warning");
          window.__TKB_RUST_SOLVER_RUNNING = false;
          window.__TKB_SOLVE_UI_BUSY = false;
          setStatus(message, "warning");
          publishE2EState("incomplete", payload, {message});
          showCompletionPopup(message, "info");
          refreshStatsPopoverIfOpen();
          return null;
        }
        if(acceptableWithUnassigned || acceptableForUiCleanup){
          payload.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
          payload.warnings.push({
            kind: "best_effort_unassigned_accepted",
            message: "Đã áp dụng phần lịch hợp lệ; các tiết thiếu hoặc vi phạm nằm trong Tiết chưa phân."
          });
        }
        if(!payloadHasUsableSchedule(payload)){
          if(!releasedDuringSolve) restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
          window.__TKB_SOLVER_LAST_PAYLOAD = payload;
          window.__TKB_SOLVER_LAST_RESULT = null;
          window.__TKB_SOLVER_LAST_ERROR = message;
          const displayedPercent = completion.expected > 0
            ? Math.round((completion.scheduled / completion.expected) * 100)
            : 99;
          finishProgress(`${Math.max(1, Math.min(99, displayedPercent))}%`, "warning");
          window.__TKB_RUST_SOLVER_RUNNING = false;
          window.__TKB_SOLVE_UI_BUSY = false;
          setStatus(message, "warning");
          publishE2EState("incomplete", payload, {message});
          showCompletionPopup(message, "info");
          refreshStatsPopoverIfOpen();
          return null;
        }
        if(
          settings?.require_complete_schedule === true
          && !capacityShortageAccepted
          && !settings?.ui_staged_existing_repair
        ){
          if(!releasedDuringSolve) restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
          window.__TKB_SOLVER_LAST_PAYLOAD = payload;
          window.__TKB_SOLVER_LAST_RESULT = null;
          window.__TKB_SOLVER_LAST_ERROR = message;
          const displayedPercent = completion.expected > 0
            ? Math.round((completion.scheduled / completion.expected) * 100)
            : 99;
          finishProgress(`${Math.max(1, Math.min(99, displayedPercent))}%`, "warning");
          window.__TKB_RUST_SOLVER_RUNNING = false;
          window.__TKB_SOLVE_UI_BUSY = false;
          setStatus(message, "warning");
          publishE2EState("incomplete", payload, {message, rejectedIncomplete: true});
          showCompletionPopup(message, "info");
          refreshStatsPopoverIfOpen();
          return null;
        }
        window.__TKB_SOLVER_LAST_ERROR = "";
      }
      const incumbentPayload = scheduleSnapshot?.tkbSolverResult || null;
      const incumbentQualityGuard = incumbentQualityGuardState(
        incumbentPayload,
        scheduleSnapshot,
        dataForProgress || getData(),
        settings
      );
      if(
        settings?.ui_keep_better_existing_on_resort !== false
        && !isTeacherSessionOptSettings(settings)
        && !releasedDuringSolve
        && incumbentSatisfiesCurrentConstraints
        && incumbentQualityGuard
        && (
          !strictBrowserAutomaticRequired(settings)
          || !strictBrowserAutomaticQualityMessage(incumbentPayload, settings)
        )
        && shouldKeepIncumbentForTeacherQuality(payload, incumbentPayload, incumbentQualityGuard, settings)
      ){
        inheritRefinementRound(incumbentPayload, payload);
        restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
        syncVisibleCompletionMetrics(incumbentPayload, incumbentPayload);
        window.__TKB_SOLVER_LAST_PAYLOAD = incumbentPayload;
        window.__TKB_SOLVER_LAST_RESULT = incumbentPayload;
        finishProgress("100%", "ok");
        window.__TKB_RUST_SOLVER_RUNNING = false;
        window.__TKB_SOLVE_UI_BUSY = false;
        // The incumbent-quality guard can retain the current complete
        // timetable, but its terminal UI notice follows the same concise
        // success contract as every other completed path. Keep the guard
        // reason and missing count in E2E metadata below.
        const message = SOLVE_COMPLETE_MESSAGE;
        window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = message;
        setStatus(message, "ok");
        scheduleUiRefresh();
        publishE2EState("done", incumbentPayload, {
          message,
          keptIncumbent: true,
          rejectedWorseQuality: true,
          nearCompleteIncumbent: incumbentQualityGuard.nearComplete === true,
          incumbentMissing: incumbentQualityGuard.missing,
          candidateQuality: teacherQualitySummary(payload),
          incumbentQuality: teacherQualitySummary(incumbentPayload)
        });
        showCompletionPopup(message, incumbentQualityGuard.nearComplete ? "info" : "ok");
        refreshStatsPopoverIfOpen();
        return incumbentPayload;
      }
      if(
        isTeacherSessionOptSettings(settings)
        && !releasedDuringSolve
        && incumbentSatisfiesCurrentConstraints
        && incumbentQualityGuard?.complete === true
        && (
          !strictBrowserAutomaticRequired(settings)
          || !strictBrowserAutomaticQualityMessage(incumbentPayload, settings)
        )
        && shouldKeepIncumbentForTeacherQuality(payload, incumbentPayload, incumbentQualityGuard, settings)
      ){
        inheritRefinementRound(incumbentPayload, payload);
        restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
        window.__TKB_SOLVER_LAST_PAYLOAD = incumbentPayload;
        window.__TKB_SOLVER_LAST_RESULT = incumbentPayload;
        finishProgress("100%", "ok");
        window.__TKB_RUST_SOLVER_RUNNING = false;
        window.__TKB_SOLVE_UI_BUSY = false;
        const message = SOLVE_COMPLETE_MESSAGE;
        window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = message;
        setStatus(message, "ok");
        publishE2EState("done", incumbentPayload, {message, keptIncumbent: true});
        showCompletionPopup(message, "ok");
        refreshStatsPopoverIfOpen();
        return incumbentPayload;
      }
      completion = payloadCompletion(payload);
      if(shouldRejectIncompletePresetPayload(settings, payload)){
        if(!releasedDuringSolve) restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
        const message = incompleteSolveMessage(payload, {
          requireComplete: true,
          preset: settings?.ui_solver_preset
        });
        window.__TKB_SOLVER_LAST_PAYLOAD = payload;
        window.__TKB_SOLVER_LAST_RESULT = null;
        window.__TKB_SOLVER_LAST_ERROR = message;
        const displayedPercent = completion.expected > 0
          ? Math.round((completion.scheduled / completion.expected) * 100)
          : 99;
        finishProgress(`${Math.max(1, Math.min(99, displayedPercent))}%`, "warning");
        window.__TKB_RUST_SOLVER_RUNNING = false;
        window.__TKB_SOLVE_UI_BUSY = false;
        setStatus(message, "warning");
        publishE2EState("incomplete", payload, {
          message,
          rejectedIncomplete: true,
          finalPresetGuard: true
        });
        showCompletionPopup(message, "info");
        refreshStatsPopoverIfOpen();
        return null;
      }
      const strictBrowserAutomatic = strictBrowserAutomaticRequired(settings);
      const hardQualityMessage = skipFurtherRetries && !strictBrowserAutomatic
        ? ""
        : hardQualityViolationMessage(payload, settings);
      if(hardQualityMessage){
        if(!releasedDuringSolve) restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
        window.__TKB_SOLVER_LAST_PAYLOAD = payload;
        window.__TKB_SOLVER_LAST_RESULT = null;
        window.__TKB_SOLVER_LAST_ERROR = hardQualityMessage;
        finishProgress("Lỗi", "error");
        window.__TKB_RUST_SOLVER_RUNNING = false;
        window.__TKB_SOLVE_UI_BUSY = false;
        setStatus(hardQualityMessage, "error");
        publishE2EState("quality_violation", payload, {message: hardQualityMessage});
        showCompletionPopup(hardQualityMessage, "error");
        refreshStatsPopoverIfOpen();
        return null;
      }
      setStatus("Đang sắp xếp...", "info");
      await sleep(0);
      let result;
      autoSortTerminalSettlementActive = true;
      window.__TKB_AUTO_SORT_TERMINAL_SETTLEMENT_ACTIVE = true;
      try{
        result = await applyPayload(payload, settings);
      }catch(applyErr){
        const appliedRuntime = payload?.solver?.runtime_settings || {};
        const canFreshRetryRejectedStagedCandidate = isApplyPayloadCandidateContractError(applyErr)
          && !!stagedExistingRepairState
          && settings?.ui_constraint_change_repair === true
          && appliedRuntime.ui_staged_existing_repair === true
          && appliedRuntime.ui_staged_existing_fresh_retry !== true;
        if(!canFreshRetryRejectedStagedCandidate) throw applyErr;

        const rejectedDiagnostics = clonePlain(applyErr?.payload?.diagnostics || {});
        window.__TKB_SOLVER_LAST_REJECTED_CANDIDATE = {
          kind:String(applyErr?.kind || "apply_payload_candidate_contract_rejected"),
          diagnostics:rejectedDiagnostics
        };
        restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
        const retrySettings = stagedExistingFreshRetrySettings(
          settings,
          dataForProgress || getData(),
          activeSolveRunId
        );
        retrySettings.ui_staged_existing_fresh_retry_reason = "ui_candidate_contract_rejected_after_apply";
        setStatus("\u0110ang s\u1eafp x\u1ebfp...", "info");
        restartProgressForRetry(retrySettings, dataForProgress || getData());
        payload = markStagedExistingFreshRetryPayload(
          await postSolve(retrySettings, dataForProgress || getData()),
          stagedExistingRepairState,
          {
            ui_staged_apply_candidate_rejected:true,
            ui_staged_apply_rejected_count:Math.max(0, Number(rejectedDiagnostics?.rejected_periods || 0) || 0),
            ui_staged_apply_released_count:Math.max(0, Number(rejectedDiagnostics?.released_periods || 0) || 0),
            ui_staged_apply_violation_count:Math.max(0, Number(rejectedDiagnostics?.post_apply_violation_count || 0) || 0)
          }
        );
        const freshCompletion = payloadCompletion(payload);
        if(!freshCompletion.complete){
          const freshErr = new Error(incompleteSolveMessage(payload, {requireComplete:true}));
          freshErr.kind = "no_complete_schedule_before_deadline";
          freshErr.payload = payload;
          throw freshErr;
        }
        result = await applyPayload(payload, retrySettings);
      }
      const localRepairAfterPayload = metricNumber(payload?.metrics?.unassigned_periods, 0) > 0
        ? autoPlaceUnassignedFromUi("after_payload", {maxPlace: 24})
        : null;
      if(localRepairAfterPayload && Number(localRepairAfterPayload.placed || 0) > 0){
        try{
          payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
          payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
            ? payload.solver.runtime_settings
            : {};
          payload.solver.runtime_settings.ui_local_unassigned_repair = localRepairAfterPayload;
        }catch(_){}
      }
      const scheduleAfterFingerprint = scheduleFingerprintFromData(dataForProgress || getData());
      const unchangedSchedule = !!scheduleBeforeFingerprint && scheduleBeforeFingerprint === scheduleAfterFingerprint;
      if(unchangedSchedule){
        try{
          payload.solver = payload.solver && typeof payload.solver === "object" ? payload.solver : {};
          payload.solver.runtime_settings = payload.solver.runtime_settings && typeof payload.solver.runtime_settings === "object"
            ? payload.solver.runtime_settings
            : {};
          payload.solver.runtime_settings.schedule_unchanged = true;
        }catch(_){}
      }
      window.__TKB_SOLVER_LAST_PAYLOAD = payload;
      window.__TKB_SOLVER_LAST_RESULT = result;
      const finalQualityStatus = completionQualityStatus(payload, dataForProgress || getData());
      const visibleAfterApply = cheapSchoolCompletionStats(dataForProgress || getData());
      const finalScheduled = Math.max(
        0,
        Math.round(Number(visibleAfterApply?.scheduled ?? completion.scheduled) || 0)
      );
      const finalExpected = Math.max(
        0,
        Math.round(Number(visibleAfterApply?.expected ?? completion.expected) || 0)
      );
      const finalUnassigned = Math.max(
        0,
        Math.round(Number(
          visibleAfterApply?.unassigned
          ?? completion.unassigned
          ?? payloadUnassignedPeriods(payload)
        ) || 0)
      );
      const acceptedPartialTerminal = acceptedCapacityPartial
        && finalExpected > 0
        && (finalScheduled < finalExpected || finalUnassigned > 0);
      const terminalMessage = acceptedPartialTerminal
        ? `Hoàn tất: đã xếp ${finalScheduled}/${finalExpected} tiết, còn ${finalUnassigned} tiết ở Chưa phân.`
        : SOLVE_COMPLETE_MESSAGE;
      finishProgress("100%", "ok");
      window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = terminalMessage;
      setStatus(terminalMessage, "ok");
      window.__TKB_RUST_SOLVER_RUNNING = false;
      window.__TKB_SOLVE_UI_BUSY = false;
      schedulePostSolveUi(payload, result);
      clearManualFreshRetryBudget(dataForProgress || getData(), true);
      publishE2EState("done", payload, {
        message:terminalMessage,
        acceptedCapacityPartial:acceptedPartialTerminal,
        unassignedPeriods:finalUnassigned,
        scheduleUnchanged: unchangedSchedule,
        qualityDebt: qualityDebtMessage(payload, payload?.solver?.runtime_settings || settings),
        qualityTargetMet: finalQualityStatus.targetMet
      });
      if(acceptedPartialTerminal) showCompletionPopup(terminalMessage, "success");
      return result;
    }catch(err){
      if(!isCurrentSolveRun(activeSolveRunId)) return null;
      stopProgressTicker();
      if(err?.kind === "user_cancelled"){
        finishProgress("Dừng", "error");
        setStatus(err.message || "Đã dừng sắp xếp.", "info");
        try{ callMaybe("resetAutoSortStopRequest"); }catch(_){}
        try{ callMaybe("hideAutoSortProgress"); }catch(_){}
        publishE2EState("cancelled", null, {message: err.message || "user_cancelled"});
        return null;
      }
      const rawError = String(err && (err.message || err) || err);
      const friendly = friendlySolveError(err);
      if(err?.payload && typeof err.payload === "object"){
        window.__TKB_SOLVER_LAST_ERROR_PAYLOAD = err.payload;
      }
      const failedKind = String(err?.kind || err?.payload?.kind || "").trim().toLowerCase();
      if(localAgentRoleAllowed() && failedKind.startsWith("native_agent_")){
        try{
          const refreshRequiredAgent = window.checkNativeAgentNow?.();
          if(refreshRequiredAgent && typeof refreshRequiredAgent.catch === "function"){
            refreshRequiredAgent.catch(() => {});
          }
        }catch(_){ }
      }
      if(failedKind === "solver_result_auth_required" || err?.authRequired === true){
        const authMessage = "Phi\u00ean \u0111\u0103ng nh\u1eadp \u0111\u00e3 h\u1ebft h\u1ea1n. L\u01b0\u1ee3t x\u1ebfp v\u1eabn \u0111\u01b0\u1ee3c gi\u1eef tr\u00ean m\u00e1y ch\u1ee7.";
        suspendBackendResumeForAuth(err?.status, err?.payload, "solver-ui");
        window.__TKB_SOLVER_LAST_ERROR_RAW = rawError;
        window.__TKB_SOLVER_LAST_ERROR = authMessage;
        finishProgress("\u0110\u0103ng nh\u1eadp", "warning");
        setStatus(authMessage, "warning");
        publishE2EState("auth_required", err?.payload || null, {
          title:"Phi\u00ean \u0111\u0103ng nh\u1eadp h\u1ebft h\u1ea1n",
          message:authMessage,
          rawError,
          pendingJobId:readPendingBackendJob()?.jobId || ""
        });
        refreshStatsPopoverIfOpen();
        return null;
      }
      console.error(`[${VERSION}] solve failed`, err);
      window.__TKB_SOLVER_LAST_FAILURE_RETRYABLE = retryableManualFreshSolveFailure(settings, err);
      const snapshotExpected = Math.max(0, Number(expectedLessonCount(dataForProgress || getData()) || 0) || 0);
      const snapshotScheduled = Math.max(0, Number(snapshotScheduledLessonCount(scheduleSnapshot) || 0) || 0);
      if(
        failedKind === "no_complete_schedule_before_deadline"
        && snapshotExpected > 0
        && snapshotScheduled < snapshotExpected
      ){
        friendly.message = [
          `Kh\u00f4ng thay \u0111\u1ed5i ${snapshotScheduled} ti\u1ebft hi\u1ec7n c\u00f3.`,
          `Ch\u01b0a t\u00ecm \u0111\u01b0\u1ee3c l\u1ecbch \u0111\u1ee7 ${snapshotExpected} ti\u1ebft trong gi\u1edbi h\u1ea1n th\u1eddi gian hi\u1ec7n t\u1ea1i.`
        ].join(" ");
        friendly.statusMessage = `Kh\u00f4ng thay \u0111\u1ed5i ${snapshotScheduled} ti\u1ebft hi\u1ec7n c\u00f3; ch\u01b0a t\u00ecm \u0111\u01b0\u1ee3c l\u1ecbch \u0111\u1ee7.`;
      }
      window.__TKB_SOLVER_LAST_ERROR_RAW = rawError;
      window.__TKB_SOLVER_LAST_ERROR = friendly.message;
      const level = friendly.level || "error";
      const statusLevel = friendly.statusLevel || level;
      const statusMessage = friendly.statusMessage || (friendly.title ? `${friendly.title}: ${friendly.message}` : friendly.message);
      const retainedPayloadForFailure = (dataForProgress || getData())?.tkbSolverResult
        || window.__TKB_SOLVER_LAST_PAYLOAD
        || null;
      const strictRetainedMessage = strictBrowserAutomaticQualityMessage(
        retainedPayloadForFailure,
        settings
      );
      const retainedCompleteTerminal = statusLevel === "ok"
        && statusMessage === SOLVE_COMPLETE_MESSAGE
        && !!completeScheduleStateForExistingOptimize(dataForProgress || getData())
        && !strictRetainedMessage;
      const finalStatusMessage = strictRetainedMessage && !retainedCompleteTerminal
        ? strictRetainedMessage
        : statusMessage;
      const finalStatusLevel = strictRetainedMessage && !retainedCompleteTerminal
        ? "error"
        : statusLevel;
      if(retainedCompleteTerminal){
        window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = SOLVE_COMPLETE_MESSAGE;
      }
      finishProgress(
        retainedCompleteTerminal
          ? "100%"
          : (strictRetainedMessage
              ? "Lỗi"
              : (level === "warning" ? (friendly.progressLabel || "Chưa đủ") : "Lỗi")),
        retainedCompleteTerminal ? "ok" : (strictRetainedMessage ? "error" : level)
      );
      setStatus(finalStatusMessage, finalStatusLevel);
      publishE2EState(
        retainedCompleteTerminal ? "done" : (level === "warning" ? "incomplete" : "error"),
        retainedCompleteTerminal
          ? retainedPayloadForFailure
          : (err?.payload || null),
        {
          title:friendly.title,
          message:strictRetainedMessage || friendly.message,
          rawError,
          keptIncumbent:retainedCompleteTerminal
        }
      );
      if(Number(window.__TKB_SOLVE_RELEASED_CONSTRAINT_VIOLATIONS || 0) <= 0){
        restoreScheduleData(dataForProgress || getData(), scheduleSnapshot);
        rememberManualFreshRetryFailure(dataForProgress || getData(), settings, err);
      }
      refreshStatsPopoverIfOpen();
      return null;
    }finally{
      window.__TKB_DEFER_SERVER_RESULT_SETTLEMENT_UNTIL_APPLY = false;
      autoSortTerminalSettlementActive = false;
      window.__TKB_AUTO_SORT_TERMINAL_SETTLEMENT_ACTIVE = false;
      if(isCurrentSolveRun(activeSolveRunId)){
        stopProgressTicker();
        window.__TKB_RUST_SOLVER_RUNNING = false;
        window.__TKB_SOLVE_UI_BUSY = false;
        window.__TKB_ACTIVE_SOLVE_RUN_ID = "";
      }
      releaseAutoSortButtonSoon();
      try{ window.clearInterval(finishWatchdog); }catch(_){}
    }
  }

  try{
    if(window.__TKB_E2E_EXPOSE_TEST_HOOKS === true){
      window.__TKB_RUST_BRIDGE_TEST_HOOKS = {
        hardwareWorkerCount,
        localAgentRoleAllowed,
        settingsForAutoSort,
        settingsForFastQualityAutoSort,
        settingsForTeacherSessionOpt,
        countScheduledLessons,
        expectedLessonCount,
        effectiveSettingsForSolve,
        normalizeCustomSolveDurationSeconds,
        readCustomSolveDurationSeconds,
        writeCustomSolveDurationSeconds,
        applyCustomSolveDurationSettings,
        applyHybridCloudRunBudget,
        hybridCloudRunInvocationSettings,
        backendHybridDedupeScope,
        settingsForSolveRequestMode,
        applyBoundedFreshFallbackCeiling,
        fastPresetDeadlineSeconds,
        automaticSolverCeilingSeconds,
        initialAutomaticSolverCeilingSeconds,
        manualFreshRetryBudgetSeconds,
        rememberManualFreshRetryFailure,
        clearManualFreshRetryBudget,
        retryableManualFreshSolveFailure,
        incrementalRefineCeilingSeconds,
        friendlySolveError,
        buildAutomaticAutoSortPlan,
        applyRequestedSolveModeToPlan,
        settingsForPersistedOptimizationContract,
        normalizeSolveRequestMode,
        normalizeMetricProgressSnapshot,
        metricProgressPercent,
        metricProgressCurrentLabel,
        readGapProgressBaseline,
        rememberQuickGapProgressBaseline,
        refreshGapProgressBaselineFromRemote,
        canonicalizeGapProgressSnapshot,
        activeStudentSessionCount,
        buildConstraintRepairAutoSortPlan,
        stagedExistingFreshRetrySettings,
        cheapSchoolCompletionStats,
        hardQualityViolationMessage,
        strictBrowserAutomaticRequired,
        strictBrowserAutomaticQualityState,
        strictBrowserAutomaticQualityMessage,
        payloadIsMobileLocalQualityTerminal,
        payloadIsSafeCapacityPartial,
        shouldUseCapacitySafeFreshProbe,
        capacitySafeFreshProbeSettings,
        solveCapacitySafeFreshProbe,
        applyCapacityShortageAcceptedSettings,
        maybeRunBackendPrecheck,
        confirmCapacityPrecheckBeforeSolve,
        currentConstraintViolationsAsync,
        releaseConstraintViolatingLessons,
        optimizationPlateauState,
        rememberOptimizationPlateau,
        clearOptimizationPlateau,
        currentUserIsSuperadmin,
        solveRequestModeAllowedForCurrentUser,
        embeddedAutomaticSortCycleState,
        attachAutomaticSortCycleToPayload,
        automaticSortCycleState,
        ordinaryAutomaticSortLimitReached,
        rememberAutomaticSortSuccess,
        automaticSortCycleIntentFromSettings,
        persistAutomaticSortSuccess,
        refinementStatisticsImproved,
        syncOptimizationLockState,
        readSettings,
        estimateSolveSeconds,
        progressBudgetSeconds,
        visibleCompletionMetrics,
        partialExistingRepairState,
        constraintProfile,
        solveTimingProfileKey,
        readSolveTimingEstimate,
        rememberSolveTiming,
        teacherSessionGapQualityTarget,
        teacherSessionQuality,
        onePeriodTeacherSessionLowerBound,
        onePeriodTeacherSessionFloorReached,
        onePeriodTeacherSessionFloorMessage,
        completionQualityStatus,
        completeScheduleNeedsFreshQualityRebuild,
        uiTeacherQualityMetrics,
        visibleCompleteIncumbentQualityPayload,
        buildCompletionMessage,
        schedulePostSolveUi,
        finishProgress,
        setProgress,
        setStatus,
        stopStatusDots,
        noBetterScheduleStatus,
        hasVisibleTeacherQualityMetrics,
        inheritRefinementRound,
        teacherSessionOptGoalSatisfied,
        candidateWithinVisibleQualityEnvelope,
        payloadBetterOrEqualTeacherQuality,
        payloadStrictlyBetterTeacherQuality,
        teacherSessionQualityRetryPlan,
        teacherSessionQualityRetrySettings,
        shouldRetryTeacherSessionQuality,
        sanitizeRefinementLearning,
        mergeRefinementLearning,
        rememberRefinementLearning,
        dataForSolverRequest,
        shouldBuildClientFastSeed,
        compactClientFastSeed,
        buildClientFastSeed,
        incumbentQualityGuardState,
        shouldKeepIncumbentForTeacherQuality,
        snapshotScheduleData,
        restoreScheduleData,
        restoreUnimprovedRefinementSnapshot,
        restoreFailedConstraintRepairSnapshot,
        buildFreshQualityAutoSortSettings,
        clearPostRollbackSettings,
         backendJobStorageScope,
         backendScheduleScope,
         serverOwnedResultWaitMs,
         ownerBackendJobDiscoveryAllowed,
         persistentAutoResumeSuppressionForScope,
        rememberPersistentAutoResumeSuppression,
        clearPersistentAutoResumeSuppression,
        scheduleMutationTombstone,
        markScheduleMutationTombstone,
        clearScheduleMutationTombstone,
        readServerCancellationIntent,
        rememberServerCancellationIntent,
        clearServerCancellationIntent,
        retryServerCancellationIntent,
        beginScheduleMutationCancellation,
        invalidatePendingSolveForScheduleMutation,
        durableScheduleFingerprint,
        durableScheduleFingerprintMatches,
        readPendingBackendJob,
        writePendingBackendJob,
        resetPendingBackendJobForReplay,
         selectDiscoverableBackendJob,
         liveBackendJobForScheduleScope,
         inspectExistingBackendJobForManualSolve,
         observeBackendJob,
         reattachExistingServerJobPollOnly,
         beginServerJobReattachLease,
         endServerJobReattachLease,
         removePendingBackendJob,
        settledBackendJobsForScope,
        rememberSettledBackendJob,
        forgetSettledBackendJob,
        isSettledBackendJob,
        clearActiveBackendJobId,
        publishCurrentSolveExecutorState,
        clearCurrentSolveExecutorState,
        markBackendJobQueued,
        recordBackendJobStarted,
        backendProgressStageLabel,
        recordBackendLiveProgress,
         waitForServerOwnedSolverResult,
         terminalApplySaveWatchdogMs,
         deferredBackendSavePendingFor,
         awaitTrustedSolverApplySave,
         startInstantProgressTicker,
         primeAutoSortStartUi,
        startProgressTicker,
        restartProgressForRetry,
        tickEstimatedProgress,
        writeStatus,
        setStatus,
        autoSortPreflightActive,
        buildTeacherReleaseCellIndexAsync,
        localSolveLifecycleActive,
        automaticBackendResumeSuppressed,
        cancelPendingBackendResume,
        waitForScheduleMutationCancellation,
        prepareManualSolveIntent,
        pendingBackendResumeBlocked,
        schedulePendingBackendResume,
        resumePendingBackendJobOnLoad,
        backendAuthRequired:() => backendAuthRequired,
        suspendBackendResumeForAuth,
        clearBackendAuthRequired,
        postSolve
      };
    }
  }catch(_){}

  const rustApi = {
    version: VERSION,
    solve: solveWithRustApi,
    bridgeSapXepTuDongAll,
    applyPayload,
    releaseConstraintViolatingLessons,
    readSettings,
    promptSettings,
    invalidatePendingSolveForScheduleMutation
  };
  window.TKBRustAPI = rustApi;
  window.bridgeSapXepTuDongAll = bridgeSapXepTuDongAll;

  function buildFreshQualityAutoSortSettings(data, expected, preset){
    const safeData = data || getData();
    const expectedCount = Math.max(0, Number(expected || expectedLessonCount(safeData)) || 0);
    const activePreset = preset ? normalizeSolverPreset(preset) : readSolverPreset();
    const strongPreset = activePreset !== "fast";
    const qualityTargets = practicalTeacherQualityTargets(safeData);
    const settings = applyDefaultFreshSortSettings(
      settingsForFastQualityAutoSort(applyDefaultFreshSortSettings(readSettings()))
    );
    settings.ui_single_pass_auto_sort = !strongPreset;
    settings.optimization_continue_quality_search = true;
    settings.ui_no_hint_randomized_solve = true;
    settings.ui_disable_initial_fast_draft = true;
    settings.ui_force_initial_fast_draft = false;
    settings.ui_smart_fast_default = true;
    settings.ui_allow_quality_after_single_pass = strongPreset;
    settings.ui_allow_staged_existing_on_fresh_sort = false;
    settings.ui_allow_presolve_local_fast_finish = false;
    settings.ui_allow_incomplete_retry_after_single_pass = strongPreset;
    settings.ui_skip_pre_solve_constraint_release = true;
    settings.ui_keep_near_complete_existing_max_missing = 6;
    settings.ui_allow_auto_existing_optimize = false;
    settings.complete_schedule_seed_retry = false;
    settings.complete_schedule_seed_retry_max_runs = strongPreset
      ? (expectedCount >= 900 ? 4 : 3)
      : 0;
    settings.allow_zero_one_quality_retry = strongPreset;
    settings.allow_teacher_session_fast_portfolio = strongPreset;
    settings.allow_teacher_session_deep_retry = strongPreset;
    if(strongPreset){
      settings.allow_teacher_session_fast_portfolio = true;
    }
    settings.allow_quality_debt = false;
    if(qualityTargets.teacherTarget > 0){
      settings.optimization_accept_teacher_sessions = qualityTargets.teacherTarget;
      if(strongPreset){
        delete settings.target_teacher_sessions;
        delete settings.max_teacher_sessions;
        delete settings.requested_max_teacher_sessions;
        delete settings.teacher_session_target_explicit;
      }else{
        settings.target_teacher_sessions = qualityTargets.teacherTarget;
        settings.max_teacher_sessions = Math.max(
          qualityTargets.speedTeacherCap,
          Number(settings.max_teacher_sessions || 0) || 0
        );
        settings.requested_max_teacher_sessions = settings.max_teacher_sessions;
        settings.teacher_session_target_explicit = true;
      }
    }
    if(strongPreset) delete settings.session_early_stop_teacher_sessions;
    else settings.session_early_stop_teacher_sessions = positiveNumberSetting(qualityTargets.teacherTarget);
    settings.session_early_stop_max_one_period_sessions = 0;
    settings.session_early_stop_enabled = false;
    settings.fast_quality_warmup_direct = activePreset === "fast";
    if(activePreset === "fast"){
      settings.fast_quality_teacher_cap = expectedCount >= 900
        ? positiveNumberSetting(qualityTargets.speedTeacherCap)
        : positiveNumberSetting(qualityTargets.teacherTarget);
    }else{
      delete settings.fast_quality_teacher_cap;
    }
    if(strongPreset){
      // Max must actively chase zero one-period teacher gaps.  The practical
      // target remains only a bounded fallback for very tight timetables.
      settings.target_gap1_sessions = 0;
      if(qualityTargets.gap1Target != null){
        settings.optimization_accept_gap1_sessions = qualityTargets.gap1Target;
        settings.optimization_default_accept_gap1_sessions = qualityTargets.gap1Target;
      }else{
        delete settings.optimization_accept_gap1_sessions;
        delete settings.optimization_default_accept_gap1_sessions;
      }
      settings.gap1_quality_target_explicit = true;
      if(expectedCount >= 900){
        const adaptiveFloor = expectedCount >= 1200 && hasFixedOffPressure(safeData) ? 180 : 150;
        settings.optimization_adaptive_time_limit_seconds = Math.max(
          adaptiveFloor,
          Number(settings.optimization_adaptive_time_limit_seconds || 0) || 0
        );
      }
    }else if(qualityTargets.gap1Target != null){
      settings.target_gap1_sessions = qualityTargets.gap1Target;
      settings.optimization_accept_gap1_sessions = qualityTargets.gap1Target;
      settings.optimization_default_accept_gap1_sessions = qualityTargets.gap1Target;
      settings.gap1_quality_target_explicit = true;
    }else{
      delete settings.target_gap1_sessions;
      delete settings.optimization_accept_gap1_sessions;
      delete settings.optimization_default_accept_gap1_sessions;
      settings.gap1_quality_target_explicit = false;
    }
    const fixedOnlySeedSchedule = isFixedOnlySeedSchedule(safeData);
    const compactFirst = expectedCount >= 900
      && qualityTargets.teacherTarget > 0
      && fixedOnlySeedSchedule;
    if(compactFirst){
      settings.ui_compact_first_pass = true;
      settings.auto_sort_strategy = "fresh_fast_quality_compact_first";
      settings.max_teacher_sessions = qualityTargets.teacherTarget;
      settings.requested_max_teacher_sessions = qualityTargets.teacherTarget;
      settings.random_seed = makeRandomSeed();
      settings.fresh_randomize = true;
      settings.randomize_search = true;
      settings.progress_estimate_seconds = Math.min(120, Math.max(80, Number(settings.progress_estimate_seconds || 90) || 90));
      applyCompactFirstTimeBudget(settings, expectedCount);
    }
    settings.minimize_teacher_gaps = true;
    settings.period_max_teacher_gap = 1;
    settings.relax_period_teacher_gap_on_failure = false;
    settings.allow_optimize_with_fixed_lessons = true;
    settings.fast_quality_retry_time_limit_seconds = Math.max(
        expectedCount >= 900 ? 75 : 50,
        Math.min(expectedCount >= 900 ? 105 : 70, Number(settings.fast_quality_retry_time_limit_seconds || 75) || 75)
      );
    settings.teacher_session_quality_retry_attempts = activePreset === "fast"
      ? 0
      : 2;
    settings.gap_existing_optimize_attempts = Math.max(
        expectedCount >= 900 ? 5 : 4,
        Number(settings.gap_existing_optimize_attempts || 0) || 0
      );
    settings.ui_skip_final_existing_teacher_gap_optimize = true;
    settings.ui_keep_better_existing_on_resort = strongPreset;
    settings.ui_allow_best_effort_on_timeout = true;
    disableScheduleDiversitySettings(settings);
    enforceNoHintFreshSolveSettings(settings);
    applySolverPresetToSettings(settings, activePreset, safeData, expectedCount);
    settings.fresh_randomize = true;
    settings.randomize_search = true;
    settings.random_seed = makeRandomSeed();
    if(strongPreset){
      delete settings.target_teacher_sessions;
      delete settings.max_teacher_sessions;
      delete settings.requested_max_teacher_sessions;
      delete settings.teacher_session_target_explicit;
      delete settings.session_early_stop_teacher_sessions;
    }
    enforceCompletePresetSolveSettings(settings);
    settings.ui_keep_better_existing_on_resort = strongPreset;
    settings.ui_capacity_precheck_warning_only = true;
    settings.ui_skip_capacity_precheck = true;
    settings.ui_fast_auto_sort_no_capacity_precheck = true;
    return {settings, qualityTargets};
  }

  function automaticSolverCeilingSeconds(expected, data){
    return Math.max(
      manualFreshRetryBudgetSeconds(data),
      Number(expected || 0) >= LARGE_AUTOMATIC_LESSON_THRESHOLD
        ? LARGE_AUTOMATIC_DURATION_SECONDS
        : (Number(expected || 0) >= MEDIUM_AUTOMATIC_LESSON_THRESHOLD
            ? MEDIUM_AUTOMATIC_DURATION_SECONDS
            : 0)
    );
  }

  function browserAgentEnabledForAutomaticBudget(){
    if(!localAgentRoleAllowed()) return false;
    if(isWindowsNativeAgentNavigator(window.navigator)) return true;
    try{
      const executor = window.TKBBrowserWasmExecutor;
      if(!executor || typeof executor.isEnabled !== "function") return false;
      return executor.isEnabled() !== false;
    }catch(_){ return false; }
  }

  function initialAutomaticSolverCeilingSeconds(expected, data){
    const subjectPeriodCeiling = hasSubjectPeriodRequirements(data)
      ? ROBUST_AUTO_DURATION_SECONDS
      : 0;
    // Browser Agent owns the heavy solve when enabled. Give its exact local
    // pipeline the same adaptive quality window as a refinement click; the
    // old 130-second first gate left slow iPhone runs with only a few seconds
    // for quality, then handed an exhausted job to VPS.
    const firstQualityCeiling = browserAgentEnabledForAutomaticBudget()
      ? ROBUST_AUTO_DURATION_SECONDS
      : FIRST_QUALITY_GATE_CEILING_SECONDS;
    return Math.max(
      firstQualityCeiling,
      manualFreshRetryBudgetSeconds(data),
      subjectPeriodCeiling,
      Number(expected || 0) >= LARGE_AUTOMATIC_LESSON_THRESHOLD
        ? LARGE_AUTOMATIC_DURATION_SECONDS
        : (Number(expected || 0) >= MEDIUM_AUTOMATIC_LESSON_THRESHOLD
            ? MEDIUM_AUTOMATIC_DURATION_SECONDS
            : 0)
    );
  }

  function incrementalRefineCeilingSeconds(expected, data, refinementRound){
    void refinementRound;
    const quality = uiTeacherQualityMetrics(data || getData());
    const singletonTarget = onePeriodTeacherSessionTarget(quality, 0);
    const hardQualityDebt = onePeriodTeacherSessionCount(quality) > singletonTarget
      || gap2PlusCount(quality) > 0;
    // Keep ordinary compaction clicks short. A complete timetable that still
    // has singleton/Gap2 debt needs one wider exact slice: local singleton
    // repair, progressive hard-debt CP-SAT, full floor/zero retry, then the
    // session-locked Gap1 tail all need independent room on a 2,000+ period
    // school. The backend still stops on accepted targets/plateau, so this is
    // a ceiling rather than a forced wait.
    if(hardQualityDebt && Number(expected || 0) >= LARGE_AUTOMATIC_LESSON_THRESHOLD){
      return HARD_DEBT_REFINEMENT_DURATION_SECONDS;
    }
    if(hardQualityDebt && Number(expected || 0) >= MEDIUM_AUTOMATIC_LESSON_THRESHOLD){
      return ROBUST_AUTO_DURATION_SECONDS;
    }
    return REFINEMENT_AUTO_DURATION_SECONDS;
  }

  function applyIncrementalRefineCeiling(settings, expected, data, refinementRound){
    const seconds = incrementalRefineCeilingSeconds(expected, data, refinementRound);
    settings.optimization_time_limit_seconds = seconds;
    settings.optimization_adaptive_time_limit_seconds = seconds;
    settings.overall_time_limit_seconds = seconds;
    settings.integrated_time_limit = seconds;
    settings.backend_deadline_ms = seconds * 1000;
    settings.native_global_deadline_ms = seconds * 1000;
    settings.ui_allow_short_backend_deadline = true;
    return seconds;
  }

  function applyUnifiedSafetyCeiling(settings, expected, data){
    const seconds = automaticSolverCeilingSeconds(expected, data);
    settings.optimization_time_limit_seconds = seconds;
    settings.optimization_adaptive_time_limit_seconds = seconds;
    settings.overall_time_limit_seconds = seconds;
    settings.integrated_time_limit = seconds;
    settings.backend_deadline_ms = seconds * 1000;
    settings.native_global_deadline_ms = seconds * 1000;
    settings.progress_estimate_seconds = seconds;
    settings.ui_client_timeout_reserve_ms = 5000;
    settings.ui_allow_short_backend_deadline = true;
    return seconds;
  }

  function applyUnifiedInitialCeiling(settings, expected, data, ceilingOverride){
    const override = normalizeCustomSolveDurationSeconds(ceilingOverride, 0);
    const seconds = override > 0
      ? override
      : initialAutomaticSolverCeilingSeconds(expected, data);
    settings.optimization_time_limit_seconds = seconds;
    settings.optimization_adaptive_time_limit_seconds = seconds;
    settings.overall_time_limit_seconds = seconds;
    settings.integrated_time_limit = seconds;
    settings.backend_deadline_ms = seconds * 1000;
    settings.native_global_deadline_ms = seconds * 1000;
    settings.progress_estimate_seconds = seconds;
    settings.ui_allow_short_backend_deadline = true;
    return seconds;
  }

  // A staged repair has already consumed its short local slice.  If that slice
  // cannot produce a valid candidate, the same click gets one fresh rebuild;
  // it must not inherit the persistent retry budget (which may have reached
  // the 180-second refinement ceiling after earlier clicks).
  function applyBoundedFreshFallbackCeiling(settings, expected, data, requestedCustomSeconds){
    const requested = normalizeCustomSolveDurationSeconds(requestedCustomSeconds, 0);
    const seconds = requested > 0
      ? requested
      : Math.max(
          FIRST_QUALITY_GATE_CEILING_SECONDS,
          hasSubjectPeriodRequirements(data) ? ROBUST_AUTO_DURATION_SECONDS : 0,
          Number(expected || 0) >= LARGE_AUTOMATIC_LESSON_THRESHOLD
            ? LARGE_AUTOMATIC_DURATION_SECONDS
            : (Number(expected || 0) >= MEDIUM_AUTOMATIC_LESSON_THRESHOLD
                ? MEDIUM_AUTOMATIC_DURATION_SECONDS
                : 0)
        );
    return applyUnifiedInitialCeiling(settings, expected, data, seconds);
  }

  function applyUnifiedReferenceWatchdogReserve(settings){
    settings.ui_unified_reference_watchdog_reserve_ms = 20000;
    // Keep the solver watchdog handoff tight, while giving the browser an
    // additional bounded window to receive and decode the terminal payload.
    settings.ui_client_timeout_reserve_ms = 30_000;
    return settings;
  }

  function applyUnifiedTeacherQualityPriority(settings){
    settings.quality_priority_order = "one_period_teacher_sessions_gap2_gap1";
    settings.optimization_two_stage_teacher_quality = true;
    // Phase S may trade gaps for fewer sessions. Phase G keeps zero as its
    // cleanup target while the achieved session count remains a hard ceiling.
    settings.target_gap1_sessions = 0;
    settings.gap1_quality_target_explicit = true;
    return settings;
  }

  function clearFreshOnlyFlags(settings){
    [
      "ui_default_fresh_sort",
      "ui_no_hint_fresh_solve",
      "ui_no_hint_randomized_solve",
      "ui_smart_fast_default",
      "ui_disable_staged_existing_repair",
      "ui_disable_partial_existing_repair",
      "ui_force_initial_fast_draft",
      "ui_disable_initial_fast_draft"
    ].forEach(key => delete settings[key]);
    settings.ui_allow_staged_existing_on_fresh_sort = false;
    settings.ui_keep_better_existing_on_resort = true;
    settings.force_fresh_backend_solve = true;
    settings.allow_backend_cache = false;
    return settings;
  }

  function buildAutomaticAutoSortPlan(data, expected, knownConstraintViolationCount, preparedFreshPlan){
    const safeData = data || getData();
    const expectedCount = Math.max(0, Number(expected || expectedLessonCount(safeData)) || 0);
    const customDurationSeconds = readCustomSolveDurationSeconds();
    const freshPlan = preparedFreshPlan?.settings
      ? preparedFreshPlan
      : buildFreshQualityAutoSortSettings(safeData, expectedCount, "balanced");
    const settings = freshPlan.settings;
    settings.ui_solver_preset = "balanced";
    settings.ui_unified_auto_sort = true;
    settings.ui_allow_quality_after_single_pass = false;
    // One user click owns one bounded solve. A fresh click first secures a
    // complete hard-valid incumbent, then continues its quality phases inside
    // that same canonical job. Later user clicks each spend one bounded slice
    // on quality from that incumbent. Never chain hidden retry jobs.
    settings.ui_disable_initial_fast_draft = true;
    settings.ui_disable_automatic_retry = true;
    settings.ui_allow_incomplete_retry_after_single_pass = false;
    settings.ui_stop_after_first_complete_schedule = true;
    settings.complete_schedule_seed_retry = false;
    settings.complete_schedule_seed_retry_max_runs = 0;
    settings.allow_zero_one_quality_retry = false;
    settings.allow_teacher_session_fast_portfolio = false;
    settings.allow_teacher_session_deep_retry = false;
    settings.ui_skip_final_existing_teacher_gap_optimize = true;
    settings.teacher_session_quality_retry_attempts = 0;
    settings.gap_existing_optimize_attempts = 0;
    settings.optimization_benders_disable_session_early_stop = true;
    applyUnifiedSafetyCeiling(settings, expectedCount, safeData);
    applyUnifiedTeacherQualityPriority(settings);
    // A clean block-cycle checkpoint is only a warm start, not the final
    // timetable.  Returning immediately here used to leave the remaining
    // watchdog budget unused, which is exactly why large schools still showed
    // many Buổi/Gap1 entries after a successful first refinement.  Let the
    // bounded CP-SAT tail consume the same click budget; its atomic publication
    // guard retains the incumbent whenever the tail cannot improve it.
    settings.optimization_clean_quality_cycles_early_return = false;

    const knownViolations = Number(knownConstraintViolationCount);
    const hasKnownConstraintViolations = Number.isFinite(knownViolations) && knownViolations >= 0;
    if(hasKnownConstraintViolations){
      settings.ui_preflight_constraint_violation_count = Math.round(knownViolations);
    }else{
      delete settings.ui_preflight_constraint_violation_count;
    }
    const completeState = completeScheduleStateForExistingOptimize(
      safeData,
      hasKnownConstraintViolations ? knownViolations : undefined,
      expectedCount
    );
    // A complete timetable is always the incumbent for a later click.  Even a
    // rough one must enter the same strict wide-cap refinement lane: rebuilding
    // from fixed anchors discards the useful arrangement and can spend the
    // whole 180-second budget proving a fresh cap without producing a better
    // result.  The backend keeps this incumbent as an atomic Pareto fallback.
    const qualityDebtFreshRebuild = false;
    const useInitialFastStage = !completeState
      && countScheduledLessons(safeData, {flexibleOnly:true}) <= 0
      && (hasKnownConstraintViolations
        ? knownViolations === 0
        : currentConstraintViolations(1).length === 0);
    if(completeState && !qualityDebtFreshRebuild){
      clearFreshOnlyFlags(settings);
      settings.ui_disable_initial_fast_draft = true;
      settings.ui_force_initial_fast_draft = false;
      settings.ui_unified_solve_kind = "refine_complete";
      settings.ui_use_existing_complete_incumbent = true;
      // Tell the server that this complete, constraint-clean schedule was
      // checked before the refinement click. If the quality search reaches its
      // deadline without a Pareto improvement, the incumbent is still a valid
      // successful result and must be returned instead of an empty 422.
      settings.ui_existing_incumbent_revalidated = true;
      settings.ui_return_complete_incumbent_on_existing_optimize_failure = true;
      const incumbentQualityMetrics = uiTeacherQualityMetrics(safeData);
      const incumbentSingletonFloor = onePeriodTeacherSessionLowerBound(
        incumbentQualityMetrics
      );
      settings.one_period_teacher_sessions_lower_bound = incumbentSingletonFloor;
      // Continued Automatic clicks use the canonical incumbent directly. The
      // backend skips fresh Phase F, keeps singleton/Gap2 at zero as hard
      // gates, then reduces sessions without increasing Gap1 before a
      // session-locked Gap1 stage. A failed trajectory returns the incumbent.
      settings.optimization_safe_staged_reclick = true;
      settings.auto_sort_mode = "teacher_session_opt";
      settings.auto_sort_strategy = "continue_teacher_quality_from_incumbent";
      settings.preserve_existing_tkb = true;
      settings.preserve_fixed_lessons_only = true;
      settings.preserve_existing_min_ratio = 1;
      settings.optimize_existing_schedule = false;
      settings.existing_fill_missing_schedule = false;
      settings.allow_solver_warm_start = true;
      // Keep the complete incumbent as a soft, all-period hint, but do not
      // replay one deterministic CP-SAT trajectory on every "Xếp tiếp" click.
      // The backend's Pareto/incumbent guard still rejects any regression.
      settings.ui_randomized_incumbent_refinement = true;
      const refinementSeed = makeRandomSeed();
      settings.fresh_randomize = true;
      settings.randomize_search = true;
      settings.random_seed = refinementSeed;
      settings.quality_variant_seed = refinementSeed;
      const previousPayload = safeData?.tkbSolverResult || safeData?.tkbRustSolverResult || {};
      const previousRound = Math.max(0, Math.round(metricNumber(
        previousPayload?.solver?.runtime_settings?.optimization_refinement_round
          ?? previousPayload?.metrics?.optimization_refinement_round,
        0
      )));
      const nextRound = previousRound + 1;
      settings.optimization_refinement_round = nextRound;
      settings.ui_unified_refine_ceiling_seconds = applyIncrementalRefineCeiling(
        settings,
        expectedCount,
        safeData,
        nextRound
      );
      settings.ui_incremental_refine_progress = true;
      const learnedRefineSeconds = readSolveTimingEstimate(settings, safeData);
      const fallbackRefineSeconds = expectedCount >= 1200
        ? Math.min(settings.ui_unified_refine_ceiling_seconds, 90 + Math.min(60, (nextRound - 1) * 30))
        : (expectedCount >= 900
            ? Math.min(settings.ui_unified_refine_ceiling_seconds, 75 + Math.min(60, (nextRound - 1) * 30))
            : (expectedCount >= 300
                ? Math.min(settings.ui_unified_refine_ceiling_seconds, 50 + Math.min(30, (nextRound - 1) * 15))
                : 30));
      settings.progress_estimate_seconds = Math.max(
        10,
        Math.min(
          settings.ui_unified_refine_ceiling_seconds,
          Math.round(learnedRefineSeconds || fallbackRefineSeconds)
        )
      );
      settings.ui_incremental_progress_estimate_seconds = settings.progress_estimate_seconds;
      // Keep zero as the final Gap1 search target. The safe staged backend
      // fences Gap1 during session compression, then locks the achieved
      // session count while it continues Gap1 cleanup.
      settings.target_gap1_sessions = 0;
      settings.gap1_quality_target_explicit = true;
      // A complete incumbent starts an explicit "Xếp tiếp" search. The
      // adaptive ceiling is only a maximum: keep the best candidate and stop
      // as soon as the complete acceptance envelope is reached. That envelope
      // includes sessions and Gap1; zero singleton/Gap2 alone is not enough.
      settings.optimization_continue_quality_search = true;
      settings.ui_stop_refinement_when_good_enough = true;
      settings.optimization_refine_try_lower_session_cap = true;
      const subjectPeriodRefinement = hasSubjectPeriodRequirements(safeData);
      settings.optimization_refine_strict_integrated_period_bridge =
        subjectPeriodRefinement;
      // Subject-period requirements must travel with every session decision.
      // A lean session-only proposal can look much better (for example 484
      // teacher sessions) and still fail as soon as concrete periods are
      // allocated, causing the whole refinement click to return unchanged.
      // Plain schools keep the faster Benders materialization path.
      settings.optimization_benders_lean_refinement_periods =
        !subjectPeriodRefinement;
      settings.optimization_stop_on_stagnation = true;
      settings.optimization_benders_accept_stagnant_iterations = 2;
      settings.optimization_adaptive_stagnant_attempts = Math.min(4, nextRound + 1);
      settings.optimization_adaptive_stagnant_seconds = Math.min(40, 10 + nextRound * 10);
      settings.optimization_existing_incumbent_gap_attempts = nextRound >= 2 ? 4 : 3;
      [
        "optimization_existing_local_quality_lns_passes",
        "optimization_existing_local_quality_lns_pass_seconds",
        "optimization_existing_local_quality_lns_stagnant_passes",
        "optimization_existing_local_quality_lns_max_classes",
        "optimization_existing_local_quality_lns_max_lessons"
      ].forEach(key => delete settings[key]);
      applyUnifiedReferenceWatchdogReserve(settings);
      applyCustomSolveDurationSettings(settings, customDurationSeconds);
      const refineBudgetSeconds = customDurationSeconds > 0
        ? customDurationSeconds
        : settings.ui_unified_refine_ceiling_seconds;
      settings.optimization_unbounded_quality_search = false;
      settings.optimization_continue_quality_search = true;
      settings.ui_stop_refinement_when_good_enough = true;
      settings.optimization_stop_on_stagnation = true;
      settings.optimization_benders_accept_stagnant_iterations = 2;
      void refineBudgetSeconds;
      syncSolveDurationPreview(settings, customDurationSeconds);
      return {
        kind:"refine_complete",
        settings,
        qualityTargets:freshPlan.qualityTargets,
        state:completeState,
        qualityDebtFreshRebuild:false
      };
    }

    settings.ui_unified_solve_kind = "fresh_complete_first";
    // Large fresh schools with subject-period rules need a proven
    // completion-first lane.  The quality objectives are soft and are
    // continued from the returned incumbent; making them a prerequisite for
    // the first publication can turn a feasible timetable into a 422.
    // Keep this opt-in marker server-owned by requiring the backend to
    // revalidate the resulting complete payload before publication.
    if(expectedCount >= 900 || hasSubjectPeriodRequirements(safeData)){
      settings.ui_completion_first_rescue = true;
      settings.ui_completion_first_rescue_seed = 17;
    }else{
      delete settings.ui_completion_first_rescue;
      delete settings.ui_completion_first_rescue_seed;
    }
    delete settings.one_period_teacher_sessions_lower_bound;
    if(qualityDebtFreshRebuild){
      settings.ui_quality_debt_fresh_rebuild = true;
      settings.ui_keep_better_existing_on_resort = true;
      settings.allow_solver_warm_start = false;
      settings.preserve_existing_tkb = false;
      settings.force_fresh_backend_solve = true;
      settings.allow_backend_cache = false;
      settings.ui_disable_initial_fast_draft = true;
      settings.ui_force_initial_fast_draft = false;
      const qualityRebuildCeiling = customDurationSeconds > 0
        ? customDurationSeconds
        : ROBUST_AUTO_DURATION_SECONDS;
      settings.ui_unified_initial_ceiling_seconds = applyUnifiedInitialCeiling(
        settings,
        expectedCount,
        safeData,
        qualityRebuildCeiling
      );
    }else{
      delete settings.ui_quality_debt_fresh_rebuild;
    }
    delete settings.optimization_benders_lean_refinement_periods;
    settings.ui_allow_incomplete_retry_after_single_pass = false;
    settings.ui_stop_after_first_complete_schedule = true;
    delete settings.ui_unified_initial_fast_draft;
    delete settings.ui_unified_initial_draft_ceiling_seconds;
    if(useInitialFastStage){
      settings.ui_unified_initial_fast_stage = true;
      settings.ui_unified_initial_ceiling_seconds = applyUnifiedInitialCeiling(
        settings,
        expectedCount,
        safeData
      );
    }else if(!qualityDebtFreshRebuild && browserAgentEnabledForAutomaticBudget()){
      // A partial timetable is still a fresh completeness problem. Previously
      // only an entirely empty timetable received the Browser Agent's full
      // quality window, so resumed mobile/desktop attempts were normalized
      // back to 60 seconds and could expire before finding a complete seed.
      settings.ui_unified_initial_ceiling_seconds = applyUnifiedInitialCeiling(
        settings,
        expectedCount,
        safeData
      );
    }else if(!qualityDebtFreshRebuild){
      delete settings.ui_unified_initial_fast_stage;
      delete settings.ui_unified_initial_ceiling_seconds;
    }
    settings.ui_unified_first_click_quality = true;
    settings.ui_unified_return_first_complete = true;
    const firstClickTeacherTarget = positiveNumberSetting(freshPlan.qualityTargets?.teacherTarget);
    const rawFirstClickGapTarget = nonnegativeNumberSetting(freshPlan.qualityTargets?.gap1Target);
    const firstClickGapTarget = rawFirstClickGapTarget == null
      ? null
      : (useInitialFastStage
          ? rawFirstClickGapTarget
          : rawFirstClickGapTarget + Math.max(5, Math.ceil(rawFirstClickGapTarget * 0.10)));
    if(firstClickTeacherTarget > 0){
      settings.target_teacher_sessions = firstClickTeacherTarget;
      settings.max_teacher_sessions = firstClickTeacherTarget;
      settings.requested_max_teacher_sessions = firstClickTeacherTarget;
      settings.optimization_accept_teacher_sessions = firstClickTeacherTarget;
      settings.teacher_session_target_explicit = true;
    }
    if(firstClickGapTarget != null){
      settings.target_gap1_sessions = firstClickGapTarget;
      settings.optimization_accept_gap1_sessions = firstClickGapTarget;
      settings.optimization_default_accept_gap1_sessions = firstClickGapTarget;
      settings.gap1_quality_target_explicit = true;
    }
    settings.optimization_continue_quality_search = false;
    settings.optimization_benders_disable_session_early_stop = true;
    let effectiveCustomDurationSeconds = customDurationSeconds;
    if(
      effectiveCustomDurationSeconds > 0
      && effectiveCustomDurationSeconds < MIN_FRESH_SOLVE_DURATION_SECONDS
    ){
      settings.ui_requested_custom_solve_duration_seconds = effectiveCustomDurationSeconds;
      settings.ui_fresh_solve_duration_floor_applied = true;
      effectiveCustomDurationSeconds = MIN_FRESH_SOLVE_DURATION_SECONDS;
      writeCustomSolveDurationSeconds(effectiveCustomDurationSeconds);
    }
    const firstClickCeiling = Math.max(
      MIN_FRESH_SOLVE_DURATION_SECONDS,
      effectiveCustomDurationSeconds > 0
        ? effectiveCustomDurationSeconds
        : (Number(settings.optimization_time_limit_seconds || 0) || MIN_FRESH_SOLVE_DURATION_SECONDS)
    );
    const automaticFirstGood = effectiveCustomDurationSeconds <= 0;
    const boundedFirstComplete = automaticFirstGood || firstClickCeiling < 120;
    const subjectPeriodFirstClick = hasSubjectPeriodRequirements(safeData);
    // The backend first tries the clean zero-singleton / gap-at-most-one lane.
    // If user-authored constraints make that quality envelope impossible, the
    // same click may return a complete hard-valid timetable with visible
    // quality debt instead of incorrectly reporting that no timetable exists.
    settings.ui_bounded_fresh_accept_quality_debt = true;
    settings.optimization_first_click_strict_quality_gate = true;
    settings.optimization_first_click_strict_quality_gate_seconds = subjectPeriodFirstClick
      ? 105
      : 55;
    // Automatic is one complete-first pipeline. Phase F retains the first
    // hard-valid timetable as an atomic fallback; the same job then spends
    // its remaining budget on singleton, Gap2, session and Gap1 cleanup. Do
    // not make users click Play again merely to enter the quality phases.
    // Subject-period rules need one uninterrupted all-period strict search.
    // A plain school keeps the faster v1.44 lean Phase-Q path, which has already
    // produced complete zero-singleton/zero-gap2 schedules for diverse seeds in
    // roughly one minute. Both paths retain a complete hard-valid safety result.
    settings.ui_unified_return_first_complete = false;
    settings.ui_stop_after_first_complete_schedule = false;
    settings.optimization_first_click_continue_local_after_complete = true;
    settings.optimization_first_click_skip_global_quality = false;
    // Backend marker: keep the public first-click contract stable while routing
    // plain schools through the proven lean Phase-Q path. Subject-period rows
    // deliberately omit this shortcut and use the exact all-period gate.
    settings.ui_plain_first_click_lean_quality = !subjectPeriodFirstClick;
    settings.optimization_first_click_lean_global_quality = false;
    settings.optimization_first_click_quality_stop_at_cap = false;
    settings.optimization_continue_quality_search = true;
    settings.optimization_first_click_feasibility_time_limit_seconds = subjectPeriodFirstClick
      ? Math.min(105, firstClickCeiling)
      : Math.min(70, firstClickCeiling);
    // An explicit first-run budget owns the whole click. After the complete
    // feasibility phase, give nearly all remaining time to quality instead of
    // retaining the old 85-second ceiling (which made 180/275-second first
    // runs finish much like a short run and waste their extra budget).
    const explicitFirstClickQualitySeconds = !automaticFirstGood && firstClickCeiling >= 120
      ? Math.max(
          12,
          firstClickCeiling
            - settings.optimization_first_click_feasibility_time_limit_seconds
            - 10
        )
      : 0;
    const automaticFirstClickQualitySeconds = automaticFirstGood && firstClickCeiling >= 120
      ? Math.max(
          30,
          firstClickCeiling
            - settings.optimization_first_click_feasibility_time_limit_seconds
            - 10
        )
      : 0;
    settings.optimization_first_click_quality_time_limit_seconds = explicitFirstClickQualitySeconds > 0
      ? explicitFirstClickQualitySeconds
      : automaticFirstClickQualitySeconds > 0
        ? automaticFirstClickQualitySeconds
      : (boundedFirstComplete && expectedCount >= 900
          ? 35
          : Math.max(30, Math.min(85, firstClickCeiling - 90)));
    if(useInitialFastStage){
      settings.optimization_first_click_quality_minimum_seconds = boundedFirstComplete ? 12 : 24;
    }
    settings.optimization_first_click_quality_session_time_limit_seconds = boundedFirstComplete
      ? Math.min(20, settings.optimization_first_click_quality_time_limit_seconds)
      : Math.min(40, settings.optimization_first_click_quality_time_limit_seconds);
    // Large timetables first reach a useful 16-session headroom, then tighten
    // in a small incumbent-safe step. A two-session step produced a complete
    // 480-session candidate and let local LNS reach 478; the old eight-session
    // jump repeatedly exhausted its search without finding a candidate.
    settings.optimization_first_click_quality_cap_headroom = expectedCount >= 900
      ? 16
      : 8;
    settings.optimization_first_click_target_probe_step = expectedCount >= 900 ? 2 : 4;
    settings.optimization_first_click_target_probe_time_limit_seconds = expectedCount >= 900
      ? Math.max(30, Math.min(
          firstClickCeiling,
          Math.round(firstClickCeiling - settings.optimization_first_click_feasibility_time_limit_seconds - 10)
        ))
      : 60;
    // Once a complete hard-valid incumbent exists, a tighter optional cap must
    // not consume the full orphan watchdog when that cap is infeasible. Two
    // non-improving Benders iterations end this bounded convergence probe.
    settings.optimization_first_click_target_probe_convergence_ceiling_seconds = expectedCount >= 900
      ? Math.min(120, firstClickCeiling)
      : 60;
    settings.optimization_first_click_target_probe_enabled = firstClickCeiling >= 180;
    settings.optimization_first_click_local_lns_time_limit_seconds = boundedFirstComplete
      ? (expectedCount >= 900 ? 30 : 18)
      : (useInitialFastStage ? 12 : (firstClickCeiling >= 150 ? 45 : 10));
    settings.optimization_existing_local_quality_lns_passes = expectedCount >= 900
      ? (boundedFirstComplete ? 16 : 6)
      : 4;
    settings.optimization_existing_local_quality_lns_pass_seconds = expectedCount >= 900
      ? (boundedFirstComplete ? 3 : 7)
      : 5;
    settings.optimization_existing_local_quality_lns_stagnant_passes = boundedFirstComplete
      && expectedCount >= 900
      ? 5
      : 3;
    settings.optimization_existing_local_quality_lns_max_classes = expectedCount >= 900 ? 12 : 8;
    settings.optimization_existing_local_quality_lns_max_lessons = expectedCount >= 900 ? 420 : 300;
    // A deleted timetable is a real no-hint solve. Give every Play click a new
    // CP-SAT and quality-variant trajectory instead of replaying one benchmark
    // seed forever; strict completeness and quality gates still decide apply.
    const freshSeed = makeRandomSeed();
    settings.ui_no_hint_randomized_solve = true;
    settings.fresh_randomize = true;
    settings.randomize_search = true;
    settings.random_seed = freshSeed;
    settings.quality_variant_seed = freshSeed;
    settings.session_early_stop_enabled = false;
    settings.session_early_stop_max_one_period_sessions = 0;
    settings.optimization_stop_on_stagnation = true;
    settings.optimization_adaptive_stagnant_attempts = 2;
    settings.optimization_adaptive_stagnant_seconds = 20;
    applyUnifiedReferenceWatchdogReserve(settings);
    // Only an explicit long custom budget opts into deep quality search. The
    // automatic lane returns the first complete result that clears its strict
    // quality gate, while retaining 180 seconds for genuinely difficult data.
    settings.optimization_unbounded_quality_search = (
      automaticFirstGood && firstClickCeiling >= 120
    ) || effectiveCustomDurationSeconds >= 120;
    if(settings.optimization_unbounded_quality_search){
      // Keep searching while quality improves; the backend's Benders lane
      // stops only after its convergence threshold is reached.
      settings.optimization_stop_on_stagnation = true;
      settings.optimization_benders_accept_stagnant_iterations = 2;
    }
    applyCustomSolveDurationSettings(settings, effectiveCustomDurationSeconds);
    const automaticRetryRecord = effectiveCustomDurationSeconds <= 0
      ? manualFreshRetryRecord(safeData)
      : null;
    if(automaticRetryRecord){
      settings.ui_manual_fresh_retry_seconds = automaticRetryRecord.nextSeconds;
      settings.ui_manual_fresh_retry_failures = automaticRetryRecord.failures;
    }else{
      delete settings.ui_manual_fresh_retry_seconds;
      delete settings.ui_manual_fresh_retry_failures;
    }
    if(!automaticFirstGood && firstClickCeiling >= 120){
      settings.ui_custom_fresh_continue_quality = true;
      settings.ui_unified_return_first_complete = false;
      settings.ui_stop_after_first_complete_schedule = false;
      settings.optimization_first_click_continue_local_after_complete = true;
      settings.optimization_first_click_skip_global_quality = false;
      settings.optimization_first_click_lean_global_quality = false;
      settings.optimization_first_click_quality_stop_at_cap = false;
      settings.optimization_continue_quality_search = true;
    }
    syncSolveDurationPreview(settings, effectiveCustomDurationSeconds);
    return {
      kind:qualityDebtFreshRebuild ? "refine_complete" : "fresh_complete_first",
      settings,
      qualityTargets:freshPlan.qualityTargets,
      state:qualityDebtFreshRebuild ? completeState : null,
      qualityDebtFreshRebuild
    };
  }

  function configurePlanMetricProgress(settings, focus, current, target, baseline){
    const normalized = normalizeMetricProgressSnapshot({
      optimizationFocus:focus,
      metricCurrent:current,
      metricTarget:target,
      metricBaseline:baseline
    });
    if(!normalized) return settings;
    settings.ui_progress_metric_focus = normalized.focus;
    settings.ui_progress_metric_current = normalized.current;
    settings.ui_progress_metric_target = normalized.target;
    settings.ui_progress_metric_baseline = normalized.baseline;
    settings.ui_progress_metric_percent = normalized.percent;
    return settings;
  }

  function applyDesktopFullReferenceRefineCeiling(settings){
    const seconds = DESKTOP_FULL_REFERENCE_REFINE_SECONDS;
    settings.optimization_time_limit_seconds = seconds;
    settings.optimization_adaptive_time_limit_seconds = seconds;
    settings.overall_time_limit_seconds = seconds;
    settings.integrated_time_limit = seconds;
    settings.backend_deadline_ms = seconds * 1000;
    settings.native_global_deadline_ms = seconds * 1000;
    settings.progress_estimate_seconds = seconds;
    settings.ui_unified_refine_ceiling_seconds = seconds;
    settings.ui_incremental_progress_estimate_seconds = seconds;
    settings.ui_progress_budget_seconds = seconds;
    settings.ui_client_timeout_reserve_ms = Math.max(
      30_000,
      Number(settings.ui_client_timeout_reserve_ms || 0) || 0
    );
    settings.ui_allow_short_backend_deadline = false;
    settings.ui_browser_full_reference_refine_deadline_extended = true;
    return seconds;
  }

  function applyDesktopStrictAutomaticCeiling(settings){
    const seconds = DESKTOP_FULL_REFERENCE_REFINE_SECONDS;
    settings.optimization_time_limit_seconds = seconds;
    settings.optimization_adaptive_time_limit_seconds = seconds;
    settings.overall_time_limit_seconds = seconds;
    settings.integrated_time_limit = seconds;
    settings.backend_deadline_ms = seconds * 1000;
    settings.native_global_deadline_ms = seconds * 1000;
    settings.progress_estimate_seconds = seconds;
    settings.ui_incremental_progress_estimate_seconds = seconds;
    settings.ui_progress_budget_seconds = seconds;
    settings.ui_client_timeout_reserve_ms = Math.max(
      30_000,
      Number(settings.ui_client_timeout_reserve_ms || 0) || 0
    );
    settings.ui_allow_short_backend_deadline = false;
    settings.ui_browser_strict_automatic_deadline_extended = true;
    return seconds;
  }

  function focusedOptimizationCeilingSeconds(settings){
    if(!settings || typeof settings !== "object") return 0;
    const focus = String(settings.optimization_focus || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if(!["singletons", "sessions", "gaps"].includes(focus)) return 0;
    const customSeconds = customSolveDurationFromSettings(settings);
    return Math.max(
      MIN_CUSTOM_SOLVE_DURATION_SECONDS,
      Math.min(
        FOCUSED_OPTIMIZATION_CEILING_SECONDS,
        customSeconds > 0 ? customSeconds : FOCUSED_OPTIMIZATION_CEILING_SECONDS
      )
    );
  }

  function applyFocusedOptimizationCeiling(settings){
    if(!settings || typeof settings !== "object") return settings;
    const seconds = focusedOptimizationCeilingSeconds(settings);
    if(seconds <= 0) return settings;
    const customSeconds = customSolveDurationFromSettings(settings);
    settings.optimization_time_limit_seconds = seconds;
    settings.optimization_adaptive_time_limit_seconds = seconds;
    settings.overall_time_limit_seconds = seconds;
    settings.integrated_time_limit = seconds;
    settings.backend_deadline_ms = seconds * 1000;
    settings.native_global_deadline_ms = seconds * 1000;
    settings.progress_estimate_seconds = seconds;
    settings.ui_unified_refine_ceiling_seconds = seconds;
    settings.ui_progress_budget_seconds = seconds;
    if(customSeconds > 0){
      // Keep the user's persisted input untouched, but cap the per-request
      // copy. Otherwise the later custom-duration normalization restores the
      // original value and silently expands the actual wire deadline.
      settings.ui_custom_solve_duration_seconds = seconds;
      settings.ui_custom_solve_duration_override = true;
    }
    const incrementalEstimate = Number(settings.ui_incremental_progress_estimate_seconds);
    if(Number.isFinite(incrementalEstimate) && incrementalEstimate > 0){
      settings.ui_incremental_progress_estimate_seconds = Math.min(
        seconds,
        Math.round(incrementalEstimate)
      );
    }
    const capSeconds = key => {
      const current = Number(settings[key]);
      if(Number.isFinite(current) && current > 0){
        settings[key] = Math.max(1, Math.min(seconds, Math.round(current)));
      }
    };
    [
      "optimization_first_cap_time_limit_seconds",
      "optimization_session_time_limit",
      "optimization_period_retry_time_limit",
      "session_time_limit",
      "period_time_limit",
      "period_fast_time_limit",
      "period_retry_time_limit",
      "fast_quality_retry_time_limit_seconds",
      "native_cpsat_quality_time_limit_seconds",
      "native_cpsat_time_limit_seconds",
      "native_cpsat_lns_time_limit_seconds"
    ].forEach(capSeconds);
    const capMilliseconds = key => {
      const current = Number(settings[key]);
      if(Number.isFinite(current) && current > 0){
        settings[key] = Math.max(1, Math.min(seconds * 1000, Math.round(current)));
      }
    };
    [
      "native_fresh_time_limit_ms",
      "native_fresh_cleanup_time_limit_ms",
      "native_cpsat_relaxed_hint_time_limit_ms",
      "native_cpsat_relaxed_hint_cleanup_ms"
    ].forEach(capMilliseconds);
    return settings;
  }

  function clearInheritedFocusedQualityPolicy(settings){
    if(!settings || typeof settings !== "object") return settings;
    for(const key of [
      "quality_priority_order",
      "target_one_period_teacher_sessions",
      "target_teacher_sessions",
      "target_gap1_sessions",
      "target_gap2_plus_sessions",
      "optimization_accept_teacher_sessions",
      "optimization_default_accept_teacher_sessions",
      "optimization_accept_gap1_sessions",
      "optimization_default_accept_gap1_sessions",
      "session_early_stop_teacher_sessions",
      "session_early_stop_max_one_period_sessions",
      "optimization_benders_gap_objective_target",
      "optimization_benders_lock_teacher_sessions",
      "optimization_benders_minimize_hint_distance",
      "browser_wasm_singleton_progressive_search",
      "browser_wasm_singleton_max_waves",
      "browser_wasm_singleton_wave_deadline_ms",
      "browser_wasm_session_deep_search",
      "browser_wasm_session_deep_max_waves",
      "browser_wasm_session_wave_deadline_ms",
      "browser_wasm_gap_progressive_search",
      "browser_wasm_gap_max_waves",
      "browser_wasm_gap_wave_deadline_ms",
      "optimization_refine_try_lower_session_cap",
      "native_skip_teacher_optimization"
    ]) delete settings[key];
    settings.optimization_two_stage_teacher_quality = false;
    settings.optimization_first_click_singleton_cleanup = false;
    settings.optimization_first_click_gap_cleanup = false;
    settings.optimization_first_click_strict_quality_gate = false;
    settings.optimization_first_click_continue_local_after_complete = false;
    settings.optimization_first_click_skip_global_quality = true;
    settings.optimization_benders_minimize_teacher_sessions = false;
    settings.optimization_benders_minimize_one_period_sessions = false;
    settings.optimization_benders_minimize_period_gaps = false;
    settings.optimization_benders_minimize_hint_distance = false;
    settings.minimize_one_period_sessions = false;
    settings.minimize_sessions = false;
    settings.minimize_teacher_gaps = false;
    settings.period_max_teacher_gap = "off";
    settings.teacher_session_target_explicit = false;
    settings.gap1_quality_target_explicit = false;
    return settings;
  }

  function applyRequestedSolveModeToPlan(plan, requestedMode, data, expected){
    if(!plan?.settings) return plan;
    const mode = normalizeSolveRequestMode(requestedMode);
    const safeData = data || getData();
    const settings = plan.settings;
    const expectedCount = Math.max(0, Number(expected || expectedLessonCount(safeData)) || 0);
    const scheduledCount = Math.max(0, countScheduledLessons(safeData));
    const complete = !!currentScheduleAppearsComplete(safeData);
    settings.ui_requested_solve_mode = mode;

    if(mode === SOLVE_REQUEST_MODES.automatic || mode === SOLVE_REQUEST_MODES.autoMin2){
      const inheritedFocusedPolicy = settings.optimization_focused_objective_only === true
        || String(settings.quality_priority_order || "").trim().toLowerCase().startsWith("focused_")
        || [
          SOLVE_REQUEST_MODES.singletons,
          SOLVE_REQUEST_MODES.sessions,
          SOLVE_REQUEST_MODES.gap1,
          SOLVE_REQUEST_MODES.gap2,
          SOLVE_REQUEST_MODES.gaps
        ].includes(normalizeSolveRequestMode(settings.ui_deferred_optimization_focus));
      settings.optimization_focus = "automatic";
      delete settings.optimization_gap_target;
      delete settings.optimization_benders_gap_objective_target;
      delete settings.optimization_focused_objective_only;
      if(inheritedFocusedPolicy){
        for(const key of [
          "target_one_period_teacher_sessions",
          "target_teacher_sessions",
          "target_gap1_sessions",
          "target_gap2_plus_sessions",
          "optimization_accept_teacher_sessions",
          "optimization_default_accept_teacher_sessions",
          "optimization_accept_gap1_sessions",
          "optimization_default_accept_gap1_sessions",
          "session_early_stop_teacher_sessions",
          "session_early_stop_max_one_period_sessions",
          "optimization_benders_lock_teacher_sessions",
          "optimization_benders_minimize_teacher_sessions",
          "optimization_benders_minimize_one_period_sessions",
          "optimization_benders_minimize_period_gaps",
          "optimization_benders_minimize_hint_distance"
        ]) delete settings[key];
        if(String(settings.quality_priority_order || "").trim().toLowerCase().startsWith("focused_")){
          delete settings.quality_priority_order;
        }
      }
      if(mode === SOLVE_REQUEST_MODES.autoMin2){
        settings.minimize_one_period_sessions = true;
        settings.max_one_period_sessions = 0;
        settings.strict_one_period_sessions_cap = true;
        settings.enforce_max_one_period_sessions = true;
        settings.one_period_priority_absolute = true;
        settings.target_one_period_teacher_sessions = 0;
        settings.session_early_stop_max_one_period_sessions = 0;
        settings.one_period_teacher_sessions_lower_bound = 0;
        settings.allow_quality_debt = false;
        settings.teacher_min_hours_daily = 2;
        settings.min_hours_per_session = 2;
        settings.teacher_min_hours_per_morning = 2;
        settings.teacher_min_hours_per_afternoon = 2;
        settings.ui_auto_min2_mode = true;
        settings.quality_priority_order = "one_period_teacher_sessions_gap2_gap1";
        settings.optimization_two_stage_teacher_quality = true;
        settings.target_gap1_sessions = 0;
        settings.gap1_quality_target_explicit = true;
      }
      settings.ui_progress_mode = "time";
      clearPlanMetricProgress(settings);
      return plan;
    }

    settings.ui_progress_mode = "work";
    delete settings.ui_progress_gap1_baseline;
    delete settings.ui_progress_gap2_baseline;

    // Focused optimization starts only from a complete, validated timetable.
    // If the user chooses it too early, complete the timetable first and keep
    // the requested focus visible in diagnostics for the next click.
    if(!complete && mode !== SOLVE_REQUEST_MODES.quickComplete){
      settings.ui_deferred_optimization_focus = mode;
      settings.ui_requested_solve_mode = SOLVE_REQUEST_MODES.quickComplete;
      settings.optimization_focus = "quick_complete";
      configurePlanMetricProgress(
        settings,
        "scheduled_periods",
        scheduledCount,
        expectedCount,
        expectedCount
      );
      return plan;
    }

    if(mode === SOLVE_REQUEST_MODES.quickComplete){
      settings.optimization_focus = "quick_complete";
      delete settings.optimization_gap_target;
      settings.optimization_two_stage_teacher_quality = false;
      settings.optimization_first_click_singleton_cleanup = false;
      settings.optimization_first_click_gap_cleanup = false;
      settings.optimization_first_click_strict_quality_gate = false;
      settings.optimization_quick_complete_allow_gap2_debt = true;
      settings.optimization_quick_complete_allow_quality_debt = true;
      settings.optimization_first_click_continue_local_after_complete = false;
      settings.optimization_first_click_skip_global_quality = true;
      settings.optimization_first_click_local_lns_time_limit_seconds = 0;
      settings.optimization_benders_session_feasibility_only = true;
      settings.optimization_benders_minimize_one_period_sessions = false;
      settings.optimization_benders_minimize_period_gaps = false;
      settings.minimize_one_period_sessions = false;
      settings.minimize_sessions = false;
      settings.max_one_period_sessions = "off";
      settings.strict_one_period_sessions_cap = false;
      settings.enforce_max_one_period_sessions = false;
      settings.one_period_priority_absolute = false;
      settings.allow_quality_debt = true;
      settings.minimize_teacher_gaps = false;
      settings.period_max_teacher_gap = "off";
      settings.relax_period_teacher_gap_on_failure = true;
      settings.native_skip_teacher_optimization = true;
      delete settings.target_one_period_teacher_sessions;
      delete settings.target_teacher_sessions;
      delete settings.target_gap1_sessions;
      delete settings.target_gap2_plus_sessions;
      delete settings.optimization_accept_teacher_sessions;
      delete settings.optimization_default_accept_teacher_sessions;
      delete settings.optimization_accept_gap1_sessions;
      delete settings.optimization_default_accept_gap1_sessions;
      delete settings.session_early_stop_teacher_sessions;
      delete settings.session_early_stop_max_one_period_sessions;
      configurePlanMetricProgress(
        settings,
        "scheduled_periods",
        scheduledCount,
        expectedCount,
        expectedCount
      );
      return plan;
    }

    const visibleMetrics = uiTeacherQualityMetrics(safeData);
    const currentSessions = Math.max(0, metricNumber(visibleMetrics.teacher_sessions, 0));
    const currentSingletons = Math.max(
      0,
      metricNumber(visibleMetrics.one_period_teacher_sessions, 0)
    );
    const currentSingletonTarget = onePeriodTeacherSessionLowerBound(
      visibleMetrics
    );
    const currentGap2 = Math.max(0, gap2PlusCount(visibleMetrics));
    const currentGap1 = Math.max(0, gapExactCount(visibleMetrics, 1));
    const currentTotalGap = Math.max(0, metricGapTotal(visibleMetrics));
    settings.auto_sort_mode = "teacher_session_opt";
    settings.ui_unified_solve_kind = "refine_complete";
    settings.ui_use_existing_complete_incumbent = true;
    settings.ui_existing_incumbent_revalidated = true;
    settings.ui_return_complete_incumbent_on_existing_optimize_failure = true;
    settings.preserve_existing_tkb = true;
    settings.preserve_fixed_lessons_only = true;
    settings.allow_solver_warm_start = true;
    settings.optimization_continue_quality_search = true;
    settings.ui_stop_refinement_when_good_enough = false;
    settings.optimization_focused_objective_only = true;
    settings.optimization_incumbent_one_period_sessions = currentSingletons;
    settings.optimization_incumbent_teacher_sessions = currentSessions;
    settings.optimization_incumbent_gap1_sessions = currentGap1;
    settings.optimization_incumbent_gap2_plus_sessions = currentGap2;
    settings.optimization_incumbent_gap_periods = currentTotalGap;
    clearInheritedFocusedQualityPolicy(settings);
    settings.max_one_period_sessions = mode === SOLVE_REQUEST_MODES.automatic
      ? currentSingletonTarget
      : currentSingletons;
    settings.strict_one_period_sessions_cap = true;
    settings.enforce_max_one_period_sessions = true;
    settings.one_period_priority_absolute = false;
    settings.max_teacher_sessions = currentSessions;
    settings.requested_max_teacher_sessions = currentSessions;
    settings.strict_teacher_session_cap = true;
    settings.optimization_benders_max_teacher_gap1_sessions = currentGap1;
    settings.optimization_benders_max_teacher_gap2_plus_sessions = currentGap2;
    settings.optimization_benders_max_teacher_gap_periods = currentTotalGap;
    settings.allow_quality_debt = true;
    settings.optimization_benders_allow_one_period_debt =
      currentSingletons > currentSingletonTarget;

    if(mode === SOLVE_REQUEST_MODES.singletons){
      settings.optimization_focus = "singletons";
      delete settings.optimization_gap_target;
      settings.browser_wasm_singleton_progressive_search = true;
      settings.browser_wasm_singleton_max_waves = 7;
      settings.browser_wasm_singleton_wave_deadline_ms = 25000;
      settings.minimize_one_period_sessions = true;
      settings.minimize_sessions = false;
      settings.minimize_teacher_gaps = false;
      settings.period_max_teacher_gap = "off";
      settings.optimization_benders_session_feasibility_only = false;
      settings.optimization_benders_minimize_teacher_sessions = false;
      settings.optimization_benders_minimize_one_period_sessions = true;
      settings.optimization_benders_minimize_period_gaps = false;
      settings.optimization_benders_period_gap_priority_absolute = false;
      settings.max_one_period_sessions = "off";
      settings.strict_one_period_sessions_cap = false;
      settings.enforce_max_one_period_sessions = false;
      settings.one_period_priority_absolute = true;
      settings.allow_quality_debt = true;
      settings.optimization_benders_allow_one_period_debt = true;
      settings.target_one_period_teacher_sessions = currentSingletonTarget;
      configurePlanMetricProgress(
        settings,
        "one_period_teacher_sessions",
        currentSingletons,
        currentSingletonTarget,
        currentSingletons
      );
      applyFocusedOptimizationCeiling(settings);
      return plan;
    }

    if(mode === SOLVE_REQUEST_MODES.sessions){
      settings.optimization_focus = "sessions";
      delete settings.optimization_gap_target;
      settings.optimization_refine_try_lower_session_cap = true;
      settings.browser_wasm_session_deep_search = true;
      settings.browser_wasm_session_deep_max_waves = 16;
      settings.browser_wasm_session_wave_deadline_ms = 15000;
      settings.minimize_sessions = true;
      settings.minimize_one_period_sessions = false;
      settings.minimize_teacher_gaps = false;
      settings.period_max_teacher_gap = "off";
      settings.optimization_benders_session_feasibility_only = false;
      settings.optimization_benders_minimize_teacher_sessions = true;
      settings.optimization_benders_minimize_one_period_sessions = false;
      settings.optimization_benders_minimize_period_gaps = false;
      settings.optimization_benders_period_gap_priority_absolute = false;
      settings.session_early_stop_max_one_period_sessions = currentSingletons;
      const activeStudentSessions = Math.max(1, activeStudentSessionCount(safeData));
      const loadLowerBound = Math.max(1, teacherSessionLoadLowerCap(safeData));
      const sessionTarget = Math.min(
        currentSessions || activeStudentSessions,
        Math.max(loadLowerBound, activeStudentSessions)
      );
      settings.ui_active_student_sessions = activeStudentSessions;
      settings.ui_teacher_session_progress_target = sessionTarget;
      settings.target_teacher_sessions = sessionTarget;
      settings.teacher_session_target_explicit = true;
      configurePlanMetricProgress(
        settings,
        "teacher_sessions",
        currentSessions,
        sessionTarget,
        currentSessions
      );
      applyFocusedOptimizationCeiling(settings);
      return plan;
    }

    const gapTarget = gapOptimizationTargetForSolveRequestMode(mode);
    settings.optimization_focus = "gaps";
    if(gapTarget) settings.optimization_gap_target = gapTarget;
    else delete settings.optimization_gap_target;
    settings.optimization_refine_try_lower_session_cap = false;
    settings.browser_wasm_gap_progressive_search = true;
    settings.browser_wasm_gap_max_waves = 12;
    settings.browser_wasm_gap_wave_deadline_ms = 15000;
    settings.minimize_sessions = false;
    settings.minimize_one_period_sessions = false;
    settings.minimize_teacher_gaps = true;
    settings.period_max_teacher_gap = "off";
    settings.optimization_benders_session_feasibility_only = false;
    settings.optimization_benders_minimize_teacher_sessions = false;
    settings.optimization_benders_minimize_one_period_sessions = false;
    settings.optimization_benders_minimize_period_gaps = true;
    settings.optimization_benders_period_gap_priority_absolute = true;
    settings.optimization_benders_gap_objective_target = gapTarget || "";
    settings.session_early_stop_max_one_period_sessions = currentSingletons;
    if(gapTarget === "gap2"){
      settings.target_gap2_plus_sessions = 0;
      settings.gap1_quality_target_explicit = false;
    }else{
      settings.target_gap1_sessions = 0;
      settings.gap1_quality_target_explicit = true;
    }
    const gapBaseline = readGapProgressBaseline(safeData);
    const gap2Baseline = gapBaseline ? gapBaseline.gap2Plus : currentGap2;
    const gap1Baseline = gapBaseline ? gapBaseline.gap1 : currentGap1;
    settings.ui_progress_gap1_baseline = gap1Baseline;
    settings.ui_progress_gap2_baseline = gap2Baseline;
    if(gapTarget === "gap2"){
      configurePlanMetricProgress(
        settings,
        "teacher_gap2_sessions",
        currentGap2,
        0,
        gap2Baseline
      );
      applyFocusedOptimizationCeiling(settings);
      return plan;
    }
    if(gapTarget === "gap1"){
      configurePlanMetricProgress(
        settings,
        "teacher_gap1_sessions",
        currentGap1,
        0,
        gap1Baseline
      );
      applyFocusedOptimizationCeiling(settings);
      return plan;
    }
    configurePlanMetricProgress(
      settings,
      "teacher_gap_sessions",
      currentGap1 + currentGap2,
      0,
      gap1Baseline + gap2Baseline
    );
    applyFocusedOptimizationCeiling(settings);
    return plan;
  }

  function buildConstraintRepairAutoSortPlan(data, expected, releasedCount, knownConstraintViolationCount, preparedFreshPlan, knownConstraintViolations){
    const safeData = data || getData();
    const expectedCount = Math.max(0, Number(expected || expectedLessonCount(safeData)) || 0);
    const knownViolationItems = Array.isArray(knownConstraintViolations)
      ? knownConstraintViolations
      : [];
    const deferredIncompleteLowerBounds = knownViolationItems.length > 0
      && knownViolationItems.every(isDeferredIncompleteLowerBoundViolation);
    if(
      expectedCount > 0
      && countScheduledLessons(safeData) < expectedCount
      && deferredIncompleteLowerBounds
    ){
      // Lower-bound rules such as lessonBlocks Min and teacher mustTeach are
      // expected to be unsatisfied while periods are still unassigned. They do
      // not make an incomplete timetable an existing-schedule repair. Keep all
      // fixed anchors and requirements, but use the complete-first fresh lane
      // so an eligible Browser Agent can own the first Automatic click.
      const freshBase = buildAutomaticAutoSortPlan(
        safeData,
        expectedCount,
        0,
        preparedFreshPlan
      );
      const lessonBlockMinimumCount = knownViolationItems.filter(
        isDeferredIncompleteLessonBlockMinimumViolation
      ).length;
      const mustTeachCount = knownViolationItems.filter(
        isDeferredIncompleteMustTeachViolation
      ).length;
      freshBase.settings.ui_deferred_incomplete_lower_bound_count = knownViolationItems.length;
      if(lessonBlockMinimumCount > 0){
        freshBase.settings.ui_deferred_incomplete_lesson_block_minimum_count = lessonBlockMinimumCount;
      }
      if(mustTeachCount > 0){
        freshBase.settings.ui_deferred_incomplete_must_teach_count = mustTeachCount;
      }
      freshBase.settings.ui_preflight_constraint_violation_count = 0;
      freshBase.settings.ui_disable_initial_fast_draft = true;
      freshBase.settings.ui_force_initial_fast_draft = false;
      return Object.assign({}, freshBase, {
        released:Math.max(0, Math.round(Number(releasedCount || 0) || 0))
      });
    }
    const base = buildAutomaticAutoSortPlan(
      safeData,
      expected,
      knownConstraintViolationCount,
      preparedFreshPlan
    );
    const settings = base.settings;
    const released = Math.max(0, Math.round(Number(releasedCount || 0) || 0));
    const repairWindow = Math.max(96, released);
    const completeSubjectPeriodRepair = Number(knownConstraintViolationCount || 0) > 0
      && expectedCount > 0
      && countScheduledLessons(safeData) >= expectedCount
      && hasSubjectPeriodRequirements(safeData)
      && Array.isArray(knownConstraintViolations)
      && knownConstraintViolations.some(isSubjectPeriodConstraintViolation);

    if(completeSubjectPeriodRepair){
      // A complete timetable that violates a newly authored subject-period
      // rule needs a real rebuild. The staged native repair intentionally
      // skips teacher optimization and gives its cleanup only two seconds,
      // which can leave a hard-valid result with many singleton sessions.
      // Keep the visible timetable transactional, but send only fixed anchors
      // to the unified complete-first lane so it can satisfy the new rule and
      // then enforce singleton=0 and gap<=1 inside the same bounded click.
      clearExistingRepairSettings(settings);
      settings.ui_unified_auto_sort = true;
      settings.ui_unified_solve_kind = "fresh_complete_first";
      settings.ui_constraint_change_repair = true;
      settings.ui_constraint_change_fresh_retry = true;
      settings.ui_constraint_change_rebuild_from_empty = true;
      settings.ui_constraint_change_allow_quality_debt = true;
      settings.ui_bounded_fresh_accept_quality_debt = true;
      settings.ui_skip_pre_solve_constraint_release = true;
      settings.ui_disable_staged_existing_repair = true;
      settings.ui_disable_partial_existing_repair = true;
      settings.ui_local_repair_needs_rearrange = true;
      settings.ui_allow_staged_existing_on_fresh_sort = false;
      settings.ui_force_staged_existing_repair = false;
      settings.ui_stop_after_first_complete_schedule = false;
      settings.complete_schedule_seed_retry = false;
      settings.complete_schedule_seed_retry_max_runs = 0;
      settings.auto_sort_mode = "teacher_session_opt";
      settings.auto_sort_strategy = "constraint_change_subject_period_fresh_rebuild";
      settings.require_complete_schedule = true;
      settings.best_effort_on_timeout = true;
      settings.ui_constraint_change_fresh_ceiling_seconds = applyBoundedFreshFallbackCeiling(
        settings,
        expectedCount,
        safeData,
        customSolveDurationFromSettings(settings)
      );
      settings.ui_unified_initial_ceiling_seconds = settings.ui_constraint_change_fresh_ceiling_seconds;
      enforceNoHintFreshSolveSettings(settings);
      return {
        kind:"fresh_complete_first",
        settings,
        qualityTargets:base.qualityTargets,
        state:null,
        released
      };
    }

    clearFreshOnlyFlags(settings);
    settings.ui_unified_solve_kind = "repair_constraints";
    settings.ui_constraint_change_repair = true;
    settings.ui_default_fresh_sort = false;
    settings.ui_allow_staged_existing_on_fresh_sort = true;
    settings.ui_force_staged_existing_repair = true;
    settings.ui_disable_staged_existing_repair = false;
    settings.ui_disable_partial_existing_repair = false;
    settings.ui_skip_pre_solve_constraint_release = true;
    // This path already owns one bounded staged fill and one full fresh
    // fallback. Do not inherit the blank-duration fresh-sort retry portfolio,
    // otherwise a tightened teacher constraint can launch several additional
    // adaptive runs after the fresh fallback has already failed.
    settings.ui_allow_incomplete_retry_after_single_pass = false;
    settings.ui_stop_after_first_complete_schedule = true;
    settings.complete_schedule_seed_retry = false;
    settings.complete_schedule_seed_retry_max_runs = 0;
    settings.ui_staged_existing_max_missing = repairWindow;
    settings.repair_fill_first_max_missing = repairWindow;
    settings.repair_existing_missing_periods = released;
    settings.auto_sort_mode = "fast";
    settings.auto_sort_strategy = "constraint_change_repair";
    settings.optimize_existing_schedule = false;
    settings.existing_fill_missing_schedule = false;
    settings.preserve_existing_tkb = true;
    settings.preserve_fixed_lessons_only = true;
    settings.allow_optimize_with_fixed_lessons = true;
    settings.force_preserve_partial_existing = true;
    settings.partial_existing_rebuild = true;
    settings.repair_fill_first = true;
    settings.repair_partial_existing = true;
    settings.require_complete_schedule = true;
    settings.best_effort_on_timeout = true;
    settings.allow_solver_warm_start = true;
    settings.fresh_randomize = false;
    settings.randomize_search = false;
    delete settings.ui_local_repair_needs_rearrange;
    delete settings.random_seed;

    return {
      kind:"repair_constraints",
      settings,
      qualityTargets:base.qualityTargets,
      state:partialExistingRepairState(safeData, settings),
      released
    };
  }

  function currentScheduleAppearsComplete(data){
    if(!data) return null;
    const expected = Math.max(0, expectedLessonCount(data));
    const scheduled = Math.max(0, countScheduledLessons(data));
    const unassigned = expected > 0 ? Math.max(0, expected - scheduled) : 0;
    if(expected <= 0 || scheduled < expected || unassigned > 0) return null;
    // applyPayload has already run the sliced full validation and normalized
    // these metrics. Re-running validateAll here after 100% used to scan the
    // whole school synchronously for a third time and freeze the finished UI.
    const payload = data?.tkbSolverResult || data?.tkbRustSolverResult || null;
    const metrics = payload?.metrics;
    if(!metrics || typeof metrics !== "object") return null;
    const payloadExpected = metricNumber(metrics.expected_periods, NaN);
    const payloadScheduled = metricNumber(metrics.scheduled_periods, NaN);
    const payloadUnassigned = metricNumber(metrics.unassigned_periods, NaN);
    const violations = metricNumber(metrics.app_constraint_violation_count, NaN);
    if(
      !Number.isFinite(payloadExpected)
      || !Number.isFinite(payloadScheduled)
      || !Number.isFinite(payloadUnassigned)
      || !Number.isFinite(violations)
      || payloadExpected !== expected
      || payloadScheduled !== scheduled
      || payloadUnassigned !== unassigned
      || metrics.hard_ok === false
      || metrics.core_hard_ok === false
      || payload?.validation?.hard_ok === false
    ) return null;
    if(violations > 0) return null;
    return {expected, scheduled, unassigned, violations};
  }

  function autoSortPreparationMatches(data, scheduleFingerprint){
    if(!data || getData() !== data) return false;
    const expected = String(scheduleFingerprint || "");
    return scheduleFingerprintFromData(data) === expected;
  }

  function reportAutoSortPreparationChanged(){
    releaseAutoSortButtonSoon();
    setStatus(
      "D\u1eef li\u1ec7u v\u1eeba thay \u0111\u1ed5i trong l\u00fac chu\u1ea9n b\u1ecb. B\u1ea1n b\u1ea5m X\u1ebfp l\u1ea1i nh\u00e9.",
      "warning"
    );
  }

  async function bridgeSapXepTuDongAll(options){
    const invocationOptions = options && typeof options === "object" ? options : {};
    if(invocationOptions.fromHybridCaller === true){
      setStatus("Hybrid đã ngừng hoạt động; hãy dùng tối ưu FET cục bộ.", "warning");
      return {
        ok:false,
        applied:false,
        executor:"fet_worker",
        failureKind:"hybrid_retired",
        error:"Hybrid/Cloud Run scheduler route is retired."
      };
    }
    const requestedSolveMode = normalizeSolveRequestMode(invocationOptions.mode);
    const hybridInvocationSettings = hybridCloudRunInvocationSettings(invocationOptions);
    if(!solveRequestModeAllowedForCurrentUser(requestedSolveMode)){
      setStatus("Mục tối ưu này chỉ dành cho superadmin.", "warning");
      return null;
    }
    const preflightToken = acquireAutoSortPreflight();
    if(!preflightToken){
      if(queueAutoSortContinuationAfterSettlement(invocationOptions)) return null;
      setStatus("Đang có lượt xếp chạy, vui lòng chờ hoàn tất.", "info");
      return null;
    }
    try{
    if(invocationOptions?.fromHybridCaller !== true && (window.__TKB_SOLVE_UI_BUSY === true || window.__TKB_RUST_SOLVER_RUNNING === true)){
      setStatus("Đang có lượt xếp chạy, vui lòng chờ hoàn tất.", "info");
      return null;
    }
    const currentData = getData();
    const autoSortCycleBeforeSolve = automaticSortCycleState(currentData);
    if(
      requestedSolveMode === SOLVE_REQUEST_MODES.singletons
      && currentScheduleAppearsComplete(currentData)
    ){
      const visibleMetrics = uiTeacherQualityMetrics(currentData);
      const hasVisibleSingletonMetric = Object.prototype.hasOwnProperty.call(
        visibleMetrics,
        "one_period_teacher_sessions"
      );
      if(
        hasVisibleSingletonMetric
        && onePeriodTeacherSessionFloorReached(visibleMetrics)
      ){
        const retainedPayload = visibleCompleteIncumbentQualityPayload(
          currentData,
          currentData?.tkbSolverResult || currentData?.tkbRustSolverResult || null
        );
        window.__TKB_SOLVER_LAST_PAYLOAD = retainedPayload;
        window.__TKB_SOLVER_LAST_RESULT = retainedPayload;
        window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = SOLVE_COMPLETE_MESSAGE;
        finishProgress("100%", "ok");
        setStatus(SOLVE_COMPLETE_MESSAGE, "ok");
        publishE2EState("done", retainedPayload, {
          message:SOLVE_COMPLETE_MESSAGE,
          singletonOptimizationAlreadySatisfied:true
        });
        releaseAutoSortButtonSoon();
        return retainedPayload;
      }
    }
    if(
      [SOLVE_REQUEST_MODES.gap2, SOLVE_REQUEST_MODES.gap1].includes(requestedSolveMode)
      && currentScheduleAppearsComplete(currentData)
    ){
      const visibleMetrics = uiTeacherQualityMetrics(currentData);
      const currentGap = requestedSolveMode === SOLVE_REQUEST_MODES.gap2
        ? gap2PlusCount(visibleMetrics)
        : gapExactCount(visibleMetrics, 1);
      if(Number.isFinite(currentGap) && currentGap === 0){
        const retainedPayload = visibleCompleteIncumbentQualityPayload(
          currentData,
          currentData?.tkbSolverResult || currentData?.tkbRustSolverResult || null
        );
        const message = requestedSolveMode === SOLVE_REQUEST_MODES.gap2
          ? "Kh\u00f4ng c\u00f2n tr\u1ed1ng 2 ti\u1ebft."
          : "Kh\u00f4ng c\u00f2n tr\u1ed1ng 1 ti\u1ebft.";
        window.__TKB_SOLVER_LAST_PAYLOAD = retainedPayload;
        window.__TKB_SOLVER_LAST_RESULT = retainedPayload;
        window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = message;
        finishProgress("100%", "ok");
        setStatus(message, "ok");
        publishE2EState("done", retainedPayload, {
          message,
          gapOptimizationAlreadySatisfied:true,
          gapTarget:gapOptimizationTargetForSolveRequestMode(requestedSolveMode)
        });
        releaseAutoSortButtonSoon();
        return retainedPayload;
      }
      // Gap-1 cleanup is intentionally staged after gap-2.  A direct
      // gap-1 search while a two-period gap remains often just moves the
      // disruption into that more expensive metric.  Keep the incumbent and
      // make the required next action explicit instead of starting a costly
      // server job that cannot satisfy the lexicographic contract.
      if(
        requestedSolveMode === SOLVE_REQUEST_MODES.gap1
        && gap2PlusCount(visibleMetrics) > 0
      ){
        const retainedPayload = visibleCompleteIncumbentQualityPayload(
          currentData,
          currentData?.tkbSolverResult || currentData?.tkbRustSolverResult || null
        );
        const message = "Hãy tối ưu Trống 2 tiết trước.";
        window.__TKB_SOLVER_LAST_PAYLOAD = retainedPayload;
        window.__TKB_SOLVER_LAST_RESULT = retainedPayload;
        window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = message;
        finishProgress("100%", "ok");
        setStatus(message, "info");
        publishE2EState("done", retainedPayload, {
          message,
          gapOptimizationRequiresGap2First:true,
          gapTarget:"gap1"
        });
        releaseAutoSortButtonSoon();
        return retainedPayload;
      }
    }
    let existingBackendJob = await inspectExistingBackendJobForManualSolve(currentData);
    if(existingBackendJob?.kind === "auth_required") return null;
    if(window.__TKB_WINDOWS_WEB_AGENT_TRIAL === true && existingBackendJob?.job){
      const existingJob = existingBackendJob.job;
      if(String(existingJob.kind || "").trim().toLowerCase() === "completed"){
        // A completed result discovered from another page/device is not this
        // click's Local work. Ignore it, then continue into a brand-new
        // Browser-required POST instead of leaving Play apparently broken.
        discardTrialBackendJob(existingJob);
        existingBackendJob = null;
      }else if(existingBackendJob.kind === "observe"){
        // Observer rows are discovered from another click/device and do not
        // carry a proof that the canonical executor is this Browser trial.
        // Never enter the observer poll loop in Local-only mode.
        trialRejectExistingBackendJob(existingJob);
        return null;
      }
      if(existingBackendJob){
        if(
          (existingBackendJob.kind === "pending" || existingBackendJob.kind === "attached")
          && !trialBackendJobCanResume(existingJob)
        ){
          trialRejectExistingBackendJob(existingJob);
          return null;
        }
        const existingPhase = String(
          existingJob.executionPhase
          || existingJob.phase
          || ""
        ).trim().toLowerCase();
        const existingExecutor = normalizedSolveExecutor(
          existingJob.executor || existingJob.executionSource,
          existingPhase
        );
        if(
          serverPayloadIsVpsOwned(existingJob)
          || existingExecutor === "vps"
          || existingPhase === "handoff_to_vps"
          || existingPhase.startsWith("vps_")
        ){
          removePendingBackendJob(existingJob.jobId);
          releaseAutoSortButtonSoon();
          setStatus(
            "Ch\u1ebf \u0111\u1ed9 th\u1eed nghi\u1ec7m ch\u1ec9 nh\u1eadn l\u01b0\u1ee3t Local m\u1edbi; l\u01b0\u1ee3t VPS hi\u1ec7n c\u00f3 s\u1ebd kh\u00f4ng \u0111\u01b0\u1ee3c nh\u1eadn l\u1ea1i.",
            "info"
          );
          return null;
        }
      }
    }
    if(existingBackendJob?.kind === "observe"){
      return await observeBackendJob(existingBackendJob.job);
    }
    if(existingBackendJob?.kind === "pending" || existingBackendJob?.kind === "attached"){
      // A manual Play during reload recovery adopts the durable canonical job
      // directly. It must not enter planner/pre-release work or POST the same
      // locally-created id again merely because its owner-state discovery bit
      // has not hydrated yet.
      prepareManualSolveIntent();
      return await reattachExistingServerJobPollOnly(existingBackendJob.job);
    }
    if(existingBackendJob?.kind === "busy"){
      releaseAutoSortButtonSoon();
      setStatus(
        "Lịch này đang có lượt xếp chạy ở phiên khác; hệ thống đã chặn lượt trùng. Vui lòng chờ lượt hiện tại hoàn tất.",
        "info"
      );
      return null;
    }
    if([
      SOLVE_REQUEST_MODES.gap2,
      SOLVE_REQUEST_MODES.gap1,
      SOLVE_REQUEST_MODES.gaps
    ].includes(requestedSolveMode)){
      await refreshGapProgressBaselineFromRemote(getData());
    }
    const agentControlsAllowed = localAgentRoleAllowed();
    const windowsNativeAgentRequired = agentControlsAllowed
      && isWindowsNativeAgentNavigator(window.navigator);
    if(
      agentControlsAllowed
      &&
      typeof window.maybeInviteAgentBeforeSort === "function"
      && (
        invocationOptions.manualAgentInvite === true
        || windowsNativeAgentRequired
      )
    ){
      const shouldContinue = await window.maybeInviteAgentBeforeSort({
        nativeRequired:windowsNativeAgentRequired,
        requestDownload:invocationOptions.manualAgentInvite === true
      });
      if(!shouldContinue) return null;
    }
    prepareManualSolveIntent();
    primeAutoSortStartUi({requestedSolveMode, data:getData()});
    await waitForUiPaint();
    // The plateau check hashes all solver-relevant data. It must run after the
    // busy state, Stop button, progress ring, and timer have reached a frame.
    const lockedState = syncOptimizationLockState();
    if(lockedState?.locked === true){
      setStatus(noBetterScheduleStatus(getData()?.tkbSolverResult || null), "ok");
      return null;
    }
    traceSolveStep("auto-sort:start");
    await yieldResponsiveUi();
    const data = getData();
    const scheduleFingerprintBefore = scheduleFingerprintFromData(data);
    await yieldResponsiveUi();
    const scheduleSnapshotBeforeAutoSort = snapshotScheduleData(data);
    await yieldResponsiveUi();
    // snapshotScheduleData already detached and compacted the incumbent.
    // Cloning the full stale solver payload here used to block the browser
    // main thread for several seconds after Delete, freezing 4% / 0 seconds.
    let incumbentPayloadBeforeAutoSort = scheduleSnapshotBeforeAutoSort?.tkbSolverResult || null;
    // Reuse the post-paint plateau result instead of hashing all data twice in
    // the same preparation turn.
    const plateauBeforeSolve = lockedState;
    if(data?.tkbOptimizationPlateau && !plateauBeforeSolve){
      clearOptimizationPlateau(data, false);
    }
    await yieldResponsiveUi();
    const violationsBeforeRepair = await currentConstraintViolationsAsync(3000, {
      allowSyncFallback:false
    });
    if(isStopRequested() || violationsBeforeRepair?.cancelled === true){
      releaseAutoSortButtonSoon();
      setStatus("\u0110\u00e3 d\u1eebng s\u1eafp x\u1ebfp theo y\u00eau c\u1ea7u.", "info");
      return null;
    }
    if(violationsBeforeRepair?.stale === true){
      reportAutoSortPreparationChanged();
      return null;
    }
    if(!autoSortPreparationMatches(data, scheduleFingerprintBefore)){
      reportAutoSortPreparationChanged();
      return null;
    }
    if(requestedSolveMode === SOLVE_REQUEST_MODES.quickComplete){
      const completeState = completeScheduleStateForExistingOptimize(
        data,
        violationsBeforeRepair.length
      );
      if(completeState){
        const retainedPayload = visibleCompleteIncumbentQualityPayload(
          data,
          data?.tkbSolverResult || data?.tkbRustSolverResult || null
        );
        const hadGapBaseline = Object.prototype.hasOwnProperty.call(data, GAP_PROGRESS_BASELINE_DATA_KEY);
        const previousGapBaseline = hadGapBaseline
          ? clonePlain(data[GAP_PROGRESS_BASELINE_DATA_KEY])
          : undefined;
        const rememberedGapBaseline = rememberQuickGapProgressBaseline(data, retainedPayload);
        if(rememberedGapBaseline){
          try{
            const saveStoreFn = window.saveStore;
            if(typeof saveStoreFn === "function"){
              await Promise.resolve(saveStoreFn.call(window, {
                force:true,
                awaitRemote:true,
                trustedSolverApply:true,
                suppressHistory:true,
                knownStats:{
                  total:completeState.expected,
                  assigned:completeState.scheduled,
                  missing:completeState.unassigned
                }
              }));
            }
          }catch(err){
            if(hadGapBaseline) data[GAP_PROGRESS_BASELINE_DATA_KEY] = previousGapBaseline;
            else delete data[GAP_PROGRESS_BASELINE_DATA_KEY];
            throw err;
          }
        }
        window.__TKB_SOLVER_LAST_PAYLOAD = retainedPayload;
        window.__TKB_SOLVER_LAST_RESULT = retainedPayload;
        window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = SOLVE_COMPLETE_MESSAGE;
        finishProgress("100%", "ok");
        setStatus(SOLVE_COMPLETE_MESSAGE, "ok");
        publishE2EState("done", retainedPayload, {
          message:SOLVE_COMPLETE_MESSAGE,
          quickCompleteAlreadySatisfied:true
        });
        releaseAutoSortButtonSoon();
        return retainedPayload;
      }
    }
    await yieldResponsiveUi();
    // Keep the visible incumbent untouched. The backend receives the complete
    // timetable as a soft hint and releases only the smallest useful flexible
    // group inside its transactional repair copy.
    const releasedForConstraintRepair = 0;
    const violationsForAutomaticPlan = violationsBeforeRepair;
    if(!autoSortPreparationMatches(data, scheduleFingerprintBefore)){
      reportAutoSortPreparationChanged();
      return null;
    }
    const planningScheduleFingerprint = scheduleFingerprintBefore;
    const planningMemoToken = beginAutoSortPlanningMemo(data);
    let expected;
    let automaticPlan;
    try{
      expected = expectedLessonCount(data);
      traceSolveStep("auto-sort:expected", {expected});
      await yieldResponsiveUi();
      const preparedFreshPlan = buildFreshQualityAutoSortSettings(data, expected, "balanced");
      traceSolveStep("auto-sort:fresh-settings-ready", preparedFreshPlan.qualityTargets);
      await yieldResponsiveUi();
      if(isStopRequested()){
        releaseAutoSortButtonSoon();
        setStatus("\u0110\u00e3 d\u1eebng s\u1eafp x\u1ebfp theo y\u00eau c\u1ea7u.", "info");
        return null;
      }
          automaticPlan = violationsForAutomaticPlan.length > 0
        ? buildConstraintRepairAutoSortPlan(
            data,
            expected,
            releasedForConstraintRepair,
            violationsForAutomaticPlan.length,
            preparedFreshPlan,
            violationsForAutomaticPlan
          )
        : buildAutomaticAutoSortPlan(
            data,
            expected,
            violationsForAutomaticPlan.length,
            preparedFreshPlan
          );
      automaticPlan = applyRequestedSolveModeToPlan(
        automaticPlan,
        requestedSolveMode,
        data,
        expected
      );
    }finally{
      endAutoSortPlanningMemo(planningMemoToken);
    }
    if(automaticPlan?.kind === "refine_complete"){
      incumbentPayloadBeforeAutoSort = visibleCompleteIncumbentQualityPayload(
        data,
        incumbentPayloadBeforeAutoSort
      );
      if(scheduleSnapshotBeforeAutoSort && incumbentPayloadBeforeAutoSort){
        scheduleSnapshotBeforeAutoSort.tkbSolverResult = clonePlain(
          incumbentPayloadBeforeAutoSort
        );
      }
    }
    await yieldResponsiveUi();
    if(!autoSortPreparationMatches(data, planningScheduleFingerprint)){
      reportAutoSortPreparationChanged();
      return null;
    }
    const settings = automaticPlan.settings;
    if(hybridInvocationSettings){
      // `automaticPlan` is intentionally rebuilt from planner state, so copy
      // the explicit Hybrid executor contract back only after canonical mode
      // mapping has finished. Without this hand-off the UI displayed Cloud Run
      // while the bridge silently sent a normal VPS/auto request.
      Object.assign(settings, hybridInvocationSettings);
    }
    if(requestedSolveMode === SOLVE_REQUEST_MODES.automatic || requestedSolveMode === SOLVE_REQUEST_MODES.autoMin2){
      settings.ui_track_automatic_sort_cycle = true;
      settings.ui_automatic_sort_previous_successful_clicks = Math.max(
        0,
        Math.round(Number(autoSortCycleBeforeSolve?.successfulClicks || 0) || 0)
      );
      settings.ui_automatic_sort_plan_kind = String(automaticPlan.kind || "");
    }
    const backendPrecheckOk = await maybeRunBackendPrecheck(data, "balanced");
    if(!autoSortPreparationMatches(data, planningScheduleFingerprint)){
      reportAutoSortPreparationChanged();
      return null;
    }
    if(!backendPrecheckOk){
      const stopped = isStopRequested();
      const blockMessage = String(window.__TKB_BACKEND_PRECHECK_BLOCK_MESSAGE || "").trim();
      releaseAutoSortButtonSoon();
      setStatus(
        stopped ? "Đã dừng sắp xếp theo yêu cầu." : (blockMessage || "Đã hủy sắp xếp sau bước kiểm tra dữ liệu."),
        stopped ? "info" : "warning"
      );
      return null;
    }
    if(isStopRequested()){
      releaseAutoSortButtonSoon();
      setStatus("Đã dừng sắp xếp theo yêu cầu.", "info");
      return null;
    }
    traceSolveStep("auto-sort:targets", automaticPlan.qualityTargets);
    traceSolveStep("auto-sort:settings-ready", {preset:"balanced", kind:automaticPlan.kind});
    setStatus("", "info");
    let result = await solveWithRustApi({
      ask:false,
      settings,
      singlePass:true,
      fromHybridCaller:!!hybridInvocationSettings,
      mode:hybridInvocationSettings ? requestedSolveMode : undefined,
      sourceScheduleFingerprint:planningScheduleFingerprint
    });
    restoreFailedConstraintRepairSnapshot(
      result,
      releasedForConstraintRepair,
      data,
      scheduleSnapshotBeforeAutoSort
    );
    if(
      !result
      && releasedForConstraintRepair > 0
      && window.__TKB_SOLVER_LAST_FAILURE_RETRYABLE === true
    ){
      rememberManualFreshRetryFailure(data, settings, {
        kind:String(window.__TKB_SOLVER_LAST_ERROR_PAYLOAD?.kind || "no_complete_schedule_before_deadline"),
        payload:window.__TKB_SOLVER_LAST_ERROR_PAYLOAD || null,
        message:String(window.__TKB_SOLVER_LAST_ERROR_RAW || "")
      });
    }
    let scheduleFingerprintAfter = scheduleFingerprintFromData(getData());
    let completeAfterSolve = !!currentScheduleAppearsComplete(getData());
    const candidatePayloadAfterAutoSort = getData()?.tkbSolverResult
      || getData()?.tkbRustSolverResult
      || window.__TKB_SOLVER_LAST_PAYLOAD
      || result;
    const fingerprintChanged = !!scheduleFingerprintBefore
      && scheduleFingerprintBefore !== scheduleFingerprintAfter;
    const statisticsImproved = automaticPlan.kind === "refine_complete"
      ? refinementStatisticsImproved(
          candidatePayloadAfterAutoSort,
          incumbentPayloadBeforeAutoSort,
          fingerprintChanged,
          automaticPlan?.settings
        )
      : fingerprintChanged;

    // A refinement may explore an equal-looking arrangement. Only retain it
    // when the ordered timetable statistics actually improve.
    if(
      automaticPlan.kind === "refine_complete"
      && !!result
      && completeAfterSolve
      && !statisticsImproved
      && fingerprintChanged
    ){
      const restoredIncumbentPayload = restoreUnimprovedRefinementSnapshot(
        getData(),
        scheduleSnapshotBeforeAutoSort,
        candidatePayloadAfterAutoSort
      );
      try{ callMaybe("saveStore", [{force:true}]); }catch(_){}
      scheduleUiRefresh();
      result = restoredIncumbentPayload || incumbentPayloadBeforeAutoSort || result;
      scheduleFingerprintAfter = scheduleFingerprintFromData(getData());
      completeAfterSolve = !!currentScheduleAppearsComplete(getData());
    }
    const refinementUnchanged = automaticPlan.kind === "refine_complete"
      && !!result
      && completeAfterSolve
      && !statisticsImproved;

    if(
      (requestedSolveMode === SOLVE_REQUEST_MODES.automatic || requestedSolveMode === SOLVE_REQUEST_MODES.autoMin2)
      && !!result
      && completeAfterSolve
    ){
      await persistAutomaticSortSuccess(
        getData(),
        autoSortCycleBeforeSolve,
        automaticPlan.kind
      );
    }

    if(refinementUnchanged){
      rememberOptimizationPlateau(getData(), plateauBeforeSolve, false);
      const plateauMessage = noBetterScheduleStatus(
        result || getData()?.tkbSolverResult || incumbentPayloadBeforeAutoSort || null
      );
      window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = plateauMessage;
      finishProgress("100%", "ok");
      setStatus(plateauMessage, "ok");
      return result;
    }
    if(result && completeAfterSolve){
      clearManualFreshRetryBudget(getData(), true);
      clearOptimizationPlateau(getData());
    }
    return result;
    }finally{
      releaseAutoSortPreflight(preflightToken);
    }
  };
  if(typeof window.executeDirectFastSchedule !== "function"){
    window.sapXepTuDongAll = bridgeSapXepTuDongAll;
    window.sapXepTheoCheDo = function(mode){
      return window.sapXepTuDongAll({
        mode:normalizeSolveRequestMode(mode),
        manualAgentInvite:true
      });
    };
  }
  try{
    const autoSortButton = document.getElementById("btnAutoSort");
    if(autoSortButton && typeof window.executeDirectFastSchedule !== "function"){
      autoSortButton.dataset.rustBridgeVersion = VERSION;
      autoSortButton.onclick = function(event){
        try{ event?.preventDefault?.(); }catch(_){}
        let result = null;
        try{
          result = window.sapXepTuDongAll({manualAgentInvite:true});
        }catch(err){
          releaseAutoSortButtonSoon();
          throw err;
        }
        if(result && typeof result.finally === "function"){
          try{ result.finally(() => releaseAutoSortButtonSoon()); }catch(_){}
        }else{
          releaseAutoSortButtonSoon();
        }
        return result;
      };
    }
  }catch(_){}

  try{
    const params = new URLSearchParams(String(window.location?.search || ""));
    const autorun = params.get("autorun") === "1" || params.get("tkb_autorun") === "1";
    if(autorun && !window.__TKB_AUTORUN_SORT_STARTED){
      window.__TKB_AUTORUN_SORT_STARTED = true;
      window.setTimeout(async () => {
        if(automaticBackendResumeSuppressed()) return;
        window.__TKB_AUTORUN_SOLVE_STARTED = true;
        try{
          await window.sapXepTuDongAll();
        }catch(err){
          console.error(`[${VERSION}] autorun sort failed`, err);
        }finally{
          window.__TKB_AUTORUN_SOLVE_STARTED = false;
        }
      }, 300);
    }
  }catch(_){}

  window.xepLaiLop = function(){
    return solveWithRustApi({
      ask:false
    });
  };

  window.openTuyChinh = function(){
    const settings = promptSettings();
    if(!settings) return null;
    return solveWithRustApi({ask:false, settings});
  };

  window.runOptimizeFromPanel = function(){
    if(currentScheduleAppearsComplete(getData())) return window.sapXepTuDongAll();
    return solveWithRustApi({ask:false});
  };

  window.continueOptimizeFromPanel = function(){
    if(currentScheduleAppearsComplete(getData())) return window.sapXepTuDongAll();
    return solveWithRustApi({ask:false});
  };

  window.xepTheoTuyChinh = function(){
    if(currentScheduleAppearsComplete(getData())) return window.sapXepTuDongAll();
    return solveWithRustApi({ask:false});
  };

  try{
    const data = getData();
    if(data && data.tkbSolverResult) renderSolverPanel(data.tkbSolverResult);
  }catch(_){}

  async function updateBackendStatusBanner(){
    const banner = document.getElementById("tkbBackendBanner");
    if(!banner) return;
    const base = await rustApiBase();
    if(base){
      banner.hidden = true;
      banner.classList.add("is-online");
    }else{
      banner.hidden = false;
      banner.classList.remove("is-online");
    }
  }

  function automaticBackendResumeSuppressed(){
    return window.__TKB_AUTO_RESUME_SUPPRESSED === true
      || isStopRequested()
      || persistentAutoResumeSuppressionForScope();
  }

  function cancelPendingBackendResume(){
    pendingBackendResumeTimerGeneration += 1;
    if(pendingBackendResumeTimer){
      try{ window.clearTimeout(pendingBackendResumeTimer); }catch(_){ }
      pendingBackendResumeTimer = 0;
      pendingBackendResumeDueAt = 0;
      return true;
    }
    pendingBackendResumeDueAt = 0;
    return false;
  }

  function prepareManualSolveIntent(){
    if(
      window.__TKB_SERVER_JOB_RESUME_STARTED === true
      || window.__TKB_AUTORUN_SOLVE_STARTED === true
    ) return false;
    cancelPendingBackendResume();
    // A delete may have happened in another tab. Start the same cancellation
    // barrier locally before clearing the tombstone so an immediate Play cannot
    // race the old server job into a second single-flight request.
    if(scheduleMutationTombstone()) beginScheduleMutationCancellation("");
    const pending = readPendingBackendJob();
    if(pending?.jobId && isSettledBackendJob(pending.jobId)){
      removePendingBackendJob(pending.jobId);
    }
    clearPersistentAutoResumeSuppression();
    clearScheduleMutationTombstone();
    window.__TKB_AUTO_RESUME_SUPPRESSED = false;
    window.__AUTO_SORT_STOP_REQUESTED = false;
    try{ callMaybe("resetAutoSortStopRequest"); }catch(_){ }
    return true;
  }

  function pendingBackendResumeBlocked(jobId){
    const value = String(jobId || "").trim();
    if(automaticBackendResumeSuppressed()){
      if(value) removePendingBackendJob(value);
      return true;
    }
    // Do not trust a shared settled bit until authenticated server state says
    // the job is no longer active. Older cached tabs can finish an obsolete
    // lifecycle and write this bit while the Agent still owns the real job.
    return false;
  }

  function schedulePendingBackendResume(attempt, delayMs, options){
    if(backendAuthRequired){
      cancelPendingBackendResume();
      return false;
    }
    if(automaticBackendResumeSuppressed()){
      cancelPendingBackendResume();
      return false;
    }
    const delay = Math.max(0, Number(delayMs || 0) || 0);
    const dueAt = Date.now() + delay;
    const force = options?.force === true;
    // A foreground wake is a higher-priority request than a late callback from
    // the suspended poll. Keep the earlier retry instead of letting a 15s
    // background retry overwrite the 100ms/2s wake window.
    if(
      (pendingBackendResumeTimer || pendingBackendResumeDueAt > 0)
      && !force
      && pendingBackendResumeDueAt > 0
      && pendingBackendResumeDueAt <= dueAt
    ) return true;
    cancelPendingBackendResume();
    const generation = pendingBackendResumeTimerGeneration;
    pendingBackendResumeDueAt = dueAt;
    pendingBackendResumeTimer = window.setTimeout(() => {
      if(generation !== pendingBackendResumeTimerGeneration) return;
      pendingBackendResumeTimer = 0;
      pendingBackendResumeDueAt = 0;
      if(automaticBackendResumeSuppressed()) return;
      try{
        const pending = resumePendingBackendJobOnLoad(Number(attempt || 0));
        if(pending && typeof pending.catch === "function") pending.catch(() => {});
      }catch(_){ }
    }, delay);
    try{ pendingBackendResumeTimer?.unref?.(); }catch(_){ }
    return true;
  }

  function localSolveLifecycleActive(){
    return autoSortPreflightActive()
      || window.__TKB_SOLVE_UI_BUSY === true
      || window.__TKB_RUST_SOLVER_RUNNING === true
      || window.__TKB_SOLVE_BACKEND_POSTED === true
      || window.__TKB_SOLVE_QUEUE_WAITING === true
      || !!activeSolveAbortController;
  }

  async function resumePendingBackendJobOnLoad(attempt){
    if(backendAuthRequired) return false;
    if(pendingBackendResumeInFlight){
      const wakeWasRequested = pendingBackendWakeRequested === true;
      const wakeNeedsEmptyProbe = pendingBackendWakeNeedsEmptyProbe === true;
      const result = await pendingBackendResumeInFlight;
      // A foreground event may arrive while the suspended lifecycle is still
      // unwinding. Once that old promise settles, immediately perform the
      // authoritative state probe that the wake requested instead of leaving
      // the page dependent on the old poll's background retry.
      if(
        wakeWasRequested
        && pendingBackendWakeRequested === true
        && !automaticBackendResumeSuppressed()
        && (readPendingBackendJob()?.jobId || wakeNeedsEmptyProbe)
      ){
        pendingBackendWakeRequested = false;
        pendingBackendWakeNeedsEmptyProbe = false;
        return await resumePendingBackendJobOnLoad(attempt);
      }
      return result;
    }
    pendingBackendWakeRequested = false;
    const run = resumePendingBackendJobOnce(attempt);
    pendingBackendResumeInFlight = run;
    try{
      return await run;
    }finally{
      if(pendingBackendResumeInFlight === run) pendingBackendResumeInFlight = null;
    }
  }

  async function resumePendingBackendJobOnce(attempt){
    // A direct wakeup (pageshow, online, tests, or another UI hook) supersedes
    // an older scheduled wakeup so two owner-state checks cannot race.
    cancelPendingBackendResume();
    if(backendAuthRequired) return false;
    if(readServerCancellationIntent()) await retryServerCancellationIntent();
    if(automaticBackendResumeSuppressed()) return false;
    const resumeEpoch = backendResumeEpoch;
    if(
      window.__TKB_SERVER_JOB_RESUME_STARTED === true
      || localSolveLifecycleActive()
    ){
      // Mobile Safari may deliver pageshow/visibilitychange while the
      // suspended request is still unwinding. That wakeup used to replace the
      // durable reconnect timer with a 100 ms attempt which then returned here
      // and was lost forever. Keep one poll-only retry armed until the local
      // lifecycle releases; it will adopt the same canonical job id and can
      // never submit a second solve.
      const activePending = readPendingBackendJob();
      if(activePending?.jobId && !pendingBackendResumeBlocked(activePending.jobId)){
        schedulePendingBackendResume(
          Number(attempt || 0),
          SERVER_SOLVER_JOB_DISCOVERY_RETRY_MS
        );
      }
      return false;
    }
    let pending = readPendingBackendJob();
    if(pendingBackendResumeBlocked(pending?.jobId)) return false;
    // The terminal candidate is already visible while its remote timetable
    // save is still settling. Do not start a second poll-only apply on this
    // same page; a reload will intentionally rediscover the durable result if
    // the save ultimately fails.
    if(pending?.jobId && deferredBackendSavePendingFor(pending.jobId)) return false;
    if(!plannerDataReady()){
      // A blank page has no canonical session to recover while the planner is
      // still hydrating. Do not start a hidden two-second probe loop here: it
      // can keep a background tab busy indefinitely when remote hydration is
      // slow or interrupted. A known durable job still gets a bounded retry so
      // it can be reattached if the readiness event is lost; an idle page waits
      // for the explicit planner/auth/foreground wake below.
      if(pending?.jobId){
        schedulePendingBackendResume(
          Number(attempt || 0) + 1,
          SERVER_SOLVER_JOB_DISCOVERY_RETRY_MS
        );
      }
      return false;
    }
    const data = getData();
    if(!data){
      const nextAttempt = Number(attempt || 0) + 1;
      if(pending?.jobId || nextAttempt <= SERVER_SOLVER_AUTH_READY_RETRIES){
        schedulePendingBackendResume(
          nextAttempt,
          nextAttempt <= 6 ? 500 : SERVER_SOLVER_JOB_DISCOVERY_RETRY_MS
        );
      }
      return false;
    }
    const currentFingerprint = durableScheduleFingerprint(data);
    if(pending?.jobId) setAutoSortButtonBusy(true);
    if(
      pending?.observeOnly === true
      && pending.scheduleFingerprint
      && currentFingerprint
      && durableScheduleFingerprintMatches(pending.scheduleFingerprint, data)
    ){
      pending = writePendingBackendJob(pending.jobId, pending.scheduleFingerprint, {
        observeOnly:false
      });
    }
    if(
      pending?.scheduleFingerprint
      && currentFingerprint
      && !durableScheduleFingerprintMatches(pending.scheduleFingerprint, data)
      && pending.observeOnly !== true
    ){
      const authoritativeJobId = String(pending.jobId || "");
      setAutoSortButtonBusy(true);
      const authoritativeState = await backendSolverState(authoritativeJobId);
      if(automaticBackendResumeSuppressed() || resumeEpoch !== backendResumeEpoch) return false;
      if(!authoritativeState || authoritativeState.ok !== true){
        releaseAutoSortButtonSoon();
        schedulePendingBackendResume(attempt, SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
        return false;
      }
      const authoritativeLifecycle = classifyBackendJobState(
        authoritativeState,
        authoritativeJobId
      );
      const authoritativeRunning = authoritativeLifecycle.kind === "running"
        ? authoritativeLifecycle.matchingJob
        : null;
      const authoritativeQueued = authoritativeLifecycle.kind === "queued"
        ? authoritativeLifecycle.matchingQueueItem
        : null;
      // A mismatched schedule is never allowed to attach merely because the
      // API echoed a broad `requestedJobActive` bit. Require the concrete
      // running/queued item so an orphaned or stale id is detached promptly.
      const authoritativeLive = !!authoritativeRunning || !!authoritativeQueued;
      if(authoritativeLive){
        const authoritativeItem = authoritativeQueued || authoritativeRunning;
        if(
          window.__TKB_WINDOWS_WEB_AGENT_TRIAL === true
          && !trialBackendJobCanResume(Object.assign({}, authoritativeItem, {
            trialLocal:pending?.trialLocal === true
          }))
        ){
          trialRejectExistingBackendJob(pending);
          clearActiveBackendJobId(authoritativeJobId, {force:true});
          endServerJobReattachLease(authoritativeJobId);
          settleAuthoritativeIdleSolveUi({force:true});
          return false;
        }
        const observer = writePendingBackendJob(authoritativeJobId, pending.scheduleFingerprint, {
          createdAt:authoritativeItem?.createdAtMs || pending.createdAt,
          solverStartedAtMs:authoritativeRunning?.startedAtMs || 0,
          clearSolverStartedAt:!!authoritativeQueued,
          progressBudgetSeconds:authoritativeItem?.progressBudgetSeconds || pending.progressBudgetSeconds,
          progressRunIndex:authoritativeItem?.progressRunIndex || pending.progressRunIndex,
          discoveredFromOwnerState:true,
          localClickTimeline:false,
          observeOnly:true
        });
        if(observer?.jobId) return await observeBackendJob(observer);
      }
      rememberSettledBackendJob(authoritativeJobId);
      reportSkippedDiscoveredBackendJob({jobId:authoritativeJobId, kind:"stale_schedule"});
      endServerJobReattachLease(authoritativeJobId);
      removePendingBackendJob(authoritativeJobId);
      settleAuthoritativeIdleSolveUi({force:true});
      return false;
    }
    if(!pending?.jobId && !ownerBackendJobDiscoveryAllowed()){
      const nextAttempt = Math.max(0, Number(attempt || 0) || 0) + 1;
      if(nextAttempt <= SERVER_SOLVER_AUTH_READY_RETRIES){
        schedulePendingBackendResume(
          nextAttempt,
          nextAttempt <= 6 ? 500 : SERVER_SOLVER_JOB_DISCOVERY_RETRY_MS
        );
      }
      return false;
    }
    // Lease only the asynchronous state probe. Once it resolves, JavaScript
    // runs synchronously into the dedicated reattach, which immediately
    // reacquires the same lease. Early deferrals must not leave a stale lease
    // that could prevent an unrelated normal solve from clearing its job.
    const probeLeaseJobId = pending?.observeOnly === true ? "" : String(pending?.jobId || "");
    if(probeLeaseJobId) beginServerJobReattachLease(probeLeaseJobId);
    const state = await backendSolverState(pending?.jobId || "");
    if(probeLeaseJobId) endServerJobReattachLease(probeLeaseJobId);
    // Explicit Stop is authoritative. A settled bit alone is not: another tab
    // may have written it while this authenticated state probe was in flight,
    // even though the API still retains the exact result for this fingerprint.
    if(automaticBackendResumeSuppressed() || resumeEpoch !== backendResumeEpoch) return false;
    if(!state || state.ok !== true){
      if(pending?.jobId) releaseAutoSortButtonSoon();
      const nextAttempt = Number(attempt || 0) + 1;
      if(pending?.jobId || nextAttempt <= 6){
        schedulePendingBackendResume(nextAttempt, nextAttempt <= 6 ? 700 : SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
      }
      return false;
    }
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const jobs = Array.isArray(state.jobs) ? state.jobs : [];
    const completedJobs = Array.isArray(state.completedJobs) ? state.completedJobs : [];
    if(!pending?.jobId){
      const discovered = selectDiscoverableBackendJob(state, data, Date.now());
      if(discovered.staleJob) reportSkippedDiscoveredBackendJob(discovered.staleJob);
      const discoveredJob = discovered.job || discovered.observerJob;
      const observeOnly = !discovered.job && !!discovered.observerJob;
      if(!discoveredJob){
        // An idle page performs one authoritative load/wake probe. If there is
        // no session, stay idle; a later pageshow/visibility/online/auth-ready
        // event is the explicit next wake and will issue a fresh probe.
        settleAuthoritativeIdleSolveUi();
        return false;
      }
      if(
        localSolveLifecycleActive()
        || pendingBackendResumeBlocked(discoveredJob.jobId)
      ) return false;
      if(discoveredJob.kind !== "completed"){
        forgetSettledBackendJob(discoveredJob.jobId);
      }
      pending = writePendingBackendJob(
        discoveredJob.jobId,
        discoveredJob.scheduleFingerprint,
        {
          createdAt:discoveredJob.createdAtMs,
          solverStartedAtMs:discoveredJob.startedAtMs,
           progressBudgetSeconds:discoveredJob.progressBudgetSeconds,
           progressRunIndex:discoveredJob.progressRunIndex,
           optimizationFocus:discoveredJob.optimizationFocus,
           optimizationGapTarget:discoveredJob.optimizationGapTarget,
           solveRequestMode:discoveredJob.solveRequestMode,
           executor:discoveredJob.executor,
           executionPhase:discoveredJob.executionPhase,
           serverOwned:discoveredJob.serverOwned === true,
           discoveredFromOwnerState:true,
           localClickTimeline:false,
           observeOnly
        }
      );
      if(!pending?.jobId) return false;
    }
    const lifecycle = classifyBackendJobState(state, pending.jobId);
    const responseRequestedJobId = String(state.requestedJobId || "").trim();
    // Current APIs echo requestedJobId. Older APIs did not, so their scalar
    // requestedJob* fields remain usable only when no conflicting id exists.
    const requestedIdentityMatches = !responseRequestedJobId
      || lifecycle.exactRequestedJob;
    const concreteKnown = !!lifecycle.matchingJob
      || !!lifecycle.matchingQueueItem
      || !!lifecycle.matchingCompletedJob;
    const requestedKnown = requestedIdentityMatches && (
      state.requestedJobServerOwned === true
      || state.requestedJobResultReady === true
      || state.requestedJobActive === true
      || state.requestedJobQueued === true
    );
    const known = concreteKnown || requestedKnown;
    if(!known){
      const unknownAttempt = Math.max(0, Number(attempt || 0) || 0);
      const explicitlyAbsent = requestedIdentityMatches
        && state.requestedJobServerOwned === false
        && state.requestedJobActive !== true
        && state.requestedJobQueued !== true
        && state.requestedJobResultReady !== true;
      if(!explicitlyAbsent && unknownAttempt < SERVER_SOLVER_JOB_UNKNOWN_RETRIES){
        schedulePendingBackendResume(unknownAttempt + 1, 700);
        return false;
      }
      // An unknown id after the short registration grace period is detached,
      // never replayed. Reposting it used to turn F5 into a brand-new solve
      // after an API restart and could resurrect a job the user had stopped.
      rememberSettledBackendJob(pending.jobId);
      removePendingBackendJob(pending.jobId);
      clearActiveBackendJobId(pending.jobId, {force:true});
      endServerJobReattachLease(pending.jobId);
      settleAuthoritativeIdleSolveUi({force:true});
      return false;
    }
    const runningItem = lifecycle.matchingJob;
    const queuedItem = lifecycle.matchingQueueItem;
    recordBackendLiveProgress(
      state?.requestedJobProgress
      || runningItem?.progress
      || queuedItem?.progress
    );
    // Terminal/cancelling state blocks admission, and queue membership wins
    // over a stale jobs entry for the same canonical id.
    if(lifecycle.kind === "queued"){
      markBackendJobQueued(pending.jobId, {
        progressBudgetSeconds:queuedItem?.progressBudgetSeconds,
        progressRunIndex:queuedItem?.progressRunIndex
      });
    }else if(lifecycle.kind === "running"){
      recordBackendJobStarted(
        pending.jobId,
        runningItem?.startedAtMs || state?.requestedJobStartedAtMs,
        {
          authoritativeRunning:true,
          progressBudgetSeconds:runningItem?.progressBudgetSeconds || state?.requestedJobProgressBudgetSeconds,
          progressRunIndex:runningItem?.progressRunIndex || state?.requestedJobProgressRunIndex
        }
      );
    }
    pending = readPendingBackendJob() || pending;
    if(window.__TKB_SOLVE_UI_BUSY === true || window.__TKB_RUST_SOLVER_RUNNING === true){
      schedulePendingBackendResume(0, 2_000);
      return false;
    }
    if(automaticBackendResumeSuppressed()) return false;
    if(
      window.__TKB_WINDOWS_WEB_AGENT_TRIAL === true
      && (
        pending.observeOnly === true
        || !trialBackendJobCanResume(pending)
      )
    ){
      // A trial may resume only a durable row created by this same Local
      // request (or an explicitly Browser-required row from a future API).
      // Existing native/VPS/unknown rows are discarded before any result poll.
      trialRejectExistingBackendJob(pending);
      clearActiveBackendJobId(pending.jobId, {force:true});
      endServerJobReattachLease(pending.jobId);
      settleAuthoritativeIdleSolveUi({force:true});
      return false;
    }
    const trialExecutionPhase = String(
      lifecycle.matchingJob?.executionPhase
      || lifecycle.matchingQueueItem?.executionPhase
      || lifecycle.matchingCompletedJob?.executionPhase
      || state.requestedJobExecutionPhase
      || ""
    ).trim().toLowerCase();
    const trialExecutor = normalizedSolveExecutor(
      lifecycle.matchingJob?.executor
      || lifecycle.matchingQueueItem?.executor
      || lifecycle.matchingCompletedJob?.executor
      || state.requestedJobExecutor,
      trialExecutionPhase
    );
    if(
      window.__TKB_WINDOWS_WEB_AGENT_TRIAL === true
      && (
        trialExecutor === "vps"
        || trialExecutionPhase === "handoff_to_vps"
        || trialExecutionPhase.startsWith("vps_")
      )
    ){
      removePendingBackendJob(pending.jobId);
      clearActiveBackendJobId(pending.jobId, {force:true});
      releaseAutoSortButtonSoon();
      setStatus(
        "Ch\u1ebf \u0111\u1ed9 th\u1eed nghi\u1ec7m kh\u00f4ng nh\u1eadn l\u1ea1i l\u01b0\u1ee3t VPS; b\u1ecf webAgentTrial=mac \u0111\u1ec3 xem l\u01b0\u1ee3t \u0111\u00f3.",
        "info"
      );
      return false;
    }
    if(pending.observeOnly === true){
      return await observeBackendJob(pending);
    }
    // Every foreground recovery is the same immutable poll-only operation,
    // whether the canonical job is queued, active, or already terminal. The
    // normal Play/preflight/planning pipeline is never entered from here.
    const requestedExecutionPhase = String(
      lifecycle.matchingJob?.executionPhase
      || lifecycle.matchingQueueItem?.executionPhase
      || state.requestedJobExecutionPhase
      || ""
    ).trim().toLowerCase();
    const requestedExecutor = normalizedSolveExecutor(
      lifecycle.matchingJob?.executor
      || lifecycle.matchingQueueItem?.executor
      || state.requestedJobExecutor,
      requestedExecutionPhase
    );
    const foregroundAgentHandoff = (
      (lifecycle.kind === "running" || lifecycle.kind === "queued")
      && requestedExecutor === "vps"
      && !isMobileBrowserAgentNavigator(window.navigator)
      && (typeof document === "undefined" || document.visibilityState !== "hidden")
    );
    activeBackendResumeTarget = Object.assign({}, pending, {
      foregroundAgentHandoff,
      requestedExecutor,
      requestedExecutionPhase
    });
    try{
      return await reattachExistingServerJobPollOnly(activeBackendResumeTarget);
    }finally{
      activeBackendResumeTarget = null;
      if(readPendingBackendJob()?.jobId){
        schedulePendingBackendResume(0, SERVER_SOLVER_JOB_BACKGROUND_RETRY_MS);
      }
    }
  }

  try{
    installOptimizationLockSaveHook();
    initSolverPresetUi();
    initCustomSolveDurationUi();
    syncOptimizationLockState();
    if(window.TKBRustAPI){
      window.TKBRustAPI.readSolverPreset = readSolverPreset;
      window.TKBRustAPI.writeSolverPreset = writeSolverPreset;
      window.TKBRustAPI.readSolveDurationSeconds = readCustomSolveDurationSeconds;
      window.TKBRustAPI.writeSolveDurationSeconds = writeCustomSolveDurationSeconds;
    }
    if(window.TKBRustAPI){
      window.TKBRustAPI.updateBackendStatusBanner = updateBackendStatusBanner;
    }
    updateBackendStatusBanner();
    if(window.__TKB_E2E_EXPOSE_TEST_HOOKS !== true){
      window.setTimeout(() => { rustApiBase().catch(() => ""); }, 0);
    }
    window.setInterval(updateBackendStatusBanner, 30000);
    setAutoSortHomeHiddenState(false);
    // Do not paint a reconnect state from localStorage alone. The VPS state
    // probe below is authoritative; it decides whether a session exists.
    schedulePendingBackendResume(0, 800);
    try{
      const requestBackendResumeWake = () => {
        pendingBackendWakeRequested = true;
        retryServerCancellationIntent().catch(() => {});
        schedulePendingBackendResume(0, 100, {force:true});
      };
      window.addEventListener?.("tkb:planner-data-ready", () => {
        // Data readiness can arrive while the initial authoritative probe is
        // still unwinding. Mark it as a real wake so the single-flight wrapper
        // performs one follow-up probe instead of losing the event when the
        // older promise settles.
        pendingBackendWakeRequested = true;
        pendingBackendWakeNeedsEmptyProbe = true;
        schedulePendingBackendResume(0, 0, {force:true});
      });
      document.addEventListener?.("visibilitychange", () => {
        if(document.hidden === false) requestBackendResumeWake();
      });
      window.addEventListener?.("pageshow", () => {
        requestBackendResumeWake();
      });
      window.addEventListener?.("online", () => {
        rustApiBaseCache = "";
        requestBackendResumeWake();
      });
      window.addEventListener?.("tkb:auth-ready", () => {
        clearBackendAuthRequired();
        pendingBackendWakeRequested = true;
        pendingBackendWakeNeedsEmptyProbe = true;
        schedulePendingBackendResume(0, 0, {force:true});
      });
      window.addEventListener?.("tkb:auth-expired", event => {
        suspendBackendResumeForAuth(
          Number(event?.detail?.status || 401) || 401,
          event?.detail?.payload || null,
          event?.detail?.source || "auth-event"
        );
      });
    }catch(_){ }
  }catch(_){}

  if(typeof window.requestStopAutoSort === "function" && window.requestStopAutoSort !== requestStopActiveSolve){
    window.__TKB_PHANMON_REQUEST_STOP = window.requestStopAutoSort;
  }
  window.requestStopAutoSort = requestStopActiveSolve;
  if(window.TKBRustAPI){
    window.TKBRustAPI.cancelBackendSolver = cancelBackendSolver;
    window.TKBRustAPI.backendSolverState = backendSolverState;
  }
})();
