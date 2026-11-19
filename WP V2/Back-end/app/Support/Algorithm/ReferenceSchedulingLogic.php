<?php

namespace App\Support\Algorithm;

use App\Models\Employee;
use Carbon\Carbon;
use Illuminate\Support\Facades\Log;

/**
 * Core scheduling algorithm from app/Http/Controllers/Api/AlgoController.php.
 * Workplanner 2.0 keeps integration (cache, stepped runs, histogram overrides) in AlgoController.
 */
trait ReferenceSchedulingLogic
{
/**
     * Feature flags — toggle algorithm features on/off.
     * Set true to enable, false to disable.
     */
    private array $features = [
        'use_oap_sorting' => true,   // sort candidates by OAP when tie
        'use_overrides' => true,   // allow Override_1/2/3 fields
        'enforce_rounds' => true,   // enforce roundLimit (24h cap)
        'use_AL_splitting' => true,   // use AL field to split hours
        'use_SH_limit' => true,   // use SH field as shift hours
        'availability_fallback' => true,   // fallback to nearest availability if none found
        'track_spent_hours' => true,   // track hours spent for reporting
        'use_performance_subbranch' => true,   // schedule & validate against PS.01.12-adjusted plan when trainees are present
        'scale_round_cap_by_performance' => true,   // trainee: cap = base(SH or roundLimit) × (1 + (1 − performance))
        'bump_al_when_trainee_adjusted_exceeds_cap' => true,   // raise AL≥2 when adjusted workload > raw round/SH cap; re-select + optional helper from full pool
        'prefer_operative_primary_when_trainee_overloaded' => true,   // within same start date, put operatives ahead of trainees when lone trainee adjusted > round/SH or default 2.1/2.5/3.1
        'prefer_trainees_globally' => true,   // for all tasks: prioritize trainees (<100% performance) ahead of operatives when they are valid candidates
        'allow_gap_assist_increase_allocation' => true,   // gap dead-end: bump task AL and add another assignee from the pool
        'gap_assist_max_allocation' => 6,   // hard ceiling when auto-bumping AL during gap assist
        'optimize_shortest_task_span' => true,   // front-load hours into earliest feasible days to minimize task duration
    ];

    # ------------------------------------------------------------------
    # ENTRY POINT
    # ------------------------------------------------------------------

    /**
     * Run the main scheduling algorithm.
     */
    private function processAllTasks($tasks, $allEmployees, $roundLimit)
    {
        $filteredTasks = [];
        $assignmentDetails = [];
        $roundUsage = [];

        // Always process tasks in strict numeric Pri order so shared availability
        // is consumed by higher-priority tasks first, regardless of incoming order.
        $tasksArray = is_array($tasks) ? $tasks : $tasks->toArray();
        usort($tasksArray, function ($a, $b) {
            $aPri = (isset($a['Pri']) && is_numeric($a['Pri'])) ? (float) $a['Pri'] : INF;
            $bPri = (isset($b['Pri']) && is_numeric($b['Pri'])) ? (float) $b['Pri'] : INF;
            if ($aPri === $bPri) {
                $aCreatedAt = $this->taskCreatedAtTimestamp($a);
                $bCreatedAt = $this->taskCreatedAtTimestamp($b);
                if ($aCreatedAt !== $bCreatedAt) {
                    return $aCreatedAt <=> $bCreatedAt;
                }
                return ((int) ($a['id'] ?? PHP_INT_MAX)) <=> ((int) ($b['id'] ?? PHP_INT_MAX));
            }
            return $aPri <=> $bPri;
        });

        foreach ($tasksArray as &$task) {
            $result = $this->processOneTask($task, $allEmployees, $roundUsage, $roundLimit);
            if (!$result)
                continue;

            [$task, $taskDetails] = $result;
            $filteredTasks[] = $task;
            $assignmentDetails[] = $taskDetails;
        }

        // Sort tasks by priority
        usort(
            $assignmentDetails,
            fn($a, $b) => ($a['Pri'] ?? PHP_INT_MAX) <=> ($b['Pri'] ?? PHP_INT_MAX)
        );

        return [$filteredTasks, $assignmentDetails];
    }

    /**
     * Process one task: validate, find candidates, select employees, assign hours.
     */
    private function processOneTask($task, $allEmployees, &$roundUsage, $roundLimit)
    {
        $task['Plan'] = is_numeric($task['Plan']) ? (float) $task['Plan'] : 0;
        if ($task['Plan'] <= 0 || $task['Done'] == 1)
            return null;

        $this->applyDefaultAlForTraineePairActivities($task);

        [$allCandidates, $finalCandidates] = $this->findCandidates($task, $allEmployees);
        if ($finalCandidates->isEmpty())
            return null;

        $finalCandidates = $this->reorderCandidatesPreferOperativeWhenTraineeOverloaded($task, $finalCandidates, $roundLimit);
        $allCandidates = $this->reorderCandidatesPreferOperativeWhenTraineeOverloaded($task, $allCandidates, $roundLimit);

        [$primary, $secondary, $tertiary] = $this->selectEmployees($task, $finalCandidates, $allEmployees);

        [$primary, $secondary, $tertiary] = $this->maybeBumpAlForTraineeWorkload(
            $task,
            $primary,
            $secondary,
            $tertiary,
            $finalCandidates,
            $allEmployees,
            $roundLimit
        );

        return $this->assignTaskHours(
            $task,
            $primary,
            $secondary,
            $tertiary,
            $roundUsage,
            $roundLimit,
            $allCandidates,
            $finalCandidates,
            $allEmployees
        );
    }

    # ------------------------------------------------------------------
    # DATA LOADING
    # ------------------------------------------------------------------

    private function taskCreatedAtTimestamp($task): int
    {
        $raw = $task['created_at'] ?? null;
        if (!$raw) {
            return PHP_INT_MAX;
        }
        try {
            return Carbon::parse($raw)->timestamp;
        } catch (\Throwable $e) {
            return PHP_INT_MAX;
        }
    }

    # ------------------------------------------------------------------
    # CANDIDATES
    # ------------------------------------------------------------------

    private function findCandidates($task, $allEmployees)
    {
        $number = $this->extractNumberFromTaskName($task['TaskName']);
        $candidates = collect();
        $allCandidates = collect();
        $uniqueEmployeeIds = [];

        foreach ($allEmployees as $employee) {
            $filteredNrms = $employee->nrms->filter(fn($nrm) => $nrm->number == $number);
            if ($filteredNrms->isEmpty() || !isset($filteredNrms->first()->pivot->OAP)) {
                continue;
            }

            $availabilitiesResult = $this->filterAvailabilities($employee, $task);
            $availabilities = $availabilitiesResult['availabilities'];
            if ($availabilities->isEmpty())
                continue;

            $validAvailabilities = $availabilities
                ->filter(fn($a) => (float) $a->Total > 0)
                ->sortBy(fn($a) => $a->date)
                ->values();

            if ($validAvailabilities->count() < 2)
                continue;

            $availabilityDate = $validAvailabilities->first()->date;

            $candidateData = [
                'employee' => $employee,
                'OAP' => $filteredNrms->first()->pivot->OAP,
                'availability' => $availabilityDate,
                'valid_ava_objects' => $validAvailabilities,
            ];

            if (!isset($uniqueEmployeeIds[$employee->id])) {
                $allCandidates->push($candidateData);
                $candidates->push($candidateData);
                $uniqueEmployeeIds[$employee->id] = true;
            }
        }

        // Sort by earliest availability. Within same date, optionally prioritize trainees first.
        $candidates = $candidates->groupBy('availability')->flatMap(function ($group) use ($task) {
            $group = $group->values();
            if (!empty($this->features['prefer_trainees_globally'] ?? false)) {
                $trainees = $group
                    ->filter(fn($c) => $this->getEmployeePerformanceRate($c['employee'], $task) < 1.0 - 0.0001)
                    ->values();
                $operatives = $group
                    ->reject(fn($c) => $this->getEmployeePerformanceRate($c['employee'], $task) < 1.0 - 0.0001)
                    ->values();
                if ($this->features['use_oap_sorting']) {
                    $trainees = $trainees->sortBy('OAP')->values();
                    $operatives = $operatives->sortBy('OAP')->values();
                }
                return $trainees->concat($operatives);
            }

            if ($this->features['use_oap_sorting'] && $group->count() > 1) {
                return $group->sortBy('OAP');
            }
            return $group;
        })->sortBy('availability')->values();

        return [$allCandidates, $candidates];
    }

    /**
     * If the current #1 candidate is a trainee and PS-adjusted solo workload exceeds round/SH (overloaded in one slot),
     * or the task is default 2.1/2.5/3.1, reorder so operatives (100% performance) rank before trainees on each
     * calendar start date — same earliest day, better-suited primary without delaying the task.
     */
    private function reorderCandidatesPreferOperativeWhenTraineeOverloaded(array $task, $candidates, float $roundLimit)
    {
        if ($candidates->isEmpty()) {
            return $candidates;
        }
        if (!empty($this->features['prefer_trainees_globally'] ?? false)) {
            // Global trainee-priority mode overrides overload-based operative promotion.
            return $candidates;
        }
        if (empty($this->features['prefer_operative_primary_when_trainee_overloaded'] ?? true)) {
            return $candidates;
        }
        if (!$this->features['use_performance_subbranch']) {
            return $candidates;
        }

        $first = $candidates->first();
        $emp0 = $first['employee'] ?? null;
        if (!$emp0) {
            return $candidates;
        }

        if ($this->getEmployeePerformanceRate($emp0, $task) >= 1.0 - 0.0001) {
            return $candidates;
        }

        $plan = is_numeric($task['Plan'] ?? null) ? (float) $task['Plan'] : 0.0;
        if ($plan <= 0.0001) {
            return $candidates;
        }

        $taskForAdj = $task;
        $taskForAdj['Plan'] = $plan;
        $taskForAdj['TaskName'] = $task['TaskName'] ?? '';
        $adjustedSoloTrainee = $this->adjustTaskPlanByPerformance($taskForAdj, collect([$emp0]));

        $roundCap = (float) $roundLimit;
        if ($this->features['use_SH_limit'] && !empty($task['SH'])) {
            $roundCap = (float) $task['SH'];
        }

        $trigger = $this->isDefaultTraineePairActivityTask($task)
            || $adjustedSoloTrainee > $roundCap + 0.0001;
        if (!$trigger) {
            return $candidates;
        }

        $hasOperative = $candidates->contains(function ($c) use ($task) {
            $e = $c['employee'] ?? null;

            return $e && $this->getEmployeePerformanceRate($e, $task) >= 1.0 - 0.0001;
        });
        if (!$hasOperative) {
            return $candidates;
        }

        return $candidates
            ->groupBy('availability')
            ->sortKeys()
            ->flatMap(function ($group) use ($task) {
                $group = $group->values();
                $opers = $group->filter(fn($c) => $this->getEmployeePerformanceRate($c['employee'], $task) >= 1.0 - 0.0001)
                    ->values();
                $trainees = $group->reject(fn($c) => $this->getEmployeePerformanceRate($c['employee'], $task) >= 1.0 - 0.0001)
                    ->values();
                if ($this->features['use_oap_sorting']) {
                    $opers = $opers->sortBy(fn($c) => (float) $c['OAP']);
                    $trainees = $trainees->sortBy(fn($c) => (float) $c['OAP']);
                }

                return $opers->concat($trainees);
            })
            ->values();
    }

    private function selectEmployees($task, $finalCandidates, $allEmployees)
    {
        // Collect override names if any
        $overrideNames = array_filter([
            $task['Override_1'] ?? null,
            $task['Override_2'] ?? null,
            $task['Override_3'] ?? null,
        ]);

        // Remove candidates whose names match the overrides (to avoid duplication)
        $filteredCandidates = $finalCandidates->reject(function ($cand) use ($overrideNames) {
            return in_array($cand['employee']->first_name, $overrideNames, true);
        })->values();

        // Auto-select from filtered candidates (fallbacks)
        $primary = $filteredCandidates->count() > 0 ? $filteredCandidates[0]['employee'] : null;
        $secondary = $filteredCandidates->count() > 1 ? $filteredCandidates[1]['employee'] : null;
        $tertiary = $filteredCandidates->count() > 2 ? $filteredCandidates[2]['employee'] : null;

        // 🧠 Apply overrides — use in-memory employees from $allEmployees, not DB fetch
        if ($this->features['use_overrides']) {
            foreach (['Override_1' => 'primary', 'Override_2' => 'secondary', 'Override_3' => 'tertiary'] as $overrideKey => $slot) {
                if (!empty($task[$overrideKey])) {
                    $overrideName = $task[$overrideKey];

                    // Find existing in-memory employee model by first name
                    $existingEmp = $allEmployees->first(fn($e) => $e->first_name === $overrideName);

                    if ($existingEmp) {
                        if ($slot === 'primary')
                            $primary = $existingEmp;
                        if ($slot === 'secondary')
                            $secondary = $existingEmp;
                        if ($slot === 'tertiary')
                            $tertiary = $existingEmp;
                    }
                }
            }
        }

        return [$primary, $secondary, $tertiary];
    }

    /**
     * If the primary is a trainee with no secondary: pair them when the task is 2.1/2.5/3.1 (default AL=2 path)
     * or when PS-adjusted workload exceeds the raw round/SH cap. Raises AL≥2, picks an operative, sets HYPERMODE flag.
     * Skipped when overrides exist.
     */
    private function maybeBumpAlForTraineeWorkload(
        array &$task,
        $primary,
        $secondary,
        $tertiary,
        $finalCandidates,
        $allEmployees,
        float $roundLimit
    ): array {
        if (empty($this->features['bump_al_when_trainee_adjusted_exceeds_cap'] ?? true)) {
            return [$primary, $secondary, $tertiary];
        }
        if (!$this->features['use_performance_subbranch']) {
            return [$primary, $secondary, $tertiary];
        }

        $overrideExists = !empty(array_filter([
            $task['Override_1'] ?? null,
            $task['Override_2'] ?? null,
            $task['Override_3'] ?? null,
        ]));
        if ($overrideExists) {
            return [$primary, $secondary, $tertiary];
        }

        if ($secondary !== null) {
            return [$primary, $secondary, $tertiary];
        }
        if (!$primary) {
            return [$primary, $secondary, $tertiary];
        }

        $rate = $this->getEmployeePerformanceRate($primary, $task);
        if ($rate >= 1.0 - 0.0001) {
            return [$primary, $secondary, $tertiary];
        }

        $originalPlan = is_numeric($task['Plan'] ?? null) ? (float) $task['Plan'] : 0.0;
        if ($originalPlan <= 0.0001) {
            return [$primary, $secondary, $tertiary];
        }

        $taskForAdj = $task;
        $taskForAdj['Plan'] = $originalPlan;
        $taskForAdj['TaskName'] = $task['TaskName'] ?? '';
        $adjustedTarget = $this->adjustTaskPlanByPerformance($taskForAdj, collect([$primary]));

        $roundCap = (float) $roundLimit;
        if ($this->features['use_SH_limit'] && !empty($task['SH'])) {
            $roundCap = (float) $task['SH'];
        }

        $pairTrainee = $this->isDefaultTraineePairActivityTask($task)
            || $adjustedTarget > $roundCap + 0.0001;
        if (!$pairTrainee) {
            return [$primary, $secondary, $tertiary];
        }

        $currentAl = isset($task['AL']) && is_numeric($task['AL']) ? (int) $task['AL'] : 0;
        $task['AL'] = max($currentAl, 2);

        [$p, $s, $t] = $this->selectEmployees($task, $finalCandidates, $allEmployees);
        if ($s === null && $allEmployees) {
            $s = $this->findSecondaryEmployeeForTraineeFromPool($task, $p ?? $primary, $allEmployees);
        }

        // assignTaskHours: same HYPERMODE path as 2 manual overrides (even plan split; 70/30 disabled + SH phases)
        if ($s !== null) {
            $task['_hypermode_trainee_split'] = true;
        }

        return [$p, $s, $t];
    }

    /**
     * When findCandidates only returns one row (≥2 avail days), still pick an operative from allEmployees:
     * performance ≥ 100%, same activity NRM + OAP, ≥2 days with hours in the task window; tie-break by higher OAP.
     */
    private function findSecondaryEmployeeForTraineeFromPool(array $task, $primary, $allEmployees): ?Employee
    {
        if (!$primary || !$allEmployees) {
            return null;
        }
        $number = $this->extractNumberFromTaskName($task['TaskName'] ?? '');
        if (!$number) {
            return null;
        }

        $rows = collect();
        foreach ($allEmployees as $employee) {
            if ((int) $employee->id === (int) $primary->id) {
                continue;
            }
            $filteredNrms = $employee->nrms->filter(fn($nrm) => $nrm->number == $number);
            if ($filteredNrms->isEmpty() || !isset($filteredNrms->first()->pivot->OAP)) {
                continue;
            }
            $availabilitiesResult = $this->filterAvailabilities($employee, $task);
            $availabilities = $availabilitiesResult['availabilities'];
            if ($availabilities->isEmpty()) {
                continue;
            }
            $validAvailabilities = $availabilities
                ->filter(fn($a) => (float) $a->Total > 0)
                ->sortBy(fn($a) => $a->date ?? $a->Date ?? '')
                ->values();
            // Operative (helper) must have at least 2 bookable days in the task window, same bar as findCandidates.
            if ($validAvailabilities->count() < 2) {
                continue;
            }
            $perfRate = $this->getEmployeePerformanceRate($employee, $task);
            if ($perfRate < 1.0 - 0.0001) {
                continue;
            }
            $oap = (float) $filteredNrms->first()->pivot->OAP;
            $rows->push([
                'employee' => $employee,
                'oap' => $oap,
                'rate' => $perfRate,
            ]);
        }

        if ($rows->isEmpty()) {
            return null;
        }

        return $rows->sort(function ($a, $b) {
            $aExp = ($a['rate'] >= 1.0 - 0.0001) ? 1 : 0;
            $bExp = ($b['rate'] >= 1.0 - 0.0001) ? 1 : 0;
            if ($aExp !== $bExp) {
                return $bExp <=> $aExp;
            }
            return $b['oap'] <=> $a['oap'];
        })->first()['employee'];
    }

    /**
     * Default AL = 2 for activities 2.1 / 2.5 / 3.1 / 2.7 when there are no manual overrides.
     */
    private function applyDefaultAlForTraineePairActivities(array &$task): void
    {
        $n = $this->extractNumberFromTaskName($task['TaskName'] ?? '');
        if (!in_array($n, ['2.1', '2.5', '3.1', '2.7'], true)) {
            return;
        }
        if (!empty(array_filter([
            $task['Override_1'] ?? null,
            $task['Override_2'] ?? null,
            $task['Override_3'] ?? null,
        ]))) {
            return;
        }
        $al = isset($task['AL']) && is_numeric($task['AL']) ? (int) $task['AL'] : 0;
        if ($al < 2) {
            $task['AL'] = 2;
        }
    }

    private function isDefaultTraineePairActivityTask(array $task): bool
    {
        $n = $this->extractNumberFromTaskName($task['TaskName'] ?? '');

        return in_array($n, ['2.1', '2.5', '3.1'], true);
    }


    # ------------------------------------------------------------------
    # ASSIGNMENT
    # ------------------------------------------------------------------


    private function assignTaskHours(
        $task,
        $primary,
        $secondary,
        $tertiary,
        &$roundUsage,
        $roundLimit,
        $allCandidates,
        $finalCandidates,
        $allEmployees = null
    ) {
        $taskId = $task['id'];
        $originalPlan = is_numeric($task['Plan'] ?? null) ? (float) $task['Plan'] : 0.0;
        $baseSelectedEmployees = collect([$primary, $secondary, $tertiary])->filter()->values();
        $plan = $originalPlan;
        $totalAssigned = 0;
        $assignedHoursTracker = [];
        $spentHrs = [];
        $gapAssistRemainingQuota = [];
        $unlockLog = [];
        $empMinHours = [];
        $empMinDays = [];
        $pId = $primary?->id;
        $sId = $secondary?->id;
        $tId = $tertiary?->id;

        $taskAssignmentDetails = [
            'task_id' => $taskId,
            'part_id' => $task['parts_id'],
            'task_name' => $task['TaskName'],
            'Plan' => $originalPlan,
            'DD' => isset($task['DD']) && is_numeric($task['DD']) ? (int) $task['DD'] : 0,
            'assignments' => [],
            'Pri' => $task['Pri'] ?? PHP_INT_MAX,
            'primary_employee' => null,
            'secondary_employee' => null,
            'tertiary_employee' => null,
            'override_1' => $task['Override_1'] ?? null,
            'override_2' => $task['Override_2'] ?? null,
            'override_3' => $task['Override_3'] ?? null,
            'end_dates' => [],
            'performance_subbranch_active' => false,
        ];
        
        // Helper function to log assignment process events (only if needed for debugging)
        $logProcess = function($event, $details = []) use (&$taskAssignmentDetails) {
            // Disabled by default to minimize output - enable only for debugging
            // Uncomment below to enable logging:
            // $taskAssignmentDetails['assignment_process_log'][] = [
            //     'event' => $event,
            //     'details' => $details,
            // ];
        };

        // Gap summary calculation removed to minimize output size

        // -----------------------------
        // Employees in fixed order
        // -----------------------------

        // =====================================================
        // 🔥 HYPERMODE — SPLIT (1 OR 2 OVERRIDES, OR TRAINEE BUMP TWO-SLOT)
        // RULES:
        // - Trigger if override count = 1 or 2, OR internal _hypermode_trainee_split (AL bump + two assignees)
        // - Algo employees first, overrides force participation
        // - Override count (or fixed 2 for trainee bump) OVERRIDES AL - forcibly splits on slot count
        // - Trainee bump: even plan split (70/30 disabled); overrides: even split, rounded UP
        // - NEVER exceed Plan
        // =====================================================

        // 0️⃣ Detect overrides
        $overrideSlots = array_filter([
            $task['Override_1'] ?? null,
            $task['Override_2'] ?? null,
            $task['Override_3'] ?? null,
        ]);

        $overrideCount = count($overrideSlots);

        $traineeAlgoHyper = !empty($task['_hypermode_trainee_split'])
            && $overrideCount === 0
            && $primary
            && $secondary;

        // ✅ HYPERMODE: 1–2 manual overrides, OR trainee workload bump with primary+secondary (same as 2 overrides + trainee)
        $hyperMode = in_array($overrideCount, [1, 2], true) || $traineeAlgoHyper;

        if ($hyperMode) {

            // -------------------------------------------------
            // 1️⃣ Resolve override employees (FULL NAME SAFE)
            // -------------------------------------------------
            $resolved = [];

            if ($traineeAlgoHyper) {
                $resolved = [$primary, $secondary];
            } else {
                foreach ($overrideSlots as $name) {

                    $normalized = strtolower(trim(preg_replace('/\s+/', ' ', $name)));

                    $match = function ($e) use ($normalized) {
                        $full = strtolower(trim(preg_replace(
                            '/\s+/',
                            ' ',
                            ($e->first_name ?? '') . ' ' . ($e->last_name ?? '')
                        )));
                        return $full === $normalized;
                    };

                    // 🔥 USE GENERAL AVAILABILITY: Try allEmployees first to respect assignments from other modes
                    $emp =
                        $finalCandidates->pluck('employee')->first($match)
                        ?? $allCandidates->pluck('employee')->first($match)
                        ?? ($allEmployees ? $allEmployees->first($match) : null) // 🔥 USE GENERAL AVA (prevents using already-assigned availability)
                        ?? null;

                    if ($emp) {
                        $resolved[] = $emp;
                    }
                }
            }

            // -------------------------------------------------
            // 2️⃣ Determine LIMIT (OVERRIDE COUNT overrides AL)
            // -------------------------------------------------

            $alLimit = null;

            // 1️⃣ Override count has priority - forcibly split on number of overrides (or 2 for trainee bump)
            $alLimit = $traineeAlgoHyper ? 2 : $overrideCount;

            // 2️⃣ AL is ignored when overrides exist - override count determines split

            // -------------------------------------------------
            // 3️⃣ Select employees (OVERRIDES FIRST → ALGO FILL)
            // -------------------------------------------------
            $employees = collect();

            // Overrides first — they override algo selection
            foreach ($resolved as $emp) {
                if (!$employees->contains(fn($e) => $e->id === $emp->id)) {
                    $employees->push($emp);
                }
            }

            // Fill remaining slots from algo-selected employees (if any)
            foreach ([$primary, $secondary, $tertiary] as $emp) {
                if ($emp && !$employees->contains(fn($e) => $e->id === $emp->id)) {
                    $employees->push($emp);
                }
            }

            // De-duplicate + apply AL limit
            $employees = $employees
                ->unique(fn($e) => $e->id)
                ->when($alLimit !== null, fn($c) => $c->take($alLimit))
                ->values();

            if ($employees->isEmpty()) {
                $this->applyPostAssignmentHrsPerAndBufferAdjustments($task, $taskAssignmentDetails, $allEmployees);
                return $this->finalizeRoundedTaskOutput($task, $taskAssignmentDetails, $originalPlan, $allEmployees);
            }

            $taskAssignmentDetails['mode'] = $traineeAlgoHyper
                ? 'HYPERMODE_TRAINEE_BUMP_TWO_SLOT'
                : 'HYPERMODE_OVERRIDE_EVEN_SPLIT';

            // -------------------------------------------------
            // 4️⃣ Build availability map
            // -------------------------------------------------
            $availabilityMap = [];

            foreach ($employees as $emp) {
                $availabilityMap[$emp->id] = $this
                    ->filterAvailabilities($emp, $task)['availabilities']
                    ->map(function ($a) {
                        $a->date = $a->date ?? $a->Date;
                        $a->Total = (float) $this->convertToHours($a->Total);
                        return $a;
                    })
                    ->filter(fn($a) => $a->Total > 0)
                    ->values();
            }

            // -------------------------------------------------
            // 4.5️⃣ Apply DD (Delay Days) — operative slot 0, then trainee (+DD per slot).
            // -------------------------------------------------
            $dd = isset($task['DD']) && is_numeric($task['DD']) ? (int) $task['DD'] : 0;
            $ddStartsByName = [];
            $pairForDd = $this->resolveSynchronizedTwoPersonPair($employees, $task);
            if ($pairForDd) {
                $employees = collect([$pairForDd['operative'], $pairForDd['trainee']])
                    ->merge($employees)
                    ->unique(fn($e) => $e->id)
                    ->when($alLimit !== null, fn($c) => $c->take($alLimit))
                    ->values();
                $availabilityMap = [];
                foreach ($employees as $emp) {
                    $availabilityMap[$emp->id] = $this
                        ->filterAvailabilities($emp, $task)['availabilities']
                        ->map(function ($a) {
                            $a->date = $a->date ?? $a->Date;
                            $a->Total = (float) $this->convertToHours($a->Total);
                            return $a;
                        })
                        ->filter(fn($a) => $a->Total > 0)
                        ->values();
                }
            }
            if ($dd > 0 && $employees->count() > 1) {
                $ddSlotNames = $this->resolveDdOrderedAssigneeNames(
                    $task,
                    $allEmployees,
                    $employees->pluck('first_name')->filter()->values()->all()
                );
                $ddPrimary = !empty($ddSlotNames)
                    ? $employees->first(fn($e) => $e->first_name === $ddSlotNames[0])
                    : $employees->first();
                $baseDate = $ddPrimary
                    ? $this->resolveEmployeeEarliestCalendarDateInTaskWindow($ddPrimary, $task)
                    : null;
                if ($baseDate) {
                    $empKeys = [];
                    foreach ($ddSlotNames as $slotName) {
                        $slotEmp = $employees->first(fn($e) => $e->first_name === $slotName);
                        if ($slotEmp) {
                            $empKeys[] = $slotEmp->id;
                        }
                    }
                    if ($empKeys === []) {
                        $empKeys = $employees->pluck('id')->toArray();
                    }
                    $this->applyDDToAvailabilityMap($availabilityMap, $empKeys, $baseDate, $dd);
                }
                $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName(
                    $task,
                    $allEmployees,
                    !empty($ddSlotNames) ? $ddSlotNames : $employees->pluck('first_name')->filter()->values()->all()
                );
                $taskAssignmentDetails['dd_starts_by_name'] = $ddStartsByName;
            }

            // -------------------------------------------------
            // 5️⃣ Plan split: even (70/30 disabled)
            //     PS.01.12: if trainees are selected, plan may be raised to adjusted target.
            // -------------------------------------------------
            $plan = (float) $originalPlan;
            if ($this->features['use_performance_subbranch']) {
                $selectedModels = $employees->filter()->values();
                if ($selectedModels->isNotEmpty()) {
                    $taskForAdj = $task;
                    $taskForAdj['Plan'] = $originalPlan;
                    $taskForAdj['TaskName'] = $task['TaskName'] ?? ($taskAssignmentDetails['task_name'] ?? '');
                    $adjustedTarget = $this->adjustTaskPlanByPerformance($taskForAdj, $selectedModels);
                    if ($adjustedTarget > $plan + 0.0001) {
                        $plan = $adjustedTarget;
                        $taskAssignmentDetails['performance_subbranch_active'] = true;
                    }
                }
            }

            $targets = $this->buildHypermodeOverrideFairTargets((float) $plan, $employees, $task);

            // Map quotas
            $remainingQuota = [];
            // Pure AL should stay neutral/even; do not expand quotas by performance rate.
            $syncPairEven = true;
            foreach ($employees as $idx => $emp) {
                $baseQuota = (float) $targets[$idx];
                $remainingQuota[$emp->id] = $baseQuota;
            }

            // -------------------------------------------------
            // 6️⃣ Assign hours: Sequential until SH limit, then parallel
            // -------------------------------------------------
            $dates = collect($availabilityMap)
                ->flatMap(fn($av) => $av->pluck('date'))
                ->unique()
                ->sort()
                ->values();

            // Determine effective limit (SH if set, else roundLimit, else no limit)
            $effectiveLimit = null;
            $isSHDefault = empty($task['SH']);
            
            if ($this->features['use_SH_limit'] && !$isSHDefault) {
                $effectiveLimit = (float) $task['SH'];
            } elseif ($this->features['enforce_rounds'] && !$isSHDefault) {
                $effectiveLimit = (float) $roundLimit;
            }

            if ($isSHDefault) {
                // No SH:
                // - If exactly one trainee + one operative, assign trainee forward then operative backward.
                // - Otherwise keep normal date->employee sweep.
                $remainingPlan = array_sum($remainingQuota);
                $pair = $this->resolveSynchronizedTwoPersonPair($employees, $task);
                if ($employees->count() === 2 && $pair !== null) {
                    $traineeDates = $this->buildTraineeDatesForPairMode(
                        $pair['trainee'],
                        $pair['operative'],
                        $availabilityMap,
                        $dates
                    );
                    $traineeResult = $this->assignEmployeeByDateDirection(
                        $pair['trainee'],
                        $traineeDates,
                        $availabilityMap,
                        $remainingQuota,
                        $remainingPlan,
                        $taskAssignmentDetails,
                        false
                    );
                    $traineeEndDate = $traineeResult['last_date'] ?? null;
                    $operativeResult = $this->assignEmployeeByDateDirection(
                        $pair['operative'],
                        $dates,
                        $availabilityMap,
                        $remainingQuota,
                        $remainingPlan,
                        $taskAssignmentDetails,
                        true,
                        $traineeEndDate
                    );
                    if (($operativeResult['assigned'] ?? 0.0) > 0 && !empty($traineeEndDate)) {
                        $taskAssignmentDetails['end_dates'][$pair['operative']->first_name] = $traineeEndDate;
                    }
                } else {
                    $dailyAssigned = [];
                    foreach ($dates as $date) {
                        if ($remainingPlan <= 0) {
                            break;
                        }

                        foreach ($employees as $emp) {
                            if ($remainingPlan <= 0) {
                                break;
                            }

                            $empId = $emp->id;
                            while ($remainingPlan > 0) {
                                $empQuota = (float) ($remainingQuota[$empId] ?? 0);
                                if ($empQuota <= 0.0001) {
                                    break;
                                }

                                $ava = $availabilityMap[$empId]
                                    ->first(fn($a) => $a->date === $date);

                                if (!$ava || $ava->Total <= 0) {
                                    break;
                                }

                                $previouslyAssigned = $dailyAssigned[$empId][$date] ?? 0.0;
                                // Total already reflects remaining capacity after previous assignments.
                                $dailyAvailable = max(0.0, (float) $ava->Total);
                                if ($dailyAvailable <= 0.0001) {
                                    break;
                                }

                                $assign = min($dailyAvailable, $remainingPlan, $empQuota);
                                if ($assign <= 0.0) {
                                    break;
                                }

                                $taskAssignmentDetails['assignments'][] = [
                                    'employee' => $emp->first_name,
                                    'date' => $date,
                                    'hours' => $assign,
                                ];

                                $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;

                                $this->updateGlobalAvailability($emp, $date, $assign);
                                $remainingPlan -= $assign;
                                $remainingQuota[$empId] = $empQuota - $assign;

                                if (!isset($dailyAssigned[$empId])) {
                                    $dailyAssigned[$empId] = [];
                                }
                                $dailyAssigned[$empId][$date] = $previouslyAssigned + $assign;
                            }
                        }
                    }
                }

                // -------------------------------------------------
                // 7️⃣ Final algorithm slots
                // -------------------------------------------------
                $names = $employees->pluck('first_name')->values();

                $taskAssignmentDetails['primary_employee'] = $names[0] ?? null;
                $taskAssignmentDetails['AL'] = $alLimit ?? null;
                $taskAssignmentDetails['secondary_employee'] = $names[1] ?? null;
                $taskAssignmentDetails['tertiary_employee'] = $names[2] ?? null;

                $task['AL'] = $alLimit ?? null;
                $task['Algorithm_1'] = $names[0] ?? null;
                $task['Algorithm_2'] = $names[1] ?? null;
                $task['Algorithm_3'] = $names[2] ?? null;

                $task['TS'] = $employees->count();

                $statsBeforeFinalize = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
                $hyperRemaining = (float) $plan - (float) ($statsBeforeFinalize['total_assigned'] ?? 0.0);
                if ($hyperRemaining > 0.0001) {
                    $this->exhaustOverrideHardSlotPlanToTarget(
                        $task,
                        $taskAssignmentDetails,
                        $employees,
                        (float) $plan,
                        $allEmployees,
                        365
                    );
                }

                $this->applyPostAssignmentHrsPerAndBufferAdjustments($task, $taskAssignmentDetails, $allEmployees);
                return $this->finalizeRoundedTaskOutput($task, $taskAssignmentDetails, $originalPlan, $allEmployees);
            }
            
            $fairTargetsByEmpId = [];
            foreach ($employees as $idx => $emp) {
                $fairTargetsByEmpId[$emp->id] = (float) ($targets[$idx] ?? 0.0);
            }
            $ddStartsByName = $ddStartsByName ?? [];
            $twoPersonShSplit = $this->isHypermodeTwoPersonShAsymmetricSplit($employees, $targets, $task);

            // 3+ overrides with SH: parallel day-by-day fill (later-ava first on overlap).
            // 2-person SH split uses sequential slot fill so primary reaches min(plan, SH) first.
            if ($effectiveLimit !== null && !$isSHDefault && $employees->count() >= 2 && !$twoPersonShSplit) {
                $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName(
                    $task,
                    $allEmployees,
                    $employees->pluck('first_name')->filter()->values()->all()
                );
                $this->fillOverrideHardSlotRemainingPlan(
                    $task,
                    $taskAssignmentDetails,
                    $employees,
                    (float) $plan,
                    $effectiveLimit,
                    $allEmployees,
                    $fairTargetsByEmpId,
                    $ddStartsByName,
                    true
                );
            } else {
            $remainingPlan = array_sum($remainingQuota); // Track remaining distributed hours
            // Track daily assignments per employee for SH limit enforcement
            $dailyAssigned = [];
            // Track total assigned per employee (for sequential phase)
            $totalAssignedPerEmp = [];
            foreach ($employees as $emp) {
                $totalAssignedPerEmp[$emp->id] = 0.0;
            }

            // Phase 1: Sequential assignment - fill each employee up to SH limit
            // Skip this phase if SH is not provided - go straight to normal even split
            if ($effectiveLimit !== null && !$isSHDefault) {
                foreach ($employees as $emp) {
                    $empId = $emp->id;
                    
                    // Skip if this employee already reached SH limit
                    if ($totalAssignedPerEmp[$empId] >= $effectiveLimit) {
                        continue;
                    }
                    
                    foreach ($dates as $date) {
                        if (
                            !$this->isOverrideEmployeeDateEligible(
                                $emp,
                                (string) $date,
                                $ddStartsByName,
                                $taskAssignmentDetails['assignments'] ?? []
                            )
                        ) {
                            continue;
                        }
                        // Check if we've exceeded plan
                        if ($remainingPlan <= 0) {
                            break 2; // Break out of both loops
                        }

                        // Check if employee reached SH limit
                        if ($totalAssignedPerEmp[$empId] >= $effectiveLimit) {
                            break;
                        }

                        while ($remainingPlan > 0 && $totalAssignedPerEmp[$empId] < $effectiveLimit) {
                            $ava = $availabilityMap[$empId]
                                ->first(fn($a) => $a->date === $date);

                            if (!$ava || $ava->Total <= 0) {
                                break;
                            }

                            // Calculate daily available hours
                            $previouslyAssigned = $dailyAssigned[$empId][$date] ?? 0;
                            // Total already reflects remaining capacity after previous assignments.
                            $dailyAvailable = max(0.0, (float) $ava->Total);

                            if ($dailyAvailable <= 0.0001) {
                                break;
                            }

                            // Calculate remaining SH for this employee
                            $remainingSH = $effectiveLimit - $totalAssignedPerEmp[$empId];
                            if ($remainingSH <= 0) {
                                break;
                            }

                            // Allow a small same-day SH overflow (<5h) to finish the day.
                            $overflowToFinishDay = $dailyAvailable - $remainingSH;
                            $allowSmallTail = $overflowToFinishDay > 0 && $overflowToFinishDay < 5;
                            $assignBySh = $allowSmallTail ? $dailyAvailable : min($dailyAvailable, $remainingSH);
                            // Keep hypermode override split fair: honor each employee's remaining quota.
                            $empQuota = (float) ($remainingQuota[$empId] ?? 0.0);
                            if ($empQuota <= 0.0001) {
                                break;
                            }
                            // Assign based on availability, plan, SH allowance, and quota.
                            $assign = min($assignBySh, $remainingPlan, $empQuota);

                            if ($assign <= 0) {
                                break;
                            }

                            $taskAssignmentDetails['assignments'][] = [
                                'employee' => $emp->first_name,
                                'date' => $date,
                                'hours' => $assign,
                            ];

                            $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;

                            // Update in-memory availability
                            $ava->Total -= $assign;
                            // Update global availability to prevent double-booking across tasks
                            $this->updateGlobalAvailability($emp, $date, $assign);
                            $remainingPlan -= $assign;

                            // Track assignments
                            if (!isset($dailyAssigned[$empId])) {
                                $dailyAssigned[$empId] = [];
                            }
                            $dailyAssigned[$empId][$date] = ($dailyAssigned[$empId][$date] ?? 0) + $assign;
                            $totalAssignedPerEmp[$empId] += $assign;
                            $remainingQuota[$empId] = max(0.0, $empQuota - $assign);
                        }
                    }
                }
            }
            
            // Phase 2: Parallel assignment for any remaining plan hours
            if ($remainingPlan > 0.0001) {
                // If SH is not provided, use original quotas that split full plan evenly
                // Otherwise, recalculate quotas for remaining plan
                if ($isSHDefault) {
                    // Use the original quotas that split the full plan evenly
                    $parallelQuota = $remainingQuota;
                } elseif ($twoPersonShSplit) {
                    $parallelQuota = $remainingQuota;
                } else {
                    // Recalculate quotas for remaining plan (even split; 70/30 disabled)
                    $targets = $this->buildPlanTargetsForEmployees((float) $remainingPlan, $employees, $task);

                    // Map quotas for parallel phase
                    $parallelQuota = [];
                    foreach ($employees as $idx => $emp) {
                        $baseQuota = (float) $targets[$idx];
                        $rate = $this->getEmployeePerformanceRate($emp, $task);
                        $parallelQuota[$emp->id] = ($rate > 0 && $rate < 1.0)
                            ? (float) ceil($baseQuota / $rate)
                            : $baseQuota;
                    }
                }
                
                foreach ($dates as $date) {
                    foreach ($employees as $emp) {
                        $empId = $emp->id;
                        if (
                            !$this->isOverrideEmployeeDateEligible(
                                $emp,
                                (string) $date,
                                $ddStartsByName,
                                $taskAssignmentDetails['assignments'] ?? []
                            )
                        ) {
                            continue;
                        }
                        while ($remainingPlan > 0 && ($parallelQuota[$empId] ?? 0) > 0.0001) {
                            $ava = $availabilityMap[$empId]
                                ->first(fn($a) => $a->date === $date);

                            if (!$ava || $ava->Total <= 0) {
                                break;
                            }

                            // Calculate daily available hours
                            $previouslyAssigned = $dailyAssigned[$empId][$date] ?? 0;
                            // Total already reflects remaining capacity after previous assignments.
                            $dailyAvailable = max(0.0, (float) $ava->Total);

                            if ($dailyAvailable <= 0.0001) {
                                break;
                            }

                            // Apply daily SH limit if set (skip if SH is not provided)
                            $remainingDailySH = null;
                            if ($effectiveLimit !== null && !$isSHDefault) {
                                $remainingDailySH = $effectiveLimit - $previouslyAssigned;
                                if ($remainingDailySH <= 0) {
                                    break;
                                }
                            }

                            // Assign based on quota, availability, plan, and daily SH limit
                            // If SH is not provided, do normal even split without SH restrictions
                            $assign = min($dailyAvailable, $remainingPlan, $parallelQuota[$empId]);
                            if ($remainingDailySH !== null && !$isSHDefault) {
                                $overflowToFinishDay = $dailyAvailable - $remainingDailySH;
                                $allowSmallTail = $overflowToFinishDay > 0 && $overflowToFinishDay < 5;
                                $shBound = $allowSmallTail ? $dailyAvailable : $remainingDailySH;
                                $assign = min($assign, $shBound);
                            }

                            if ($assign <= 0) {
                                break;
                            }

                            $taskAssignmentDetails['assignments'][] = [
                                'employee' => $emp->first_name,
                                'date' => $date,
                                'hours' => $assign,
                            ];

                            $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;

                            // Update in-memory availability
                            $ava->Total -= $assign;
                            // Update global availability to prevent double-booking across tasks
                            $this->updateGlobalAvailability($emp, $date, $assign);
                            $parallelQuota[$empId] -= $assign;
                            $remainingPlan -= $assign;

                            // Track assignments
                            if (!isset($dailyAssigned[$empId])) {
                                $dailyAssigned[$empId] = [];
                            }
                            $dailyAssigned[$empId][$date] = ($dailyAssigned[$empId][$date] ?? 0) + $assign;
                            $totalAssignedPerEmp[$empId] += $assign;
                        }
                    }
                }
            }

            // For normal operative-only override hypermode, do a spillover pass:
            // if one override cannot satisfy its fair quota, let the other operative
            // consume remaining plan hours (still bounded by daily availability / SH).
            $allOperatives = $employees->every(
                fn($emp) => $this->getEmployeePerformanceRate($emp, $task) >= 1.0 - 0.0001
            );
            if ($remainingPlan > 0.0001 && $allOperatives) {
                $guard = 0;
                while ($remainingPlan > 0.0001 && $guard++ < 200) {
                    $progress = false;
                    foreach ($dates as $date) {
                        if ($remainingPlan <= 0.0001) {
                            break;
                        }
                        foreach ($employees as $emp) {
                            if ($remainingPlan <= 0.0001) {
                                break;
                            }
                            if (
                                !$this->isOverrideEmployeeDateEligible(
                                    $emp,
                                    (string) $date,
                                    $ddStartsByName,
                                    $taskAssignmentDetails['assignments'] ?? []
                                )
                            ) {
                                continue;
                            }
                            $empId = $emp->id;
                            $empQuota = (float) ($remainingQuota[$empId] ?? 0.0);
                            if ($empQuota <= 0.0001) {
                                continue;
                            }
                            while ($remainingPlan > 0.0001 && $empQuota > 0.0001) {
                                $ava = $availabilityMap[$empId]
                                    ->first(fn($a) => $a->date === $date);
                                if (!$ava || $ava->Total <= 0.0001) {
                                    break;
                                }

                                $dailyAvailable = max(0.0, (float) $ava->Total);
                                if ($dailyAvailable <= 0.0001) {
                                    break;
                                }

                                // Preserve daily SH guard in spill mode (if SH is active).
                                $previouslyAssigned = $dailyAssigned[$empId][$date] ?? 0.0;
                                $remainingDailySH = null;
                                if ($effectiveLimit !== null && !$isSHDefault) {
                                    $remainingDailySH = $effectiveLimit - $previouslyAssigned;
                                    if ($remainingDailySH <= 0.0001) {
                                        break;
                                    }
                                }

                                $assign = min($dailyAvailable, $remainingPlan, $empQuota);
                                if ($remainingDailySH !== null) {
                                    $overflowToFinishDay = $dailyAvailable - $remainingDailySH;
                                    $allowSmallTail = $overflowToFinishDay > 0 && $overflowToFinishDay < 5;
                                    $shBound = $allowSmallTail ? $dailyAvailable : $remainingDailySH;
                                    $assign = min($assign, $shBound);
                                }
                                if ($assign <= 0.0001) {
                                    break;
                                }

                                $taskAssignmentDetails['assignments'][] = [
                                    'employee' => $emp->first_name,
                                    'date' => $date,
                                    'hours' => $assign,
                                ];
                                $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;

                                $ava->Total -= $assign;
                                $this->updateGlobalAvailability($emp, $date, $assign);
                                $remainingPlan -= $assign;
                                $empQuota -= $assign;
                                $remainingQuota[$empId] = max(0.0, $empQuota);

                                if (!isset($dailyAssigned[$empId])) {
                                    $dailyAssigned[$empId] = [];
                                }
                                $dailyAssigned[$empId][$date] = ($dailyAssigned[$empId][$date] ?? 0.0) + $assign;
                                $totalAssignedPerEmp[$empId] = ($totalAssignedPerEmp[$empId] ?? 0.0) + $assign;
                                $progress = true;
                            }
                        }
                    }
                    if (!$progress) {
                        break;
                    }
                }
            }

            } // end legacy SH phases (single override / no SH)

            // -------------------------------------------------
            // 7️⃣ Final algorithm slots
            // -------------------------------------------------
            $names = $employees->pluck('first_name')->values();

            $taskAssignmentDetails['primary_employee'] = $names[0] ?? null;
            $taskAssignmentDetails['AL'] = $alLimit ?? null;
            $taskAssignmentDetails['secondary_employee'] = $names[1] ?? null;
            $taskAssignmentDetails['tertiary_employee'] = $names[2] ?? null;

            $task['AL'] = $alLimit ?? null;
            $task['Algorithm_1'] = $names[0] ?? null;
            $task['Algorithm_2'] = $names[1] ?? null;
            $task['Algorithm_3'] = $names[2] ?? null;

            $task['TS'] = $employees->count();

            $statsBeforeFinalize = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $hyperRemaining = (float) $plan - (float) ($statsBeforeFinalize['total_assigned'] ?? 0.0);
            if ($dd > 0 && $ddStartsByName === [] && $employees->count() > 1) {
                $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName(
                    $task,
                    $allEmployees,
                    $employees->pluck('first_name')->filter()->values()->all()
                );
            }
            if ($hyperRemaining > 0.0001) {
                if ($ddStartsByName === []) {
                    $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName(
                        $task,
                        $allEmployees,
                        $employees->pluck('first_name')->filter()->values()->all()
                    );
                }
                if (!$twoPersonShSplit) {
                    $this->fillOverrideHardSlotRemainingPlan(
                        $task,
                        $taskAssignmentDetails,
                        $employees,
                        (float) $plan,
                        ($effectiveLimit !== null && !$isSHDefault) ? $effectiveLimit : null,
                        $allEmployees,
                        $fairTargetsByEmpId,
                        $ddStartsByName,
                        $effectiveLimit !== null && !$isSHDefault
                    );
                    $statsBeforeFinalize = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
                    $hyperRemaining = (float) $plan - (float) ($statsBeforeFinalize['total_assigned'] ?? 0.0);
                }
            }
            if ($hyperRemaining > 0.0001) {
                $this->exhaustOverrideHardSlotPlanToTarget(
                    $task,
                    $taskAssignmentDetails,
                    $employees,
                    (float) $plan,
                    $allEmployees,
                    365,
                    $ddStartsByName
                );
            }

            $this->applyPostAssignmentHrsPerAndBufferAdjustments($task, $taskAssignmentDetails, $allEmployees);
            return $this->finalizeRoundedTaskOutput($task, $taskAssignmentDetails, $originalPlan, $allEmployees);
        }



        // =====================================================
        // ⭐ OVERRIDE MODE — HARD + SLOT-AWARE + EVEN SPLIT
        // RULES:
        // - Override count OVERRIDES AL - forcibly splits on number of overrides
        // - Even split based on override count, rounded UP
        // - Never exceed effective plan (nominal Plan, or PS-adjusted when trainees are present)
        // =====================================================
        $overrideSlots = [
            1 => $task['Override_1'] ?? null,
            2 => $task['Override_2'] ?? null,
            3 => $task['Override_3'] ?? null,
        ];

        // keep only filled overrides BUT KEEP SLOT INDEX
        $overrideSlots = array_filter($overrideSlots);
        $overrideCount = count($overrideSlots);
        $alCount = isset($task['AL']) && is_numeric($task['AL'])
            ? (int) $task['AL']
            : 0;

        $overrideFullyCoversAL = $overrideCount > 0 && $overrideCount === $alCount;
        $resolvedBySlot = []; // Initialize to avoid undefined variable errors

        if (!empty($overrideSlots)) {

            // -------------------------------------------------
            // 1️⃣ Resolve override employees (FULL NAME SAFE)
            // -------------------------------------------------
            $resolvedBySlot = [];

            foreach ($overrideSlots as $slot => $name) {

                $normalized = strtolower(trim(preg_replace('/\s+/', ' ', $name)));

                $match = function ($e) use ($normalized) {
                    $full = strtolower(trim(preg_replace(
                        '/\s+/',
                        ' ',
                        ($e->first_name ?? '') . ' ' . ($e->last_name ?? '')
                    )));
                    return $full === $normalized;
                };

                // 🔥 USE GENERAL AVAILABILITY: Try allEmployees first to respect assignments from other modes
                $emp =
                    $finalCandidates->pluck('employee')->first($match)
                    ?? $allCandidates->pluck('employee')->first($match)
                    ?? ($allEmployees ? $allEmployees->first($match) : null) // 🔥 USE GENERAL AVA (prevents using already-assigned availability)
                    ?? null; // Never fetch fresh model (would lose in-memory availability remnants)

                if ($emp) {
                    $resolvedBySlot[$slot] = $emp;
                }
            }

            if (empty($resolvedBySlot)) {
                $this->applyPostAssignmentHrsPerAndBufferAdjustments($task, $taskAssignmentDetails, $allEmployees);
                return $this->finalizeRoundedTaskOutput($task, $taskAssignmentDetails, $originalPlan, $allEmployees);
            }

            $taskAssignmentDetails['mode'] = 'OVERRIDE_HARD_SLOT';

            // PS.01.12: when overrides include a trainee, schedule to performance-adjusted total (same as unlock path).
            $plan = (float) $originalPlan;
            if ($this->features['use_performance_subbranch']) {
                $selectedOverrideModels = collect($resolvedBySlot)->sortKeys()->values()->filter();
                if ($selectedOverrideModels->isNotEmpty()) {
                    $taskForAdj = $task;
                    $taskForAdj['Plan'] = $originalPlan;
                    $taskForAdj['TaskName'] = $task['TaskName'] ?? ($taskAssignmentDetails['task_name'] ?? '');
                    $adjustedTarget = $this->adjustTaskPlanByPerformance($taskForAdj, $selectedOverrideModels);
                    if ($adjustedTarget > $plan + 0.0001) {
                        $plan = $adjustedTarget;
                        $taskAssignmentDetails['performance_subbranch_active'] = true;
                    }
                }
            }
            $remainingPlan = $plan;

            // -------------------------------------------------
            // 2️⃣ HARD AVAILABILITY (USE IN-MEMORY TO RESPECT PREVIOUS ASSIGNMENTS)
            // -------------------------------------------------
            $availabilityMap = [];

            foreach ($resolvedBySlot as $slot => $emp) {
                // Use in-memory availability to respect assignments from previous tasks
                $filtered = $this->filterAvailabilities($emp, $task);
                $availabilityMap[$slot] = $filtered['availabilities']
                    ->map(function ($a) {
                        $a->date = $a->date ?? $a->Date;        // normalize
                        $a->Total = (float) $this->convertToHours($a->Total);
                        return $a;
                    })
                    ->filter(fn($a) => $a->Total > 0)
                    ->values();
            }

            // Hard override assignment order: earliest availability first (not slot order).
            $assignmentSlots = array_keys($resolvedBySlot);

            // -------------------------------------------------
            // 2.5️⃣ Apply DD (Delay Days) — operative-first slot order when trainee pair exists.
            // -------------------------------------------------
            $dd = isset($task['DD']) && is_numeric($task['DD']) ? (int) $task['DD'] : 0;
            if ($dd > 0 && count($resolvedBySlot) > 1) {
                $slotKeys = array_keys($resolvedBySlot);
                $slotNames = collect($resolvedBySlot)->map(fn($e) => $e->first_name)->values()->all();
                $orderedNames = $this->resolveDdOrderedAssigneeNames($task, $allEmployees, $slotNames);
                if ($orderedNames !== $slotNames) {
                    $slotKeys = [];
                    foreach ($orderedNames as $name) {
                        foreach ($resolvedBySlot as $slot => $emp) {
                            if ($emp->first_name === $name) {
                                $slotKeys[] = $slot;
                                break;
                            }
                        }
                    }
                }
                $firstSlot = $slotKeys[0];
                $baseDate = ($availabilityMap[$firstSlot] ?? collect())->first()->date ?? null;
                if ($baseDate) {
                    $this->applyDDToAvailabilityMap($availabilityMap, $slotKeys, $baseDate, $dd);
                }
            }

            // Re-evaluate earliest slot order after DD filtering.
            $assignmentSlots = collect(array_keys($resolvedBySlot))
                ->sortBy(function ($slot) use ($availabilityMap) {
                    $first = ($availabilityMap[$slot] ?? collect())
                        ->sortBy(fn($a) => $a->date ?? $a->Date ?? '')
                        ->first();
                    $date = $first->date ?? $first->Date ?? null;
                    return $date ? strtotime((string) $date) : PHP_INT_MAX;
                })
                ->values()
                ->toArray();
            if (empty($assignmentSlots)) {
                $assignmentSlots = array_keys($resolvedBySlot);
            }

            // -------------------------------------------------
            // 3️⃣ EVEN SPLIT — Forcibly split on number of overrides
            // -------------------------------------------------
            // If an SH limit is active we don't want the simplistic "equal split" behaviour
            // used above; instead treat the override employees exactly as we would in the
            // normal algorithm, which enforces SH sequential/parallel phases.
            $isSHDefault = empty($task['SH']);
            $effectiveLimit = null;
            if ($this->features['use_SH_limit'] && !$isSHDefault) {
                $effectiveLimit = (float) $task['SH'];
            } elseif ($this->features['enforce_rounds'] && !$isSHDefault) {
                $effectiveLimit = (float) $roundLimit;
            }

            $fairTargetsByEmpId = $this->buildOverrideHardSlotFairTargetsByEmpId(
                (float) $plan,
                $resolvedBySlot,
                $assignmentSlots,
                $task
            );

            // SH override: fair split + SH cycles via fillOverrideHardSlotRemainingPlan (later-ava first on overlap).
            if ($effectiveLimit === null || $isSHDefault) {
                // -------------------------------------------------
                // 4️⃣ Collect ALL dates (AL-style)
                // -------------------------------------------------
                $dates = collect($availabilityMap)
                    ->flatMap(fn($av) => $av->pluck('date'))
                    ->unique()
                    ->sort()
                    ->values();

                // -------------------------------------------------
                // 5️⃣ Date-order assignment (no SH), availability-first with fair targets first.
                //     Pass 1 enforces even per-override targets, pass 2 spills any remainder.
                // -------------------------------------------------
                $remainingQuota = [];
                foreach ($fairTargetsByEmpId as $empId => $targetHours) {
                    $remainingQuota[$empId] = (float) $targetHours;
                }
                $remainingPlan = (float) $plan;
                $dailyAssigned = [];
                // Track cumulative hours — deficit-first so employees left behind get priority.
                $assignedSoFar = [];
                foreach ($assignmentSlots as $slot) {
                    $emp = $resolvedBySlot[$slot] ?? null;
                    if ($emp) {
                        $assignedSoFar[$emp->id] = 0.0;
                    }
                }

                foreach ($dates as $date) {
                    if ($remainingPlan <= 0.0001) {
                        break;
                    }

                    // Hybrid-like day flow:
                    // 1) consume soft quotas first, 2) immediately flex-spill same day.
                    $dayProgress = true;
                    while ($remainingPlan > 0.0001 && $dayProgress) {
                        $dayProgress = false;

                        // Pass A (soft-quota priority)
                        $orderedSlots = [];
                        foreach ($assignmentSlots as $slot) {
                            $emp = $resolvedBySlot[$slot] ?? null;
                            if (!$emp) {
                                continue;
                            }
                            $empId = $emp->id;
                            if ($this->getGlobalRemainingHoursOnDate($emp, $date) <= 0.0001) {
                                continue;
                            }
                            if ((float) ($remainingQuota[$empId] ?? 0.0) <= 0.0001) {
                                continue;
                            }
                            $orderedSlots[] = $slot;
                        }

                        $orderedSlots = $this->sortOverrideHardSlotSlotsByDeficit(
                            $orderedSlots,
                            $resolvedBySlot,
                            $assignedSoFar,
                            $fairTargetsByEmpId
                        );

                        foreach ($orderedSlots as $slot) {
                            if ($remainingPlan <= 0.0001) {
                                break;
                            }
                            $emp = $resolvedBySlot[$slot] ?? null;
                            if (!$emp) {
                                continue;
                            }
                            $empId = $emp->id;
                            $ava = $availabilityMap[$slot]->first(fn($a) => $a->date === $date);
                            if (!$ava) {
                                continue;
                            }
                            $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
                            if ($room <= 0.0001) {
                                continue;
                            }
                            $quota = (float) ($remainingQuota[$empId] ?? 0.0);
                            if ($quota <= 0.0001) {
                                continue;
                            }
                            $deficit = $this->getOverrideHardSlotDeficit($empId, $assignedSoFar, $fairTargetsByEmpId);
                            if ($deficit <= 0.0001) {
                                continue;
                            }
                            $assign = min($room, $remainingPlan, $quota, $deficit);
                            if ($assign <= 0.0001) {
                                continue;
                            }

                            $taskAssignmentDetails['assignments'][] = [
                                'employee' => $emp->first_name,
                                'date' => $date,
                                'hours' => $assign,
                            ];
                            $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;
                            $this->updateGlobalAvailability($emp, $date, $assign);
                            $ava->Total = max(0.0, (float) $ava->Total - $assign);
                            $remainingQuota[$empId] = $quota - $assign;
                            $assignedSoFar[$empId] = ($assignedSoFar[$empId] ?? 0.0) + $assign;
                            $remainingPlan -= $assign;
                            $dayProgress = true;
                        }

                        // Pass B (same-day flexible spill): do not wait until future dates.
                        $spillSlots = [];
                        foreach ($assignmentSlots as $slot) {
                            $emp = $resolvedBySlot[$slot] ?? null;
                            if (!$emp) {
                                continue;
                            }
                            if ($this->getGlobalRemainingHoursOnDate($emp, $date) > 0.0001) {
                                $spillSlots[] = $slot;
                            }
                        }

                        $dayDeficitsByEmpId = [];
                        foreach ($spillSlots as $slot) {
                            $emp = $resolvedBySlot[$slot] ?? null;
                            if (!$emp) {
                                continue;
                            }
                            $dayDeficitsByEmpId[$emp->id] = $this->getOverrideHardSlotDeficit(
                                $emp->id,
                                $assignedSoFar,
                                $fairTargetsByEmpId
                            );
                        }

                        $spillSlots = $this->sortOverrideHardSlotSlotsByDeficit(
                            $spillSlots,
                            $resolvedBySlot,
                            $assignedSoFar,
                            $fairTargetsByEmpId
                        );

                        foreach ($spillSlots as $slot) {
                            if ($remainingPlan <= 0.0001) {
                                break;
                            }
                            $emp = $resolvedBySlot[$slot] ?? null;
                            if (!$emp) {
                                continue;
                            }
                            $empId = $emp->id;
                            $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
                            if ($room <= 0.0001) {
                                continue;
                            }

                            $assign = $this->computeOverrideHardSlotSpillAssignAmount(
                                $empId,
                                $room,
                                $remainingPlan,
                                $assignedSoFar,
                                $fairTargetsByEmpId,
                                $dayDeficitsByEmpId
                            );
                            if ($assign <= 0.0001) {
                                continue;
                            }

                            $taskAssignmentDetails['assignments'][] = [
                                'employee' => $emp->first_name,
                                'date' => $date,
                                'hours' => $assign,
                            ];
                            $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;
                            $this->updateGlobalAvailability($emp, $date, $assign);
                            $ava = $availabilityMap[$slot]->first(fn($a) => $a->date === $date);
                            if ($ava) {
                                $ava->Total = max(0.0, (float) $ava->Total - $assign);
                            }
                            $assignedSoFar[$empId] = ($assignedSoFar[$empId] ?? 0.0) + $assign;
                            $remainingPlan -= $assign;
                            $dayProgress = true;
                        }
                    }
                }

                $this->redistributeOverrideHardSlotUnusedQuota(
                    $task,
                    $resolvedBySlot,
                    $assignmentSlots,
                    $remainingQuota,
                    $fairTargetsByEmpId,
                    $assignedSoFar
                );
            }

            $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName(
                $task,
                $allEmployees,
                collect($resolvedBySlot)->map(fn($e) => $e->first_name)->filter()->values()->all()
            );

            // Never stop with leftover plan: keep filling alternately until plan is exhausted
            // (or task window ends with zero usable capacity).
            $employeesForFill = collect($assignmentSlots)
                ->map(fn($slot) => $resolvedBySlot[$slot] ?? null)
                ->filter()
                ->values();
            $preferLaterAvailabilityFirst = $this->features['use_SH_limit']
                && !$isSHDefault
                && $effectiveLimit !== null;

            $this->fillOverrideHardSlotRemainingPlan(
                $task,
                $taskAssignmentDetails,
                $employeesForFill,
                (float) $plan,
                $effectiveLimit,
                $allEmployees,
                $fairTargetsByEmpId,
                $ddStartsByName,
                $preferLaterAvailabilityFirst
            );
            $this->exhaustOverrideHardSlotPlanToTarget(
                $task,
                $taskAssignmentDetails,
                $employeesForFill,
                (float) $plan,
                $allEmployees,
                365,
                $ddStartsByName
            );

            $lockedEmployeeNames = collect($resolvedBySlot)
                ->map(fn($e) => $e->first_name)
                ->values()
                ->toArray();

            // -------------------------------------------------
            // 5️⃣ SLOT-CORRECT FINAL OUTPUT
            // -------------------------------------------------
            $taskAssignmentDetails['primary_employee'] = null;
            $taskAssignmentDetails['secondary_employee'] = null;
            $taskAssignmentDetails['tertiary_employee'] = null;

            if (isset($resolvedBySlot[1])) {
                $taskAssignmentDetails['primary_employee'] = $resolvedBySlot[1]->first_name;
                $task['Algorithm_1'] = $resolvedBySlot[1]->first_name;
            }

            if (isset($resolvedBySlot[2])) {
                $taskAssignmentDetails['secondary_employee'] = $resolvedBySlot[2]->first_name;
                $task['Algorithm_2'] = $resolvedBySlot[2]->first_name;
            }

            if (isset($resolvedBySlot[3])) {
                $taskAssignmentDetails['tertiary_employee'] = $resolvedBySlot[3]->first_name;
                $task['Algorithm_3'] = $resolvedBySlot[3]->first_name;
            }

            // TS = number of override slots used (NOT compressed)
            $task['TS'] = count($resolvedBySlot);
            
            // AL = override count (override forcibly splits on number of overrides)
            $task['AL'] = $overrideCount;
            $taskAssignmentDetails['AL'] = $overrideCount;

            // assignments are already generated in date→slot order; keep that sequence
            $this->applyPostAssignmentHrsPerAndBufferAdjustments($task, $taskAssignmentDetails, $allEmployees);
            return $this->finalizeRoundedTaskOutput($task, $taskAssignmentDetails, $originalPlan, $allEmployees);
        }

        $overrideExists = !empty($overrideSlots);

        // =====================================================
        // ⭐ AL MODE — PURE DISTRIBUTION (NO ROUND / NO UNLOCK)
        // =====================================================
        if (
            isset($task['AL'])
            && is_numeric($task['AL'])
            && (int) $task['AL'] > 0
            && (!$overrideExists || $overrideFullyCoversAL)
        ) {

            // 🔥 RESET ALL STATE (CRITICAL)
            $totalAssigned = 0;
            $roundUsage = [];
            $empStarted = [];
            $unlockLog = [];

            // 1️⃣ Use already selected employees ONLY
            $employees = $overrideFullyCoversAL
                ? collect($resolvedBySlot)->values()   // ✅ Employee models
                : collect([$primary, $secondary, $tertiary])->filter()->values();

            $employees = $employees->take((int) $task['AL']);

            if ($employees->isEmpty()) {
                $this->applyPostAssignmentHrsPerAndBufferAdjustments($task, $taskAssignmentDetails, $allEmployees);
                return $this->finalizeRoundedTaskOutput($task, $taskAssignmentDetails, $originalPlan, $allEmployees);
            }

            $taskAssignmentDetails['mode'] = 'AL';
            $plan = $originalPlan;
            // Base share per employee (even; 70/30 disabled), then expand trainee scheduling quota.
            $targets = $this->buildPlanTargetsForEmployees((float) $plan, $employees, $task);
            $remainingQuota = [];
            $syncPairEven = ($employees->count() === 2) && $this->isDefaultTraineePairActivityTask($task);
            foreach ($employees as $idx => $emp) {
                $baseQuota = (float) $targets[$idx];
                $rate = $this->getEmployeePerformanceRate($emp, $task);
                $remainingQuota[$emp->id] = (!$syncPairEven && $rate > 0 && $rate < 1.0)
                    ? (float) ceil($baseQuota / $rate)
                    : $baseQuota;
            }
            $remainingPlan = array_sum($remainingQuota);

            // Operative before trainee so DD stagger matches mentoring (operative slot 0).
            $pairForDd = $this->resolveSynchronizedTwoPersonPair($employees, $task);
            if ($pairForDd) {
                $employees = collect([$pairForDd['operative'], $pairForDd['trainee']])->values();
            }

            // 2️⃣ Build availability per employee
            $availabilityMap = [];

            foreach ($employees as $emp) {
                $availabilityMap[$emp->id] = $this
                    ->filterAvailabilities($emp, $task)['availabilities']
                    ->map(function ($a) {
                        $a->date = $a->date ?? $a->Date;              // ✅ normalize
                        $a->Total = (float) $this->convertToHours($a->Total);
                        return $a;
                    })
                    ->filter(fn($a) => $a->Total > 0 && !empty($a->date))
                    ->values();
            }

            // 2.5️⃣ Apply DD (Delay Days) between employees (operative slot 0, then trainee).
            $dd = isset($task['DD']) && is_numeric($task['DD']) ? (int) $task['DD'] : 0;
            if ($dd > 0 && $employees->count() > 1) {
                $ddSlotNames = $this->resolveDdOrderedAssigneeNames(
                    $task,
                    $allEmployees,
                    $employees->pluck('first_name')->filter()->values()->all()
                );
                $ddPrimary = !empty($ddSlotNames)
                    ? $employees->first(fn($e) => $e->first_name === $ddSlotNames[0])
                    : $employees->first();
                $firstEmpId = $ddPrimary ? $ddPrimary->id : $employees->first()->id;
                $baseDate = ($availabilityMap[$firstEmpId] ?? collect())->first()->date ?? null;
                if ($baseDate) {
                    $empKeys = $employees->pluck('id')->toArray();
                    $this->applyDDToAvailabilityMap($availabilityMap, $empKeys, $baseDate, $dd);
                }
            }

            // 3️⃣ Date-based assignment
            $dates = collect($availabilityMap)
                ->flatMap(fn($av) => $av->pluck('date'))
                ->unique()
                ->sort()
                ->values();

            // Keep pure AL flexible: only apply synchronized pair constraints when AL is fully override-driven.
            $pair = $pairForDd ?? $this->resolveSynchronizedTwoPersonPair($employees, $task);
            $useSynchronizedPair = $overrideFullyCoversAL && $employees->count() === 2 && $pair !== null;
            if ($useSynchronizedPair) {
                $before = $remainingPlan;
                $traineeDates = $this->buildTraineeDatesForPairMode(
                    $pair['trainee'],
                    $pair['operative'],
                    $availabilityMap,
                    $dates
                );
                $traineeResult = $this->assignEmployeeByDateDirection(
                    $pair['trainee'],
                    $traineeDates,
                    $availabilityMap,
                    $remainingQuota,
                    $remainingPlan,
                    $taskAssignmentDetails,
                    false
                );
                $traineeEndDate = $traineeResult['last_date'] ?? null;
                $operativeResult = $this->assignEmployeeByDateDirection(
                    $pair['operative'],
                    $dates,
                    $availabilityMap,
                    $remainingQuota,
                    $remainingPlan,
                    $taskAssignmentDetails,
                    true,
                    $traineeEndDate
                );
                if (($operativeResult['assigned'] ?? 0.0) > 0 && !empty($traineeEndDate)) {
                    $taskAssignmentDetails['end_dates'][$pair['operative']->first_name] = $traineeEndDate;
                }
                $totalAssigned += max(0.0, $before - $remainingPlan);
            } else {
                foreach ($dates as $date) {
                    foreach ($employees as $emp) {
                        $empId = $emp->id;
                        while ($remainingPlan > 0) {
                            $quota = (float) ($remainingQuota[$empId] ?? 0);
                            if ($quota <= 0.0001) {
                                break;
                            }

                            $ava = $availabilityMap[$empId]
                                ->first(fn($a) => $a->date === $date);

                            if (!$ava) {
                                break;
                            }

                            $available = (float) $ava->Total; // ✅ no double convert
                            if ($available <= 0.0001) {
                                break;
                            }

                            $assign = min($available, $remainingPlan, $quota);
                            if ($assign <= 0.0001) {
                                break;
                            }

                            $taskAssignmentDetails['assignments'][] = [
                                'employee' => $emp->first_name,
                                'date' => $date,
                                'hours' => $assign,
                            ];

                            $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;

                            $ava->Total -= $assign;
                            $remainingPlan -= $assign;
                            $totalAssigned += $assign;
                            $remainingQuota[$empId] = $quota - $assign;
                        }
                    }
                }
            }

            // Option A + E: gap assist, gap fill, compress/redistribute (AL mode).
            $employeeEntries = $employees->map(fn($emp) => [
                'id' => (int) $emp->id,
                'model' => $emp,
            ])->values();

            foreach ($employeeEntries as $entry) {
                $eid = (int) $entry['id'];
                if (!isset($roundUsage[$eid][$taskId])) {
                    $roundUsage[$eid][$taskId] = 0;
                }
            }

            $employeeEntries = $this->expandEmployeesToAllocationLimit(
                $employeeEntries,
                $task,
                $taskAssignmentDetails,
                $roundUsage,
                $taskId,
                $finalCandidates,
                $allEmployees
            );

            $this->syncAlRemainingQuotaForRoster(
                $employeeEntries,
                $remainingQuota,
                (float) $plan,
                $task
            );

            $this->applyAlModeGapAssistAndRedistribute(
                $task,
                $taskAssignmentDetails,
                $employeeEntries,
                $remainingQuota,
                $remainingPlan,
                $totalAssigned,
                $roundUsage,
                $taskId,
                $dd,
                (float) $plan,
                $allEmployees,
                $finalCandidates
            );

            $employees = $employeeEntries->pluck('model')->filter()->values();

            // 4️⃣ Final names (fixed order)
            $names = $employees->pluck('first_name')->values();

            $taskAssignmentDetails['primary_employee'] = $names[0] ?? null;
            $taskAssignmentDetails['secondary_employee'] = $names[1] ?? null;
            $taskAssignmentDetails['tertiary_employee'] = $names[2] ?? null;

            $task['Algorithm_1'] = $taskAssignmentDetails['primary_employee'];
            $task['Algorithm_2'] = $taskAssignmentDetails['secondary_employee'];
            $task['Algorithm_3'] = $taskAssignmentDetails['tertiary_employee'];

            $task['TS'] = $names->count();

            $this->applyPostAssignmentHrsPerAndBufferAdjustments($task, $taskAssignmentDetails, $allEmployees);
            return $this->finalizeRoundedTaskOutput($task, $taskAssignmentDetails, $originalPlan, $allEmployees);
        }
        // =====================================================






        $missingSlots = [
            1 => empty($taskAssignmentDetails['primary_employee']),
            2 => empty($taskAssignmentDetails['secondary_employee']),
            3 => empty($taskAssignmentDetails['tertiary_employee']),
        ];

        $hasMissingSlots = collect($missingSlots)->contains(true);

        $employees = collect([
            ['id' => $pId, 'model' => $primary],
            ['id' => $sId, 'model' => $secondary],
            ['id' => $tId, 'model' => $tertiary],
        ])
            ->filter(fn($e) => $e['model'])
            ->values()
            ->take($this->resolveTaskAllocationLimit($task));


        $employees = $this->expandEmployeesToAllocationLimit(
            $employees,
            $task,
            $taskAssignmentDetails,
            $roundUsage,
            $taskId,
            $finalCandidates,
            $allEmployees
        );

        foreach ($employees as $e) {
            if (!isset($roundUsage[$e['id']][$taskId])) {
                $roundUsage[$e['id']][$taskId] = 0;
            }
        }

        // PS.01.12: workload target can exceed the stored Plan when trainees are included — schedule to adjusted total.
        if ($this->features['use_performance_subbranch']) {
            $selectedModels = $employees->pluck('model')->filter()->values();
            if ($selectedModels->isNotEmpty()) {
                $taskForAdj = $task;
                $taskForAdj['Plan'] = $originalPlan;
                $taskForAdj['TaskName'] = $task['TaskName'] ?? ($taskAssignmentDetails['task_name'] ?? '');
                $adjustedTarget = $this->adjustTaskPlanByPerformance($taskForAdj, $selectedModels);
                if ($adjustedTarget > $plan + 0.0001) {
                    $plan = $adjustedTarget;
                    $task['Plan'] = $plan;
                    $taskAssignmentDetails['performance_subbranch_active'] = true;
                }
            }
        }

        $finalSlotOrder = [
            1 => $taskAssignmentDetails['primary_employee'],
            2 => $taskAssignmentDetails['secondary_employee'],
            3 => $taskAssignmentDetails['tertiary_employee'],
        ];


        // =====================================================

        // -----------------------------
        // Unlock state
        // -----------------------------
        $empStarted = [];

        // DD (Delay Days) — stagger starts (operative slot 0, trainee +DD, tertiary +2×DD).
        $dd = isset($task['DD']) && is_numeric($task['DD']) ? (int) $task['DD'] : 0;
        $ddDelayedStarts = []; // employee collection index => earliest allowed start (Y-m-d)
        if ($dd > 0 && $allEmployees) {
            $ddSlotNames = array_values(array_filter([
                $taskAssignmentDetails['primary_employee'] ?? ($primary->first_name ?? null),
                $taskAssignmentDetails['secondary_employee'] ?? ($secondary->first_name ?? null),
                $taskAssignmentDetails['tertiary_employee'] ?? ($tertiary->first_name ?? null),
            ]));
            $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $ddSlotNames);
            foreach ($employees as $idx => $emp) {
                $name = $emp['model']->first_name ?? null;
                if ($name && isset($ddStartsByName[$name])) {
                    $ddDelayedStarts[$idx] = $ddStartsByName[$name];
                }
            }
        }

        $maxIterations = 10000;
        $iterations = 0;

        $forceFinishTask = false;
        
        // Track current working date (starts from task start date)
        $currentWorkingDate = strtotime($task['Doc_Supply']);
        
        // Helper function to update current working date after assignment
        $updateCurrentDate = function() use (&$currentWorkingDate, &$taskAssignmentDetails) {
            if (!empty($taskAssignmentDetails['assignments'])) {
                $lastAssignment = end($taskAssignmentDetails['assignments']);
                if ($lastAssignment && isset($lastAssignment['date'])) {
                    $assignmentDate = strtotime($lastAssignment['date']);
                    if ($assignmentDate > $currentWorkingDate) {
                        $currentWorkingDate = $assignmentDate;
                    }
                }
            }
        };

        while ($totalAssigned < $plan && $iterations < $maxIterations) {

            $cycleAssigned = 0;
            $remainingLeft = $plan - $totalAssigned;
            
            // Reset flags for each cycle
            unset($taskAssignmentDetails['_catchup_done']);
            unset($taskAssignmentDetails['_two_emp_processed']);
            
            // 🆕 GAP-AWARE EMPLOYEE SELECTION
            // Find next available date for each active employee from current working date
            $empNextDates = [];
            $empGaps = [];
            
            foreach ($employees as $emp) {
                if (empty($empStarted[$emp['id']]) || !$emp['model']) continue;
                
                $empAvail = $this->filterAvailabilities($emp['model'], $task)['availabilities']
                    ->filter(fn($a) => (float) $a->Total > 0)
                    ->sortBy(fn($a) => strtotime($a->Date ?? $a->date ?? ''))
                    ->values();
                
                if ($empAvail->isEmpty()) {
                    $empNextDates[$emp['id']] = null;
                    $empGaps[$emp['id']] = PHP_INT_MAX; // No availability = infinite gap
                    continue;
                }
                
                // Find next available date (earliest feasible when optimizing for shortest span).
                $searchFromTs = $currentWorkingDate;
                if (!empty($this->features['optimize_shortest_task_span'])) {
                    $searchFromTs = $this->resolveEarliestSchedulingAnchorTs(
                        $task,
                        $taskAssignmentDetails,
                        $emp,
                        $employees,
                        $ddDelayedStarts,
                        $currentWorkingDate
                    );
                }
                $nextAvail = $empAvail->first(function ($a) use ($searchFromTs) {
                    $date = strtotime($a->Date ?? $a->date ?? '');

                    return $date !== false && $date >= $searchFromTs;
                });
                
                if ($nextAvail) {
                    $nextDate = strtotime($nextAvail->Date ?? $nextAvail->date ?? '');
                    $empNextDates[$emp['id']] = $nextDate;
                    $empGaps[$emp['id']] = ($nextDate - $searchFromTs) / 86400;
                } else {
                    $empNextDates[$emp['id']] = null;
                    $empGaps[$emp['id']] = PHP_INT_MAX;
                }
            }
            
            // Determine which employees to skip (those with gaps > 3 days)
            $skipEmployees = [];
            $availableEmployees = [];
            
            foreach ($empGaps as $empId => $gapDays) {
                if ($gapDays > 3) {
                    $skipEmployees[] = $empId;
                } else {
                    $availableEmployees[] = $empId;
                }
            }
            
            if (!empty($this->features['optimize_shortest_task_span'])) {
                $startedNext = [];
                foreach ($employees as $emp) {
                    if (empty($empStarted[$emp['id'] ?? null])) {
                        continue;
                    }
                    $next = $empNextDates[$emp['id']] ?? null;
                    if ($next !== null) {
                        $startedNext[] = $next;
                    }
                }
                if ($startedNext !== []) {
                    $earliestNext = min($startedNext);
                    if ($earliestNext < $currentWorkingDate) {
                        $currentWorkingDate = $earliestNext;
                    }
                }
            }

            // If all employees have gaps, choose the one with smallest gap
            if (empty($availableEmployees) && !empty($empGaps)) {
                $minGap = min($empGaps);
                $minGapEmpId = array_search($minGap, $empGaps);
                if ($minGapEmpId !== false) {
                    $availableEmployees = [$minGapEmpId];
                    $skipEmployees = array_filter($empGaps, fn($gap, $id) => $id != $minGapEmpId, ARRAY_FILTER_USE_BOTH);
                    $skipEmployees = array_keys($skipEmployees);
                    
                    $minGapEmp = collect($employees)->first(fn($e) => $e['id'] == $minGapEmpId);
                    if ($minGapEmp) {
                        $logProcess('SMALLEST_GAP_SELECTED', [
                            'employee' => $minGapEmp['model']->first_name,
                            'gap_days' => round($minGap, 1),
                            'current_date' => date('Y-m-d', $currentWorkingDate),
                            'next_date' => $empNextDates[$minGapEmpId] ? date('Y-m-d', $empNextDates[$minGapEmpId]) : null,
                        ]);
                    }
                }
            }
            
            // Log skipped employees + gap assist unlock (ignore round/HBS; tertiary only if #2 deadends)
            if (!empty($skipEmployees)) {
                foreach ($skipEmployees as $skipId) {
                    $skipEmp = collect($employees)->first(fn($e) => $e['id'] == $skipId);
                    if ($skipEmp) {
                        $logProcess('EMPLOYEE_SKIPPED_GAP', [
                            'employee' => $skipEmp['model']->first_name,
                            'gap_days' => round($empGaps[$skipId], 1),
                            'current_date' => date('Y-m-d', $currentWorkingDate),
                            'next_date' => $empNextDates[$skipId] ? date('Y-m-d', $empNextDates[$skipId]) : null,
                        ]);
                        $skipIndex = $employees->search(fn($e) => $e['id'] == $skipId);
                        $gapEndTs = $empNextDates[$skipId] ?? null;
                        if ($skipIndex !== false && $gapEndTs) {
                            $gapStartTs = (int) $currentWorkingDate;
                            $lastAssignedDate = null;
                            foreach (array_reverse($taskAssignmentDetails['assignments'] ?? []) as $as) {
                                if (($as['employee'] ?? null) === $skipEmp['model']->first_name) {
                                    $lastAssignedDate = $as['date'] ?? null;
                                    break;
                                }
                            }
                            if ($lastAssignedDate) {
                                $lastTs = strtotime((string) $lastAssignedDate);
                                if ($lastTs !== false) {
                                    $gapStartTs = $lastTs + 86400;
                                }
                            }
                            $this->handleSchedulingGapAssist(
                                $employees,
                                $empStarted,
                                (int) $skipIndex,
                                $skipEmp['model']->first_name,
                                (int) $skipId,
                                $gapStartTs,
                                (int) $gapEndTs,
                                $task,
                                $taskAssignmentDetails,
                                $roundUsage,
                                $totalAssigned,
                                $taskId,
                                $dd,
                                $ddDelayedStarts,
                                $allEmployees,
                                $finalCandidates,
                                $logProcess,
                                $empMinHours,
                                $gapAssistRemainingQuota,
                                $assignedHoursTracker,
                                $spentHrs,
                                $roundLimit
                            );
                        }
                    }
                }
            }

            foreach ($employees as $index => $emp) {
                $remainingLeft = $plan - $totalAssigned;
                
                // 🆕 Skip employees with gaps (unless they're the only available one)
                if (!empty($skipEmployees) && in_array($emp['id'], $skipEmployees) && !empty($availableEmployees)) {
                    continue; // Skip this employee, use others
                }

                // 🚫 HARD STOP: never allow next employee if remainder < 16
                if ($remainingLeft > 0 && $remainingLeft < 16 && $index > 0) {

                    $prevEmp = $employees[$index - 1];
                    $prevId = $prevEmp['id'];
                    $prevModel = $prevEmp['model'];

                    if (!empty($empStarted[$prevId])) {

                        $prevAvail = $this->filterAvailabilities($prevModel, $task)['availabilities']
                            ->filter(fn($a) => (float) $a->Total > 0)
                            ->values();

                        if ($prevAvail->isNotEmpty()) {

                            $assignedNow = (float) $this->assignHoursForOneEmployee(
                                $prevModel,
                                $prevAvail,
                                $task,
                                $roundUsage,
                                $prevId,
                                $taskId,
                                $totalAssigned,
                                $assignedHoursTracker,
                                $spentHrs,
                                $taskAssignmentDetails,
                                $remainingLeft,
                                null,
                                $roundLimit
                            );

                            if ($assignedNow > 0) {
                                $totalAssigned += $assignedNow;
                                $roundUsage[$prevId][$taskId] += $assignedNow;
                            }
                        }
                    }

                    break; // ⛔ EXIT FOREACH — Todor NEVER runs
                }

                $empId = $emp['id'];
                $model = $emp['model'];
                if (!$model)
                    continue;

                $currentSlot = $index + 1;

                // ✅ enforce slot order
                if (
                    isset($finalSlotOrder[$currentSlot])
                    && $model->first_name !== $finalSlotOrder[$currentSlot]
                ) {
                    continue;
                }

                // -----------------------------
                // UNLOCK RULES (with DD support)
                // -----------------------------
                if ($index === 0 && empty($empStarted[$empId])) {
                    $empStarted[$empId] = true;
                    $logProcess('EMPLOYEE_UNLOCKED', [
                        'employee' => $model->first_name,
                        'role' => 'primary',
                        'index' => 0,
                        'total_assigned' => $totalAssigned,
                    ]);
                }

                if ($index === 1 && empty($empStarted[$empId])) {
                    $roundMet = $totalAssigned >= $roundLimit;
                    $ddMet = true;
                    if ($dd > 0 && isset($ddDelayedStarts[1])) {
                        $ddMet = $currentWorkingDate >= strtotime($ddDelayedStarts[1]);
                    }
                    if ($roundMet && $ddMet) {
                        $empStarted[$empId] = true;
                        $logProcess('EMPLOYEE_UNLOCKED', [
                            'employee' => $model->first_name,
                            'role' => 'secondary',
                            'index' => 1,
                            'total_assigned' => $totalAssigned,
                            'threshold' => $roundLimit,
                            'dd_delayed_start' => $ddDelayedStarts[1] ?? null,
                        ]);
                    }
                }

                if ($index === 2 && empty($empStarted[$empId])) {
                    $roundMet = $totalAssigned >= ($roundLimit * 2);
                    $ddMet = true;
                    if ($dd > 0 && isset($ddDelayedStarts[2])) {
                        $ddMet = $currentWorkingDate >= strtotime($ddDelayedStarts[2]);
                    }
                    if ($roundMet && $remainingLeft >= 16 && $ddMet) {
                        $empStarted[$empId] = true;
                        $logProcess('EMPLOYEE_UNLOCKED', [
                            'employee' => $model->first_name,
                            'role' => 'tertiary',
                            'index' => 2,
                            'total_assigned' => $totalAssigned,
                            'threshold' => $roundLimit * 2,
                            'remaining' => $remainingLeft,
                            'dd_delayed_start' => $ddDelayedStarts[2] ?? null,
                        ]);
                        continue; // restart loop naturally
                    } else {
                        continue; // 🚫 never unlock tertiary if conditions not met
                    }
                }

                if (empty($empStarted[$empId])) {
                    continue;
                }

                // -----------------------------
                // 🔁 SMALL REMAINDER REDIRECT
                // -----------------------------
                if ($remainingLeft > 0 && $remainingLeft < 16 && $index > 0) {

                    $prevEmp = $employees[$index - 1];
                    $prevId = $prevEmp['id'];
                    $prevModel = $prevEmp['model'];

                    if (!empty($empStarted[$prevId])) {

                        $prevAvail = $this->filterAvailabilities($prevModel, $task)['availabilities']
                            ->filter(fn($a) => (float) $a->Total > 0)
                            ->values();

                        if ($prevAvail->isNotEmpty()) {

                            $assignedNow = (float) $this->assignHoursForOneEmployee(
                                $prevModel,
                                $prevAvail,
                                $task,
                                $roundUsage,
                                $prevId,
                                $taskId,
                                $totalAssigned,
                                $assignedHoursTracker,
                                $spentHrs,
                                $taskAssignmentDetails,
                                $remainingLeft,
                                null,
                                $roundLimit
                            );

                            if ($assignedNow > 0) {
                                $totalAssigned += $assignedNow;
                                $roundUsage[$prevId][$taskId] += $assignedNow;
                            }
                        }

                        $forceFinishTask = true;
                        break; // exit FOREACH safely
                    }
                }




                // -----------------------------
                // ASSIGN HOURS (NORMAL)
                // -----------------------------
                
                // 🧩 Collect all currently active employees
                $activeEmps = collect($employees)
                    ->filter(fn($e) => isset($empStarted[$e['id']]))
                    ->values();

                $remainingPlan = $plan - $totalAssigned;
                if ($remainingPlan <= 0)
                    break;

                // 🔹 CASE 1: Only one active employee (continuous work)
                if ($activeEmps->count() === 1) {
                    $avail = $this->filterAvailabilities($model, $task)['availabilities']
                        ->filter(fn($a) => (float) $a->Total > 0)
                        ->values();

                    if ($avail->isEmpty())
                        continue;

                    // 🛑 GAP CONTROL: Check if this employee has a gap, and if others can work in it
                    $lastAssignedDate = null;
                    foreach (array_reverse($taskAssignmentDetails['assignments']) as $as) {
                        if (($as['employee'] ?? null) === $model->first_name) {
                            $lastAssignedDate = $as['date'] ?? null;
                            break;
                        }
                    }
                    
                    $shouldPauseForGap = false;
                    if ($lastAssignedDate) {
                        $lastDate = strtotime($lastAssignedDate);
                        $nextDate = strtotime($avail->first()->Date ?? $avail->first()->date ?? '');
                        $gapDays = ($nextDate - $lastDate) / 86400;
                        
                        // If gap > 3 days: rollback forward rows, unlock assistant(s) ignoring round/HBS
                        if ($gapDays > self::SCHEDULING_GAP_DEADEND_DAYS) {
                            $gapStart = $lastDate + 86400; // Next day after last assignment
                            $gapEnd = $nextDate;

                            $blockedIndex = $employees->search(fn($e) => $e['id'] === $empId);
                            if ($blockedIndex !== false) {
                                if ($this->handleSchedulingGapAssist(
                                    $employees,
                                    $empStarted,
                                    (int) $blockedIndex,
                                    $model->first_name,
                                    (int) $empId,
                                    $gapStart,
                                    $gapEnd,
                                    $task,
                                    $taskAssignmentDetails,
                                    $roundUsage,
                                    $totalAssigned,
                                    $taskId,
                                    $dd,
                                    $ddDelayedStarts,
                                    $allEmployees,
                                    $finalCandidates,
                                    $logProcess,
                                    $empMinHours,
                                    $gapAssistRemainingQuota,
                                    $assignedHoursTracker,
                                    $spentHrs,
                                    $roundLimit
                                )) {
                                    $shouldPauseForGap = true;
                                }
                            }
                        }
                    }
                    
                    // If we paused for gap, skip this employee's assignment this cycle
                    if ($shouldPauseForGap) {
                        continue;
                    }

                    $alreadyUsed = (float) ($roundUsage[$empId][$taskId] ?? 0);
                    $remainingCap = $roundLimit - $alreadyUsed;
                    if ($remainingCap <= 0) $remainingCap = $remainingPlan;

                    $assignable = min($remainingPlan, $remainingCap);

                    $assignedNow = (float) $this->assignHoursForOneEmployee(
                        $model,
                        $avail,
                        $task,
                        $roundUsage,
                        $empId,
                        $taskId,
                        $totalAssigned,
                        $assignedHoursTracker,
                        $spentHrs,
                        $taskAssignmentDetails,
                        $assignable,
                    null,
                    $roundLimit
                    );

                    if ($assignedNow > 0) {
                        $totalAssigned += $assignedNow;
                        $roundUsage[$empId][$taskId] += $assignedNow;
                        $cycleAssigned += $assignedNow;

                        $empMinHours[$empId] = ($empMinHours[$empId] ?? 0) + $assignedNow;

                        $dates = array_column(
                            array_filter(
                                $taskAssignmentDetails['assignments'],
                                fn($r) => $r['employee'] === $model->first_name
                            ),
                            'date'
                        );

                        $empMinDays[$empId] = count(array_unique($dates));
                        
                        // Update current working date
                        $updateCurrentDate();
                    }
                }
                // 🔹 CASE 2: Two employees active — handle catch-up + parallel assignment
                elseif ($activeEmps->count() === 2 && $index === 1 && !isset($taskAssignmentDetails['_two_emp_processed'])) {
                    [$first, $second] = $activeEmps->toArray();
                    
                    $logProcess('PHASE_TWO_EMPLOYEES', [
                        'first' => $first['model']->first_name,
                        'second' => $second['model']->first_name,
                        'remaining_plan' => $remainingPlan,
                    ]);

                    $firstAvail = $this->filterAvailabilities($first['model'], $task)['availabilities']
                        ->filter(fn($a) => (float) $a->Total > 0)->values();
                    $secondAvail = $this->filterAvailabilities($second['model'], $task)['availabilities']
                        ->filter(fn($a) => (float) $a->Total > 0)->values();

                    // 🕓 Find last assigned date for first
                    $firstLastDate = null;
                    foreach (array_reverse($taskAssignmentDetails['assignments']) as $as) {
                        if (($as['employee'] ?? null) === $first['model']->first_name) {
                            $firstLastDate = $as['date'] ?? null;
                            break;
                        }
                    }
                    if (!$firstLastDate && $firstAvail->isNotEmpty()) {
                        $firstLastDate = $firstAvail->first()->Date ?? $firstAvail->first()->date ?? null;
                    }
                    if (!$firstLastDate) continue;

                    // Find next working date after last assigned date
                    $primaryStart = null;
                    if ($firstLastDate) {
                        $firstLast = strtotime($firstLastDate);
                        $primaryStart = strtotime('+1 day', $firstLast);
                        while (in_array(date('N', $primaryStart), [6, 7])) {
                            $primaryStart = strtotime('+1 day', $primaryStart);
                        }
                    }

                    // ⚙️ Catch-up phase for secondary (only on first iteration of this cycle)
                    if ($index === 1 && !isset($taskAssignmentDetails['_catchup_done'])) {
                        // DD: secondary can only work from their delayed start date
                        $secondaryDDStart = ($dd > 0 && isset($ddDelayedStarts[1])) ? strtotime($ddDelayedStarts[1]) : 0;
                        $catchUpDays = $secondAvail->filter(
                            fn($a) =>
                            strtotime($a->Date ?? $a->date ?? '') < $primaryStart
                            && strtotime($a->Date ?? $a->date ?? '') >= $secondaryDDStart
                        )->values();

                        foreach ($catchUpDays as $slot) {
                            $remainingPlan = $plan - $totalAssigned;
                            if ($remainingPlan <= 0) break;

                            $assignable = min((float) $slot->Total, 8, $remainingPlan);
                            $assignedNow = (float) $this->assignHoursForOneEmployee(
                                $second['model'],
                                collect([$slot]),
                                $task,
                                $roundUsage,
                                $second['id'],
                                $taskId,
                                $totalAssigned,
                                $assignedHoursTracker,
                                $spentHrs,
                                $taskAssignmentDetails,
                                $assignable,
                            null,
                            $roundLimit
                            );

                            if ($assignedNow > 0) {
                                $totalAssigned += $assignedNow;
                                $roundUsage[$second['id']][$taskId] += $assignedNow;
                                $cycleAssigned += $assignedNow;

                                $empMinHours[$second['id']] = ($empMinHours[$second['id']] ?? 0) + $assignedNow;

                                $dates = array_column(
                                    array_filter(
                                        $taskAssignmentDetails['assignments'],
                                        fn($r) => $r['employee'] === $second['model']->first_name
                                    ),
                                    'date'
                                );
                                $empMinDays[$second['id']] = count(array_unique($dates));
                            }
                        }
                        $taskAssignmentDetails['_catchup_done'] = true;
                    }

                    // 🔍 Check if we should unlock tertiary instead of continuing parallel work
                    // This prevents first employee from jumping to far future dates
                    $remainingPlan = $plan - $totalAssigned;
                    
                    // DD check for tertiary unlock
                    $tertiaryDDMet = true;
                    if ($dd > 0 && isset($ddDelayedStarts[2])) {
                        $tertiaryDDMet = $currentWorkingDate >= strtotime($ddDelayedStarts[2]);
                    }
                    
                    if ($remainingPlan >= 16 && $totalAssigned >= ($roundLimit * 2) && $tertiaryDDMet) {
                        // Check if tertiary exists and isn't started yet
                        $tertiaryEmp = $employees->get(2);
                        if ($tertiaryEmp && $tertiaryEmp['model'] && empty($empStarted[$tertiaryEmp['id']])) {
                            // Check if first employee has availability gaps (future dates far away)
                            $firstAlignedDates = $firstAvail->filter(
                                fn($a) => strtotime($a->Date ?? $a->date ?? '') >= $primaryStart
                            )->map(fn($a) => strtotime($a->Date ?? $a->date ?? ''))->sort()->values();
                            
                            if ($firstAlignedDates->isNotEmpty()) {
                                $firstNextDate = $firstAlignedDates->first();
                                $daysUntilNext = ($firstNextDate - $primaryStart) / 86400;
                                
                                // If there's a gap of more than 7 calendar days (including weekends),
                                // unlock tertiary instead. This prevents first employee from jumping 
                                // to January when we can use tertiary now
                                if ($daysUntilNext > 7) {
                                    $empStarted[$tertiaryEmp['id']] = true;
                                    $taskAssignmentDetails['_two_emp_processed'] = true;
                                    break; // Break to let tertiary be processed in next iteration
                                }
                            }
                            
                            // Also unlock if remaining plan is very substantial (more than 2.5 round limits)
                            // This ensures we use tertiary when there's a lot of work left
                            if ($remainingPlan > ($roundLimit * 2.5)) {
                                $empStarted[$tertiaryEmp['id']] = true;
                                $taskAssignmentDetails['_two_emp_processed'] = true;
                                break; // Break to let tertiary be processed in next iteration
                            }
                        }
                    }

                    // ⚙️ Parallel work — split remaining hours evenly day-by-day
                    $firstAligned = $firstAvail->filter(
                        fn($a) =>
                        strtotime($a->Date ?? $a->date ?? '') >= $primaryStart
                    )->values();
                    // DD: secondary aligned dates also respect their delayed start
                    $secondAlignedStart = $primaryStart;
                    if ($dd > 0 && isset($ddDelayedStarts[1])) {
                        $secondAlignedStart = max($primaryStart, strtotime($ddDelayedStarts[1]));
                    }
                    $secondAligned = $secondAvail->filter(
                        fn($a) =>
                        strtotime($a->Date ?? $a->date ?? '') >= $secondAlignedStart
                    )->values();

                    // 🛑 GAP CONTROL: Check if first employee has a gap, pause them and let others work
                    $firstNextDate = $firstAligned->first();
                    $gapStart = $primaryStart;
                    $gapEnd = $firstNextDate ? strtotime($firstNextDate->Date ?? $firstNextDate->date) : null;
                    
                    // Store first employee's resume date for later parallel work
                    $firstResumeDate = $gapEnd;
                    
                    $shouldPauseFirst = false;
                    if ($gapEnd && ($gapEnd - $gapStart) > self::SCHEDULING_GAP_DEADEND_DAYS * 86400) {
                        $firstIndex = $employees->search(fn($e) => $e['id'] === $first['id']);
                        if ($firstIndex !== false) {
                            $this->handleSchedulingGapAssist(
                                $employees,
                                $empStarted,
                                (int) $firstIndex,
                                $first['model']->first_name,
                                (int) $first['id'],
                                $gapStart,
                                $gapEnd,
                                $task,
                                $taskAssignmentDetails,
                                $roundUsage,
                                $totalAssigned,
                                $taskId,
                                $dd,
                                $ddDelayedStarts,
                                $allEmployees,
                                $finalCandidates,
                                $logProcess,
                                $empMinHours,
                                $gapAssistRemainingQuota,
                                $assignedHoursTracker,
                                $spentHrs,
                                $roundLimit,
                                false
                            );
                        }

                        // Check secondary for gap availability
                        $secondGapAvail = $secondAvail->filter(function($a) use ($gapStart, $gapEnd) {
                            $date = strtotime($a->Date ?? $a->date ?? '');
                            return $date >= $gapStart && $date < $gapEnd;
                        })->sortBy(function($a) {
                            return strtotime($a->Date ?? $a->date ?? '');
                        })->values();
                        
                        // Tertiary only when secondary cannot work in the gap (ignore round/HBS unlock)
                        $tertiaryGapAvail = collect();
                        $tertiaryEmp = $employees->get(2);
                        if ($tertiaryEmp && $tertiaryEmp['model']) {
                            $gapTertiaryDDMet = true;
                            if ($dd > 0 && isset($ddDelayedStarts[2])) {
                                $gapTertiaryDDMet = $currentWorkingDate >= strtotime($ddDelayedStarts[2]);
                            }
                            if ($secondGapAvail->isEmpty() && empty($empStarted[$tertiaryEmp['id']]) && $gapTertiaryDDMet) {
                                $empStarted[$tertiaryEmp['id']] = true;
                                $taskAssignmentDetails['_gap_assist_active'] = true;
                            }
                            
                            if (!empty($empStarted[$tertiaryEmp['id']])) {
                                $tertiaryAvail = $this->filterAvailabilities($tertiaryEmp['model'], $task)['availabilities']
                                    ->filter(fn($a) => (float) $a->Total > 0)->values();
                                $tertiaryGapAvail = $tertiaryAvail->filter(function($a) use ($gapStart, $gapEnd) {
                                    $date = strtotime($a->Date ?? $a->date ?? '');
                                    return $date >= $gapStart && $date < $gapEnd;
                                })->sortBy(function($a) {
                                    return strtotime($a->Date ?? $a->date ?? '');
                                })->values();
                            }
                        }
                        
                        // If others have gap availability, pause first employee completely
                        if ($secondGapAvail->isNotEmpty() || $tertiaryGapAvail->isNotEmpty()) {
                            $shouldPauseFirst = true;
                            
                            $logProcess('FIRST_EMPLOYEE_PAUSED', [
                                'first_employee' => $first['model']->first_name,
                                'reason' => 'gap_detected',
                                'secondary_gap_days' => $secondGapAvail->count(),
                                'tertiary_gap_days' => $tertiaryGapAvail->count(),
                                'resume_date' => date('Y-m-d', $firstResumeDate),
                            ]);
                            
                            // Phase 1: Let secondary work alone in the gap until tertiary starts
                            $currentDate = $gapStart;
                            $tertiaryStarted = !empty($empStarted[$tertiaryEmp['id'] ?? null]);
                            
                            while ($currentDate < $gapEnd && $remainingPlan > 0) {
                                $remainingPlan = $plan - $totalAssigned;
                                if ($remainingPlan <= 0) break;
                                
                                // Check if we should unlock tertiary (with DD support)
                                $loopTertiaryDDMet = true;
                                if ($dd > 0 && isset($ddDelayedStarts[2])) {
                                    $loopTertiaryDDMet = $currentDate >= strtotime($ddDelayedStarts[2]);
                                }
                                if (!$tertiaryStarted && $secondGapAvail->isEmpty() && $loopTertiaryDDMet) {
                                    if ($tertiaryEmp && $tertiaryEmp['model']) {
                                        $empStarted[$tertiaryEmp['id']] = true;
                                        $tertiaryStarted = true;
                                        $taskAssignmentDetails['_gap_assist_active'] = true;
                                        
                                        $logProcess('TERTIARY_UNLOCKED_IN_GAP', [
                                            'employee' => $tertiaryEmp['model']->first_name,
                                            'total_assigned' => $totalAssigned,
                                            'current_date' => date('Y-m-d', $currentDate),
                                            'reason' => 'secondary_deadend_in_gap',
                                        ]);
                                        // Refresh tertiary gap availability
                                        $tertiaryAvail = $this->filterAvailabilities($tertiaryEmp['model'], $task)['availabilities']
                                            ->filter(fn($a) => (float) $a->Total > 0)->values();
                                        $tertiaryGapAvail = $tertiaryAvail->filter(function($a) use ($gapStart, $gapEnd) {
                                            $date = strtotime($a->Date ?? $a->date ?? '');
                                            return $date >= $gapStart && $date < $gapEnd;
                                        })->sortBy(function($a) {
                                            return strtotime($a->Date ?? $a->date ?? '');
                                        })->values();
                                    }
                                }
                                
                                // Phase 2: If tertiary is active, work together day-by-day
                                if ($tertiaryStarted && $tertiaryGapAvail->isNotEmpty()) {
                                    if (!isset($taskAssignmentDetails['_phase2_logged'])) {
                                        $logProcess('PHASE_GAP_WORK_TWO_EMPLOYEES', [
                                            'secondary' => $second['model']->first_name,
                                            'tertiary' => $tertiaryEmp['model']->first_name,
                                            'start_date' => date('Y-m-d', $currentDate),
                                        ]);
                                        $taskAssignmentDetails['_phase2_logged'] = true;
                                    }
                                    // Find slots for current date
                                    $secondSlot = $secondGapAvail->first(function($a) use ($currentDate) {
                                        $date = strtotime($a->Date ?? $a->date ?? '');
                                        return $date >= $currentDate && $date < $currentDate + 86400;
                                    });
                                    $tertiarySlot = $tertiaryGapAvail->first(function($a) use ($currentDate) {
                                        $date = strtotime($a->Date ?? $a->date ?? '');
                                        return $date >= $currentDate && $date < $currentDate + 86400;
                                    });
                                    
                                    if ($secondSlot || $tertiarySlot) {
                                        $share = $remainingPlan / 2;
                                        
                                        // Assign to secondary
                                        if ($secondSlot) {
                                            $assignable = min((float) $secondSlot->Total, $share, $remainingPlan);
                                            $assignedNow = (float) $this->assignHoursForOneEmployee(
                                                $second['model'],
                                                collect([$secondSlot]),
                                                $task,
                                                $roundUsage,
                                                $second['id'],
                                                $taskId,
                                                $totalAssigned,
                                                $assignedHoursTracker,
                                                $spentHrs,
                                                $taskAssignmentDetails,
                                                $assignable,
                                            null,
                                            $roundLimit
                                            );
                                            
                                            if ($assignedNow > 0) {
                                                $totalAssigned += $assignedNow;
                                                $roundUsage[$second['id']][$taskId] += $assignedNow;
                                                $cycleAssigned += $assignedNow;
                                                $empMinHours[$second['id']] = ($empMinHours[$second['id']] ?? 0) + $assignedNow;
                                                $dates = array_column(
                                                    array_filter($taskAssignmentDetails['assignments'], 
                                                        fn($r) => $r['employee'] === $second['model']->first_name),
                                                    'date'
                                                );
                                                $empMinDays[$second['id']] = count(array_unique($dates));
                                            }
                                        }
                                        
                                        // Assign to tertiary
                                        if ($tertiarySlot && $tertiaryEmp && $tertiaryEmp['model']) {
                                            $remainingPlan = $plan - $totalAssigned;
                                            if ($remainingPlan > 0) {
                                                $assignable = min((float) $tertiarySlot->Total, $share, $remainingPlan);
                                                $assignedNow = (float) $this->assignHoursForOneEmployee(
                                                    $tertiaryEmp['model'],
                                                    collect([$tertiarySlot]),
                                                    $task,
                                                    $roundUsage,
                                                    $tertiaryEmp['id'],
                                                    $taskId,
                                                    $totalAssigned,
                                                    $assignedHoursTracker,
                                                    $spentHrs,
                                                    $taskAssignmentDetails,
                                                    $assignable,
                                                null,
                                                $roundLimit
                                                );
                                                
                                                if ($assignedNow > 0) {
                                                    $totalAssigned += $assignedNow;
                                                    $roundUsage[$tertiaryEmp['id']][$taskId] += $assignedNow;
                                                    $cycleAssigned += $assignedNow;
                                                    $empMinHours[$tertiaryEmp['id']] = ($empMinHours[$tertiaryEmp['id']] ?? 0) + $assignedNow;
                                                    $dates = array_column(
                                                        array_filter($taskAssignmentDetails['assignments'], 
                                                            fn($r) => $r['employee'] === $tertiaryEmp['model']->first_name),
                                                        'date'
                                                    );
                                                    $empMinDays[$tertiaryEmp['id']] = count(array_unique($dates));
                                                }
                                            }
                                        }
                                        
                                        $currentDate += 86400; // Move to next day
                                        // Skip weekends
                                        while (in_array(date('N', $currentDate), [6, 7])) {
                                            $currentDate += 86400;
                                        }
                                    } else {
                                        // No more slots for this date, move forward
                                        $currentDate += 86400;
                                        while (in_array(date('N', $currentDate), [6, 7])) {
                                            $currentDate += 86400;
                                        }
                                    }
                                } else {
                                    // Phase 1: Secondary works alone
                                    if (!isset($taskAssignmentDetails['_phase1_logged'])) {
                                        $logProcess('PHASE_GAP_WORK_SECONDARY_ALONE', [
                                            'secondary' => $second['model']->first_name,
                                            'start_date' => date('Y-m-d', $currentDate),
                                        ]);
                                        $taskAssignmentDetails['_phase1_logged'] = true;
                                    }
                                    
                                    $secondSlot = $secondGapAvail->first(function($a) use ($currentDate) {
                                        $date = strtotime($a->Date ?? $a->date ?? '');
                                        return $date >= $currentDate && $date < $currentDate + 86400;
                                    });
                                    
                                    if ($secondSlot) {
                                        $assignable = min((float) $secondSlot->Total, 8, $remainingPlan);
                                        $assignedNow = (float) $this->assignHoursForOneEmployee(
                                            $second['model'],
                                            collect([$secondSlot]),
                                            $task,
                                            $roundUsage,
                                            $second['id'],
                                            $taskId,
                                            $totalAssigned,
                                            $assignedHoursTracker,
                                            $spentHrs,
                                            $taskAssignmentDetails,
                                            $assignable,
                                        null,
                                        $roundLimit
                                        );
                                        
                                        if ($assignedNow > 0) {
                                            $totalAssigned += $assignedNow;
                                            $roundUsage[$second['id']][$taskId] += $assignedNow;
                                            $cycleAssigned += $assignedNow;
                                            $empMinHours[$second['id']] = ($empMinHours[$second['id']] ?? 0) + $assignedNow;
                                            $dates = array_column(
                                                array_filter($taskAssignmentDetails['assignments'], 
                                                    fn($r) => $r['employee'] === $second['model']->first_name),
                                                'date'
                                            );
                                            $empMinDays[$second['id']] = count(array_unique($dates));
                                        }
                                        
                                        $currentDate += 86400;
                                        while (in_array(date('N', $currentDate), [6, 7])) {
                                            $currentDate += 86400;
                                        }
                                    } else {
                                        $currentDate += 86400;
                                        while (in_array(date('N', $currentDate), [6, 7])) {
                                            $currentDate += 86400;
                                        }
                                    }
                                }
                                
                                // Stop if we've reached first employee's resume date
                                if ($currentDate >= $gapEnd) {
                                    break;
                                }
                            }
                        }
                    }

                    // Check if we've reached first employee's resume date (all three work in parallel)
                    $currentDateForParallel = time();
                    if (!empty($taskAssignmentDetails['assignments'])) {
                        $lastAssignment = end($taskAssignmentDetails['assignments']);
                        $currentDateForParallel = strtotime($lastAssignment['date'] ?? date('Y-m-d'));
                    }
                    
                    // If we've reached first employee's resume date, include them in parallel work
                    $includeFirstInParallel = false;
                    if ($shouldPauseFirst && $firstResumeDate && $currentDateForParallel >= $firstResumeDate) {
                        $includeFirstInParallel = true;
                        $shouldPauseFirst = false; // Resume first employee
                        
                        $logProcess('FIRST_EMPLOYEE_RESUMED', [
                            'first_employee' => $first['model']->first_name,
                            'resume_date' => date('Y-m-d', $firstResumeDate),
                            'current_date' => date('Y-m-d', $currentDateForParallel),
                            'mode' => 'all_three_parallel',
                        ]);
                    }
                    
                    // Determine how many employees to work in parallel
                    $tertiaryEmp = $employees->get(2);
                    $tertiaryActive = $tertiaryEmp && $tertiaryEmp['model'] && !empty($empStarted[$tertiaryEmp['id']]);
                    
                    if ($includeFirstInParallel && $tertiaryActive) {
                        // All three work in parallel from first resume date
                        $logProcess('PHASE_ALL_THREE_PARALLEL', [
                            'first' => $first['model']->first_name,
                            'second' => $second['model']->first_name,
                            'tertiary' => $tertiaryEmp['model']->first_name,
                            'start_date' => date('Y-m-d', $firstResumeDate),
                        ]);
                        $firstAlignedFromResume = $firstAvail->filter(function($a) use ($firstResumeDate) {
                            $date = strtotime($a->Date ?? $a->date ?? '');
                            return $date >= $firstResumeDate;
                        })->values();
                        $secondAlignedFromResume = $secondAvail->filter(function($a) use ($firstResumeDate) {
                            $date = strtotime($a->Date ?? $a->date ?? '');
                            return $date >= $firstResumeDate;
                        })->values();
                        $tertiaryAvailFromResume = $this->filterAvailabilities($tertiaryEmp['model'], $task)['availabilities']
                            ->filter(function($a) use ($firstResumeDate) {
                                $date = strtotime($a->Date ?? $a->date ?? '');
                                return $date >= $firstResumeDate && (float) $a->Total > 0;
                            })->values();
                        
                        $maxDays = max($firstAlignedFromResume->count(), $secondAlignedFromResume->count(), $tertiaryAvailFromResume->count());
                        for ($i = 0; $i < $maxDays; $i++) {
                            $remainingPlan = $plan - $totalAssigned;
                            if ($remainingPlan <= 0) break;
                            
                            $share = $remainingPlan / 3;
                            $fSlot = $firstAlignedFromResume[$i] ?? $firstAlignedFromResume->last();
                            $sSlot = $secondAlignedFromResume[$i] ?? $secondAlignedFromResume->last();
                            $tSlot = $tertiaryAvailFromResume[$i] ?? $tertiaryAvailFromResume->last();
                            
                            foreach ([[$first, $fSlot], [$second, $sSlot], [$tertiaryEmp, $tSlot]] as [$emp, $slot]) {
                                if (!$emp || !$emp['model'] || !$slot) continue;
                                $assignable = min((float) $slot->Total, $share);
                                
                                $assignedNow = (float) $this->assignHoursForOneEmployee(
                                    $emp['model'],
                                    collect([$slot]),
                                    $task,
                                    $roundUsage,
                                    $emp['id'],
                                    $taskId,
                                    $totalAssigned,
                                    $assignedHoursTracker,
                                    $spentHrs,
                                    $taskAssignmentDetails,
                                    $assignable,
                                null,
                                $roundLimit
                                );
                                
                                if ($assignedNow > 0) {
                                    $totalAssigned += $assignedNow;
                                    $roundUsage[$emp['id']][$taskId] += $assignedNow;
                                    $cycleAssigned += $assignedNow;
                                    $empMinHours[$emp['id']] = ($empMinHours[$emp['id']] ?? 0) + $assignedNow;
                                    $dates = array_column(
                                        array_filter($taskAssignmentDetails['assignments'], 
                                            fn($r) => $r['employee'] === $emp['model']->first_name),
                                        'date'
                                    );
                                    $empMinDays[$emp['id']] = count(array_unique($dates));
                                }
                            }
                        }
                    } else {
                        // Normal 2-employee parallel work (first still paused)
                        $maxDays = max($firstAligned->count(), $secondAligned->count());
                        for ($i = 0; $i < $maxDays; $i++) {
                            $remainingPlan = $plan - $totalAssigned;
                            if ($remainingPlan <= 0) break;

                            $share = $remainingPlan / 2;
                            
                            // 🛑 Skip first employee's future dates if we paused them for gap catch-up
                            $fSlot = null;
                            if (!$shouldPauseFirst) {
                                $fSlot = $firstAligned[$i] ?? $firstAligned->last();
                            }
                            $sSlot = $secondAligned[$i] ?? $secondAligned->last();

                            foreach ([[$first, $fSlot], [$second, $sSlot]] as [$emp, $slot]) {
                                if (!$slot) continue;
                                $assignable = min((float) $slot->Total, $share);

                                $assignedNow = (float) $this->assignHoursForOneEmployee(
                                    $emp['model'],
                                    collect([$slot]),
                                    $task,
                                    $roundUsage,
                                    $emp['id'],
                                    $taskId,
                                    $totalAssigned,
                                    $assignedHoursTracker,
                                    $spentHrs,
                                    $taskAssignmentDetails,
                                    $assignable,
                                null,
                                $roundLimit
                                );

                                if ($assignedNow > 0) {
                                    $totalAssigned += $assignedNow;
                                    $roundUsage[$emp['id']][$taskId] += $assignedNow;
                                    $cycleAssigned += $assignedNow;

                                    $empMinHours[$emp['id']] = ($empMinHours[$emp['id']] ?? 0) + $assignedNow;

                                    $dates = array_column(
                                        array_filter(
                                            $taskAssignmentDetails['assignments'],
                                            fn($r) => $r['employee'] === $emp['model']->first_name
                                        ),
                                        'date'
                                    );
                                    $empMinDays[$emp['id']] = count(array_unique($dates));
                                }
                            }
                        }
                    }

                    // Mark that we've processed the 2-employee case for this cycle
                    $taskAssignmentDetails['_two_emp_processed'] = true;
                    break;
                }
                // 🔹 CASE 3: Three employees active — all share equally day-by-day
                elseif ($activeEmps->count() === 3) {
                    // 🆕 Filter out employees with gaps > 3 days
                    $availableInThree = $activeEmps->filter(function($e) use ($empGaps) {
                        $gap = $empGaps[$e['id']] ?? 0;
                        return $gap <= 3;
                    })->values();
                    
                    // If all have gaps, use the one with smallest gap
                    if ($availableInThree->isEmpty() && $activeEmps->isNotEmpty()) {
                        $minGap = PHP_INT_MAX;
                        $minGapEmp = null;
                        foreach ($activeEmps as $e) {
                            $gap = $empGaps[$e['id']] ?? PHP_INT_MAX;
                            if ($gap < $minGap) {
                                $minGap = $gap;
                                $minGapEmp = $e;
                            }
                        }
                        if ($minGapEmp) {
                            $availableInThree = collect([$minGapEmp]);
                            $logProcess('SMALLEST_GAP_IN_THREE_PHASE', [
                                'selected' => $minGapEmp['model']->first_name,
                                'gap_days' => round($minGap, 1),
                            ]);
                        }
                    }
                    
                    // Log skipped employees
                    $skippedInThree = $activeEmps->reject(fn($e) => $availableInThree->contains(fn($a) => $a['id'] === $e['id']));
                    foreach ($skippedInThree as $skipped) {
                        $gap = $empGaps[$skipped['id']] ?? 0;
                        if ($gap > 3) {
                            $logProcess('EMPLOYEE_SKIPPED_IN_THREE_PHASE', [
                                'skipped' => $skipped['model']->first_name,
                                'gap_days' => round($gap, 1),
                            ]);
                        }
                    }
                    
                    $availSets = $availableInThree->map(
                        fn($e) =>
                        $this->filterAvailabilities($e['model'], $task)['availabilities']
                            ->filter(fn($a) => (float) $a->Total > 0)->values()
                    );
                    
                    if ($availSets->isEmpty()) {
                        continue; // No available employees
                    }

                    $maxDays = max($availSets->map(fn($l) => $l->count())->toArray());
                    $activeCount = $availableInThree->count();
                    for ($i = 0; $i < $maxDays; $i++) {
                        $remainingPlan = $plan - $totalAssigned;
                        if ($remainingPlan <= 0) break;

                        $share = $remainingPlan / $activeCount;
                        foreach ($availableInThree as $j => $emp) {
                            $availList = $availSets->get($j);
                            if (!$availList || $availList->isEmpty()) continue;
                            $slot = $availList->get($i) ?? $availList->last();
                            if (!$slot) continue;
                            $assignable = min((float) $slot->Total, $share);

                            $assignedNow = (float) $this->assignHoursForOneEmployee(
                                $emp['model'],
                                collect([$slot]),
                                $task,
                                $roundUsage,
                                $emp['id'],
                                $taskId,
                                $totalAssigned,
                                $assignedHoursTracker,
                                $spentHrs,
                                $taskAssignmentDetails,
                                $assignable,
                            null,
                            $roundLimit
                            );

                            if ($assignedNow > 0) {
                                $totalAssigned += $assignedNow;
                                $roundUsage[$emp['id']][$taskId] += $assignedNow;
                                $cycleAssigned += $assignedNow;

                                $empMinHours[$emp['id']] = ($empMinHours[$emp['id']] ?? 0) + $assignedNow;

                                $dates = array_column(
                                    array_filter(
                                        $taskAssignmentDetails['assignments'],
                                        fn($r) => $r['employee'] === $emp['model']->first_name
                                    ),
                                    'date'
                                );
                                $empMinDays[$emp['id']] = count(array_unique($dates));
                                
                                // Update current working date
                                $updateCurrentDate();
                            }
                        }
                    }
                    break;
                }
                // 🔹 DEFAULT: Single employee normal assignment
                else {
                    $avail = $this->filterAvailabilities($model, $task)['availabilities']
                        ->filter(fn($a) => (float) $a->Total > 0)
                        ->values();

                    if ($avail->isEmpty())
                        continue;

                    $alreadyUsed = (float) ($roundUsage[$empId][$taskId] ?? 0);

                    $activeCount = count(array_filter($empStarted));
                    $totalSlots = count($employees);

                    if ($totalSlots < 3 || $activeCount < 3) {
                        $remainingCap = $roundLimit - $alreadyUsed;
                        if ($remainingCap <= 0)
                            continue;
                    } else {
                        $remainingCap = $remainingPlan;
                    }

                    $assignable = min($remainingPlan, $remainingCap);

                    $assignedNow = (float) $this->assignHoursForOneEmployee(
                        $model,
                        $avail,
                        $task,
                        $roundUsage,
                        $empId,
                        $taskId,
                        $totalAssigned,
                        $assignedHoursTracker,
                        $spentHrs,
                        $taskAssignmentDetails,
                        $assignable,
                    null,
                    $roundLimit
                    );

                    if ($assignedNow > 0) {
                        $totalAssigned += $assignedNow;
                        $roundUsage[$empId][$taskId] += $assignedNow;
                        $cycleAssigned += $assignedNow;

                        $empMinHours[$empId] = ($empMinHours[$empId] ?? 0) + $assignedNow;

                        $dates = array_column(
                            array_filter(
                                $taskAssignmentDetails['assignments'],
                                fn($r) => $r['employee'] === $model->first_name
                            ),
                            'date'
                        );

                        $empMinDays[$empId] = count(array_unique($dates));
                    }
                }
            }

            // 🛑 ENFORCE MIN 16h OR 2 DAYS
            foreach ($empStarted as $eId => $started) {
                if (!$started)
                    continue;

                $hours = $empMinHours[$eId] ?? 0;
                $days = $empMinDays[$eId] ?? 0;

                if ($hours > 0 && $hours < 16 && $days < 2) {
                    $cycleAssigned = 1;
                    break;
                }
            }

            if ($forceFinishTask)
                break;
            if ($cycleAssigned === 0)
                break;

            $iterations++;
        }

        // -----------------------------
        // FINAL EMPLOYEE NAMES (HYBRID OVERRIDE + ALGO)
        // -----------------------------
        $hoursPerEmployee = [];
        foreach ($taskAssignmentDetails['assignments'] as $row) {
            $hoursPerEmployee[$row['employee']] =
                ($hoursPerEmployee[$row['employee']] ?? 0) + ($row['hours'] ?? $row['hours_assigned'] ?? 0);
        }

        /*
 | At this point:
 | - Override slots may already be filled (locked)
 | - Algo employees are in $employees
 | We ONLY fill missing slots
*/

        // PRIMARY
        if (empty($taskAssignmentDetails['primary_employee'])) {
            foreach ($employees as $emp) {
                $name = $emp['model']->first_name;
                if (!empty($hoursPerEmployee[$name])) {
                    $taskAssignmentDetails['primary_employee'] = $name;
                    break;
                }
            }
        }

        // SECONDARY
        if (empty($taskAssignmentDetails['secondary_employee'])) {
            foreach ($employees as $emp) {
                $name = $emp['model']->first_name;
                if (
                    !empty($hoursPerEmployee[$name])
                    && $name !== $taskAssignmentDetails['primary_employee']
                ) {
                    $taskAssignmentDetails['secondary_employee'] = $name;
                    break;
                }
            }
        }

        // TERTIARY
        if (empty($taskAssignmentDetails['tertiary_employee'])) {
            foreach ($employees as $emp) {
                $name = $emp['model']->first_name;
                if (
                    !empty($hoursPerEmployee[$name])
                    && !in_array($name, [
                        $taskAssignmentDetails['primary_employee'],
                        $taskAssignmentDetails['secondary_employee'],
                    ])
                ) {
                    $taskAssignmentDetails['tertiary_employee'] = $name;
                    break;
                }
            }
        }

        $taskAssignmentDetails['unlock_log'] = $unlockLog;

        $task['Algorithm_1'] = $taskAssignmentDetails['primary_employee'];
        $task['Algorithm_2'] = $taskAssignmentDetails['secondary_employee'];
        $task['Algorithm_3'] = $taskAssignmentDetails['tertiary_employee'];

        $task['TS'] = collect([
            $taskAssignmentDetails['primary_employee'],
            $taskAssignmentDetails['secondary_employee'],
            $taskAssignmentDetails['tertiary_employee'],
        ])->filter()->count();

        // =====================================================
        // ✅ APPLY POST-ASSIGNMENT ADJUSTMENTS (Hbs/hrsPer + Adj/Buf)
        // =====================================================
        $this->applyPostAssignmentHrsPerAndBufferAdjustments($task, $taskAssignmentDetails, $allEmployees);

        // Remove verbose fields to minimize output
        unset($taskAssignmentDetails['assignment_process_log']);
        unset($taskAssignmentDetails['gap_summary']);
        unset($taskAssignmentDetails['all_candidates']);
        unset($taskAssignmentDetails['employee_full_availability']);
        unset($taskAssignmentDetails['unlock_log']);


        return $this->finalizeRoundedTaskOutput($task, $taskAssignmentDetails, $originalPlan, $allEmployees);
    }



    private function getFullAvailabilityForTaskPeriod($employee, $task)
    {
        $rows = \App\Models\Availability::where('employee_id', $employee->id)
            ->where('date', '>=', $task['Doc_Supply'])
            ->orderBy('date')
            ->get()
            ->map(function ($a) {
                return [
                    'date'  => $a->date ?? $a->Date,
                    'total' => (float)$this->convertToHours($a->Total),
                ];
            });

        return [
            'availability' => $rows
                ->filter(fn($r) => $r['total'] > 0)
                ->values()
                ->toArray(),

            'zero_days' => $rows
                ->filter(fn($r) => $r['total'] <= 0)
                ->pluck('date')
                ->values()
                ->toArray(),
        ];
    }






    /**
     * Scale the round/SH cap for trainees: base × (1 + (1 − rate)).
     * Full performance (100%) leaves the cap unchanged; lower % increases the cap (e.g. 50% → ×1.5).
     */
    private function applyPerformanceScaleToRoundCap(float $baseCap, float $performanceRate): float
    {
        if ($baseCap <= 0) {
            return $baseCap;
        }
        if ($performanceRate >= 1.0 - 0.0001) {
            return $baseCap;
        }
        $rate = max(0.0001, min(1.0, $performanceRate));
        return $baseCap * (1.0 + (1.0 - $rate));
    }

    # ------------------------------------------------------------------
    # HOUR ASSIGNMENT
    # ------------------------------------------------------------------
    private function assignHoursForOneEmployee(
        $employeeModel,
        $availabilities,
        array &$task,
        array &$roundUsage,
        int $empId,
        int $taskId,
        float $totalAssignedSoFar,
        array &$assignedHoursTracker,
        array &$spentHrs,
        array &$taskAssignmentDetails,
        $roundLimit,
        $targetHours = null,
        $globalRoundCapForPerformance = null
    ) {
        // SH overrides the 11th arg when set (same as before). 11th may be assignable/remaining — not always global cap.
        $effectiveLimit = (float) $roundLimit;
        if ($this->features['use_SH_limit'] && !empty($task['SH'])) {
            $effectiveLimit = (float) $task['SH'];
        }

        if (
            $this->features['scale_round_cap_by_performance']
            && $globalRoundCapForPerformance !== null
        ) {
            $baseCap = ($this->features['use_SH_limit'] && !empty($task['SH']))
                ? (float) $task['SH']
                : (float) $globalRoundCapForPerformance;
            $effectiveLimit = $this->applyPerformanceScaleToRoundCap(
                $baseCap,
                $this->getEmployeePerformanceRate($employeeModel, $task)
            );
        }

        $hoursAssignedNow = 0.0;
        $taskRemaining = $task['Plan'] - $totalAssignedSoFar;

        if ($targetHours !== null) {
            $targetRemaining = $targetHours;
        } else {
            $roundRemaining = $this->features['enforce_rounds']
                ? $effectiveLimit - ($roundUsage[$empId][$taskId] ?? 0)
                : $taskRemaining;

            if ($taskRemaining <= 0)
                return 0.0;

            // allow finishing current day even if limit hit
            if ($roundRemaining <= 0) {
                $nextAvailableDay = $availabilities->first(fn($a) => (float) $a->Total > 0);
                if ($nextAvailableDay) {
                    $roundRemaining = (float) $this->convertToHours($nextAvailableDay->Total);
                } else {
                    return 0.0;
                }
            }
        }

        foreach ($availabilities as $availability) {
            $date = $availability->date;

            while (true) {
                if ($taskRemaining <= 0) {
                    break 2;
                }
                if ($targetHours !== null && $targetRemaining <= 0) {
                    break 2;
                }
                if ($targetHours === null && $roundRemaining <= 0) {
                    break 2;
                }

                // Remaining slot on this calendar day (Total is already reduced by updateGlobalAvailability).
                $dailyAvailable = max(0.0, $this->getGlobalRemainingHoursOnDate($employeeModel, $date));
                if ($dailyAvailable <= 0.0001) {
                    break;
                }

                if ($roundRemaining < $dailyAvailable && $roundRemaining > 0) {
                    $roundRemaining = $dailyAvailable;
                }

                $globalRemaining = $task['Plan'] - $totalAssignedSoFar - $hoursAssignedNow;
                if ($globalRemaining <= 0) {
                    break 2;
                }

                $canAssign = $targetHours !== null
                    ? min($dailyAvailable, $targetRemaining, $globalRemaining)
                    : min($dailyAvailable, $roundRemaining, $globalRemaining);

                if ($canAssign <= 0.0001) {
                    break;
                }

                $previouslyAssigned = $assignedHoursTracker[$empId][$date] ?? 0;
                $assignedHoursTracker[$empId][$date] = $previouslyAssigned + $canAssign;
                $roundUsage[$empId][$taskId] = ($roundUsage[$empId][$taskId] ?? 0) + $canAssign;

                $hoursAssignedNow += $canAssign;
                $taskRemaining -= $canAssign;

                if ($targetHours !== null) {
                    $targetRemaining -= $canAssign;
                } else {
                    $roundRemaining -= $canAssign;
                }

                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $employeeModel->first_name,
                    'date' => $date,
                    'hours' => $canAssign,
                ];

                $taskAssignmentDetails['end_dates'][$employeeModel->first_name] = $date;

                if ($this->features['track_spent_hours']) {
                    $this->updateSpentHrs($spentHrs, $empId, $taskId, $task['TaskName'], $canAssign, $date);
                }

                $this->updateGlobalAvailability($employeeModel, $date, $canAssign);
            }
        }

        return $hoursAssignedNow;
    }


 


    # ------------------------------------------------------------------
    # UTILITIES
    # ------------------------------------------------------------------

    private const SCHEDULING_GAP_DEADEND_DAYS = 3;

    private const DEFAULT_TASK_ALLOCATION_LIMIT = 3;

    /**
     * Remove an employee's assignments strictly after $afterDate; restore plan/round counters.
     */
    private function rollbackEmployeeAssignmentsAfterDate(
        string $employeeName,
        string $afterDate,
        int $empId,
        int $taskId,
        array &$taskAssignmentDetails,
        array &$roundUsage,
        float &$totalAssigned,
        array &$empMinHours = [],
        array &$remainingQuota = []
    ): float {
        $afterTs = strtotime($afterDate);
        if ($afterTs === false) {
            return 0.0;
        }

        $removed = 0.0;
        $kept = [];
        foreach ($taskAssignmentDetails['assignments'] ?? [] as $row) {
            $name = (string) ($row['employee'] ?? '');
            $date = $row['date'] ?? null;
            if ($name === $employeeName && $date && strtotime($date) > $afterTs) {
                $removed += (float) ($row['hours'] ?? 0);
                continue;
            }
            $kept[] = $row;
        }

        if ($removed <= 0.0001) {
            return 0.0;
        }

        $taskAssignmentDetails['assignments'] = $kept;
        $totalAssigned = max(0.0, $totalAssigned - $removed);
        $roundUsage[$empId][$taskId] = max(0.0, (float) ($roundUsage[$empId][$taskId] ?? 0) - $removed);
        if ($empMinHours !== null) {
            $empMinHours[$empId] = max(0.0, (float) ($empMinHours[$empId] ?? 0) - $removed);
        }
        if ($remainingQuota !== null) {
            $remainingQuota[$empId] = ($remainingQuota[$empId] ?? 0) + $removed;
        }

        return $removed;
    }

    private function filterAvailabilityInDateRange($availabilities, int $rangeStartTs, int $rangeEndTs)
    {
        return $availabilities->filter(function ($a) use ($rangeStartTs, $rangeEndTs) {
            $date = strtotime($a->Date ?? $a->date ?? '');
            return $date >= $rangeStartTs && $date < $rangeEndTs;
        });
    }

    private function resolveTaskAllocationLimit(array $task): int
    {
        $al = isset($task['AL']) && is_numeric($task['AL']) ? (int) $task['AL'] : self::DEFAULT_TASK_ALLOCATION_LIMIT;
        $ceiling = (int) ($this->features['gap_assist_max_allocation'] ?? 6);
        return max(1, min(max($al, 1), max(1, $ceiling)));
    }

    /**
     * Pre-fill employee slots up to task AL from candidates (when AL > selected prim/sec/ter).
     */
    private function expandEmployeesToAllocationLimit(
        $employees,
        array &$task,
        array &$taskAssignmentDetails,
        array &$roundUsage,
        int $taskId,
        $finalCandidates,
        $allEmployees
    ) {
        $employees = collect($employees)->values();
        $limit = $this->resolveTaskAllocationLimit($task);
        if ($employees->count() >= $limit) {
            return $employees->take($limit)->values();
        }

        $usedIds = $employees->pluck('id')->filter()->map(fn($id) => (int) $id)->all();
        $pool = collect();
        if ($finalCandidates) {
            foreach ($finalCandidates as $row) {
                if (!empty($row['employee'])) {
                    $pool->push($row['employee']);
                }
            }
        }
        if ($allEmployees) {
            $pool = $pool->merge($allEmployees);
        }
        $pool = $pool->filter()->unique(fn($e) => (int) $e->id)->reject(fn($e) => in_array((int) $e->id, $usedIds, true))->values();

        while ($employees->count() < $limit && $pool->isNotEmpty()) {
            $next = $pool->shift();
            $slotIndex = $employees->count() + 1;
            $this->registerGapAssistEmployeeOnTask($task, $taskAssignmentDetails, $next, $slotIndex, $roundUsage, $taskId);
            $employees->push(['id' => (int) $next->id, 'model' => $next]);
            $usedIds[] = (int) $next->id;
        }

        $task['TS'] = $employees->count();
        return $employees->values();
    }

    private function bumpTaskAllocationLimit(array &$task, int $requiredSlots): int
    {
        $current = isset($task['AL']) && is_numeric($task['AL']) ? (int) $task['AL'] : 1;
        $ceiling = (int) ($this->features['gap_assist_max_allocation'] ?? 6);
        $newAl = min(max(1, $ceiling), max($current, $requiredSlots));
        if ($newAl > $current) {
            $task['AL'] = $newAl;
            $task['_gap_assist_al_bumped'] = true;
        }
        return $newAl;
    }

    private function registerGapAssistEmployeeOnTask(
        array &$task,
        array &$taskAssignmentDetails,
        $model,
        int $slotIndex,
        array &$roundUsage,
        int $taskId
    ): void {
        $name = $model->first_name;
        $algoKey = 'Algorithm_' . $slotIndex;
        if ($slotIndex <= 3) {
            $task[$algoKey] = $name;
        }
        if ($slotIndex === 1) {
            $taskAssignmentDetails['primary_employee'] = $name;
        } elseif ($slotIndex === 2) {
            $taskAssignmentDetails['secondary_employee'] = $name;
        } elseif ($slotIndex === 3) {
            $taskAssignmentDetails['tertiary_employee'] = $name;
        } else {
            $extras = $taskAssignmentDetails['gap_assist_extra_employees'] ?? [];
            if (!in_array($name, $extras, true)) {
                $extras[] = $name;
                $taskAssignmentDetails['gap_assist_extra_employees'] = $extras;
            }
        }
        $empId = (int) $model->id;
        if (!isset($roundUsage[$empId][$taskId])) {
            $roundUsage[$empId][$taskId] = 0;
        }
    }

    private function findGapAssistExtraEmployee(
        array $task,
        $employees,
        $allEmployees,
        $finalCandidates,
        int $gapStartTs,
        int $gapEndTs
    ): ?Employee {
        $usedIds = collect($employees)->pluck('id')->filter()->map(fn($id) => (int) $id)->all();
        $candidates = collect();
        if ($finalCandidates) {
            foreach ($finalCandidates as $row) {
                if (!empty($row['employee'])) {
                    $candidates->push($row['employee']);
                }
            }
        }
        if ($allEmployees) {
            $candidates = $candidates->merge($allEmployees);
        }
        $candidates = $candidates
            ->filter()
            ->unique(fn($e) => (int) $e->id)
            ->reject(fn($e) => in_array((int) $e->id, $usedIds, true))
            ->values();

        foreach ($candidates as $employee) {
            $avail = $this->filterAvailabilities($employee, $task)['availabilities']
                ->filter(fn($a) => (float) $a->Total > 0)
                ->values();
            if ($this->filterAvailabilityInDateRange($avail, $gapStartTs, $gapEndTs)->isNotEmpty()) {
                return $employee;
            }
        }

        return null;
    }

    /**
     * All current assistants dead-end in the gap: bump AL (up to ceiling) and append another pool employee.
     */
    private function tryGapAssistIncreaseAllocation(
        &$employees,
        array &$empStarted,
        array &$task,
        array &$taskAssignmentDetails,
        array &$roundUsage,
        int $gapStartTs,
        int $gapEndTs,
        $allEmployees,
        $finalCandidates,
        int $taskId,
        ?callable $logProcess = null
    ): bool {
        if (empty($this->features['allow_gap_assist_increase_allocation'])) {
            return false;
        }

        $employees = collect($employees);
        $requiredSlots = $employees->count() + 1;
        $limit = $this->resolveTaskAllocationLimit($task);
        if ($requiredSlots > $limit) {
            $this->bumpTaskAllocationLimit($task, $requiredSlots);
            $limit = $this->resolveTaskAllocationLimit($task);
        }
        if ($requiredSlots > $limit) {
            return false;
        }

        $extra = $this->findGapAssistExtraEmployee(
            $task,
            $employees,
            $allEmployees,
            $finalCandidates,
            $gapStartTs,
            $gapEndTs
        );
        if (!$extra) {
            return false;
        }

        $this->bumpTaskAllocationLimit($task, $requiredSlots);
        $slotIndex = $requiredSlots;
        $this->registerGapAssistEmployeeOnTask(
            $task,
            $taskAssignmentDetails,
            $extra,
            $slotIndex,
            $roundUsage,
            $taskId
        );

        $entry = ['id' => (int) $extra->id, 'model' => $extra];
        $employees->push($entry);
        $empStarted[(int) $extra->id] = true;
        $taskAssignmentDetails['_gap_assist_active'] = true;
        $task['TS'] = $employees->count();

        if ($logProcess) {
            $logProcess('GAP_ASSIST_AL_BUMP', [
                'new_al' => (int) ($task['AL'] ?? $requiredSlots),
                'employee' => $extra->first_name,
                'slot' => $slotIndex,
            ]);
        }

        return true;
    }

    /**
     * Consecutive assignment dates for one employee with a hole longer than threshold days.
     *
     * @return list<array{gap_start:int,gap_end:int,last_date:string}>
     */
    private function detectEmployeeAssignmentGaps(
        array $assignments,
        string $employeeName,
        int $thresholdDays = self::SCHEDULING_GAP_DEADEND_DAYS
    ): array {
        $dates = collect($assignments)
            ->filter(fn($a) => ($a['employee'] ?? '') === $employeeName)
            ->pluck('date')
            ->filter()
            ->unique()
            ->sort()
            ->values();

        $gaps = [];
        for ($i = 0; $i < $dates->count() - 1; $i++) {
            $lastTs = strtotime((string) $dates[$i]);
            $nextTs = strtotime((string) $dates[$i + 1]);
            if ($lastTs === false || $nextTs === false) {
                continue;
            }
            $gapDays = ($nextTs - $lastTs) / 86400;
            if ($gapDays > $thresholdDays) {
                $gaps[] = [
                    'gap_start' => $lastTs + 86400,
                    'gap_end' => $nextTs,
                    'last_date' => (string) $dates[$i],
                ];
            }
        }

        return $gaps;
    }

    private function gapRangeHasNoTaskHours(array $assignments, int $gapStartTs, int $gapEndTs): bool
    {
        foreach ($assignments as $row) {
            $date = $row['date'] ?? null;
            if (!$date) {
                continue;
            }
            $ts = strtotime($date);
            if ($ts !== false && $ts >= $gapStartTs && $ts < $gapEndTs) {
                return false;
            }
        }
        return true;
    }

    private function getSelectedAssigneeNamesForTask(array $taskAssignmentDetails): array
    {
        $names = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
            $taskAssignmentDetails['tertiary_employee'] ?? null,
        ]));
        $extras = $taskAssignmentDetails['gap_assist_extra_employees'] ?? [];
        if (is_array($extras)) {
            foreach ($extras as $extra) {
                if ($extra && !in_array($extra, $names, true)) {
                    $names[] = $extra;
                }
            }
        }
        return $names;
    }

    private function syncAlRemainingQuotaForRoster(
        $employeeEntries,
        array &$remainingQuota,
        float $plan,
        array $task
    ): void {
        $models = collect($employeeEntries)->pluck('model')->filter()->values();
        if ($models->isEmpty()) {
            return;
        }
        $targets = $this->buildPlanTargetsForEmployees($plan, $models, $task);
        foreach ($models as $idx => $emp) {
            $empId = (int) $emp->id;
            if (!isset($remainingQuota[$empId]) || $remainingQuota[$empId] <= 0.0001) {
                $base = (float) ($targets[$idx] ?? 0.0);
                $rate = $this->getEmployeePerformanceRate($emp, $task);
                $remainingQuota[$empId] = ($rate > 0 && $rate < 1.0)
                    ? (float) ceil($base / $rate)
                    : $base;
            }
        }
    }

    private function fillAlModeGapFromAvailability(
        array &$task,
        array &$taskAssignmentDetails,
        $employeeEntries,
        array $empStarted,
        array &$remainingQuota,
        float &$remainingPlan,
        float &$totalAssigned,
        int $gapStartTs,
        int $gapEndTs
    ): float {
        $placed = 0.0;
        $cursor = $gapStartTs;
        while ($cursor < $gapEndTs && $remainingPlan > 0.0001) {
            $date = date('Y-m-d', $cursor);
            foreach (collect($employeeEntries) as $entry) {
                $empId = (int) ($entry['id'] ?? 0);
                if ($empId <= 0 || empty($entry['model']) || empty($empStarted[$empId])) {
                    continue;
                }
                $quota = (float) ($remainingQuota[$empId] ?? 0);
                if ($quota <= 0.0001) {
                    continue;
                }

                $avail = $this->filterAvailabilities($entry['model'], $task)['availabilities']
                    ->first(function ($a) use ($date) {
                        $d = $a->date ?? $a->Date ?? null;
                        return $d === $date && (float) $a->Total > 0;
                    });
                if (!$avail) {
                    continue;
                }

                $available = (float) $this->convertToHours($avail->Total);
                $assign = min($available, $remainingPlan, $quota, 8.0);
                if ($assign <= 0.0001) {
                    continue;
                }

                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $entry['model']->first_name,
                    'date' => $date,
                    'hours' => $assign,
                ];
                $taskAssignmentDetails['end_dates'][$entry['model']->first_name] = $date;
                $this->updateGlobalAvailability($entry['model'], $date, $assign);

                $remainingQuota[$empId] = $quota - $assign;
                $remainingPlan -= $assign;
                $totalAssigned += $assign;
                $placed += $assign;
            }
            $cursor += 86400;
        }

        return $placed;
    }

    /**
     * Option A: gap rollback + assistant unlock (+ AL bump) in AL mode.
     * Option E: compress hours into earlier empty days / across assignees.
     */
    private function applyAlModeGapAssistAndRedistribute(
        array &$task,
        array &$taskAssignmentDetails,
        &$employeeEntries,
        array &$remainingQuota,
        float &$remainingPlan,
        float &$totalAssigned,
        array &$roundUsage,
        int $taskId,
        int $dd,
        float $plan,
        $allEmployees,
        $finalCandidates
    ): void {
        if (!$allEmployees) {
            return;
        }

        $gapAssistEmpMinHours = [];
        $gapAssistHoursTracker = [];
        $gapAssistSpentHrs = [];

        $employeeEntries = collect($employeeEntries)->values();
        $empStarted = [];
        foreach ($employeeEntries as $entry) {
            if (empty($entry['model'])) {
                continue;
            }
            $name = $entry['model']->first_name;
            $hasRows = collect($taskAssignmentDetails['assignments'] ?? [])
                ->contains(fn($a) => ($a['employee'] ?? '') === $name);
            if ($hasRows) {
                $empStarted[(int) $entry['id']] = true;
            }
        }

        $ddDelayedStarts = [];
        if ($dd > 0 && $employeeEntries->isNotEmpty()) {
            $first = $employeeEntries->first()['model'] ?? null;
            if ($first) {
                $firstAvail = $this->filterAvailabilities($first, $task)['availabilities']
                    ->filter(fn($a) => (float) $a->Total > 0)
                    ->sortBy(fn($a) => $a->date ?? $a->Date ?? '')
                    ->first();
                $ddBaseDate = $firstAvail ? ($firstAvail->date ?? $firstAvail->Date ?? null) : null;
                if ($ddBaseDate) {
                    $ddDelayedStarts[0] = $ddBaseDate;
                    $ddDelayedStarts[1] = $this->getEmployeeDelayedStartDate($ddBaseDate, 1, $dd);
                    $ddDelayedStarts[2] = $this->getEmployeeDelayedStartDate($ddBaseDate, 2, $dd);
                }
            }
        }

        $maxRounds = 10;
        for ($round = 0; $round < $maxRounds; $round++) {
            $progress = false;
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $totalAssigned = (float) ($stats['total_assigned'] ?? 0);
            $remainingPlan = max(0.0, $plan - $totalAssigned);

            if (
                $employeeEntries->count() < 2
                && !empty($this->features['allow_gap_assist_increase_allocation'])
                && empty(array_filter([
                    $task['Override_1'] ?? null,
                    $task['Override_2'] ?? null,
                    $task['Override_3'] ?? null,
                ]))
            ) {
                $this->bumpTaskAllocationLimit($task, 2);
                $employeeEntries = $this->expandEmployeesToAllocationLimit(
                    $employeeEntries,
                    $task,
                    $taskAssignmentDetails,
                    $roundUsage,
                    $taskId,
                    $finalCandidates,
                    $allEmployees
                );
                $this->syncAlRemainingQuotaForRoster(
                    $employeeEntries,
                    $remainingQuota,
                    is_numeric($task['Plan'] ?? null) ? (float) $task['Plan'] : 0.0,
                    $task
                );
                $progress = true;
            }

            foreach ($employeeEntries as $idx => $entry) {
                if (empty($entry['model'])) {
                    continue;
                }
                $name = $entry['model']->first_name;
                $gaps = $this->detectEmployeeAssignmentGaps(
                    $taskAssignmentDetails['assignments'] ?? [],
                    $name
                );
                foreach ($gaps as $gap) {
                    $gapStart = (int) $gap['gap_start'];
                    $gapEnd = (int) $gap['gap_end'];

                    if ($this->handleSchedulingGapAssist(
                        $employeeEntries,
                        $empStarted,
                        (int) $idx,
                        $name,
                        (int) $entry['id'],
                        $gapStart,
                        $gapEnd,
                        $task,
                        $taskAssignmentDetails,
                        $roundUsage,
                        $totalAssigned,
                        $taskId,
                        $dd,
                        $ddDelayedStarts,
                        $allEmployees,
                        $finalCandidates,
                        null,
                        $gapAssistEmpMinHours,
                        $remainingQuota,
                        $gapAssistHoursTracker,
                        $gapAssistSpentHrs,
                        40.0,
                        false
                    )) {
                        $progress = true;
                    }

                    $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
                    $totalAssigned = (float) ($stats['total_assigned'] ?? 0);
                    $remainingPlan = max(0.0, $plan - $totalAssigned);

                    $placed = $this->fillAlModeGapFromAvailability(
                        $task,
                        $taskAssignmentDetails,
                        $employeeEntries,
                        $empStarted,
                        $remainingQuota,
                        $remainingPlan,
                        $totalAssigned,
                        $gapStart,
                        $gapEnd
                    );
                    if ($placed > 0.0001) {
                        $progress = true;
                    }

                    if (
                        $remainingPlan > 0.0001
                        && $this->gapRangeHasNoTaskHours($taskAssignmentDetails['assignments'] ?? [], $gapStart, $gapEnd)
                        && $this->gapAssistChainDeadendInRange($employeeEntries, $task, $gapStart, $gapEnd, 1)
                    ) {
                        if ($this->tryGapAssistIncreaseAllocation(
                            $employeeEntries,
                            $empStarted,
                            $task,
                            $taskAssignmentDetails,
                            $roundUsage,
                            $gapStart,
                            $gapEnd,
                            $allEmployees,
                            $finalCandidates,
                            $taskId,
                            null
                        )) {
                            $this->syncAlRemainingQuotaForRoster(
                                $employeeEntries,
                                $remainingQuota,
                                is_numeric($task['Plan'] ?? null) ? (float) $task['Plan'] : 0.0,
                                $task
                            );
                            $placed2 = $this->fillAlModeGapFromAvailability(
                                $task,
                                $taskAssignmentDetails,
                                $employeeEntries,
                                $empStarted,
                                $remainingQuota,
                                $remainingPlan,
                                $totalAssigned,
                                $gapStart,
                                $gapEnd
                            );
                            if ($placed2 > 0.0001) {
                                $progress = true;
                            }
                        }
                    }
                }
            }

            if (!$progress) {
                break;
            }
        }

        $taskAssignmentDetails['_gap_assist_active'] = true;
        $this->compressTaskIntoEarlierGaps($task, $taskAssignmentDetails, $allEmployees);
        $this->compressTaskAcrossEmployeesIntoEarlierGaps($task, $taskAssignmentDetails, $allEmployees);

        $planCap = is_numeric($task['Plan'] ?? null) ? (float) $task['Plan'] : $plan;
        if ($planCap > 0.0001) {
            $this->trimTaskAssignmentsAbovePlan($task, $taskAssignmentDetails, $planCap, $allEmployees);
        }
        $taskAssignmentDetails['_gap_assist_calendar_repaired'] = true;
    }

    private function gapAssistChainDeadendInRange(
        $employees,
        array $task,
        int $gapStartTs,
        int $gapEndTs,
        int $fromIndex = 1
    ): bool {
        $employees = collect($employees);
        for ($i = max(1, $fromIndex); $i < $employees->count(); $i++) {
            $entry = $employees->get($i);
            if (!$entry || empty($entry['model'])) {
                continue;
            }
            $avail = $this->filterAvailabilities($entry['model'], $task)['availabilities']
                ->filter(fn($a) => (float) $a->Total > 0)
                ->values();
            if ($this->filterAvailabilityInDateRange($avail, $gapStartTs, $gapEndTs)->isNotEmpty()) {
                return false;
            }
        }
        return true;
    }

    /**
     * Normal algo gap window: unlock roster helpers after blocked index and assign hours in [gapStart, gapEnd).
     */
    private function assignHelpersInSchedulingGap(
        &$employees,
        array &$empStarted,
        int $blockedIndex,
        int $gapStartTs,
        int $gapEndTs,
        array &$task,
        array &$taskAssignmentDetails,
        array &$roundUsage,
        float &$totalAssigned,
        int $taskId,
        int $dd,
        array $ddDelayedStarts,
        ?callable $logProcess,
        array &$empMinHours,
        array &$assignedHoursTracker,
        array &$spentHrs,
        float $roundLimit,
        ?int $helperStartIndex = null
    ): float {
        $employees = collect($employees);
        $plan = (float) ($task['Plan'] ?? 0);
        $placed = 0.0;
        $startIdx = $helperStartIndex ?? ($blockedIndex + 1);

        for ($i = $startIdx; $i < $employees->count(); $i++) {
            $entry = $employees->get($i);
            if (!$entry || empty($entry['model'])) {
                continue;
            }

            $helperId = (int) $entry['id'];
            $helperDDMet = true;
            if ($dd > 0 && isset($ddDelayedStarts[$i])) {
                $ddTs = strtotime((string) $ddDelayedStarts[$i]);
                $helperDDMet = $ddTs !== false && $gapStartTs >= $ddTs;
            }
            if (!$helperDDMet) {
                continue;
            }

            if ($i === 2 && $blockedIndex === 0) {
                $secEntry = $employees->get(1);
                if ($secEntry && !empty($secEntry['model'])) {
                    $secAvail = $this->filterAvailabilities($secEntry['model'], $task)['availabilities']
                        ->filter(fn($a) => (float) $a->Total > 0)
                        ->values();
                    if ($this->filterAvailabilityInDateRange($secAvail, $gapStartTs, $gapEndTs)->isNotEmpty()) {
                        continue;
                    }
                }
            }

            if (empty($empStarted[$helperId])) {
                $empStarted[$helperId] = true;
                $taskAssignmentDetails['_gap_assist_active'] = true;
                if ($logProcess) {
                    $logProcess('GAP_ASSIST_ASSIGN', [
                        'employee' => $entry['model']->first_name,
                        'slot' => $i,
                        'gap_start' => date('Y-m-d', $gapStartTs),
                        'gap_end' => date('Y-m-d', $gapEndTs),
                    ]);
                }
            }

            $helperAvail = $this->filterAvailabilities($entry['model'], $task)['availabilities']
                ->filter(fn($a) => (float) $a->Total > 0)
                ->values();
            $gapAvail = $this->filterAvailabilityInDateRange($helperAvail, $gapStartTs, $gapEndTs)
                ->sortBy(fn($a) => strtotime((string) ($a->date ?? $a->Date ?? '')))
                ->values();

            foreach ($gapAvail as $slot) {
                $remainingPlan = $plan - $totalAssigned;
                if ($remainingPlan <= 0.0001) {
                    break 2;
                }

                $assignable = min((float) $slot->Total, 8.0, $remainingPlan);
                $assignedNow = (float) $this->assignHoursForOneEmployee(
                    $entry['model'],
                    collect([$slot]),
                    $task,
                    $roundUsage,
                    $helperId,
                    $taskId,
                    $totalAssigned,
                    $assignedHoursTracker,
                    $spentHrs,
                    $taskAssignmentDetails,
                    $assignable,
                    null,
                    $roundLimit
                );

                if ($assignedNow > 0.0001) {
                    $totalAssigned += $assignedNow;
                    $roundUsage[$helperId][$taskId] = ($roundUsage[$helperId][$taskId] ?? 0) + $assignedNow;
                    $empMinHours[$helperId] = ($empMinHours[$helperId] ?? 0) + $assignedNow;
                    $placed += $assignedNow;
                }
            }
        }

        return $placed;
    }

    /**
     * Big calendar gap: rollback blocked employee's forward rows, unlock #2 immediately (ignore round/HBS),
     * unlock #3 only if #2 has no availability in the gap; may bump AL for further helpers when enabled.
     */
    private function handleSchedulingGapAssist(
        &$employees,
        array &$empStarted,
        int $blockedIndex,
        string $blockedEmpName,
        int $blockedEmpId,
        int $gapStartTs,
        int $gapEndTs,
        array &$task,
        array &$taskAssignmentDetails,
        array &$roundUsage,
        float &$totalAssigned,
        int $taskId,
        int $dd,
        array $ddDelayedStarts = [],
        $allEmployees = null,
        $finalCandidates = null,
        ?callable $logProcess = null,
        array &$empMinHours = [],
        array &$remainingQuota = [],
        array &$assignedHoursTracker = [],
        array &$spentHrs = [],
        float $roundLimit = 40.0,
        bool $assignGapHours = true
    ): bool {
        $employees = collect($employees);
        $limit = $this->resolveTaskAllocationLimit($task);
        if ($employees->count() > $limit) {
            $employees = $employees->take($limit)->values();
        }
        if ($gapEndTs <= $gapStartTs) {
            return false;
        }

        $gapDays = ($gapEndTs - $gapStartTs) / 86400;
        if ($gapDays <= self::SCHEDULING_GAP_DEADEND_DAYS) {
            return false;
        }

        $lastAssignedDate = null;
        foreach (array_reverse($taskAssignmentDetails['assignments'] ?? []) as $as) {
            if (($as['employee'] ?? null) === $blockedEmpName) {
                $lastAssignedDate = $as['date'] ?? null;
                break;
            }
        }
        if ($lastAssignedDate) {
            $removed = $this->rollbackEmployeeAssignmentsAfterDate(
                $blockedEmpName,
                $lastAssignedDate,
                $blockedEmpId,
                $taskId,
                $taskAssignmentDetails,
                $roundUsage,
                $totalAssigned,
                $empMinHours,
                $remainingQuota
            );
            if ($removed > 0.0001 && $logProcess) {
                $logProcess('GAP_ROLLBACK', [
                    'employee' => $blockedEmpName,
                    'after_date' => $lastAssignedDate,
                    'removed_hours' => round($removed, 2),
                ]);
            }
        }

        $taskAssignmentDetails['_gap_assist_active'] = true;
        $assisted = false;

        $secondaryEntry = $employees->get(1);
        if ($blockedIndex <= 0 && $secondaryEntry && !empty($secondaryEntry['model'])) {
            $secId = (int) $secondaryEntry['id'];
            if (empty($empStarted[$secId])) {
                $empStarted[$secId] = true;
                $assisted = true;
                if ($logProcess) {
                    $logProcess('GAP_ASSIST_UNLOCK', [
                        'employee' => $secondaryEntry['model']->first_name,
                        'role' => 'secondary',
                        'ignore_round_hbs' => true,
                    ]);
                }
            }

            $secAvail = $this->filterAvailabilities($secondaryEntry['model'], $task)['availabilities']
                ->filter(fn($a) => (float) $a->Total > 0)
                ->values();
            $secGapAvail = $this->filterAvailabilityInDateRange($secAvail, $gapStartTs, $gapEndTs);

            $tertiaryEntry = $employees->get(2);
            if ($secGapAvail->isEmpty() && $tertiaryEntry && !empty($tertiaryEntry['model'])) {
                $terId = (int) $tertiaryEntry['id'];
                $terDDMet = true;
                if ($dd > 0 && isset($ddDelayedStarts[2])) {
                    $terDDMet = $gapStartTs >= strtotime($ddDelayedStarts[2]);
                }
                if ($terDDMet && empty($empStarted[$terId])) {
                    $empStarted[$terId] = true;
                    $assisted = true;
                    if ($logProcess) {
                        $logProcess('GAP_ASSIST_UNLOCK', [
                            'employee' => $tertiaryEntry['model']->first_name,
                            'role' => 'tertiary',
                            'reason' => 'secondary_deadend_in_gap',
                        ]);
                    }
                }
            }

            if ($secGapAvail->isEmpty()) {
                $terAvail = collect();
                if ($tertiaryEntry && !empty($tertiaryEntry['model'])) {
                    $terAvail = $this->filterAvailabilities($tertiaryEntry['model'], $task)['availabilities']
                        ->filter(fn($a) => (float) $a->Total > 0)
                        ->values();
                }
                $terDeadend = $terAvail->isEmpty()
                    || $this->filterAvailabilityInDateRange($terAvail, $gapStartTs, $gapEndTs)->isEmpty();
                if ($terDeadend && $this->gapAssistChainDeadendInRange($employees, $task, $gapStartTs, $gapEndTs, 1)) {
                    if ($this->tryGapAssistIncreaseAllocation(
                        $employees,
                        $empStarted,
                        $task,
                        $taskAssignmentDetails,
                        $roundUsage,
                        $gapStartTs,
                        $gapEndTs,
                        $allEmployees,
                        $finalCandidates,
                        $taskId,
                        $logProcess
                    )) {
                        $assisted = true;
                    }
                }
            }
        } elseif ($blockedIndex === 1) {
            $tertiaryEntry = $employees->get(2);
            if ($tertiaryEntry && !empty($tertiaryEntry['model'])) {
                $terId = (int) $tertiaryEntry['id'];
                $terDDMet = true;
                if ($dd > 0 && isset($ddDelayedStarts[2])) {
                    $terDDMet = $gapStartTs >= strtotime($ddDelayedStarts[2]);
                }
                if ($terDDMet && empty($empStarted[$terId])) {
                    $empStarted[$terId] = true;
                    $assisted = true;
                    if ($logProcess) {
                        $logProcess('GAP_ASSIST_UNLOCK', [
                            'employee' => $tertiaryEntry['model']->first_name,
                            'role' => 'tertiary',
                            'reason' => 'secondary_gap_deadend',
                        ]);
                    }
                } elseif ($terDDMet && $this->gapAssistChainDeadendInRange($employees, $task, $gapStartTs, $gapEndTs, 2)) {
                    if ($this->tryGapAssistIncreaseAllocation(
                        $employees,
                        $empStarted,
                        $task,
                        $taskAssignmentDetails,
                        $roundUsage,
                        $gapStartTs,
                        $gapEndTs,
                        $allEmployees,
                        $finalCandidates,
                        $taskId,
                        $logProcess
                    )) {
                        $assisted = true;
                    }
                }
            } elseif ($this->gapAssistChainDeadendInRange($employees, $task, $gapStartTs, $gapEndTs, 1)) {
                if ($this->tryGapAssistIncreaseAllocation(
                    $employees,
                    $empStarted,
                    $task,
                    $taskAssignmentDetails,
                    $roundUsage,
                    $gapStartTs,
                    $gapEndTs,
                    $allEmployees,
                    $finalCandidates,
                    $taskId,
                    $logProcess
                )) {
                    $assisted = true;
                }
            }
        }

        if ($assignGapHours) {
            $placed = $this->assignHelpersInSchedulingGap(
                $employees,
                $empStarted,
                $blockedIndex,
                $gapStartTs,
                $gapEndTs,
                $task,
                $taskAssignmentDetails,
                $roundUsage,
                $totalAssigned,
                $taskId,
                $dd,
                $ddDelayedStarts,
                $logProcess,
                $empMinHours,
                $assignedHoursTracker,
                $spentHrs,
                $roundLimit
            );
            if ($placed > 0.0001) {
                $assisted = true;
                if ($logProcess) {
                    $logProcess('GAP_ASSIST_HOURS_PLACED', [
                        'blocked' => $blockedEmpName,
                        'hours' => round($placed, 2),
                        'gap_start' => date('Y-m-d', $gapStartTs),
                        'gap_end' => date('Y-m-d', $gapEndTs),
                    ]);
                }
            }

            $assignments = $taskAssignmentDetails['assignments'] ?? [];
            $remainingPlan = (float) ($task['Plan'] ?? 0) - $totalAssigned;
            if (
                $remainingPlan > 0.0001
                && $this->gapRangeHasNoTaskHours($assignments, $gapStartTs, $gapEndTs)
                && $this->gapAssistChainDeadendInRange($employees, $task, $gapStartTs, $gapEndTs, max(1, $blockedIndex))
            ) {
                $rosterCountBefore = $employees->count();
                if ($this->tryGapAssistIncreaseAllocation(
                    $employees,
                    $empStarted,
                    $task,
                    $taskAssignmentDetails,
                    $roundUsage,
                    $gapStartTs,
                    $gapEndTs,
                    $allEmployees,
                    $finalCandidates,
                    $taskId,
                    $logProcess
                )) {
                    $assisted = true;
                    $extraPlaced = $this->assignHelpersInSchedulingGap(
                        $employees,
                        $empStarted,
                        $blockedIndex,
                        $gapStartTs,
                        $gapEndTs,
                        $task,
                        $taskAssignmentDetails,
                        $roundUsage,
                        $totalAssigned,
                        $taskId,
                        $dd,
                        $ddDelayedStarts,
                        $logProcess,
                        $empMinHours,
                        $assignedHoursTracker,
                        $spentHrs,
                        $roundLimit,
                        $rosterCountBefore
                    );
                    if ($extraPlaced > 0.0001) {
                        $assisted = true;
                    }
                }
            }
        }

        return $assisted;
    }

    private function adjustTaskPlanByPerformance(array $task, $employees): float
    {
        $plan = is_numeric($task['Plan'] ?? null) ? (float) $task['Plan'] : 0.0;
        if ($plan <= 0) {
            return 0.0;
        }

        $employeeList = collect($employees)
            ->filter()
            ->unique(fn($emp) => $emp->id ?? spl_object_id($emp))
            ->values();

        if ($employeeList->isEmpty()) {
            return $plan;
        }

        $performanceByEmp = [];
        foreach ($employeeList as $emp) {
            $performanceByEmp[$emp->id] = $this->getEmployeePerformanceRate($emp, $task);
        }

        $shares = $this->buildPerformanceShares($employeeList, $performanceByEmp);

        $adjusted = 0.0;
        foreach ($employeeList as $emp) {
            $empId = $emp->id;
            $share = $shares[$empId] ?? 0.0;
            if ($share <= 0) {
                continue;
            }

            $rate = $performanceByEmp[$empId] ?? 1.0;
            $divisor = $rate < 1.0 ? $rate : 1.0;
            if ($divisor <= 0) {
                $divisor = 1.0;
            }

            $adjusted += ($plan * $share) / $divisor;
        }

        return $adjusted > 0 ? $adjusted : $plan;
    }

    private function buildPerformanceShares($employees, array $performanceByEmp): array
    {
        $employeeList = collect($employees)->filter()->values();
        $count = $employeeList->count();
        $shares = [];

        if ($count <= 0) {
            return $shares;
        }

        $trainees = $employeeList->filter(
            fn($emp) => ($performanceByEmp[$emp->id] ?? 1.0) < 1.0
        )->values();
        $experienced = $employeeList->reject(
            fn($emp) => ($performanceByEmp[$emp->id] ?? 1.0) < 1.0
        )->values();

        if ($count === 1) {
            $onlyEmpId = $this->extractEmployeeId($employeeList[0]);
            if ($onlyEmpId !== null) {
                $shares[$onlyEmpId] = 1.0;
            }
            return $shares;
        }

        // 70/30 trainee–operative split (commented out — fall through to equal split below)
        // if ($count === 2 && $trainees->count() === 1 && $experienced->count() === 1) {
        //     $experiencedEmp = $experienced->first();
        //     $traineeEmp = $trainees->first();
        //     $experiencedId = $this->extractEmployeeId($experiencedEmp);
        //     $traineeId = $this->extractEmployeeId($traineeEmp);
        //     if ($experiencedId !== null && $traineeId !== null) {
        //         $shares[$traineeId] = 0.7;
        //         $shares[$experiencedId] = 0.3;
        //     }
        //     return $shares;
        // }

        if ($count === 3 && $trainees->count() === 1 && $experienced->count() === 2) {
            $traineeEmp = $trainees->first();
            $experiencedEmp1 = $experienced->get(0);
            $experiencedEmp2 = $experienced->get(1);
            $traineeId = $this->extractEmployeeId($traineeEmp);
            $experiencedId1 = $this->extractEmployeeId($experiencedEmp1);
            $experiencedId2 = $this->extractEmployeeId($experiencedEmp2);
            if ($traineeId !== null && $experiencedId1 !== null && $experiencedId2 !== null) {
                $shares[$traineeId] = 1 / 5;
                $shares[$experiencedId1] = 2 / 5;
                $shares[$experiencedId2] = 2 / 5;
            }
            return $shares;
        }

        if ($count === 3 && $trainees->count() === 2 && $experienced->count() === 1) {
            $traineeEmp1 = $trainees->get(0);
            $traineeEmp2 = $trainees->get(1);
            $experiencedEmp = $experienced->first();
            $traineeId1 = $this->extractEmployeeId($traineeEmp1);
            $traineeId2 = $this->extractEmployeeId($traineeEmp2);
            $experiencedId = $this->extractEmployeeId($experiencedEmp);
            if ($traineeId1 !== null && $traineeId2 !== null && $experiencedId !== null) {
                $shares[$traineeId1] = 1 / 5;
                $shares[$traineeId2] = 1 / 5;
                $shares[$experiencedId] = 3 / 5;
            }
            return $shares;
        }

        // Fallback to equal split for patterns not explicitly specified.
        $equalShare = 1 / $count;
        foreach ($employeeList as $emp) {
            $empId = $this->extractEmployeeId($emp);
            if ($empId !== null) {
                $shares[$empId] = $equalShare;
            }
        }

        return $shares;
    }

    private function getEmployeePerformanceRate($employeeModel, array $task): float
    {
        $number = $this->extractNumberFromTaskName($task['TaskName'] ?? '');
        if (!$number) {
            return 1.0;
        }

        $nrm = $employeeModel->nrms->firstWhere('number', $number);
        $rawPerformance = $nrm?->pivot?->performance_percentage;

        return $this->normalizePerformanceRate($rawPerformance);
    }

    private function normalizePerformanceRate($rawPerformance): float
    {
        if ($rawPerformance === null || $rawPerformance === '') {
            return 1.0;
        }

        if (is_string($rawPerformance)) {
            $rawPerformance = str_replace('%', '', trim($rawPerformance));
        }

        if (!is_numeric($rawPerformance)) {
            return 1.0;
        }

        $rate = (float) $rawPerformance;
        if ($rate <= 0) {
            return 1.0;
        }

        if ($rate > 1.0) {
            $rate = $rate / 100;
        }

        return ($rate > 0 && $rate <= 1.0) ? $rate : 1.0;
    }

    private function extractEmployeeId($employee): ?int
    {
        if (!is_object($employee) || !isset($employee->id) || !is_numeric($employee->id)) {
            return null;
        }

        return (int) $employee->id;
    }

    /**
     * Hbs (Hours Before Share) = hrsPer: scale non-primary assignment hours vs primary.
     * Adj/Buf: absolute hour deltas on the final plan. Must run before finalize for every path
     * that returns assignments (override/hypermode included).
     */
    private function applyPostAssignmentHrsPerAndBufferAdjustments(
        array &$task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        $toNumeric = function ($value): ?float {
            if ($value === null || $value === '') {
                return null;
            }
            if (is_numeric($value)) {
                return (float) $value;
            }
            if (is_string($value)) {
                $normalized = str_replace(',', '', trim($value));
                if (is_numeric($normalized)) {
                    return (float) $normalized;
                }
            }
            return null;
        };

        $hrsPer = $toNumeric($task['hrsPer'] ?? $task['Hbs'] ?? null);
        if (
            $hrsPer !== null
            && $hrsPer > 0
            && empty($taskAssignmentDetails['_gap_assist_active'])
        ) {
            $primaryEmployee = $taskAssignmentDetails['primary_employee'] ?? null;
            if ($primaryEmployee) {
                $primaryTotal = 0.0;
                $nonPrimaryTotal = 0.0;
                foreach ($taskAssignmentDetails['assignments'] ?? [] as $assignment) {
                    $hours = (float) ($assignment['hours'] ?? 0);
                    if (($assignment['employee'] ?? null) === $primaryEmployee) {
                        $primaryTotal += $hours;
                    } else {
                        $nonPrimaryTotal += $hours;
                    }
                }

                // Hbs/hrsPer is defined relative to primary workload, not relative to current non-primary total.
                // Example: hrsPer=50 => non-primary target = 50% of primary assigned hours.
                if ($primaryTotal > 0.0001) {
                    $targetNonPrimary = $primaryTotal * ($hrsPer / 100.0);
                } else {
                    // Fallback: when primary has no hours yet, keep old behavior to avoid surprising zeroing.
                    $targetNonPrimary = $nonPrimaryTotal * ($hrsPer / 100.0);
                }

                $delta = $targetNonPrimary - $nonPrimaryTotal;
                if (abs($delta) > 0.0001) {
                    $this->applyAssignmentDeltasWithGlobalAvailability(
                        $task,
                        $taskAssignmentDetails['assignments'],
                        $delta,
                        fn($a) => ($a['employee'] ?? null) !== $primaryEmployee,
                        $allEmployees
                    );
                }
            }
        }

        $adjDelta = $toNumeric($task['Adj'] ?? null) ?? 0.0;
        $bufDelta = $toNumeric($task['Buf'] ?? null) ?? 0.0;
        $netDelta = $adjDelta + $bufDelta;
        if (abs($netDelta) > 0.0001) {
            $this->applyAssignmentDeltasWithGlobalAvailability(
                $task,
                $taskAssignmentDetails['assignments'],
                $netDelta,
                null,
                $allEmployees
            );
        }

        $taskAssignmentDetails['end_dates'] = [];
        foreach ($taskAssignmentDetails['assignments'] ?? [] as $assignment) {
            $employee = $assignment['employee'] ?? null;
            $date = $assignment['date'] ?? null;
            if (!$employee || !$date) {
                continue;
            }
            if (
                !isset($taskAssignmentDetails['end_dates'][$employee]) ||
                strtotime($date) > strtotime($taskAssignmentDetails['end_dates'][$employee])
            ) {
                $taskAssignmentDetails['end_dates'][$employee] = $date;
            }
        }
    }

    /**
     * Gap respect + shortest-span passes shared by every finalize exit (all assignment modes).
     */
    private function runUniversalGapAndSpanOptimizationPasses(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }

        if (empty($taskAssignmentDetails['_gap_assist_calendar_repaired'])) {
            $this->compressTaskIntoEarlierGaps($task, $taskAssignmentDetails, $allEmployees);
            $this->compressTaskAcrossEmployeesIntoEarlierGaps($task, $taskAssignmentDetails, $allEmployees);
        }

        $this->collapseInternalAssignmentGaps($task, $taskAssignmentDetails, $allEmployees);

        if (!empty($this->features['optimize_shortest_task_span'])) {
            $this->compressTaskToShortestPeriod($task, $taskAssignmentDetails, $allEmployees);
        }
    }

    private function finalizeRoundedTaskOutput(
        array $task,
        array $taskAssignmentDetails,
        ?float $originalPlan = null,
        $allEmployees = null
    ): array {
        unset($task['_hypermode_trainee_split']);

        if ($originalPlan !== null) {
            $task['Plan'] = $originalPlan;
            $taskAssignmentDetails['Plan'] = $originalPlan;
        }

        // Keep fractional rows (0.25/0.5/etc.) intact; row-level ceil can create artificial gaps.
        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $taskAssignmentDetails['assignments'] = $stats['assignments'];
        $totalsByEmployee = $stats['totals_by_employee'];
        $computedEndDates = $stats['end_dates'];
        $totalAssigned = $stats['total_assigned'];
        $lastGlobalDate = $stats['last_global_date'];

        $plan = is_numeric($task['Plan'] ?? null)
            ? (float) $task['Plan']
            : (is_numeric($taskAssignmentDetails['Plan'] ?? null) ? (float) $taskAssignmentDetails['Plan'] : 0.0);

        // Return adjusted plan as a separate field while preserving original Plan.
        $selectedNames = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
            $taskAssignmentDetails['tertiary_employee'] ?? null,
        ]));
        if (empty($selectedNames)) {
            $selectedNames = array_keys($totalsByEmployee);
        }

        $lookupNames = array_values(array_unique(array_filter(array_merge($selectedNames, array_keys($totalsByEmployee)))));
        $employeesByName = empty($lookupNames)
            ? collect()
            : Employee::with('nrms')->whereIn('first_name', $lookupNames)->get()->keyBy('first_name');

        $selectedEmployees = collect($selectedNames)
            ->map(fn($name) => $employeesByName->get($name))
            ->filter()
            ->values();
        $selectedEmployees = $selectedEmployees->unique(fn($e) => $e->id)->values();

        $taskForAdjustedPlan = $task;
        $taskForAdjustedPlan['Plan'] = $plan;
        $taskForAdjustedPlan['TaskName'] = $task['TaskName'] ?? ($taskAssignmentDetails['task_name'] ?? '');
        $adjustedPlan = $this->adjustTaskPlanByPerformance($taskForAdjustedPlan, $selectedEmployees);

        $flagFromTask = (bool) ($task['performance_subbranch_active']
            ?? $taskAssignmentDetails['performance_subbranch_active']
            ?? false);
        $usePerformanceSubbranch = !empty($this->features['use_performance_subbranch']);
        $adjustedExceedsPlan = $usePerformanceSubbranch && $adjustedPlan > $plan + 0.0001;
        $performanceSubbranchActive = $flagFromTask || $adjustedExceedsPlan;
        if ($performanceSubbranchActive) {
            $taskAssignmentDetails['performance_subbranch_active'] = true;
        }
        $validationPlan = $performanceSubbranchActive ? max($plan, $adjustedPlan) : $plan;

        if (
            !empty($taskAssignmentDetails['_gap_assist_active'])
            && $plan > 0.0001
            && $totalAssigned > $plan + 0.0001
        ) {
            $this->trimTaskAssignmentsAbovePlan($task, $taskAssignmentDetails, $plan, $allEmployees);
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $taskAssignmentDetails['assignments'] = $stats['assignments'];
            $totalsByEmployee = $stats['totals_by_employee'];
            $computedEndDates = $stats['end_dates'];
            $totalAssigned = $stats['total_assigned'];
        }

        $remaining = $validationPlan - $totalAssigned;
        $modeNow = (string) ($taskAssignmentDetails['mode'] ?? '');
        $toNumeric = function ($value): ?float {
            if ($value === null || $value === '') {
                return null;
            }
            if (is_numeric($value)) {
                return (float) $value;
            }
            if (is_string($value)) {
                $normalized = str_replace(',', '', trim($value));
                if (is_numeric($normalized)) {
                    return (float) $normalized;
                }
            }
            return null;
        };
        $ddValue = isset($task['DD']) && is_numeric($task['DD']) ? (int) $task['DD'] : 0;
        $hrsPerOrHbs = $toNumeric($task['hrsPer'] ?? $task['Hbs'] ?? null);
        $preserveOverrideConstraints = in_array($modeNow, ['HYPERMODE_OVERRIDE_EVEN_SPLIT', 'OVERRIDE_HARD_SLOT'], true)
            && ($ddValue > 0 || ($hrsPerOrHbs !== null && $hrsPerOrHbs > 0));

        // Final catch-up:
        // - for synchronized 2-person default pair tasks: spread extra hours across both
        // - otherwise: keep trainee-focused catch-up
        if (!$preserveOverrideConstraints && $remaining > 0.0001 && !empty($totalsByEmployee)) {
            $taskForPerformance = [
                'TaskName' => $task['TaskName'] ?? $taskAssignmentDetails['task_name'] ?? '',
            ];
            $isDefaultPairTask = $this->isDefaultTraineePairActivityTask($task);

            if ($isDefaultPairTask && $selectedEmployees->count() >= 2 && $allEmployees) {
                $syncModels = $selectedEmployees
                    ->map(function ($emp) use ($allEmployees) {
                        if (!$emp) {
                            return null;
                        }
                        $live = $allEmployees->first(fn($e) => (int) $e->id === (int) $emp->id);
                        return $live ?? $emp;
                    })
                    ->filter()
                    ->values();

                $remainingCatchup = (float) $remaining;
                $guard = 0;
                while ($remainingCatchup > 0.0001 && $guard++ < 300) {
                    $progress = false;
                    foreach ($syncModels as $emp) {
                        if ($remainingCatchup <= 0.0001) {
                            break;
                        }
                        // Small alternating slices keep synchronized assignees balanced day-by-day.
                        $slice = min(4.0, $remainingCatchup);
                        $left = $this->appendExtraHoursOnAvailableDates(
                            $task,
                            $emp,
                            $taskAssignmentDetails['assignments'],
                            $slice
                        );
                        $placed = $slice - $left;
                        if ($placed > 0.0001) {
                            $remainingCatchup -= $placed;
                            $progress = true;
                        }
                    }
                    if (!$progress) {
                        break;
                    }
                }
            } else {
            $traineeName = null;
            $lowestRate = 1.0;

            foreach (array_keys($totalsByEmployee) as $employeeName) {
                $employee = $employeesByName->get($employeeName);
                if (!$employee) {
                    continue;
                }
                $rate = $this->getEmployeePerformanceRate($employee, $taskForPerformance);
                if ($rate > 0 && $rate < 1.0 && $rate <= $lowestRate) {
                    $lowestRate = $rate;
                    $traineeName = $employeeName;
                }
            }

            if ($traineeName !== null) {
                $extraHours = (float) $remaining;
                if ($extraHours > 0.0001) {
                    $traineeModel = $allEmployees
                        ? $allEmployees->first(fn($e) => $e->first_name === $traineeName)
                        : null;
                    if (!$traineeModel) {
                        $traineeModel = $employeesByName->get($traineeName);
                    }
                    if ($traineeModel && $allEmployees) {
                        $live = $allEmployees->first(fn($e) => (int) $e->id === (int) $traineeModel->id);
                        if ($live) {
                            $traineeModel = $live;
                        }
                        $remainingCatchup = (float) $extraHours;
                        $this->appendExtraHoursOnAvailableDates(
                            $task,
                            $traineeModel,
                            $taskAssignmentDetails['assignments'],
                            $remainingCatchup
                        );
                    } elseif ($traineeModel) {
                        // Legacy catch-up (no $allEmployees): still respect the trainee's
                        // real in-memory availability calendar instead of blindly advancing days.
                        $remainingCatchup = (float) $extraHours;
                        $this->appendExtraHoursOnAvailableDates(
                            $task,
                            $traineeModel,
                            $taskAssignmentDetails['assignments'],
                            $remainingCatchup
                        );
                    }
                }
            }
            }
        }

        // Universal staging across modes:
        // - after initial cap, #2 catches #1 before both continue
        // - with #3, #1/#2 pause at cap while #3 catches up
        $this->enforceUniversalRoundLimitCatchupStaging($task, $taskAssignmentDetails, $allEmployees);

        // DD-aware gap/span optimization — all modes (uses isRationalDdAlignmentDate on every move).
        $this->runUniversalGapAndSpanOptimizationPasses($task, $taskAssignmentDetails, $allEmployees);

        if (!$preserveOverrideConstraints) {
            // Cosmetic / trainee alignment passes (skipped when explicit DD/Hbs must not be reshaped).
            $this->enforceSynchronizedPairSameEndDate($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceOverrideHardSlotSameEndDate($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceHardSlotTraineeOverlap($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceHardSlotSingleEndDate($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceALParticipationBalance($taskAssignmentDetails, $allEmployees);
            $this->enforceTinyLateTailCompression($taskAssignmentDetails, $allEmployees, $task);
            $this->enforceTwoPersonStartOrEndAlignment($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceHypermodeTwoPersonShTarget($task, $taskAssignmentDetails, $allEmployees);
        } elseif ($allEmployees) {
            // Still absorb micro-tails when preserveOverrideConstraints skips other cosmetic passes
            // (gap/span passes can re-open tiny last-day splits; Hbs/DD preserve does not require keeping them).
            $this->enforceTinyLateTailCompression($taskAssignmentDetails, $allEmployees, $task);
            $this->enforceHypermodeTwoPersonShTarget($task, $taskAssignmentDetails, $allEmployees);
        }

        // General rule: assign up to validation_plan, never over (trim tail / exhaust remainder).
        $this->enforceAssignmentTotalsToValidationPlan(
            $task,
            $taskAssignmentDetails,
            (float) $validationPlan,
            $allEmployees,
            $selectedEmployees
        );

        // After plan fill: two-person alignment (same-end always; same-start only when DD=0).
        if ($selectedEmployees->count() === 2) {
            $this->enforceTwoPersonStartOrEndAlignment($task, $taskAssignmentDetails, $allEmployees);
            if ($this->isDefaultTraineePairActivityTask($task)) {
                $this->enforceSynchronizedPairSameEndDate($task, $taskAssignmentDetails, $allEmployees);
            }
            $this->trimTaskAssignmentsAbovePlan($task, $taskAssignmentDetails, (float) $validationPlan, $allEmployees);
        }

        // Recompute totals/end_dates after trainee catch-up and end-date synchronization.
        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $taskAssignmentDetails['assignments'] = $stats['assignments'];
        $totalsByEmployee = $stats['totals_by_employee'];
        $computedEndDates = $stats['end_dates'];
        $totalAssigned = $stats['total_assigned'];

        if ($totalAssigned > $validationPlan + 0.0001) {
            $this->trimTaskAssignmentsAbovePlan($task, $taskAssignmentDetails, (float) $validationPlan, $allEmployees);
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $taskAssignmentDetails['assignments'] = $stats['assignments'];
            $totalsByEmployee = $stats['totals_by_employee'];
            $computedEndDates = $stats['end_dates'];
            $totalAssigned = $stats['total_assigned'];
        }

        $this->runUniversalGapAndSpanOptimizationPasses($task, $taskAssignmentDetails, $allEmployees);

        // Universal gap/span passes can recreate a solo sub-hour last day; compress again before totals.
        if ($allEmployees) {
            $this->enforceTinyLateTailCompression($taskAssignmentDetails, $allEmployees, $task);
            $this->enforceNoAssignmentsBeforeTaskStart($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceOverrideAssignmentsRespectDdStarts($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceHypermodeTwoPersonShTarget($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceHypermodeTwoPersonContiguousPlacement($task, $taskAssignmentDetails, $allEmployees);
            $this->enforceTinyLateTailCompression($taskAssignmentDetails, $allEmployees, $task);
            $this->enforceOverrideAssignmentsRespectDdStarts($task, $taskAssignmentDetails, $allEmployees);
        }

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $taskAssignmentDetails['assignments'] = $stats['assignments'];
        $totalsByEmployee = $stats['totals_by_employee'];
        $computedEndDates = $stats['end_dates'];
        $totalAssigned = $stats['total_assigned'];

        $remaining = round($validationPlan - $totalAssigned, 4);
        $isOverAssigned = $remaining < -0.0001;

        $mode = (string) ($taskAssignmentDetails['mode'] ?? '');
        $partialSchedulingModes = [
            'HYPERMODE_OVERRIDE_EVEN_SPLIT',
            'HYPERMODE_TRAINEE_BUMP_TWO_SLOT',
            'OVERRIDE_HARD_SLOT',
            'AL',
        ];
        $allowsPartialScheduling = in_array($mode, $partialSchedulingModes, true) || $mode === '';
        $isValid = !$isOverAssigned && ($remaining <= 0.0001 || $allowsPartialScheduling);

        $taskAssignmentDetails['totals_by_employee'] = $totalsByEmployee;
        $taskAssignmentDetails['total_assigned'] = $totalAssigned;
        $taskAssignmentDetails['remaining'] = $remaining;
        $taskAssignmentDetails['adjusted_plan'] = $adjustedPlan;
        $taskAssignmentDetails['validation_plan'] = $validationPlan;
        $taskAssignmentDetails['SH'] = is_numeric($task['SH'] ?? null) ? (float) $task['SH'] : null;
        $taskAssignmentDetails['end_dates'] = $computedEndDates;
        $taskAssignmentDetails['is_valid'] = $isValid;
        $taskAssignmentDetails['is_over_assigned'] = $isOverAssigned;
        $taskAssignmentDetails['allows_partial_scheduling'] = $allowsPartialScheduling;
        $task['adjusted_plan'] = $adjustedPlan;

        return [$task, $taskAssignmentDetails];
    }

    /**
     * Final hard guard: no assignment row may be before Doc_Supply.
     * Relocates out-of-window early rows to in-window availability for the same employee.
     */
    private function enforceNoAssignmentsBeforeTaskStart(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees || empty($task['Doc_Supply'])) {
            return;
        }

        $taskStart = Carbon::parse($task['Doc_Supply'])->startOfDay()->toDateString();
        $removedByEmployee = [];
        $kept = [];

        foreach ($taskAssignmentDetails['assignments'] ?? [] as $row) {
            $name = $row['employee'] ?? null;
            $date = $row['date'] ?? null;
            $hours = is_numeric($row['hours'] ?? null) ? (float) $row['hours'] : 0.0;
            if (!$name || !$date || $hours <= 0.0001) {
                continue;
            }
            if ($date < $taskStart) {
                $removedByEmployee[$name] = ($removedByEmployee[$name] ?? 0.0) + $hours;
                $empModel = $allEmployees->first(fn($e) => $e->first_name === $name);
                if ($empModel) {
                    $this->restoreGlobalAvailability($empModel, $date, $hours);
                }
                continue;
            }
            $kept[] = $row;
        }

        if (empty($removedByEmployee)) {
            return;
        }

        $taskAssignmentDetails['assignments'] = $kept;
        foreach ($removedByEmployee as $name => $hours) {
            $empModel = $allEmployees->first(fn($e) => $e->first_name === $name);
            if (!$empModel || $hours <= 0.0001) {
                continue;
            }
            $left = $this->appendExtraHoursOnAvailableDates($task, $empModel, $taskAssignmentDetails['assignments'], (float) $hours);
            if ($left > 0.0001) {
                // Keep schedule valid even under constrained capacity.
                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $name,
                    'date' => $taskStart,
                    'hours' => $left,
                ];
            }
        }

        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    }

    private function resolveUniversalCatchupCap(array $task, array $taskAssignmentDetails): float
    {
        $sh = $task['SH'] ?? ($taskAssignmentDetails['SH'] ?? null);
        if (is_numeric($sh) && (float) $sh > 0.0001) {
            return (float) $sh;
        }

        return 40.0;
    }

    private function enforceUniversalRoundLimitCatchupStaging(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }

        $orderedNames = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
            $taskAssignmentDetails['tertiary_employee'] ?? null,
        ]));
        if (count($orderedNames) < 2) {
            return;
        }

        $shValue = $task['SH'] ?? ($taskAssignmentDetails['SH'] ?? null);
        $mode = (string) ($taskAssignmentDetails['mode'] ?? '');
        // Hypermode + explicit SH: primary gets min(plan, SH), secondary gets remainder — not equal catch-up.
        if (
            $mode === 'HYPERMODE_OVERRIDE_EVEN_SPLIT'
            && is_numeric($shValue)
            && (float) $shValue > 0.0001
            && count($orderedNames) === 2
        ) {
            return;
        }

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $totals = $stats['totals_by_employee'] ?? [];
        $cap = $this->resolveUniversalCatchupCap($task, $taskAssignmentDetails);
        $maxDate = collect($stats['assignments'] ?? [])->pluck('date')->filter()->max();
        if (!$maxDate) {
            return;
        }

        $first = $orderedNames[0];
        $second = $orderedNames[1];
        $firstTotal = (float) ($totals[$first] ?? 0.0);
        $secondTotal = (float) ($totals[$second] ?? 0.0);
        $totalTwo = $firstTotal + $secondTotal;
        // When SH is not set and total is below 2*cap, catch-up should still happen by
        // equalizing available total between the first two assignees (not freezing at cap).
        $secondTarget = min($firstTotal, $cap);
        if ((!is_numeric($shValue) || (float) $shValue <= 0.0001) && $totalTwo + 0.0001 < (2.0 * $cap)) {
            $secondTarget = min($firstTotal, $totalTwo / 2.0);
        }
        if ($secondTotal + 0.0001 < $secondTarget) {
            $need = $secondTarget - $secondTotal;
            $donorBudget = [
                $first => max(0.0, $firstTotal - $secondTarget),
            ];
            $this->moveHoursFromDonorsToRecipientForCatchup(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedNames,
                $donorBudget,
                $second,
                $need,
                $maxDate
            );
        }
        if (!is_numeric($shValue) || (float) $shValue <= 0.0001) {
            $this->enforcePostCapTwoPersonBalance(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedNames,
                $cap,
                $maxDate
            );
        }

        if (count($orderedNames) < 3) {
            if (!is_numeric($shValue) || (float) $shValue <= 0.0001) {
                $this->enforcePostCapTargetDistribution(
                    $task,
                    $taskAssignmentDetails,
                    $allEmployees,
                    $orderedNames,
                    $cap,
                    $maxDate
                );
            }
            return;
        }

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $totals = $stats['totals_by_employee'] ?? [];
        $firstTotal = (float) ($totals[$first] ?? 0.0);
        $secondTotal = (float) ($totals[$second] ?? 0.0);
        $third = $orderedNames[2];
        $thirdTotal = (float) ($totals[$third] ?? 0.0);
        $thirdTarget = min($cap, $firstTotal, $secondTotal);
        if ($thirdTotal + 0.0001 < $thirdTarget) {
            $need = $thirdTarget - $thirdTotal;
            $donorBudget = [
                $first => max(0.0, $firstTotal - $thirdTarget),
                $second => max(0.0, $secondTotal - $thirdTarget),
            ];
            $this->moveHoursFromDonorsToRecipientForCatchup(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedNames,
                $donorBudget,
                $third,
                $need,
                $maxDate
            );
        }

        if (!is_numeric($shValue) || (float) $shValue <= 0.0001) {
            $this->enforcePostCapThreePersonBalance(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedNames,
                $cap,
                $maxDate
            );
            $this->enforcePostCapTargetDistribution(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedNames,
                $cap,
                $maxDate
            );
        }
    }

    /**
     * Stable post-cap balancer:
     * distribute all hours above cap evenly across selected assignees while preferring
     * transfers from later finishers to earlier finishers.
     */
    private function enforcePostCapTargetDistribution(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees,
        array $orderedNames,
        float $cap,
        string $maxDate
    ): void {
        if (!$allEmployees || $cap <= 0.0001 || count($orderedNames) < 2) {
            return;
        }
        $names = array_values(array_unique(array_filter($orderedNames)));
        $guard = 0;
        while ($guard++ < 24) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $totals = $stats['totals_by_employee'] ?? [];
            $endDates = $stats['end_dates'] ?? [];

            foreach ($names as $n) {
                if ((float) ($totals[$n] ?? 0.0) + 0.0001 < $cap) {
                    return;
                }
            }

            $extraTotal = 0.0;
            foreach ($names as $n) {
                $extraTotal += max(0.0, (float) ($totals[$n] ?? 0.0) - $cap);
            }
            if ($extraTotal <= 0.0001) {
                return;
            }

            $target = $cap + ($extraTotal / count($names));
            $over = [];
            $under = [];
            foreach ($names as $n) {
                $t = (float) ($totals[$n] ?? 0.0);
                $surplus = $t - $target;
                $deficit = $target - $t;
                if ($surplus > 0.05) {
                    $over[] = ['name' => $n, 'surplus' => $surplus, 'end' => (string) ($endDates[$n] ?? '')];
                } elseif ($deficit > 0.05) {
                    $under[] = ['name' => $n, 'deficit' => $deficit, 'end' => (string) ($endDates[$n] ?? '')];
                }
            }
            if (empty($over) || empty($under)) {
                return;
            }

            usort($over, function ($a, $b) {
                $cmp = strcmp((string) $b['end'], (string) $a['end']); // later finisher first
                if ($cmp !== 0) {
                    return $cmp;
                }
                return ($b['surplus'] <=> $a['surplus']);
            });
            usort($under, function ($a, $b) {
                $cmp = strcmp((string) $a['end'], (string) $b['end']); // earlier finisher first
                if ($cmp !== 0) {
                    return $cmp;
                }
                return ($b['deficit'] <=> $a['deficit']);
            });

            $moved = false;
            foreach ($over as $o) {
                foreach ($under as $u) {
                    if ($o['name'] === $u['name']) {
                        continue;
                    }
                    $need = min((float) $o['surplus'], (float) $u['deficit']);
                    if ($need <= 0.05) {
                        continue;
                    }
                    $beforeRows = json_encode(
                        $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false)['assignments'] ?? []
                    );
                    $this->moveHoursFromDonorsToRecipientForCatchup(
                        $task,
                        $taskAssignmentDetails,
                        $allEmployees,
                        $names,
                        [$o['name'] => (float) $o['surplus']],
                        $u['name'],
                        $need,
                        $maxDate
                    );
                    $afterRows = json_encode(
                        $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false)['assignments'] ?? []
                    );
                    if ($afterRows !== $beforeRows) {
                        $moved = true;
                        break 2;
                    }
                }
            }
            if (!$moved) {
                return;
            }
        }
    }

    private function enforcePostCapTwoPersonBalance(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees,
        array $orderedNames,
        float $cap,
        string $maxDate
    ): void {
        if (count($orderedNames) < 2 || $cap <= 0.0001) {
            return;
        }

        $a = $orderedNames[0];
        $b = $orderedNames[1];
        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $totals = $stats['totals_by_employee'] ?? [];
        $endDates = $stats['end_dates'] ?? [];
        $aTotal = (float) ($totals[$a] ?? 0.0);
        $bTotal = (float) ($totals[$b] ?? 0.0);

        // Both must have reached cap first; then split post-cap load more evenly.
        if ($aTotal + 0.0001 < $cap || $bTotal + 0.0001 < $cap) {
            return;
        }

        $extraA = max(0.0, $aTotal - $cap);
        $extraB = max(0.0, $bTotal - $cap);
        $extraTotal = $extraA + $extraB;
        if ($extraTotal <= 0.0001) {
            return;
        }

        $target = $cap + ($extraTotal / 2.0);
        $orderedPair = [$a, $b];

        // Hybrid rule: prefer moving from later-finisher to earlier-finisher
        // so we keep day-by-day overlap while still balancing totals.
        $aEnd = (string) ($endDates[$a] ?? '');
        $bEnd = (string) ($endDates[$b] ?? '');
        if (
            $aTotal > $target + 0.0001
            && $bTotal + 0.0001 < $target
            && $aEnd !== ''
            && $bEnd !== ''
            && $aEnd >= $bEnd
        ) {
            $this->moveHoursFromDonorsToRecipientForCatchup(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedPair,
                [$a => max(0.0, $aTotal - $target)],
                $b,
                max(0.0, $target - $bTotal),
                $maxDate
            );
            return;
        }
        if (
            $bTotal > $target + 0.0001
            && $aTotal + 0.0001 < $target
            && $aEnd !== ''
            && $bEnd !== ''
            && $bEnd >= $aEnd
        ) {
            $this->moveHoursFromDonorsToRecipientForCatchup(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedPair,
                [$b => max(0.0, $bTotal - $target)],
                $a,
                max(0.0, $target - $aTotal),
                $maxDate
            );
            return;
        }

        if ($aTotal > $target + 0.0001 && $bTotal + 0.0001 < $target) {
            $this->moveHoursFromDonorsToRecipientForCatchup(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedPair,
                [$a => max(0.0, $aTotal - $target)],
                $b,
                max(0.0, $target - $bTotal),
                $maxDate
            );
            return;
        }

        if ($bTotal > $target + 0.0001 && $aTotal + 0.0001 < $target) {
            $this->moveHoursFromDonorsToRecipientForCatchup(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $orderedPair,
                [$b => max(0.0, $bTotal - $target)],
                $a,
                max(0.0, $target - $aTotal),
                $maxDate
            );
        }
    }

    private function enforcePostCapThreePersonBalance(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees,
        array $orderedNames,
        float $cap,
        string $maxDate
    ): void {
        $top3 = array_slice($orderedNames, 0, 3);
        if (count($top3) < 3 || $cap <= 0.0001) {
            return;
        }

        $guard = 0;
        while ($guard++ < 12) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $totals = $stats['totals_by_employee'] ?? [];
            $endDates = $stats['end_dates'] ?? [];
            $t1 = (float) ($totals[$top3[0]] ?? 0.0);
            $t2 = (float) ($totals[$top3[1]] ?? 0.0);
            $t3 = (float) ($totals[$top3[2]] ?? 0.0);

            if ($t1 + 0.0001 < $cap || $t2 + 0.0001 < $cap || $t3 + 0.0001 < $cap) {
                return;
            }

            $extras = [
                $top3[0] => max(0.0, $t1 - $cap),
                $top3[1] => max(0.0, $t2 - $cap),
                $top3[2] => max(0.0, $t3 - $cap),
            ];
            $extraTotal = array_sum($extras);
            if ($extraTotal <= 0.0001) {
                return;
            }
            $target = $cap + ($extraTotal / 3.0);

            $sorted = [
                ['name' => $top3[0], 'total' => $t1],
                ['name' => $top3[1], 'total' => $t2],
                ['name' => $top3[2], 'total' => $t3],
            ];
            usort($sorted, fn($a, $b) => ($b['total'] <=> $a['total']));
            $donor = null;
            $recipient = null;

            $donorCandidates = array_values(array_filter($sorted, fn($x) => (float) $x['total'] > $target + 0.0001));
            usort($donorCandidates, function ($a, $b) use ($endDates) {
                $ea = (string) ($endDates[$a['name']] ?? '');
                $eb = (string) ($endDates[$b['name']] ?? '');
                $cmp = strcmp($eb, $ea); // later end first
                if ($cmp !== 0) {
                    return $cmp;
                }
                return ($b['total'] <=> $a['total']);
            });

            $recipientCandidates = array_values(array_filter($sorted, fn($x) => (float) $x['total'] + 0.0001 < $target));
            usort($recipientCandidates, function ($a, $b) use ($endDates) {
                $ea = (string) ($endDates[$a['name']] ?? '');
                $eb = (string) ($endDates[$b['name']] ?? '');
                $cmp = strcmp($ea, $eb); // earlier end first
                if ($cmp !== 0) {
                    return $cmp;
                }
                return ($a['total'] <=> $b['total']);
            });

            foreach ($donorCandidates as $d) {
                foreach ($recipientCandidates as $r) {
                    if ($d['name'] === $r['name']) {
                        continue;
                    }
                    $dEnd = (string) ($endDates[$d['name']] ?? '');
                    $rEnd = (string) ($endDates[$r['name']] ?? '');
                    if ($dEnd !== '' && $rEnd !== '' && $dEnd >= $rEnd) {
                        $donor = $d;
                        $recipient = $r;
                        break 2;
                    }
                }
            }
            if ($donor === null || $recipient === null) {
                // Fallback to total-only balancing if no end-date-compatible pair exists.
                $donor = $sorted[0];
                $recipient = $sorted[2];
            }

            $donorExcess = max(0.0, (float) $donor['total'] - $target);
            $recipientNeed = max(0.0, $target - (float) $recipient['total']);
            $moveNeed = min($donorExcess, $recipientNeed);
            if ($moveNeed <= 0.25) {
                break;
            }

            $this->moveHoursFromDonorsToRecipientForCatchup(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $top3,
                [$donor['name'] => $donorExcess],
                $recipient['name'],
                $moveNeed,
                $maxDate
            );
        }
    }

    /**
     * After post-cap catch-up: extend early finishers onto shared working days by moving
     * hours from the latest finisher (calendar continuity, not only total deficit).
     */
    private function enforcePostCapSharedWindowContinuation(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees,
        array $orderedNames,
        float $cap,
        string $maxDate
    ): void {
        if (count($orderedNames) < 2 || !$allEmployees || $cap <= 0.0001) {
            return;
        }

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $totals = $stats['totals_by_employee'] ?? [];
        foreach ($orderedNames as $n) {
            if ((float) ($totals[$n] ?? 0.0) + 0.0001 < $cap) {
                return;
            }
        }

        $endDates = $stats['end_dates'] ?? [];
        $globalEnd = collect($endDates)->filter()->max();
        if (!$globalEnd) {
            return;
        }

        $datesOnRow = [];
        foreach ($taskAssignmentDetails['assignments'] ?? [] as $a) {
            $n = $a['employee'] ?? null;
            $d = $a['date'] ?? null;
            if ($n && $d) {
                $datesOnRow[$n][$d] = true;
            }
        }

        $sharedDates = collect($taskAssignmentDetails['assignments'] ?? [])
            ->pluck('date')
            ->filter(fn($d) => !empty($d) && $d <= $globalEnd)
            ->unique()
            ->sort()
            ->values()
            ->all();

        $latestNames = array_values(array_filter(
            $orderedNames,
            fn($n) => ((string) ($endDates[$n] ?? '')) === (string) $globalEnd
        ));
        if (empty($latestNames)) {
            return;
        }

        foreach ($orderedNames as $recipientName) {
            $recipientEnd = (string) ($endDates[$recipientName] ?? '');
            if ($recipientEnd === '' || $recipientEnd >= $globalEnd) {
                continue;
            }

            $recipientModel = $allEmployees->first(fn($e) => $e->first_name === $recipientName);
            if (!$recipientModel) {
                continue;
            }

            foreach ($sharedDates as $date) {
                if ($date <= $recipientEnd || $date > $globalEnd) {
                    continue;
                }
                if (!empty($datesOnRow[$recipientName][$date])) {
                    continue;
                }

                $othersOnDay = 0;
                foreach ($orderedNames as $other) {
                    if ($other === $recipientName) {
                        continue;
                    }
                    if (!empty($datesOnRow[$other][$date])) {
                        $othersOnDay++;
                    }
                }
                if ($othersOnDay < 1) {
                    continue;
                }

                $room = $this->getGlobalRemainingHoursOnDate($recipientModel, $date);
                if ($room <= 0.0001) {
                    continue;
                }

                $donorBudget = [];
                foreach ($latestNames as $donorName) {
                    if ($donorName === $recipientName) {
                        continue;
                    }
                    $donorBudget[$donorName] = 8.0;
                }
                if (empty($donorBudget)) {
                    continue;
                }

                $sliceNeed = min($room, 8.0);
                $this->moveHoursFromDonorsToRecipientForCatchup(
                    $task,
                    $taskAssignmentDetails,
                    $allEmployees,
                    $orderedNames,
                    $donorBudget,
                    $recipientName,
                    $sliceNeed,
                    $maxDate,
                    [$date]
                );

                $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
                $endDates = $stats['end_dates'] ?? [];
                $datesOnRow = [];
                foreach ($stats['assignments'] ?? [] as $a) {
                    $n = $a['employee'] ?? null;
                    $d = $a['date'] ?? null;
                    if ($n && $d) {
                        $datesOnRow[$n][$d] = true;
                    }
                }
                if (((string) ($endDates[$recipientName] ?? '')) >= $globalEnd) {
                    break;
                }
            }
        }
    }

    private function moveHoursFromDonorsToRecipientForCatchup(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees,
        array $orderedNames,
        array $donorBudgetByName,
        string $recipientName,
        float $needHours,
        string $maxDate,
        ?array $restrictRecipientDates = null
    ): void {
        if ($needHours <= 0.0001) {
            return;
        }
        $recipientModel = $allEmployees->first(fn($e) => $e->first_name === $recipientName);
        if (!$recipientModel) {
            return;
        }

        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $orderedNames);
        $recipientDates = collect($taskAssignmentDetails['assignments'] ?? [])
            ->filter(fn($a) => ($a['employee'] ?? null) === $recipientName && !empty($a['date']))
            ->pluck('date')
            ->concat(collect($recipientModel->availabilities ?? [])->pluck('date'))
            ->filter(fn($d) => !empty($d) && $d <= $maxDate)
            ->unique()
            ->sortDesc()
            ->values()
            ->all();
        if ($restrictRecipientDates !== null && $restrictRecipientDates !== []) {
            $allowed = array_flip($restrictRecipientDates);
            $recipientDates = array_values(array_filter($recipientDates, fn($d) => isset($allowed[$d])));
        }
        if (empty($recipientDates)) {
            return;
        }

        $donorRows = [];
        foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
            $name = $a['employee'] ?? null;
            $date = $a['date'] ?? null;
            if (!$name || !$date || $date > $maxDate) {
                continue;
            }
            if (!isset($donorBudgetByName[$name]) || (float) ($donorBudgetByName[$name] ?? 0.0) <= 0.0001) {
                continue;
            }
            $donorRows[] = ['idx' => $idx, 'name' => $name, 'date' => $date];
        }
        usort($donorRows, fn($a, $b) => strcmp($b['date'], $a['date']));

        foreach ($donorRows as $row) {
            if ($needHours <= 0.0001) {
                break;
            }
            $idx = $row['idx'];
            $donorName = $row['name'];
            $fromDate = $row['date'];
            $donorModel = $allEmployees->first(fn($e) => $e->first_name === $donorName);
            if (!$donorModel || !isset($taskAssignmentDetails['assignments'][$idx])) {
                continue;
            }

            $budgetLeft = (float) ($donorBudgetByName[$donorName] ?? 0.0);
            if ($budgetLeft <= 0.0001) {
                continue;
            }
            $left = min((float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0), $budgetLeft, $needHours);
            if ($left <= 0.0001) {
                continue;
            }

            foreach ($recipientDates as $toDate) {
                if ($left <= 0.0001 || $needHours <= 0.0001) {
                    break;
                }
                if (
                    !$this->isRationalDdAlignmentDate(
                        $recipientName,
                        $toDate,
                        $ddStartsByName,
                        $taskAssignmentDetails['assignments'] ?? []
                    )
                ) {
                    continue;
                }
                if (
                    $fromDate === $toDate
                    && !$this->isRationalDdSameDateAlignment(
                        $task,
                        $recipientName,
                        $donorName,
                        $toDate,
                        $ddStartsByName,
                        $taskAssignmentDetails['assignments'] ?? [],
                        true
                    )
                ) {
                    continue;
                }

                $room = $this->getGlobalRemainingHoursOnDate($recipientModel, $toDate);
                if ($room <= 0.0001) {
                    continue;
                }
                $move = min($left, $room, $needHours, (float) ($donorBudgetByName[$donorName] ?? 0.0));
                if ($move <= 0.0001) {
                    continue;
                }

                $newDonor = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                if ($newDonor <= 0.0001) {
                    unset($taskAssignmentDetails['assignments'][$idx]);
                } else {
                    $taskAssignmentDetails['assignments'][$idx]['hours'] = $newDonor;
                }

                $targetIdx = null;
                foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                    if (($a['employee'] ?? null) === $recipientName && ($a['date'] ?? null) === $toDate) {
                        $targetIdx = $j;
                        break;
                    }
                }
                if ($targetIdx !== null) {
                    $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                        (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                } else {
                    $taskAssignmentDetails['assignments'][] = [
                        'employee' => $recipientName,
                        'date' => $toDate,
                        'hours' => $move,
                    ];
                }

                $this->restoreGlobalAvailability($donorModel, $fromDate, $move);
                $this->updateGlobalAvailability($recipientModel, $toDate, $move);

                $donorBudgetByName[$donorName] = max(0.0, (float) ($donorBudgetByName[$donorName] ?? 0.0) - $move);
                $left -= $move;
                $needHours -= $move;
            }
        }

        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments'] ?? []);
    }

    private function computeAssignmentStats(array $assignments, bool $normalizeHours = false): array
    {
        // Merge duplicate (employee, date) rows first so downstream timeline is compact/stable.
        $merged = [];
        foreach ($assignments as $assignment) {
            $employeeName = (string) ($assignment['employee'] ?? '');
            $date = (string) ($assignment['date'] ?? '');
            if ($employeeName === '' || $date === '') {
                continue;
            }
            $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;
            $hours = round($hours, 4);
            $key = $employeeName . '|' . $date;
            if (!isset($merged[$key])) {
                $merged[$key] = [
                    'employee' => $employeeName,
                    'date' => $date,
                    'hours' => 0.0,
                ];
            }
            $merged[$key]['hours'] = round($merged[$key]['hours'] + $hours, 4);
        }

        $assignments = array_values($merged);
        usort($assignments, function ($a, $b) {
            $dCmp = strcmp((string) ($a['date'] ?? ''), (string) ($b['date'] ?? ''));
            if ($dCmp !== 0) {
                return $dCmp;
            }
            return strcmp((string) ($a['employee'] ?? ''), (string) ($b['employee'] ?? ''));
        });

        $totalsByEmployee = [];
        $endDates = [];
        $totalAssigned = 0.0;
        $lastGlobalDate = null;

        foreach ($assignments as &$assignment) {
            $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;
            if ($normalizeHours) {
                $hours = (int) ceil(max(0.0, $hours));
                $assignment['hours'] = $hours;
            }

            $employeeName = (string) ($assignment['employee'] ?? '');
            $date = (string) ($assignment['date'] ?? '');
            if ($employeeName === '') {
                continue;
            }

            $totalsByEmployee[$employeeName] = ($totalsByEmployee[$employeeName] ?? 0) + $hours;
            $totalAssigned += $hours;

            if ($date !== '' && (!isset($endDates[$employeeName]) || $date > $endDates[$employeeName])) {
                $endDates[$employeeName] = $date;
            }
            if ($date !== '' && ($lastGlobalDate === null || $date > $lastGlobalDate)) {
                $lastGlobalDate = $date;
            }
        }
        unset($assignment);

        return [
            'assignments' => $assignments,
            'totals_by_employee' => $totalsByEmployee,
            'end_dates' => $endDates,
            'total_assigned' => $totalAssigned,
            'last_global_date' => $lastGlobalDate,
        ];
    }

    private function updateGlobalAvailability($employeeModel, string $date, float $hoursAssigned): void
    {
        foreach ($employeeModel->availabilities as $index => $ava) {
            if (($ava->date ?? null) === $date) {
                // Keep a stable per-employee calendar order for later passes.
                // Only update remaining hours; do not reorder or remove days.
                $ava->Total = max(0, $this->convertToHours($ava->Total ?? 0) - $hoursAssigned);
                break;
            }
        }
    }

    /** Remaining free hours on an employee's in-memory calendar (after earlier tasks in this run). */
    private function getGlobalRemainingHoursOnDate($employeeModel, string $date): float
    {
        foreach ($employeeModel->availabilities ?? [] as $ava) {
            if (($ava->date ?? null) === $date) {
                return max(0.0, $this->convertToHours($ava->Total ?? 0));
            }
        }
        return 0.0;
    }

    /** Restore hours when post-processing removes assignment lines (frees capacity for later logic). */
    private function restoreGlobalAvailability($employeeModel, string $date, float $hours): void
    {
        if ($hours <= 0.0001) {
            return;
        }
        $avail = $employeeModel->availabilities ?? collect();
        foreach ($avail as $ava) {
            if (($ava->date ?? null) === $date) {
                $ava->Total = $this->convertToHours($ava->Total ?? 0) + $hours;
                return;
            }
        }
        $new = new \stdClass();
        $new->date = $date;
        $new->Total = $hours;
        $new->done = 0;
        $employeeModel->availabilities = collect($avail)->push($new)->sortBy(fn($a) => $a->date)->values();
    }

    private function applyAssignmentDeltaLegacy(array &$assignments, float $delta, ?callable $filter = null): void
    {
        if (abs($delta) < 0.0001 || empty($assignments)) {
            return;
        }

        $indexed = [];
        foreach ($assignments as $idx => $assignment) {
            $date = $assignment['date'] ?? null;
            $ts = $date ? strtotime($date) : 0;
            $indexed[] = ['idx' => $idx, 'ts' => $ts];
        }
        usort($indexed, fn($a, $b) => ($b['ts'] <=> $a['ts']) ?: ($b['idx'] <=> $a['idx']));

        if ($delta < 0) {
            $hoursToRemove = abs($delta);
            foreach ($indexed as $row) {
                if ($hoursToRemove <= 0) {
                    break;
                }
                $idx = $row['idx'];
                if (!isset($assignments[$idx])) {
                    continue;
                }
                if ($filter && !$filter($assignments[$idx])) {
                    continue;
                }
                $hours = (float) ($assignments[$idx]['hours'] ?? 0);
                if ($hours <= 0) {
                    continue;
                }
                $remove = min($hours, $hoursToRemove);
                $newHours = $hours - $remove;
                if ($newHours > 0.0001) {
                    $assignments[$idx]['hours'] = $newHours;
                } else {
                    unset($assignments[$idx]);
                }
                $hoursToRemove -= $remove;
            }
            $assignments = array_values($assignments);
            return;
        }

        $hoursToAdd = $delta;
        foreach ($indexed as $row) {
            $idx = $row['idx'];
            if (!isset($assignments[$idx])) {
                continue;
            }
            if ($filter && !$filter($assignments[$idx])) {
                continue;
            }
            $assignments[$idx]['hours'] = (float) ($assignments[$idx]['hours'] ?? 0) + $hoursToAdd;
            return;
        }
    }
     private function applyNegativeAssignmentDelta(
        array &$assignments,
        float $delta,
        ?callable $filter,
        $allEmployees
    ): void {
        if ($delta >= -0.0001 || empty($assignments)) {
            return;
        }
        $hoursToRemove = abs($delta);
        $indexed = [];
        foreach ($assignments as $idx => $assignment) {
            $date = $assignment['date'] ?? null;
            $ts = $date ? strtotime($date) : 0;
            $indexed[] = ['idx' => $idx, 'ts' => $ts];
        }
        usort($indexed, fn($a, $b) => ($b['ts'] <=> $a['ts']) ?: ($b['idx'] <=> $a['idx']));

        foreach ($indexed as $row) {
            if ($hoursToRemove <= 0) {
                break;
            }
            $idx = $row['idx'];
            if (!isset($assignments[$idx])) {
                continue;
            }
            if ($filter && !$filter($assignments[$idx])) {
                continue;
            }
            $hours = (float) ($assignments[$idx]['hours'] ?? 0);
            if ($hours <= 0) {
                continue;
            }
            $name = $assignments[$idx]['employee'] ?? null;
            $date = $assignments[$idx]['date'] ?? null;
            $remove = min($hours, $hoursToRemove);
            $newHours = $hours - $remove;
            if ($newHours > 0.0001) {
                $assignments[$idx]['hours'] = $newHours;
            } else {
                unset($assignments[$idx]);
            }
            if ($name && $date) {
                $emp = $allEmployees->first(fn($e) => $e->first_name === $name);
                if ($emp) {
                    $this->restoreGlobalAvailability($emp, $date, $remove);
                }
            }
            $hoursToRemove -= $remove;
        }
        $assignments = array_values($assignments);
    }
 
    private function applyPositiveAssignmentDelta(
        array $task,
        array &$assignments,
        float $delta,
        ?callable $filter,
        $allEmployees
    ): void {
        if ($delta <= 0.0001 || empty($assignments)) {
            return;
        }
        $left = $delta;
        $indexed = [];
        foreach ($assignments as $idx => $assignment) {
            $date = $assignment['date'] ?? null;
            $ts = $date ? strtotime($date) : 0; 
            $indexed[] = ['idx' => $idx, 'ts' => $ts];
        }
        usort($indexed, fn($a, $b) => ($b['ts'] <=> $a['ts']) ?: ($b['idx'] <=> $a['idx']));

        foreach ($indexed as $row) {
            if ($left <= 0.0001) {
                break;
            }
            $idx = $row['idx'];
            if (!isset($assignments[$idx])) {
                continue;
            }
            if ($filter && !$filter($assignments[$idx])) {
                continue;
            }
            $name = $assignments[$idx]['employee'] ?? null;
            $date = $assignments[$idx]['date'] ?? null;
            if (!$name || !$date) {
                continue;
            }
            $emp = $allEmployees->first(fn($e) => $e->first_name === $name);
            if (!$emp) {
                continue;
            }
            $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
            if ($room <= 0.0001) {
                continue;
            }
            $add = min($left, $room);
            $assignments[$idx]['hours'] = (float) ($assignments[$idx]['hours'] ?? 0) + $add;
            $this->updateGlobalAvailability($emp, $date, $add);
            $left -= $add;
        }

        if ($left <= 0.0001) {
            return;
        }

        $empNames = [];
        foreach ($indexed as $row) {
            if (!isset($assignments[$row['idx']])) {
                continue;
            }
            if ($filter && !$filter($assignments[$row['idx']])) {
                continue;
            }
            $n = $assignments[$row['idx']]['employee'] ?? null;
            if ($n) {
                $empNames[$n] = true;
            }
        }
        foreach (array_keys($empNames) as $empName) {
            if ($left <= 0.0001) {
                break;
            }
            $emp = $allEmployees->first(fn($e) => $e->first_name === $empName);
            if (!$emp) {
                continue;
            }
            $left = $this->appendExtraHoursOnAvailableDates($task, $emp, $assignments, $left);
        }
    }

    /**
     * Per-employee fair hour targets for OVERRIDE_HARD_SLOT (even split of plan).
     *
     * @return array<int, float> empId => target hours
     */
    private function buildOverrideHardSlotFairTargetsByEmpId(
        float $plan,
        array $resolvedBySlot,
        array $assignmentSlots,
        array $task
    ): array {
        $ordered = [];
        foreach ($assignmentSlots as $slot) {
            $emp = $resolvedBySlot[$slot] ?? null;
            if ($emp) {
                $ordered[] = $emp;
            }
        }
        if ($ordered === []) {
            return [];
        }

        $targets = $this->buildPlanTargetsForEmployees($plan, collect($ordered), $task);
        $fair = [];
        foreach ($ordered as $idx => $emp) {
            $fair[$emp->id] = (float) ($targets[$idx] ?? 0.0);
        }

        return $fair;
    }

    private function getOverrideHardSlotDeficit(int $empId, array $assignedSoFar, array $fairTargets): float
    {
        return max(0.0, ($fairTargets[$empId] ?? 0.0) - ($assignedSoFar[$empId] ?? 0.0));
    }

    /**
     * True if employee still has bookable hours anywhere in the task window.
     */
    private function employeeHasRemainingOverrideCapacityInTask($employeeModel, array $task): bool
    {
        if (!$employeeModel) {
            return false;
        }

        $taskStart = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()
            : null;
        $taskEnd = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(30)->endOfDay()
            : null;

        foreach ($this->filterAvailabilities($employeeModel, $task)['availabilities'] as $ava) {
            $date = $ava->date ?? $ava->Date ?? null;
            if (!$date) {
                continue;
            }
            if ($taskStart && Carbon::parse($date)->lt($taskStart)) {
                continue;
            }
            if ($taskEnd && Carbon::parse($date)->gt($taskEnd)) {
                continue;
            }
            if ($this->getGlobalRemainingHoursOnDate($employeeModel, $date) > 0.0001) {
                return true;
            }
        }

        return false;
    }

    /**
     * Move unused quota from employees with no remaining calendar room to those behind who can still work.
     */
    private function redistributeOverrideHardSlotUnusedQuota(
        array $task,
        array $resolvedBySlot,
        array $assignmentSlots,
        array &$remainingQuota,
        array $fairTargets,
        array $assignedSoFar
    ): void {
        $pool = 0.0;
        foreach ($assignmentSlots as $slot) {
            $emp = $resolvedBySlot[$slot] ?? null;
            if (!$emp) {
                continue;
            }
            $empId = $emp->id;
            $unused = (float) ($remainingQuota[$empId] ?? 0.0);
            if ($unused <= 0.0001) {
                continue;
            }
            if ($this->employeeHasRemainingOverrideCapacityInTask($emp, $task)) {
                continue;
            }
            $pool += $unused;
            $remainingQuota[$empId] = 0.0;
        }

        $guard = 0;
        while ($pool > 0.0001 && $guard++ < 50) {
            $bestId = null;
            $bestDeficit = 0.0;
            foreach ($assignmentSlots as $slot) {
                $emp = $resolvedBySlot[$slot] ?? null;
                if (!$emp) {
                    continue;
                }
                $empId = $emp->id;
                $deficit = $this->getOverrideHardSlotDeficit($empId, $assignedSoFar, $fairTargets);
                if ($deficit <= 0.0001) {
                    continue;
                }
                if (!$this->employeeHasRemainingOverrideCapacityInTask($emp, $task)) {
                    continue;
                }
                if ($deficit > $bestDeficit + 0.0001) {
                    $bestDeficit = $deficit;
                    $bestId = $empId;
                }
            }
            if ($bestId === null) {
                break;
            }
            $give = min($pool, $bestDeficit);
            $remainingQuota[$bestId] = ($remainingQuota[$bestId] ?? 0.0) + $give;
            $pool -= $give;
        }
    }

    /**
     * Sort override slots: largest fair-share deficit first, then lowest hours assigned.
     */
    private function sortOverrideHardSlotSlotsByDeficit(
        array $slots,
        array $resolvedBySlot,
        array $assignedSoFar,
        array $fairTargets
    ): array {
        $sorted = $slots;
        usort($sorted, function ($a, $b) use ($resolvedBySlot, $assignedSoFar, $fairTargets) {
            $ea = $resolvedBySlot[$a]->id;
            $eb = $resolvedBySlot[$b]->id;
            $defA = $this->getOverrideHardSlotDeficit($ea, $assignedSoFar, $fairTargets);
            $defB = $this->getOverrideHardSlotDeficit($eb, $assignedSoFar, $fairTargets);
            $cmp = $defB <=> $defA;
            if ($cmp !== 0) {
                return $cmp;
            }
            $cmp = ($assignedSoFar[$ea] ?? 0.0) <=> ($assignedSoFar[$eb] ?? 0.0);
            return $cmp !== 0 ? $cmp : $a <=> $b;
        });

        return $sorted;
    }

    /**
     * Spill cap: prefer employees still under fair share; block ahead employees while others on this day need catch-up.
     */
    private function computeOverrideHardSlotSpillAssignAmount(
        int $empId,
        float $dailyAvailable,
        float $remainingPlan,
        array $assignedSoFar,
        array $fairTargets,
        array $dayDeficitsByEmpId
    ): float {
        if ($dailyAvailable <= 0.0001 || $remainingPlan <= 0.0001) {
            return 0.0;
        }

        $deficit = $this->getOverrideHardSlotDeficit($empId, $assignedSoFar, $fairTargets);

        $maxOtherDayDeficit = 0.0;
        foreach ($dayDeficitsByEmpId as $otherId => $otherDeficit) {
            if ($otherId !== $empId && $otherDeficit > $maxOtherDayDeficit) {
                $maxOtherDayDeficit = $otherDeficit;
            }
        }

        if ($deficit > 0.0001) {
            return min($dailyAvailable, $remainingPlan, $deficit);
        }

        if ($maxOtherDayDeficit > 0.0001) {
            return 0.0;
        }

        // At fair share but others on this day cannot take more — finish the plan here.
        return min($dailyAvailable, $remainingPlan);
    }

    /**
     * True when another assignee on the same day is still under fair share (same-day catch-up only).
     */
    private function overrideHardSlotOtherOnDayNeedsCatchUp(
        int $empId,
        array $dayEmployees,
        array $taskAssignmentDetails,
        array $fairTargetsByEmpId
    ): bool {
        $totals = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false)['totals_by_employee'] ?? [];

        foreach ($dayEmployees as $emp) {
            if ((int) $emp->id === (int) $empId) {
                continue;
            }
            $assigned = (float) ($totals[$emp->first_name] ?? 0.0);
            $deficit = max(0.0, ($fairTargetsByEmpId[$emp->id] ?? 0.0) - $assigned);
            if ($deficit > 0.0001) {
                return true;
            }
        }

        return false;
    }

    private function resolveOverrideEarliestAllowedStartTs($emp, array $task, array $ddStartsByName = []): int
    {
        if (!$emp) {
            return PHP_INT_MAX;
        }

        $name = (string) ($emp->first_name ?? '');
        $minDate = $ddStartsByName[$name] ?? null;

        $first = $this->filterAvailabilities($emp, $task)['availabilities']
            ->filter(fn($a) => (float) ($a->Total ?? 0) > 0)
            ->filter(function ($a) use ($minDate) {
                if (!$minDate) {
                    return true;
                }
                $d = $a->date ?? $a->Date ?? null;
                return $d && $d >= $minDate;
            })
            ->sortBy(fn($a) => $a->date ?? $a->Date ?? '')
            ->first();

        $date = $first->date ?? $first->Date ?? $minDate ?? null;
        $ts = $date ? strtotime((string) $date) : false;
        return $ts !== false ? $ts : PHP_INT_MAX;
    }

    private function isOverrideEmployeeDateEligible($emp, string $date, array $ddStartsByName, array $assignments): bool
    {
        $name = (string) ($emp->first_name ?? '');
        if ($name === '' || empty($ddStartsByName)) {
            return true;
        }

        return $this->isRationalDdAlignmentDate($name, $date, $ddStartsByName, $assignments);
    }

    /**
     * Place every remaining plan hour: no fair cap — use real/synthetic capacity until plan is zero.
     */
    private function exhaustOverrideHardSlotPlanToTarget(
        array $task,
        array &$taskAssignmentDetails,
        $employees,
        float $planTarget,
        $allEmployees = null,
        int $completionExtensionDays = 365,
        array $ddStartsByName = []
    ): void {
        if ($employees->isEmpty() || $planTarget <= 0.0001) {
            return;
        }

        $taskStart = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()
            : null;
        $taskEnd = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(max(30, $completionExtensionDays))->endOfDay()
            : null;

        $employeeOrder = $employees;
        if ($allEmployees) {
            $employeeOrder = $employees
                ->map(function ($emp) use ($allEmployees) {
                    if (!$emp) {
                        return null;
                    }
                    $live = $allEmployees->first(fn($e) => (int) $e->id === (int) $emp->id);

                    return $live ?? $emp;
                })
                ->filter()
                ->values();
        }

        $employeeOrder = collect($employeeOrder)
            ->sortBy(fn($emp) => $this->resolveOverrideEarliestAllowedStartTs($emp, $task, $ddStartsByName))
            ->values();

        $guard = 0;
        while ($guard++ < 8000) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $remaining = (float) $planTarget - (float) ($stats['total_assigned'] ?? 0.0);
            if ($remaining <= 0.0001) {
                break;
            }

            $dates = collect();
            foreach ($employeeOrder as $emp) {
                foreach ($this->filterAvailabilities($emp, $task)['availabilities'] as $ava) {
                    $d = $ava->date ?? $ava->Date ?? null;
                    if (!$d) {
                        continue;
                    }
                    if (!$this->isOverrideEmployeeDateEligible($emp, (string) $d, $ddStartsByName, $taskAssignmentDetails['assignments'] ?? [])) {
                        continue;
                    }
                    if ($taskStart && Carbon::parse($d)->lt($taskStart)) {
                        continue;
                    }
                    if ($taskEnd && Carbon::parse($d)->gt($taskEnd)) {
                        continue;
                    }
                    $dates->push($d);
                }
            }
            foreach ($taskAssignmentDetails['assignments'] ?? [] as $row) {
                if (!empty($row['date'])) {
                    $dates->push($row['date']);
                }
            }
            $anchorTs = collect($taskAssignmentDetails['assignments'] ?? [])
                ->pluck('date')
                ->filter()
                ->map(fn($d) => strtotime((string) $d))
                ->filter(fn($ts) => $ts !== false)
                ->values();
            $dates = $dates->unique()->sortBy(function ($d) use ($anchorTs) {
                $ts = strtotime((string) $d);
                if ($ts === false) {
                    return PHP_INT_MAX;
                }
                if ($anchorTs->isEmpty()) {
                    return $ts;
                }
                $minDist = PHP_INT_MAX;
                foreach ($anchorTs as $anchor) {
                    $minDist = min($minDist, abs($ts - $anchor));
                }

                return ($minDist * 100000) + $ts;
            })->values();

            $dayAssigned = 0.0;
            foreach ($dates as $date) {
                if ($remaining <= 0.0001) {
                    break;
                }

                $dayEmployees = [];
                foreach ($employeeOrder as $emp) {
                    if (!$this->isOverrideEmployeeDateEligible($emp, (string) $date, $ddStartsByName, $taskAssignmentDetails['assignments'] ?? [])) {
                        continue;
                    }
                    if ($this->getGlobalRemainingHoursOnDate($emp, $date) > 0.0001) {
                        $dayEmployees[] = $emp;
                    }
                }
                if ($dayEmployees === []) {
                    continue;
                }

                usort($dayEmployees, function ($a, $b) use ($taskAssignmentDetails) {
                    $totals = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false)['totals_by_employee'] ?? [];
                    $ta = (float) ($totals[$a->first_name] ?? 0.0);
                    $tb = (float) ($totals[$b->first_name] ?? 0.0);
                    $cmp = $ta <=> $tb;

                    return $cmp !== 0 ? $cmp : ((int) $a->id <=> (int) $b->id);
                });

                foreach ($dayEmployees as $emp) {
                    if ($remaining <= 0.0001) {
                        break;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $assign = min(8.0, $room, $remaining);
                    if ($assign <= 0.0001) {
                        continue;
                    }
                    $taskAssignmentDetails['assignments'][] = [
                        'employee' => $emp->first_name,
                        'date' => $date,
                        'hours' => $assign,
                    ];
                    $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;
                    $this->updateGlobalAvailability($emp, $date, $assign);
                    $remaining -= $assign;
                    $dayAssigned += $assign;
                }
            }

            if ($dayAssigned > 0.0001) {
                continue;
            }

            $lastDate = collect($taskAssignmentDetails['assignments'] ?? [])
                ->pluck('date')
                ->filter()
                ->max();
            $cursor = $lastDate ? Carbon::parse($lastDate) : ($taskStart ? $taskStart->copy() : Carbon::today());
            $cursor->addDay();
            while ((int) $cursor->dayOfWeekIso >= 6) {
                $cursor->addDay();
            }
            if ($taskEnd && $cursor->gt($taskEnd)) {
                break;
            }
            $date = $cursor->toDateString();

            foreach ($employeeOrder as $emp) {
                if (!$this->isOverrideEmployeeDateEligible($emp, (string) $date, $ddStartsByName, $taskAssignmentDetails['assignments'] ?? [])) {
                    continue;
                }
                if ($this->getGlobalRemainingHoursOnDate($emp, $date) <= 0.0001) {
                    $this->restoreGlobalAvailability($emp, $date, 8.0);
                }
            }

            foreach ($employeeOrder as $emp) {
                if ($remaining <= 0.0001) {
                    break;
                }
                if (!$this->isOverrideEmployeeDateEligible($emp, (string) $date, $ddStartsByName, $taskAssignmentDetails['assignments'] ?? [])) {
                    continue;
                }
                $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
                if ($room <= 0.0001) {
                    continue;
                }
                $assign = min(8.0, $room, $remaining);
                if ($assign <= 0.0001) {
                    continue;
                }
                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $emp->first_name,
                    'date' => $date,
                    'hours' => $assign,
                ];
                $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;
                $this->updateGlobalAvailability($emp, $date, $assign);
                $remaining -= $assign;
                $dayAssigned += $assign;
            }

            if ($dayAssigned <= 0.0001) {
                break;
            }
        }
    }

    /**
     * OVERRIDE_HARD_SLOT: keep assigning until plan hours are fully placed.
     * Day-by-day alternating assignees; employees behind fair share get priority.
     * When cycle limit (round/SH) is reached for everyone, reset cycle and continue.
     */
    private function fillOverrideHardSlotRemainingPlan(
        array $task,
        array &$taskAssignmentDetails,
        $employees,
        float $planTarget,
        ?float $cycleLimit = null,
        $allEmployees = null,
        ?array $fairTargetsByEmpId = null,
        array $ddStartsByName = [],
        bool $preferLaterAvailabilityFirst = false
    ): void {
        if ($employees->isEmpty() || $planTarget <= 0.0001) {
            return;
        }

        $taskStart = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()
            : null;
        $taskEnd = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(30)->endOfDay()
            : null;

        $liveEmployees = $employees;
        if ($allEmployees) {
            $liveEmployees = $employees
                ->map(function ($emp) use ($allEmployees) {
                    if (!$emp) {
                        return null;
                    }
                    $live = $allEmployees->first(fn($e) => (int) $e->id === (int) $emp->id);
                    return $live ?? $emp;
                })
                ->filter()
                ->values();
        }

        $employeeOrder = $liveEmployees
            ->sortBy(fn($emp) => $this->resolveOverrideEarliestAllowedStartTs($emp, $task, $ddStartsByName))
            ->values();
        if ($preferLaterAvailabilityFirst) {
            $employeeOrder = $employeeOrder->sortByDesc(
                fn($emp) => $this->resolveOverrideEarliestAllowedStartTs($emp, $task, $ddStartsByName)
            );
        }
        $employeeOrder = $employeeOrder->values()->all();

        if (empty($employeeOrder)) {
            return;
        }

        if ($fairTargetsByEmpId === null || $fairTargetsByEmpId === []) {
            $targets = $this->buildPlanTargetsForEmployees($planTarget, collect($employeeOrder), $task);
            $fairTargetsByEmpId = [];
            foreach ($employeeOrder as $idx => $emp) {
                $fairTargetsByEmpId[$emp->id] = (float) ($targets[$idx] ?? 0.0);
            }
        }

        $cycleTotals = [];
        foreach ($employeeOrder as $emp) {
            $cycleTotals[$emp->id] = 0.0;
        }

        $roundRobinOffset = 0;
        $guard = 0;
        while ($guard++ < 6000) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $remaining = (float) $planTarget - (float) ($stats['total_assigned'] ?? 0.0);
            if ($remaining <= 0.0001) {
                break;
            }

            $progress = false;
            $dates = collect();
            foreach ($employeeOrder as $emp) {
                foreach ($this->filterAvailabilities($emp, $task)['availabilities'] as $ava) {
                    $d = $ava->date ?? $ava->Date ?? null;
                    if (!$d) {
                        continue;
                    }
                    if (!$this->isOverrideEmployeeDateEligible($emp, (string) $d, $ddStartsByName, $taskAssignmentDetails['assignments'] ?? [])) {
                        continue;
                    }
                    if ($taskStart && Carbon::parse($d)->lt($taskStart)) {
                        continue;
                    }
                    if ($taskEnd && Carbon::parse($d)->gt($taskEnd)) {
                        continue;
                    }
                    $dates->push($d);
                }
            }
            $dates = $dates->unique()->sort()->values();

            foreach ($dates as $date) {
                if ($remaining <= 0.0001) {
                    break;
                }

                $dayEmployees = [];
                foreach ($employeeOrder as $emp) {
                    $empId = $emp->id;
                    if (!$this->isOverrideEmployeeDateEligible($emp, (string) $date, $ddStartsByName, $taskAssignmentDetails['assignments'] ?? [])) {
                        continue;
                    }
                    if ($cycleLimit !== null && ($cycleTotals[$empId] ?? 0.0) >= $cycleLimit - 0.0001) {
                        continue;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $dayEmployees[] = $emp;
                }
                if ($dayEmployees === []) {
                    continue;
                }

                usort($dayEmployees, function ($a, $b) use (
                    $taskAssignmentDetails,
                    $fairTargetsByEmpId,
                    $task,
                    $ddStartsByName,
                    $preferLaterAvailabilityFirst
                ) {
                    $ea = $this->resolveOverrideEarliestAllowedStartTs($a, $task, $ddStartsByName);
                    $eb = $this->resolveOverrideEarliestAllowedStartTs($b, $task, $ddStartsByName);
                    $cmp = $preferLaterAvailabilityFirst ? ($eb <=> $ea) : ($ea <=> $eb);
                    if ($cmp !== 0) {
                        return $cmp;
                    }
                    $totals = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false)['totals_by_employee'] ?? [];
                    $ta = (float) ($totals[$a->first_name] ?? 0.0);
                    $tb = (float) ($totals[$b->first_name] ?? 0.0);
                    $defA = max(0.0, ($fairTargetsByEmpId[$a->id] ?? 0.0) - $ta);
                    $defB = max(0.0, ($fairTargetsByEmpId[$b->id] ?? 0.0) - $tb);
                    $cmp = $defB <=> $defA;
                    if ($cmp !== 0) {
                        return $cmp;
                    }
                    $cmp = $ta <=> $tb;
                    return $cmp !== 0 ? $cmp : ((int) $a->id <=> (int) $b->id);
                });

                if (count($dayEmployees) > 1) {
                    $rot = $roundRobinOffset % count($dayEmployees);
                    if ($rot > 0) {
                        $dayEmployees = array_merge(
                            array_slice($dayEmployees, $rot),
                            array_slice($dayEmployees, 0, $rot)
                        );
                    }
                }

                $dayProgress = true;
                while ($remaining > 0.0001 && $dayProgress) {
                    $dayProgress = false;
                    foreach ($dayEmployees as $emp) {
                        if ($remaining <= 0.0001) {
                            break;
                        }
                        $empId = $emp->id;
                        if ($cycleLimit !== null && ($cycleTotals[$empId] ?? 0.0) >= $cycleLimit - 0.0001) {
                            continue;
                        }

                        $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
                        if ($room <= 0.0001) {
                            continue;
                        }

                        $capLeft = $cycleLimit !== null
                            ? max(0.0, $cycleLimit - ($cycleTotals[$empId] ?? 0.0))
                            : $room;
                        $statsNow = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
                        $totalsNow = $statsNow['totals_by_employee'] ?? [];
                        $assignedNow = (float) ($totalsNow[$emp->first_name] ?? 0.0);
                        $deficit = max(0.0, ($fairTargetsByEmpId[$empId] ?? 0.0) - $assignedNow);
                        $assign = min(8.0, $room, $capLeft, $remaining);
                        if ($deficit > 0.0001) {
                            $assign = min($assign, $deficit);
                        } elseif ($this->overrideHardSlotOtherOnDayNeedsCatchUp(
                            $empId,
                            $dayEmployees,
                            $taskAssignmentDetails,
                            $fairTargetsByEmpId
                        )) {
                            continue;
                        }
                        if ($assign <= 0.0001) {
                            continue;
                        }

                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $emp->first_name,
                            'date' => $date,
                            'hours' => $assign,
                        ];
                        $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;
                        $this->updateGlobalAvailability($emp, $date, $assign);
                        $cycleTotals[$empId] = ($cycleTotals[$empId] ?? 0.0) + $assign;
                        $remaining -= $assign;
                        $progress = true;
                        $dayProgress = true;
                    }
                }

                $roundRobinOffset++;
            }

            if ($progress) {
                continue;
            }

            $allAtCycleLimit = $cycleLimit !== null && collect($employeeOrder)
                ->every(fn($emp) => ($cycleTotals[$emp->id] ?? 0.0) >= $cycleLimit - 0.0001);
            if ($allAtCycleLimit) {
                foreach ($employeeOrder as $emp) {
                    $cycleTotals[$emp->id] = 0.0;
                }
                continue;
            }

            // Extend to next workday inside task window and create capacity if needed.
            $lastDate = collect($taskAssignmentDetails['assignments'] ?? [])
                ->pluck('date')
                ->filter()
                ->max();
            $cursor = $lastDate ? Carbon::parse($lastDate) : ($taskStart ? $taskStart->copy() : Carbon::today());
            $cursor->addDay();
            while ((int) $cursor->dayOfWeekIso >= 6) {
                $cursor->addDay();
            }
            if ($taskEnd && $cursor->gt($taskEnd)) {
                break;
            }
            $date = $cursor->toDateString();

            foreach ($employeeOrder as $emp) {
                if (!$this->isOverrideEmployeeDateEligible($emp, (string) $date, $ddStartsByName, $taskAssignmentDetails['assignments'] ?? [])) {
                    continue;
                }
                if ($this->getGlobalRemainingHoursOnDate($emp, $date) <= 0.0001) {
                    $this->restoreGlobalAvailability($emp, $date, 8.0);
                }
            }

            $ordered = $employeeOrder;
            usort($ordered, function ($a, $b) use (
                $taskAssignmentDetails,
                $fairTargetsByEmpId,
                $task,
                $ddStartsByName,
                $preferLaterAvailabilityFirst
            ) {
                $ea = $this->resolveOverrideEarliestAllowedStartTs($a, $task, $ddStartsByName);
                $eb = $this->resolveOverrideEarliestAllowedStartTs($b, $task, $ddStartsByName);
                $cmp = $preferLaterAvailabilityFirst ? ($eb <=> $ea) : ($ea <=> $eb);
                if ($cmp !== 0) {
                    return $cmp;
                }
                $totals = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false)['totals_by_employee'] ?? [];
                $ta = (float) ($totals[$a->first_name] ?? 0.0);
                $tb = (float) ($totals[$b->first_name] ?? 0.0);
                $defA = max(0.0, ($fairTargetsByEmpId[$a->id] ?? 0.0) - $ta);
                $defB = max(0.0, ($fairTargetsByEmpId[$b->id] ?? 0.0) - $tb);
                $cmp = $defB <=> $defA;
                if ($cmp !== 0) {
                    return $cmp;
                }
                return $ta <=> $tb;
            });
            if (count($ordered) > 1) {
                $rot = $roundRobinOffset % count($ordered);
                if ($rot > 0) {
                    $ordered = array_merge(
                        array_slice($ordered, $rot),
                        array_slice($ordered, 0, $rot)
                    );
                }
            }

            $dayAssigned = 0.0;
            foreach ($ordered as $emp) {
                if ($remaining <= 0.0001) {
                    break;
                }
                $empId = $emp->id;
                if (!$this->isOverrideEmployeeDateEligible($emp, (string) $date, $ddStartsByName, $taskAssignmentDetails['assignments'] ?? [])) {
                    continue;
                }
                if ($cycleLimit !== null && ($cycleTotals[$empId] ?? 0.0) >= $cycleLimit - 0.0001) {
                    continue;
                }
                $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
                if ($room <= 0.0001) {
                    continue;
                }
                $capLeft = $cycleLimit !== null
                    ? max(0.0, $cycleLimit - ($cycleTotals[$empId] ?? 0.0))
                    : $room;
                $statsNow = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
                $totalsNow = $statsNow['totals_by_employee'] ?? [];
                $assignedNow = (float) ($totalsNow[$emp->first_name] ?? 0.0);
                $deficit = max(0.0, ($fairTargetsByEmpId[$empId] ?? 0.0) - $assignedNow);
                $assign = min(8.0, $room, $capLeft, $remaining);
                if ($deficit > 0.0001) {
                    $assign = min($assign, $deficit);
                } elseif ($this->overrideHardSlotOtherOnDayNeedsCatchUp(
                    $empId,
                    $ordered,
                    $taskAssignmentDetails,
                    $fairTargetsByEmpId
                )) {
                    continue;
                }
                if ($assign <= 0.0001) {
                    continue;
                }
                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $emp->first_name,
                    'date' => $date,
                    'hours' => $assign,
                ];
                $taskAssignmentDetails['end_dates'][$emp->first_name] = $date;
                $this->updateGlobalAvailability($emp, $date, $assign);
                $cycleTotals[$empId] = ($cycleTotals[$empId] ?? 0.0) + $assign;
                $remaining -= $assign;
                $dayAssigned += $assign;
            }

            $roundRobinOffset++;
            if ($dayAssigned <= 0.0001) {
                break;
            }
        }

        $this->exhaustOverrideHardSlotPlanToTarget(
            $task,
            $taskAssignmentDetails,
            collect($employeeOrder),
            $planTarget,
            $allEmployees,
            365,
            $ddStartsByName
        );
    }

    /**
     * General rule: total assigned must match validation_plan (fill shortfall, trim excess; never negative).
     */
    private function enforceAssignmentTotalsToValidationPlan(
        array $task,
        array &$taskAssignmentDetails,
        float $validationPlan,
        $allEmployees,
        $selectedEmployees
    ): void {
        if ($validationPlan <= 0.0001) {
            return;
        }

        $this->trimTaskAssignmentsAbovePlan($task, $taskAssignmentDetails, $validationPlan, $allEmployees);

        $fillEmployees = $selectedEmployees;
        if ($fillEmployees->isEmpty() && $allEmployees) {
            $names = collect($taskAssignmentDetails['assignments'] ?? [])
                ->pluck('employee')
                ->filter()
                ->unique()
                ->values();
            $fillEmployees = $names
                ->map(fn($name) => $allEmployees->first(fn($e) => $e->first_name === $name))
                ->filter()
                ->values();
        }

        if ($fillEmployees->isNotEmpty()) {
            $ddStartsForFill = $taskAssignmentDetails['dd_starts_by_name'] ?? [];
            if ($ddStartsForFill === [] && $this->taskDelayDays($task) > 0 && $allEmployees) {
                $ddStartsForFill = $this->buildDdEarliestStartsByEmployeeName(
                    $task,
                    $allEmployees,
                    $fillEmployees->pluck('first_name')->filter()->values()->all()
                );
            }
            $this->exhaustOverrideHardSlotPlanToTarget(
                $task,
                $taskAssignmentDetails,
                $fillEmployees,
                $validationPlan,
                $allEmployees,
                365,
                $ddStartsForFill
            );
        }

        $this->trimTaskAssignmentsAbovePlan($task, $taskAssignmentDetails, $validationPlan, $allEmployees);
    }

    /**
     * Remove hours from latest assignments until total <= validation plan (restores global availability).
     */
    private function trimTaskAssignmentsAbovePlan(
        array $task,
        array &$taskAssignmentDetails,
        float $validationPlan,
        $allEmployees
    ): void {
        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $excess = (float) ($stats['total_assigned'] ?? 0.0) - $validationPlan;
        if ($excess <= 0.0001) {
            return;
        }

        $assignments = $taskAssignmentDetails['assignments'] ?? [];
        if ($assignments === []) {
            return;
        }

        usort($assignments, function ($a, $b) {
            $cmp = strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? ''));
            if ($cmp !== 0) {
                return $cmp;
            }

            return ((float) ($b['hours'] ?? 0.0)) <=> ((float) ($a['hours'] ?? 0.0));
        });

        $trimmed = [];
        foreach ($assignments as $row) {
            if ($excess <= 0.0001) {
                $trimmed[] = $row;
                continue;
            }

            $hours = (float) ($row['hours'] ?? 0.0);
            if ($hours <= 0.0001) {
                continue;
            }

            $reduce = min($hours, $excess);
            $employeeName = (string) ($row['employee'] ?? '');
            $date = (string) ($row['date'] ?? '');
            if ($employeeName !== '' && $date !== '' && $allEmployees) {
                $emp = $allEmployees->first(fn($e) => $e->first_name === $employeeName);
                if ($emp) {
                    $this->restoreGlobalAvailability($emp, $date, $reduce);
                }
            }

            $hours -= $reduce;
            $excess -= $reduce;
            if ($hours > 0.0001) {
                $row['hours'] = $hours;
                $trimmed[] = $row;
            }
        }

        $taskAssignmentDetails['assignments'] = array_values($trimmed);
    }

    /**
     * Add rows only where the shared in-memory calendar still has free time (respects earlier tasks).
     */
    private function appendExtraHoursOnAvailableDates(
        array $task,
        $employeeModel,
        array &$assignments,
        float $hoursLeft
    ): float {
        $empName = $employeeModel->first_name ?? '';
        $existingDateTs = collect($assignments)
            ->filter(fn($a) => ($a['employee'] ?? '') === $empName && !empty($a['date']))
            ->map(fn($a) => strtotime((string) $a['date']))
            ->filter(fn($ts) => $ts !== false)
            ->values()
            ->all();

        $guard = 0;
        while ($hoursLeft > 0.0001 && $guard++ < 800) {
            $availRows = $this->filterAvailabilities($employeeModel, $task)['availabilities']
                ->filter(fn($a) => (float) $this->convertToHours($a->Total ?? 0) > 0.0001)
                ->sortBy(function ($a) use ($existingDateTs) {
                    $ts = strtotime($a->date ?? $a->Date ?? '');
                    if ($ts === false) {
                        return PHP_INT_MAX;
                    }
                    if ($existingDateTs === []) {
                        return $ts;
                    }
                    $minDist = PHP_INT_MAX;
                    foreach ($existingDateTs as $anchorTs) {
                        $minDist = min($minDist, abs($ts - $anchorTs));
                    }

                    return ($minDist * 100000) + $ts;
                });
            $placed = false;
            foreach ($availRows as $ava) {
                $date = $ava->date;
                $room = $this->getGlobalRemainingHoursOnDate($employeeModel, $date);
                if ($room <= 0.0001) {
                    continue;
                }
                $chunk = min(8.0, $hoursLeft, $room);
                if ($chunk <= 0.0001) {
                    continue;
                }
                $assignments[] = [
                    'employee' => $employeeModel->first_name,
                    'date' => $date,
                    'hours' => $chunk,
                ];
                $existingDateTs[] = strtotime($date);
                $this->updateGlobalAvailability($employeeModel, $date, $chunk);
                $hoursLeft -= $chunk;
                $placed = true;
                break;
            }
            if (!$placed) {
                break;
            }
        }
        return $hoursLeft;
    }

    /**
     * Merge satellite assignment clusters (calendar holes > gap threshold) into the main cluster
     * so plan fill / catch-up cannot leave orphan rows like 0.84h on an isolated middle day.
     */
    private function collapseInternalAssignmentGaps(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }

        $threshold = self::SCHEDULING_GAP_DEADEND_DAYS;
        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $rows = $stats['assignments'] ?? [];
        $byEmp = [];
        foreach ($rows as $a) {
            $n = $a['employee'] ?? null;
            if ($n) {
                $byEmp[$n][] = $a;
            }
        }

        foreach ($byEmp as $name => $empRows) {
            usort($empRows, fn($a, $b) => strcmp((string) ($a['date'] ?? ''), (string) ($b['date'] ?? '')));
            if (count($empRows) < 2) {
                continue;
            }

            $empModel = $allEmployees->first(fn($e) => $e->first_name === $name);
            if (!$empModel) {
                continue;
            }

            $clusters = [];
            $current = [];
            $prevDate = null;
            foreach ($empRows as $r) {
                $d = $r['date'] ?? null;
                if (!$d) {
                    continue;
                }
                if (
                    $prevDate !== null
                    && (strtotime($d) - strtotime($prevDate)) / 86400 > $threshold
                ) {
                    if ($current !== []) {
                        $clusters[] = $current;
                    }
                    $current = [];
                }
                $current[] = $r;
                $prevDate = $d;
            }
            if ($current !== []) {
                $clusters[] = $current;
            }
            if (count($clusters) <= 1) {
                continue;
            }

            usort($clusters, function ($a, $b) {
                $ha = array_sum(array_map(fn($r) => (float) ($r['hours'] ?? 0), $a));
                $hb = array_sum(array_map(fn($r) => (float) ($r['hours'] ?? 0), $b));

                return $hb <=> $ha;
            });
            $mainCluster = $clusters[0];
            $mainDates = array_values(array_unique(array_column($mainCluster, 'date')));

            for ($ci = 1; $ci < count($clusters); $ci++) {
                foreach ($clusters[$ci] as $row) {
                    $fromDate = $row['date'] ?? null;
                    $hours = (float) ($row['hours'] ?? 0);
                    if (!$fromDate || $hours <= 0.0001) {
                        continue;
                    }

                    $fromIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                        if (($a['employee'] ?? null) === $name && ($a['date'] ?? null) === $fromDate) {
                            $fromIdx = $idx;
                            break;
                        }
                    }
                    if ($fromIdx === null) {
                        continue;
                    }

                    $fromTs = strtotime($fromDate);
                    usort($mainDates, function ($a, $b) use ($fromTs) {
                        $ta = strtotime($a);
                        $tb = strtotime($b);
                        if ($ta === false || $tb === false) {
                            return strcmp($a, $b);
                        }

                        return abs($ta - $fromTs) <=> abs($tb - $fromTs);
                    });

                    $left = $hours;
                    foreach ($mainDates as $toDate) {
                        if ($left <= 0.0001) {
                            break;
                        }
                        $room = $this->getGlobalRemainingHoursOnDate($empModel, $toDate);
                        if ($room <= 0.0001) {
                            continue;
                        }
                        $move = min($left, $room);
                        if ($move <= 0.0001) {
                            continue;
                        }

                        $newFrom = (float) ($taskAssignmentDetails['assignments'][$fromIdx]['hours'] ?? 0) - $move;
                        if ($newFrom <= 0.0001) {
                            unset($taskAssignmentDetails['assignments'][$fromIdx]);
                            $fromIdx = null;
                        } else {
                            $taskAssignmentDetails['assignments'][$fromIdx]['hours'] = $newFrom;
                        }

                        $targetIdx = null;
                        foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                            if (($a['employee'] ?? null) === $name && ($a['date'] ?? null) === $toDate) {
                                $targetIdx = $j;
                                break;
                            }
                        }
                        if ($targetIdx !== null) {
                            $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                                (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0) + $move;
                        } else {
                            $taskAssignmentDetails['assignments'][] = [
                                'employee' => $name,
                                'date' => $toDate,
                                'hours' => $move,
                            ];
                        }

                        $this->restoreGlobalAvailability($empModel, $fromDate, $move);
                        $this->updateGlobalAvailability($empModel, $toDate, $move);
                        $left -= $move;
                    }
                }
            }

            $this->relocateOrphanMiddleAssignmentDays($name, $empModel, $taskAssignmentDetails);
        }

        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    }

    /**
     * Move small hour slices on a day isolated from both neighbors (e.g. 0.84h on May 19
     * between May 6 and May 22) onto the nearer adjacent day with capacity.
     */
    private function relocateOrphanMiddleAssignmentDays(
        string $employeeName,
        $empModel,
        array &$taskAssignmentDetails
    ): void {
        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $rows = array_values(array_filter(
            $stats['assignments'] ?? [],
            fn($a) => ($a['employee'] ?? null) === $employeeName && !empty($a['date'])
        ));
        if (count($rows) < 3) {
            return;
        }

        usort($rows, fn($a, $b) => strcmp((string) $a['date'], (string) $b['date']));

        for ($i = 1; $i < count($rows) - 1; $i++) {
            $cur = $rows[$i];
            $prev = $rows[$i - 1];
            $next = $rows[$i + 1];
            $curDate = (string) ($cur['date'] ?? '');
            $prevDate = (string) ($prev['date'] ?? '');
            $nextDate = (string) ($next['date'] ?? '');
            $hours = (float) ($cur['hours'] ?? 0);
            if ($curDate === '' || $hours <= 0.0001 || $hours > 4.0001) {
                continue;
            }

            $prevTs = strtotime($prevDate);
            $curTs = strtotime($curDate);
            $nextTs = strtotime($nextDate);
            if ($prevTs === false || $curTs === false || $nextTs === false) {
                continue;
            }

            $gapPrev = ($curTs - $prevTs) / 86400;
            $gapNext = ($nextTs - $curTs) / 86400;
            if ($gapPrev <= 1.0001 || $gapNext <= 1.0001) {
                continue;
            }

            $targets = [];
            if ($gapPrev <= $gapNext) {
                $targets[] = $prevDate;
                $targets[] = $nextDate;
            } else {
                $targets[] = $nextDate;
                $targets[] = $prevDate;
            }

            $this->moveEmployeeAssignmentHours(
                $employeeName,
                $empModel,
                $taskAssignmentDetails,
                $curDate,
                $hours,
                $targets
            );

            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $rows = array_values(array_filter(
                $stats['assignments'] ?? [],
                fn($a) => ($a['employee'] ?? null) === $employeeName && !empty($a['date'])
            ));
            usort($rows, fn($a, $b) => strcmp((string) $a['date'], (string) $b['date']));
        }
    }

    /**
     * @param string[] $targetDates Preferred destination dates (nearest first)
     */
    private function moveEmployeeAssignmentHours(
        string $employeeName,
        $empModel,
        array &$taskAssignmentDetails,
        string $fromDate,
        float $hours,
        array $targetDates
    ): void {
        if ($hours <= 0.0001) {
            return;
        }

        $fromIdx = null;
        foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
            if (($a['employee'] ?? null) === $employeeName && ($a['date'] ?? null) === $fromDate) {
                $fromIdx = $idx;
                break;
            }
        }
        if ($fromIdx === null) {
            return;
        }

        $left = $hours;
        foreach ($targetDates as $toDate) {
            if ($left <= 0.0001 || $toDate === $fromDate) {
                continue;
            }
            $room = $this->getGlobalRemainingHoursOnDate($empModel, $toDate);
            if ($room <= 0.0001) {
                continue;
            }
            $move = min($left, $room);
            if ($move <= 0.0001) {
                continue;
            }

            if (!isset($taskAssignmentDetails['assignments'][$fromIdx])) {
                break;
            }
            $newFrom = (float) ($taskAssignmentDetails['assignments'][$fromIdx]['hours'] ?? 0) - $move;
            if ($newFrom <= 0.0001) {
                unset($taskAssignmentDetails['assignments'][$fromIdx]);
                $fromIdx = null;
            } else {
                $taskAssignmentDetails['assignments'][$fromIdx]['hours'] = $newFrom;
            }

            $targetIdx = null;
            foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                if (($a['employee'] ?? null) === $employeeName && ($a['date'] ?? null) === $toDate) {
                    $targetIdx = $j;
                    break;
                }
            }
            if ($targetIdx !== null) {
                $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                    (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0) + $move;
            } else {
                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $employeeName,
                    'date' => $toDate,
                    'hours' => $move,
                ];
            }

            $this->restoreGlobalAvailability($empModel, $fromDate, $move);
            $this->updateGlobalAvailability($empModel, $toDate, $move);
            $left -= $move;
        }
    }

    private function applyAssignmentDeltasWithGlobalAvailability(
        array $task,
        array &$assignments,
        float $delta,
        ?callable $filter,
        $allEmployees
    ): void {
        if (abs($delta) < 0.0001 || empty($assignments)) {
            return;
        }
        if (!$allEmployees) {
            $this->applyAssignmentDeltaLegacy($assignments, $delta, $filter);
            return;
        }
        if ($delta < 0) {
            $this->applyNegativeAssignmentDelta($assignments, $delta, $filter, $allEmployees);
            return;
        }
        $this->applyPositiveAssignmentDelta($task, $assignments, $delta, $filter, $allEmployees);
    }

    /**
     * In synchronized pair mode (A + C behavior), try to align both end dates by
     * shifting hours from the later-finishing employee to the earlier-finishing employee
     * on the later dates when the earlier employee still has availability.
     */
    private function enforceSynchronizedPairSameEndDate(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }
        if (!$this->isDefaultTraineePairActivityTask($task)) {
            return;
        }
        $mode = (string) ($taskAssignmentDetails['mode'] ?? '');
        if (!in_array($mode, ['HYPERMODE_OVERRIDE_EVEN_SPLIT', 'AL', 'OVERRIDE_HARD_SLOT'], true)) {
            return;
        }

        $primary = $taskAssignmentDetails['primary_employee'] ?? null;
        $secondary = $taskAssignmentDetails['secondary_employee'] ?? null;
        if (!$primary || !$secondary) {
            return;
        }

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $endDates = $stats['end_dates'] ?? [];
        $d1 = $endDates[$primary] ?? null;
        $d2 = $endDates[$secondary] ?? null;
        if (!$d1 || !$d2 || $d1 === $d2) {
            return;
        }

        $lateName = ($d1 > $d2) ? $primary : $secondary;
        $earlyName = ($lateName === $primary) ? $secondary : $primary;
        $lateEnd = max($d1, $d2);

        $lateModel = $allEmployees->first(fn($e) => $e->first_name === $lateName);
        $earlyModel = $allEmployees->first(fn($e) => $e->first_name === $earlyName);
        if (!$lateModel || !$earlyModel) {
            return;
        }

        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName(
            $task,
            $allEmployees,
            [$primary, $secondary]
        );

        // Move from latest dates first.
        $indexes = [];
        foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
            if (($a['employee'] ?? null) !== $lateName) {
                continue;
            }
            $date = $a['date'] ?? null;
            if (!$date || $date > $lateEnd) {
                continue;
            }
            $indexes[] = ['idx' => $idx, 'date' => $date];
        }
        usort($indexes, fn($x, $y) => strcmp($y['date'], $x['date']));

        foreach ($indexes as $row) {
            $idx = $row['idx'];
            if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                continue;
            }
            $date = $taskAssignmentDetails['assignments'][$idx]['date'] ?? null;
            if (!$date) {
                continue;
            }

            $lateHours = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
            if ($lateHours <= 0.0001) {
                continue;
            }

            // Prefer same-date transfer first (respect DD — skip if same-day would be irrational).
            $roomEarly = $this->getGlobalRemainingHoursOnDate($earlyModel, $date);
            $sameDateMove = min($lateHours, max(0.0, $roomEarly));
            if (
                $sameDateMove > 0.0001
                && !$this->isRationalDdSameDateAlignment(
                    $task,
                    $earlyName,
                    $lateName,
                    $date,
                    $ddStartsByName,
                    $taskAssignmentDetails['assignments'] ?? [],
                    true
                )
            ) {
                $sameDateMove = 0.0;
            }
            if ($sameDateMove > 0.0001) {
                $newLate = $lateHours - $sameDateMove;
                if ($newLate <= 0.0001) {
                    unset($taskAssignmentDetails['assignments'][$idx]);
                } else {
                    $taskAssignmentDetails['assignments'][$idx]['hours'] = $newLate;
                }

                $targetIdx = null;
                foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                    if (($a['employee'] ?? null) === $earlyName && ($a['date'] ?? null) === $date) {
                        $targetIdx = $j;
                        break;
                    }
                }
                if ($targetIdx !== null) {
                    $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                        (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $sameDateMove;
                } else {
                    $taskAssignmentDetails['assignments'][] = [
                        'employee' => $earlyName,
                        'date' => $date,
                        'hours' => $sameDateMove,
                    ];
                }

                $this->restoreGlobalAvailability($lateModel, $date, $sameDateMove);
                $this->updateGlobalAvailability($earlyModel, $date, $sameDateMove);
                $lateHours -= $sameDateMove;
            }

            // If same-date has no room, push into earlier dates (<= late date) to remove gaps/tails.
            // Try early assignee first, then the late assignee itself (compress own tail).
            if ($lateHours > 0.0001) {
                $candidateDates = collect($taskAssignmentDetails['assignments'] ?? [])
                    ->pluck('date')
                    ->filter()
                    ->unique()
                    ->sort()
                    ->filter(fn($d) => $d <= $date)
                    ->values();

                $recipientCandidates = [
                    ['name' => $earlyName, 'model' => $earlyModel],
                    ['name' => $lateName, 'model' => $lateModel],
                ];

                foreach ($recipientCandidates as $recipient) {
                    if ($lateHours <= 0.0001) {
                        break;
                    }
                    $recipientName = $recipient['name'];
                    $recipientModel = $recipient['model'];
                    if (!$recipientModel) {
                        continue;
                    }

                    foreach ($candidateDates as $targetDate) {
                        if ($lateHours <= 0.0001) {
                            break;
                        }
                        if ($recipientName === $lateName && $targetDate >= $date) {
                            continue;
                        }
                        if (
                            !$this->isRationalDdAlignmentDate(
                                $recipientName,
                                $targetDate,
                                $ddStartsByName,
                                $taskAssignmentDetails['assignments'] ?? []
                            )
                        ) {
                            continue;
                        }

                        $room = $this->getGlobalRemainingHoursOnDate($recipientModel, $targetDate);
                        if ($room <= 0.0001) {
                            continue;
                        }
                        $move = min($lateHours, $room);
                        if ($move <= 0.0001) {
                            continue;
                        }

                        $newLate = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                        if ($newLate <= 0.0001) {
                            unset($taskAssignmentDetails['assignments'][$idx]);
                        } else {
                            $taskAssignmentDetails['assignments'][$idx]['hours'] = $newLate;
                        }

                        $targetIdx = null;
                        foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                            if (($a['employee'] ?? null) === $recipientName && ($a['date'] ?? null) === $targetDate) {
                                $targetIdx = $j;
                                break;
                            }
                        }
                        if ($targetIdx !== null) {
                            $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                                (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                        } else {
                            $taskAssignmentDetails['assignments'][] = [
                                'employee' => $recipientName,
                                'date' => $targetDate,
                                'hours' => $move,
                            ];
                        }

                        $this->restoreGlobalAvailability($lateModel, $date, $move);
                        $this->updateGlobalAvailability($recipientModel, $targetDate, $move);
                        $lateHours -= $move;
                    }
                }
            }
        }

        // Reindex after deletions.
        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    }

    /**
     * In OVERRIDE_HARD_SLOT mode, reduce tail-late behavior:
     * move hours from the latest finisher to earlier finishers on the same date
     * (only when they still have remaining global capacity on that date).
     */
    private function enforceOverrideHardSlotSameEndDate(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }
        $mode = (string) ($taskAssignmentDetails['mode'] ?? '');
        if ($mode !== 'OVERRIDE_HARD_SLOT') {
            return;
        }

        $selectedNames = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
            $taskAssignmentDetails['tertiary_employee'] ?? null,
        ]));
        if (count($selectedNames) < 2) {
            return;
        }

        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $selectedNames);

        $allAssignedDates = collect($taskAssignmentDetails['assignments'] ?? [])
            ->pluck('date')
            ->filter()
            ->unique()
            ->sort()
            ->values();
        $minAssignedDate = $allAssignedDates->first();

        $maxRounds = 120;
        for ($round = 0; $round < $maxRounds; $round++) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $endDates = $stats['end_dates'] ?? [];

            $activeNames = [];
            foreach ($selectedNames as $name) {
                if (!empty($endDates[$name])) {
                    $activeNames[] = $name;
                }
            }
            if (count($activeNames) < 2) {
                return;
            }

            $latestEnd = null;
            $earliestEnd = null;
            foreach ($activeNames as $name) {
                $d = $endDates[$name];
                $latestEnd = $latestEnd === null ? $d : max($latestEnd, $d);
                $earliestEnd = $earliestEnd === null ? $d : min($earliestEnd, $d);
            }
            if (!$latestEnd || !$earliestEnd || $latestEnd === $earliestEnd) {
                return;
            }

            $lateNames = array_values(array_filter($activeNames, fn($n) => ($endDates[$n] ?? null) === $latestEnd));
            $earlyNames = array_values(array_filter($activeNames, fn($n) => ($endDates[$n] ?? null) < $latestEnd));
            if (empty($lateNames) || empty($earlyNames)) {
                return;
            }

            usort($earlyNames, fn($a, $b) => strcmp($endDates[$a] ?? '', $endDates[$b] ?? ''));

            $movedAny = false;
            foreach ($lateNames as $lateName) {
                $lateModel = $allEmployees->first(fn($e) => $e->first_name === $lateName);
                if (!$lateModel) {
                    continue;
                }

                $indexes = [];
                foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                    if (($a['employee'] ?? null) !== $lateName) {
                        continue;
                    }
                    $date = $a['date'] ?? null;
                    if (!$date || $date < $earliestEnd) {
                        continue;
                    }
                    $indexes[] = ['idx' => $idx, 'date' => $date];
                }
                usort($indexes, fn($x, $y) => strcmp($y['date'], $x['date']));

                foreach ($indexes as $row) {
                    $idx = $row['idx'];
                    if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                        continue;
                    }
                    $date = $taskAssignmentDetails['assignments'][$idx]['date'] ?? null;
                    $lateHours = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                    if (!$date || $lateHours <= 0.0001) {
                        continue;
                    }

                    foreach ($earlyNames as $earlyName) {
                        $earlyModel = $allEmployees->first(fn($e) => $e->first_name === $earlyName);
                        if (!$earlyModel) {
                            continue;
                        }

                        // Prefer same-date transfer first (skip when DD makes same-day end/start irrational).
                        $roomSameDate = $this->getGlobalRemainingHoursOnDate($earlyModel, $date);
                        $moveSameDate = min($lateHours, max(0.0, $roomSameDate));
                        if (
                            $moveSameDate > 0.0001
                            && !$this->isRationalDdSameDateAlignment(
                                $task,
                                $earlyName,
                                $lateName,
                                $date,
                                $ddStartsByName,
                                $taskAssignmentDetails['assignments'] ?? [],
                                true
                            )
                        ) {
                            $moveSameDate = 0.0;
                        }

                        if ($moveSameDate > 0.0001) {
                            $newLate = $lateHours - $moveSameDate;
                            if ($newLate <= 0.0001) {
                                unset($taskAssignmentDetails['assignments'][$idx]);
                            } else {
                                $taskAssignmentDetails['assignments'][$idx]['hours'] = $newLate;
                            }

                            $targetIdx = null;
                            foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                                if (($a['employee'] ?? null) === $earlyName && ($a['date'] ?? null) === $date) {
                                    $targetIdx = $j;
                                    break;
                                }
                            }
                            if ($targetIdx !== null) {
                                $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                                    (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $moveSameDate;
                            } else {
                                $taskAssignmentDetails['assignments'][] = [
                                    'employee' => $earlyName,
                                    'date' => $date,
                                    'hours' => $moveSameDate,
                                ];
                            }

                            $this->restoreGlobalAvailability($lateModel, $date, $moveSameDate);
                            $this->updateGlobalAvailability($earlyModel, $date, $moveSameDate);

                            $lateHours -= $moveSameDate;
                            $movedAny = true;
                            if ($lateHours <= 0.0001) {
                                break;
                            }
                        }

                        // If same-date has no room, move to earlier/equal dates for this employee
                        // so the task ends sooner overall (even if totals become uneven).
                        // Include assignee availability gap dates too (not only currently assigned dates).
                        $candidateDates = collect($taskAssignmentDetails['assignments'] ?? [])
                            ->pluck('date')
                            ->concat(
                                collect($earlyModel->availabilities ?? [])
                                    ->pluck('date')
                            )
                            ->filter()
                            ->unique()
                            ->sort()
                            ->filter(function ($d) use ($date, $minAssignedDate) {
                                if ($d > $date) {
                                    return false;
                                }
                                if ($minAssignedDate && $d < $minAssignedDate) {
                                    return false;
                                }
                                return true;
                            })
                            ->values();

                        foreach ($candidateDates as $targetDate) {
                            if ($lateHours <= 0.0001) {
                                break;
                            }
                            if (
                                !$this->isRationalDdAlignmentDate(
                                    $earlyName,
                                    $targetDate,
                                    $ddStartsByName,
                                    $taskAssignmentDetails['assignments'] ?? []
                                )
                            ) {
                                continue;
                            }
                            $roomEarly = $this->getGlobalRemainingHoursOnDate($earlyModel, $targetDate);
                            if ($roomEarly <= 0.0001) {
                                continue;
                            }
                            $move = min($lateHours, $roomEarly);
                            if ($move <= 0.0001) {
                                continue;
                            }

                            $newLate = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                            if ($newLate <= 0.0001) {
                                unset($taskAssignmentDetails['assignments'][$idx]);
                            } else {
                                $taskAssignmentDetails['assignments'][$idx]['hours'] = $newLate;
                            }

                            $targetIdx = null;
                            foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                                if (($a['employee'] ?? null) === $earlyName && ($a['date'] ?? null) === $targetDate) {
                                    $targetIdx = $j;
                                    break;
                                }
                            }
                            if ($targetIdx !== null) {
                                $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                                    (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                            } else {
                                $taskAssignmentDetails['assignments'][] = [
                                    'employee' => $earlyName,
                                    'date' => $targetDate,
                                    'hours' => $move,
                                ];
                            }

                            // Restore late employee on the original late date,
                            // consume early employee on the earlier target date.
                            $this->restoreGlobalAvailability($lateModel, $date, $move);
                            $this->updateGlobalAvailability($earlyModel, $targetDate, $move);

                            $lateHours -= $move;
                            $movedAny = true;
                        }
                    }
                }
            }

            if (!$movedAny) {
                break;
            }
            $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
        }
    }

    /**
     * For default trainee tasks running in OVERRIDE_HARD_SLOT / HYPERMODE_OVERRIDE_EVEN_SPLIT:
     * reduce late-tail load from the latest finisher and create overlap with trainee
     * (at least one non-trainee starts/ends on trainee start/end when capacity allows).
     */
    private function enforceHardSlotTraineeOverlap(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }
        $mode = (string) ($taskAssignmentDetails['mode'] ?? '');
        if (!in_array($mode, ['OVERRIDE_HARD_SLOT', 'HYPERMODE_OVERRIDE_EVEN_SPLIT'], true)) {
            return;
        }
        if (!$this->isDefaultTraineePairActivityTask($task)) {
            return;
        }

        $dd = $this->taskDelayDays($task);

        $selectedNames = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
            $taskAssignmentDetails['tertiary_employee'] ?? null,
        ]));
        if (count($selectedNames) < 2) {
            return;
        }

        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $selectedNames);

        $selectedModels = collect($selectedNames)
            ->map(fn($name) => $allEmployees->first(fn($e) => $e->first_name === $name))
            ->filter()
            ->values();
        if ($selectedModels->count() < 2) {
            return;
        }

        // Trainee = lowest performance-rate assignee (typically < 1.0 for default pair tasks).
        $traineeName = null;
        $lowestRate = INF;
        foreach ($selectedModels as $emp) {
            $rate = (float) $this->getEmployeePerformanceRate($emp, $task);
            if ($rate > 0.0001 && $rate < $lowestRate) {
                $lowestRate = $rate;
                $traineeName = $emp->first_name;
            }
        }
        if (!$traineeName) {
            return;
        }

        $maxRounds = 80;
        for ($round = 0; $round < $maxRounds; $round++) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $assignments = $stats['assignments'] ?? [];
            $endDates = $stats['end_dates'] ?? [];
            if (empty($assignments) || empty($endDates[$traineeName])) {
                return;
            }

            $startDates = [];
            foreach ($assignments as $a) {
                $name = $a['employee'] ?? null;
                $date = $a['date'] ?? null;
                if (!$name || !$date) {
                    continue;
                }
                if (!isset($startDates[$name]) || $date < $startDates[$name]) {
                    $startDates[$name] = $date;
                }
            }

            $traineeStart = $startDates[$traineeName] ?? null;
            $traineeEnd = $endDates[$traineeName] ?? null;
            if (!$traineeStart || !$traineeEnd) {
                return;
            }

            $others = array_values(array_filter($selectedNames, fn($n) => $n !== $traineeName));
            if (empty($others)) {
                return;
            }

            $hasOverlap = false;
            foreach ($others as $name) {
                if ($dd > 0) {
                    if (($endDates[$name] ?? null) === $traineeEnd) {
                        $hasOverlap = true;
                        break;
                    }
                } elseif (
                    ($startDates[$name] ?? null) === $traineeStart
                    || ($endDates[$name] ?? null) === $traineeEnd
                ) {
                    $hasOverlap = true;
                    break;
                }
            }
            if ($hasOverlap) {
                return;
            }

            $donorName = null;
            $latestEnd = null;
            foreach ($others as $name) {
                $d = $endDates[$name] ?? null;
                if (!$d) {
                    continue;
                }
                if ($latestEnd === null || $d > $latestEnd) {
                    $latestEnd = $d;
                    $donorName = $name;
                }
            }
            if (!$donorName || !$latestEnd) {
                return;
            }

            $donorModel = $allEmployees->first(fn($e) => $e->first_name === $donorName);
            if (!$donorModel) {
                return;
            }

            $recipientNames = array_values(array_filter($selectedNames, fn($n) => $n !== $donorName));
            usort($recipientNames, function ($a, $b) use ($startDates, $endDates, $traineeStart, $traineeEnd, $dd) {
                if ($dd > 0) {
                    $scoreA = ($endDates[$a] ?? null) === $traineeEnd ? 0 : 1;
                    $scoreB = ($endDates[$b] ?? null) === $traineeEnd ? 0 : 1;
                } else {
                    $scoreA = (($startDates[$a] ?? null) === $traineeStart ? 0 : 1) + (($endDates[$a] ?? null) === $traineeEnd ? 0 : 1);
                    $scoreB = (($startDates[$b] ?? null) === $traineeStart ? 0 : 1) + (($endDates[$b] ?? null) === $traineeEnd ? 0 : 1);
                }
                if ($scoreA !== $scoreB) {
                    return $scoreA <=> $scoreB;
                }
                return strcmp((string) ($endDates[$a] ?? ''), (string) ($endDates[$b] ?? ''));
            });
            // If others have no room, allow donor self-compression to earlier trainee-window dates.
            $recipientNames[] = $donorName;

            $targetDates = collect($assignments)
                ->pluck('date')
                ->filter()
                ->unique()
                ->sort()
                ->filter(fn($d) => $d <= $traineeEnd)
                ->values()
                ->all();
            $anchorDates = $dd > 0 ? [$traineeEnd] : [$traineeStart, $traineeEnd];
            $targetDates = array_values(array_unique(array_filter(array_merge($anchorDates, $targetDates))));

            $donorRows = [];
            foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                if (($a['employee'] ?? null) !== $donorName) {
                    continue;
                }
                $date = $a['date'] ?? null;
                if (!$date || $date < $traineeEnd) {
                    continue;
                }
                $donorRows[] = ['idx' => $idx, 'date' => $date];
            }
            usort($donorRows, fn($x, $y) => strcmp($y['date'], $x['date']));

            $movedAny = false;
            foreach ($donorRows as $row) {
                $idx = $row['idx'];
                $fromDate = $row['date'];
                if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                    continue;
                }
                $remainingFromRow = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                if ($remainingFromRow <= 0.0001) {
                    continue;
                }

                    foreach ($recipientNames as $recipientName) {
                    $recipientModel = $allEmployees->first(fn($e) => $e->first_name === $recipientName);
                    if (!$recipientModel) {
                        continue;
                    }

                    foreach ($targetDates as $toDate) {
                        if ($remainingFromRow <= 0.0001) {
                            break;
                        }
                        if ($recipientName === $donorName && $toDate >= $fromDate) {
                            continue;
                        }
                        if (
                            !$this->isRationalDdAlignmentDate(
                                $recipientName,
                                $toDate,
                                $ddStartsByName,
                                $taskAssignmentDetails['assignments'] ?? []
                            )
                        ) {
                            continue;
                        }
                        if (
                            $fromDate === $toDate
                            && !$this->isRationalDdSameDateAlignment(
                                $task,
                                $recipientName,
                                $donorName,
                                $toDate,
                                $ddStartsByName,
                                $taskAssignmentDetails['assignments'] ?? [],
                                true
                            )
                        ) {
                            continue;
                        }
                        $room = $this->getGlobalRemainingHoursOnDate($recipientModel, $toDate);
                        if ($room <= 0.0001) {
                            continue;
                        }
                        $move = min($remainingFromRow, $room);
                        if ($move <= 0.0001) {
                            continue;
                        }

                        $newDonorHours = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                        if ($newDonorHours <= 0.0001) {
                            unset($taskAssignmentDetails['assignments'][$idx]);
                        } else {
                            $taskAssignmentDetails['assignments'][$idx]['hours'] = $newDonorHours;
                        }

                        $targetIdx = null;
                        foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                            if (($a['employee'] ?? null) === $recipientName && ($a['date'] ?? null) === $toDate) {
                                $targetIdx = $j;
                                break;
                            }
                        }
                        if ($targetIdx !== null) {
                            $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                                (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                        } else {
                            $taskAssignmentDetails['assignments'][] = [
                                'employee' => $recipientName,
                                'date' => $toDate,
                                'hours' => $move,
                            ];
                        }

                        $this->restoreGlobalAvailability($donorModel, $fromDate, $move);
                        $this->updateGlobalAvailability($recipientModel, $toDate, $move);

                        $remainingFromRow -= $move;
                        $movedAny = true;
                    }
                }
            }

            if (!$movedAny) {
                return;
            }
            $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
        }
    }

    /**
     * Strict end-date alignment for OVERRIDE_HARD_SLOT:
     * move any work after the target date into <= target dates (same employee or others)
     * whenever capacity exists, so all assignees can finish together.
     */
    private function enforceHardSlotSingleEndDate(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }
        if (($taskAssignmentDetails['mode'] ?? '') !== 'OVERRIDE_HARD_SLOT') {
            return;
        }

        $selectedNames = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
            $taskAssignmentDetails['tertiary_employee'] ?? null,
        ]));
        if (count($selectedNames) < 2) {
            return;
        }

        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $selectedNames);

        $maxRounds = 120;
        for ($round = 0; $round < $maxRounds; $round++) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $endDates = $stats['end_dates'] ?? [];
            $active = [];
            foreach ($selectedNames as $name) {
                if (!empty($endDates[$name])) {
                    $active[$name] = $endDates[$name];
                }
            }
            if (count($active) < 2) {
                return;
            }

            $uniqueEnds = array_values(array_unique(array_values($active)));
            sort($uniqueEnds);
            if (count($uniqueEnds) <= 1) {
                return;
            }
            // Do not extend schedule: target the second-latest end date.
            $targetEnd = $uniqueEnds[count($uniqueEnds) - 2];

            $donorNames = array_values(array_filter(array_keys($active), fn($n) => ($active[$n] ?? '') > $targetEnd));
            if (empty($donorNames)) {
                return;
            }

            $datePool = collect($taskAssignmentDetails['assignments'] ?? [])
                ->pluck('date')
                ->filter()
                ->unique()
                ->sortDesc()
                ->values()
                ->toArray();
            $minAssignedDate = empty($datePool) ? null : min($datePool);

            $movedAny = false;
            foreach ($donorNames as $donorName) {
                $donorModel = $allEmployees->first(fn($e) => $e->first_name === $donorName);
                if (!$donorModel) {
                    continue;
                }

                $donorRows = [];
                foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                    if (($a['employee'] ?? null) !== $donorName) {
                        continue;
                    }
                    $d = $a['date'] ?? null;
                    if (!$d || $d <= $targetEnd) {
                        continue;
                    }
                    $donorRows[] = ['idx' => $idx, 'date' => $d];
                }
                usort($donorRows, fn($x, $y) => strcmp($y['date'], $x['date']));

                // Prefer moving to assignees who currently end earliest, but include donor as recipient too.
                $recipientNames = $selectedNames;
                usort($recipientNames, function ($a, $b) use ($active, $donorName) {
                    if ($a === $donorName && $b !== $donorName) {
                        return 1;
                    }
                    if ($b === $donorName && $a !== $donorName) {
                        return -1;
                    }
                    return strcmp((string) ($active[$a] ?? ''), (string) ($active[$b] ?? ''));
                });

                foreach ($donorRows as $row) {
                    $idx = $row['idx'];
                    $fromDate = $row['date'];
                    if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                        continue;
                    }
                    $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                    if ($left <= 0.0001) {
                        continue;
                    }

                    foreach ($recipientNames as $recipientName) {
                        if ($left <= 0.0001) {
                            break;
                        }
                        $recipientModel = $allEmployees->first(fn($e) => $e->first_name === $recipientName);
                        if (!$recipientModel) {
                            continue;
                        }
                        $recipientDatePool = collect($datePool)
                            ->concat(
                                collect($recipientModel->availabilities ?? [])
                                    ->pluck('date')
                            )
                            ->filter()
                            ->unique()
                            ->sortDesc()
                            ->values()
                            ->toArray();
                        $targetDates = array_values(array_filter(
                            $recipientDatePool,
                            function ($d) use ($targetEnd, $minAssignedDate) {
                                if ($d > $targetEnd) {
                                    return false;
                                }
                                if ($minAssignedDate && $d < $minAssignedDate) {
                                    return false;
                                }
                                return true;
                            }
                        ));
                        if ($targetDates === []) {
                            continue;
                        }
                        foreach ($targetDates as $toDate) {
                            if ($left <= 0.0001) {
                                break;
                            }
                            if (
                                !$this->isRationalDdAlignmentDate(
                                    $recipientName,
                                    $toDate,
                                    $ddStartsByName,
                                    $taskAssignmentDetails['assignments'] ?? []
                                )
                            ) {
                                continue;
                            }
                            if (
                                $fromDate === $toDate
                                && !$this->isRationalDdSameDateAlignment(
                                    $task,
                                    $recipientName,
                                    $donorName,
                                    $toDate,
                                    $ddStartsByName,
                                    $taskAssignmentDetails['assignments'] ?? [],
                                    true
                                )
                            ) {
                                continue;
                            }
                            $room = $this->getGlobalRemainingHoursOnDate($recipientModel, $toDate);
                            if ($room <= 0.0001) {
                                continue;
                            }
                            $move = min($left, $room);
                            if ($move <= 0.0001) {
                                continue;
                            }

                            $newDonor = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                            if ($newDonor <= 0.0001) {
                                unset($taskAssignmentDetails['assignments'][$idx]);
                            } else {
                                $taskAssignmentDetails['assignments'][$idx]['hours'] = $newDonor;
                            }

                            $targetIdx = null;
                            foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                                if (($a['employee'] ?? null) === $recipientName && ($a['date'] ?? null) === $toDate) {
                                    $targetIdx = $j;
                                    break;
                                }
                            }
                            if ($targetIdx !== null) {
                                $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                                    (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                            } else {
                                $taskAssignmentDetails['assignments'][] = [
                                    'employee' => $recipientName,
                                    'date' => $toDate,
                                    'hours' => $move,
                                ];
                            }

                            $this->restoreGlobalAvailability($donorModel, $fromDate, $move);
                            $this->updateGlobalAvailability($recipientModel, $toDate, $move);
                            $left -= $move;
                            $movedAny = true;
                        }
                    }
                }
            }

            $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
            if (!$movedAny) {
                return;
            }
        }
    }

    /**
     * Participation balance: avoid 100/0 split when selected assignees have usable capacity.
     * Applies to pure AL and two-person hypermode overrides.
     */
    private function enforceALParticipationBalance(
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        $mode = (string) ($taskAssignmentDetails['mode'] ?? '');
        if (
            !$allEmployees
            || !in_array($mode, ['AL', 'HYPERMODE_OVERRIDE_EVEN_SPLIT'], true)
        ) {
            return;
        }
        $selectedNames = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
            $taskAssignmentDetails['tertiary_employee'] ?? null,
        ]));
        if (count($selectedNames) < 2) {
            return;
        }

        $maxRounds = 80;
        for ($round = 0; $round < $maxRounds; $round++) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $totals = $stats['totals_by_employee'] ?? [];
            $sum = 0.0;
            foreach ($selectedNames as $n) {
                $sum += (float) ($totals[$n] ?? 0.0);
            }
            if ($sum <= 0.0001) {
                return;
            }
            $target = $sum / count($selectedNames);

            $under = collect($selectedNames)
                ->map(fn($n) => ['name' => $n, 'need' => max(0.0, $target - (float) ($totals[$n] ?? 0.0))])
                ->filter(fn($x) => $x['need'] > 0.0001)
                ->sortByDesc('need')
                ->values()
                ->all();
            $over = collect($selectedNames)
                ->map(fn($n) => ['name' => $n, 'extra' => max(0.0, (float) ($totals[$n] ?? 0.0) - $target)])
                ->filter(fn($x) => $x['extra'] > 0.0001)
                ->sortByDesc('extra')
                ->values()
                ->all();
            if (empty($under) || empty($over)) {
                return;
            }

            $movedAny = false;
            foreach ($under as $u) {
                $recipientName = $u['name'];
                $recipientModel = $allEmployees->first(fn($e) => $e->first_name === $recipientName);
                if (!$recipientModel) {
                    continue;
                }
                $need = (float) $u['need'];
                foreach ($over as $o) {
                    if ($need <= 0.0001) {
                        break;
                    }
                    $donorName = $o['name'];
                    if ($donorName === $recipientName) {
                        continue;
                    }
                    $donorModel = $allEmployees->first(fn($e) => $e->first_name === $donorName);
                    if (!$donorModel) {
                        continue;
                    }

                    $rows = [];
                    foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                        if (($a['employee'] ?? null) === $donorName) {
                            $d = $a['date'] ?? null;
                            if ($d) {
                                $rows[] = ['idx' => $idx, 'date' => $d];
                            }
                        }
                    }
                    usort($rows, fn($x, $y) => strcmp($y['date'], $x['date']));

                    $candidateDates = collect($taskAssignmentDetails['assignments'] ?? [])
                        ->pluck('date')
                        ->filter()
                        ->unique()
                        ->sort()
                        ->values()
                        ->all();

                    foreach ($rows as $row) {
                        if ($need <= 0.0001) {
                            break;
                        }
                        $idx = $row['idx'];
                        $fromDate = $row['date'];
                        if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                            continue;
                        }
                        $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                        if ($left <= 0.0001) {
                            continue;
                        }

                        foreach ($candidateDates as $toDate) {
                            if ($toDate > $fromDate || $need <= 0.0001 || $left <= 0.0001) {
                                continue;
                            }
                            $room = $this->getGlobalRemainingHoursOnDate($recipientModel, $toDate);
                            if ($room <= 0.0001) {
                                continue;
                            }
                            $move = min($left, $need, $room);
                            if ($move <= 0.0001) {
                                continue;
                            }

                            $newDonor = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                            if ($newDonor <= 0.0001) {
                                unset($taskAssignmentDetails['assignments'][$idx]);
                            } else {
                                $taskAssignmentDetails['assignments'][$idx]['hours'] = $newDonor;
                            }

                            $targetIdx = null;
                            foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                                if (($a['employee'] ?? null) === $recipientName && ($a['date'] ?? null) === $toDate) {
                                    $targetIdx = $j;
                                    break;
                                }
                            }
                            if ($targetIdx !== null) {
                                $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                                    (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                            } else {
                                $taskAssignmentDetails['assignments'][] = [
                                    'employee' => $recipientName,
                                    'date' => $toDate,
                                    'hours' => $move,
                                ];
                            }

                            $this->restoreGlobalAvailability($donorModel, $fromDate, $move);
                            $this->updateGlobalAvailability($recipientModel, $toDate, $move);
                            $left -= $move;
                            $need -= $move;
                            $movedAny = true;
                        }
                    }
                }
            }

            $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
            if (!$movedAny) {
                return;
            }
        }
    }

    /**
     * If an employee has a very small final tail (<=2h) on a much later date,
     * try to move it into earlier dates for the same employee.
     */
    private function enforceTinyLateTailCompression(
        array &$taskAssignmentDetails,
        $allEmployees,
        ?array $task = null
    ): void {
        if (!$allEmployees) {
            return;
        }
        $dd = $task ? $this->taskDelayDays($task) : 0;
        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $rows = $stats['assignments'] ?? [];
        $byEmp = [];
        foreach ($rows as $a) {
            $n = $a['employee'] ?? null;
            $d = $a['date'] ?? null;
            if ($n && $d) {
                $byEmp[$n][] = $a;
            }
        }
        foreach ($byEmp as $name => $empRows) {
            usort($empRows, fn($a, $b) => strcmp($a['date'], $b['date']));
            if (count($empRows) < 2) {
                continue;
            }
            $last = $empRows[count($empRows) - 1];
            $prev = $empRows[count($empRows) - 2];
            $tail = (float) ($last['hours'] ?? 0.0);
            if ($tail <= 0.0001 || $tail > 2.0001) {
                continue;
            }
            if (($last['date'] ?? '') <= ($prev['date'] ?? '')) {
                continue;
            }
            $empModel = $allEmployees->first(fn($e) => $e->first_name === $name);
            if (!$empModel) {
                continue;
            }
            foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                if (($a['employee'] ?? null) !== $name || ($a['date'] ?? null) !== $last['date']) {
                    continue;
                }
                $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                if ($left <= 0.0001) {
                    continue;
                }
                foreach ($empRows as $r) {
                    $toDate = $r['date'] ?? null;
                    if (!$toDate || $toDate >= $last['date']) {
                        continue;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($empModel, $toDate);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $move = min($left, $room);
                    if ($move <= 0.0001) {
                        continue;
                    }
                    $taskAssignmentDetails['assignments'][$idx]['hours'] -= $move;
                    if ($taskAssignmentDetails['assignments'][$idx]['hours'] <= 0.0001) {
                        unset($taskAssignmentDetails['assignments'][$idx]);
                    }

                    $targetIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $j => $x) {
                        if (($x['employee'] ?? null) === $name && ($x['date'] ?? null) === $toDate) {
                            $targetIdx = $j;
                            break;
                        }
                    }
                    if ($targetIdx !== null) {
                        $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                            (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                    } else {
                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $name,
                            'date' => $toDate,
                            'hours' => $move,
                        ];
                    }
                    $this->restoreGlobalAvailability($empModel, $last['date'], $move);
                    $this->updateGlobalAvailability($empModel, $toDate, $move);
                    $left -= $move;
                    if ($left <= 0.0001) {
                        break;
                    }
                }

                // If same-employee compression cannot absorb the tiny tail, and DD is not active,
                // push it to an earlier day on another assignee who finished before this tail day.
                if ($left > 0.0001 && $dd <= 0) {
                    $tailEndDate = (string) ($last['date'] ?? '');
                    $endDates = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false)['end_dates'] ?? [];
                    $recipientNames = array_values(array_filter(array_keys($byEmp), fn($n) => $n !== $name));
                    usort($recipientNames, function ($a, $b) use ($endDates, $tailEndDate) {
                        $ea = (string) ($endDates[$a] ?? '');
                        $eb = (string) ($endDates[$b] ?? '');
                        $aEarlier = ($ea !== '' && $tailEndDate !== '' && $ea < $tailEndDate) ? 0 : 1;
                        $bEarlier = ($eb !== '' && $tailEndDate !== '' && $eb < $tailEndDate) ? 0 : 1;
                        $cmp = $aEarlier <=> $bEarlier;
                        if ($cmp !== 0) {
                            return $cmp;
                        }
                        return strcmp($ea, $eb);
                    });

                    foreach ($recipientNames as $recipientName) {
                        if ($left <= 0.0001) {
                            break;
                        }
                        $recipientEnd = (string) ($endDates[$recipientName] ?? '');
                        if ($recipientEnd !== '' && $tailEndDate !== '' && $recipientEnd >= $tailEndDate) {
                            continue;
                        }
                        $recipientModel = $allEmployees->first(fn($e) => $e->first_name === $recipientName);
                        if (!$recipientModel) {
                            continue;
                        }

                        $candidateDates = collect($taskAssignmentDetails['assignments'] ?? [])
                            ->filter(fn($x) => ($x['employee'] ?? null) === $recipientName && !empty($x['date']) && $x['date'] < $tailEndDate)
                            ->pluck('date')
                            ->concat(
                                collect($recipientModel->availabilities ?? [])
                                    ->pluck('date')
                                    ->filter(fn($d) => !empty($d) && $d < $tailEndDate)
                            )
                            ->unique()
                            ->sortDesc()
                            ->values()
                            ->all();

                        foreach ($candidateDates as $toDate) {
                            if ($left <= 0.0001) {
                                break;
                            }
                            $room = $this->getGlobalRemainingHoursOnDate($recipientModel, $toDate);
                            if ($room <= 0.0001) {
                                continue;
                            }
                            $move = min($left, $room);
                            if ($move <= 0.0001) {
                                continue;
                            }

                            $tailIdx = null;
                            foreach ($taskAssignmentDetails['assignments'] as $j => $x) {
                                if (($x['employee'] ?? null) === $name && ($x['date'] ?? null) === $last['date']) {
                                    $tailIdx = $j;
                                    break;
                                }
                            }
                            if ($tailIdx === null) {
                                break 2;
                            }

                            $taskAssignmentDetails['assignments'][$tailIdx]['hours'] -= $move;
                            if ($taskAssignmentDetails['assignments'][$tailIdx]['hours'] <= 0.0001) {
                                unset($taskAssignmentDetails['assignments'][$tailIdx]);
                            }

                            $targetIdx = null;
                            foreach ($taskAssignmentDetails['assignments'] as $j => $x) {
                                if (($x['employee'] ?? null) === $recipientName && ($x['date'] ?? null) === $toDate) {
                                    $targetIdx = $j;
                                    break;
                                }
                            }
                            if ($targetIdx !== null) {
                                $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                                    (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                            } else {
                                $taskAssignmentDetails['assignments'][] = [
                                    'employee' => $recipientName,
                                    'date' => $toDate,
                                    'hours' => $move,
                                ];
                            }

                            $this->restoreGlobalAvailability($empModel, $last['date'], $move);
                            $this->updateGlobalAvailability($recipientModel, $toDate, $move);
                            $left -= $move;
                        }
                    }
                }
            }
        }
        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    } 

    /**
     * For two-person hypermode:
     * - DD not set: align to same start OR same end (whichever is feasible first).
     * - DD set: same-end only (staggered starts are intentional); same-start is disabled.
     */
    private function enforceTwoPersonStartOrEndAlignment(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }
        $mode = (string) ($taskAssignmentDetails['mode'] ?? '');
        if (!in_array($mode, ['HYPERMODE_OVERRIDE_EVEN_SPLIT', 'AL'], true)) {
            return;
        }
        $dd = $this->taskDelayDays($task);
        $sh = is_numeric($task['SH'] ?? null) ? (float) $task['SH'] : null;
        if ($sh !== null && $sh > 0.0001) {
            return;
        }

        $names = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
        ]));
        if (count($names) !== 2) {
            return;
        }

        // Hypermode only: skip cosmetic alignment for two operatives (AL still aligns ends when DD=0).
        if ($mode === 'HYPERMODE_OVERRIDE_EVEN_SPLIT') {
            $primaryModel = $allEmployees->first(fn($e) => $e->first_name === $names[0]);
            $secondaryModel = $allEmployees->first(fn($e) => $e->first_name === $names[1]);
            if ($primaryModel && $secondaryModel) {
                $primaryRate = $this->getEmployeePerformanceRate($primaryModel, $task);
                $secondaryRate = $this->getEmployeePerformanceRate($secondaryModel, $task);
                if ($primaryRate >= 1.0 - 0.0001 && $secondaryRate >= 1.0 - 0.0001) {
                    return;
                }
            }
        }

        $ddNames = $this->resolveDdOrderedAssigneeNames($task, $allEmployees, $names);

        $maxRounds = 8;
        for ($round = 0; $round < $maxRounds; $round++) {
            $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
            $rows = $stats['assignments'] ?? [];
            $start = [];
            $end = [];
            foreach ($rows as $a) {
                $n = $a['employee'] ?? null;
                $d = $a['date'] ?? null;
                if (!$n || !$d || !in_array($n, $names, true)) {
                    continue;
                }
                if (!isset($start[$n]) || $d < $start[$n]) {
                    $start[$n] = $d;
                }
                if (!isset($end[$n]) || $d > $end[$n]) {
                    $end[$n] = $d;
                }
            }
            if (empty($start[$names[0]]) || empty($start[$names[1]]) || empty($end[$names[0]]) || empty($end[$names[1]])) {
                return;
            }

            if ($dd > 0) {
                if ($end[$names[0]] === $end[$names[1]]) {
                    return;
                }
            } elseif ($start[$names[0]] === $start[$names[1]] || $end[$names[0]] === $end[$names[1]]) {
                return;
            }

            // Phase 1: try aligning END date to the earlier end (respects DD via shiftRowsToDateWindow).
            $targetEnd = min($end[$names[0]], $end[$names[1]]);
            $endChanged = $this->shiftRowsToDateWindow(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $ddNames,
                $targetEnd,
                true
            );
            if ($endChanged) {
                continue;
            }

            // Phase 1b: align END to the later end (pull shorter finisher forward on calendar).
            if ($dd <= 0) {
                $targetEndLate = max($end[$names[0]], $end[$names[1]]);
                $endLateChanged = $this->shiftRowsToDateWindow(
                    $task,
                    $taskAssignmentDetails,
                    $allEmployees,
                    $ddNames,
                    $targetEndLate,
                    false
                );
                if ($endLateChanged) {
                    continue;
                }
            }

            // Phase 2: same START only when DD is not set (DD intentionally staggers who begins when).
            if ($dd > 0) {
                return;
            }

            $targetStart = max($start[$names[0]], $start[$names[1]]);
            $startChanged = $this->shiftRowsToDateWindow(
                $task,
                $taskAssignmentDetails,
                $allEmployees,
                $ddNames,
                $targetStart,
                false
            );
            if (!$startChanged) {
                return;
            }
        }
    }

    /**
     * Shift rows of selected employees into a date window.
     * $forEnd=true: move rows with date > target to <= target.
     * $forEnd=false: move rows with date < target to >= target.
     */
    private function shiftRowsToDateWindow(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees,
        array $names,
        string $targetDate,
        bool $forEnd
    ): bool {
        if (!$forEnd && $this->taskDelayDays($task) > 0) {
            return false;
        }

        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $names);

        $allDates = collect($taskAssignmentDetails['assignments'] ?? [])
            ->pluck('date')
            ->filter()
            ->unique()
            ->sort()
            ->values()
            ->all();
        if (empty($allDates)) {
            return false;
        }

        $windowDates = array_values(array_filter($allDates, fn($d) => $forEnd ? ($d <= $targetDate) : ($d >= $targetDate)));
        if (empty($windowDates)) {
            return false;
        }

        // When aligning end, consume latest rows first. When aligning start, consume earliest rows first.
        $donorRows = [];
        foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
            $n = $a['employee'] ?? null;
            $d = $a['date'] ?? null;
            if (!$n || !$d || !in_array($n, $names, true)) {
                continue;
            }
            if ($forEnd ? ($d > $targetDate) : ($d < $targetDate)) {
                $donorRows[] = ['idx' => $idx, 'name' => $n, 'date' => $d];
            }
        }
        if (empty($donorRows)) {
            return false;
        }
        usort($donorRows, function ($a, $b) use ($forEnd) {
            return $forEnd ? strcmp($b['date'], $a['date']) : strcmp($a['date'], $b['date']);
        });

        $changed = false;
        foreach ($donorRows as $row) {
            $idx = $row['idx'];
            $donorName = $row['name'];
            $fromDate = $row['date'];
            if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                continue;
            }
            $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
            if ($left <= 0.0001) {
                continue;
            }

            // Prefer self-compression first, then peer.
            $recipientOrder = [$donorName];
            foreach ($names as $n) {
                if ($n !== $donorName) {
                    $recipientOrder[] = $n;
                }
            }

            foreach ($recipientOrder as $recipientName) {
                if ($left <= 0.0001) {
                    break;
                }
                $recipientModel = $allEmployees->first(fn($e) => $e->first_name === $recipientName);
                $donorModel = $allEmployees->first(fn($e) => $e->first_name === $donorName);
                if (!$recipientModel || !$donorModel) {
                    continue;
                }

                foreach ($windowDates as $toDate) {
                    if ($left <= 0.0001) {
                        break;
                    }
                    if ($recipientName === $donorName) {
                        if ($forEnd && $toDate >= $fromDate) {
                            continue;
                        }
                        if (!$forEnd && $toDate <= $fromDate) {
                            continue;
                        }
                    }
                    if (
                        !$this->isRationalDdAlignmentDate(
                            $recipientName,
                            $toDate,
                            $ddStartsByName,
                            $taskAssignmentDetails['assignments'] ?? []
                        )
                    ) {
                        continue;
                    }
                    if (
                        $fromDate === $toDate
                        && !$this->isRationalDdSameDateAlignment(
                            $task,
                            $recipientName,
                            $donorName,
                            $toDate,
                            $ddStartsByName,
                            $taskAssignmentDetails['assignments'] ?? [],
                            $forEnd
                        )
                    ) {
                        continue;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($recipientModel, $toDate);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $move = min($left, $room);
                    if ($move <= 0.0001) {
                        continue;
                    }

                    $newDonor = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                    if ($newDonor <= 0.0001) {
                        unset($taskAssignmentDetails['assignments'][$idx]);
                    } else {
                        $taskAssignmentDetails['assignments'][$idx]['hours'] = $newDonor;
                    }

                    $targetIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                        if (($a['employee'] ?? null) === $recipientName && ($a['date'] ?? null) === $toDate) {
                            $targetIdx = $j;
                            break;
                        }
                    }
                    if ($targetIdx !== null) {
                        $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                            (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                    } else {
                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $recipientName,
                            'date' => $toDate,
                            'hours' => $move,
                        ];
                    }

                    $this->restoreGlobalAvailability($donorModel, $fromDate, $move);
                    $this->updateGlobalAvailability($recipientModel, $toDate, $move);
                    $left -= $move;
                    $changed = true;
                }
            }
        }

        if ($changed) {
            $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
        }
        return $changed;
    }
 
    /**
     * Pack each assignee's hours into the earliest contiguous run from their DD anchor
     * (fixes fragmented Gantt bars / orphan purple clusters after gap passes).
     */
    private function enforceHypermodeTwoPersonContiguousPlacement(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }
        if (($taskAssignmentDetails['mode'] ?? '') !== 'HYPERMODE_OVERRIDE_EVEN_SPLIT') {
            return;
        }

        $names = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
        ]));
        if (count($names) !== 2) {
            return;
        }

        $ddStarts = $taskAssignmentDetails['dd_starts_by_name'] ?? [];
        if ($ddStarts === [] && $this->taskDelayDays($task) > 0) {
            $ddStarts = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $names);
        }

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $totals = $stats['totals_by_employee'] ?? [];

        $taskStart = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()->toDateString()
            : null;
        $taskEnd = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(30)->endOfDay()->toDateString()
            : null;

        foreach ($names as $name) {
            $target = (float) ($totals[$name] ?? 0.0);
            if ($target <= 0.0001) {
                continue;
            }

            $emp = $allEmployees->first(fn($e) => $e->first_name === $name);
            if (!$emp) {
                continue;
            }

            $earliest = $ddStarts[$name] ?? $taskStart;

            $kept = [];
            foreach ($taskAssignmentDetails['assignments'] as $row) {
                if (($row['employee'] ?? null) !== $name) {
                    $kept[] = $row;
                    continue;
                }
                $d = $row['date'] ?? null;
                $h = is_numeric($row['hours'] ?? null) ? (float) $row['hours'] : 0.0;
                if ($d && $h > 0.0001) {
                    $this->restoreGlobalAvailability($emp, $d, $h);
                }
            }
            $taskAssignmentDetails['assignments'] = $kept;

            $left = $target;
            $dates = collect($emp->availabilities ?? [])
                ->map(fn($a) => $a->date ?? $a->Date ?? null)
                ->filter()
                ->filter(function ($d) use ($taskStart, $taskEnd, $earliest) {
                    if ($taskStart && $d < $taskStart) {
                        return false;
                    }
                    if ($taskEnd && $d > $taskEnd) {
                        return false;
                    }
                    if ($earliest && $d < $earliest) {
                        return false;
                    }

                    return true;
                })
                ->unique()
                ->sort()
                ->values();

            foreach ($dates as $date) {
                if ($left <= 0.0001) {
                    break;
                }
                $room = $this->getGlobalRemainingHoursOnDate($emp, $date);
                if ($room <= 0.0001) {
                    continue;
                }
                $chunk = min(8.0, $left, $room);
                if ($chunk <= 0.0001) {
                    continue;
                }

                $merged = false;
                foreach ($taskAssignmentDetails['assignments'] as $idx => $row) {
                    if (($row['employee'] ?? null) === $name && ($row['date'] ?? null) === $date) {
                        $taskAssignmentDetails['assignments'][$idx]['hours'] =
                            (float) ($row['hours'] ?? 0.0) + $chunk;
                        $merged = true;
                        break;
                    }
                }
                if (!$merged) {
                    $taskAssignmentDetails['assignments'][] = [
                        'employee' => $name,
                        'date' => $date,
                        'hours' => $chunk,
                    ];
                }

                $this->updateGlobalAvailability($emp, $date, $chunk);
                $left -= $chunk;
            }

            if ($left > 0.0001) {
                $this->appendExtraHoursOnAvailableDates(
                    $task,
                    $emp,
                    $taskAssignmentDetails['assignments'],
                    $left
                );
            }
        }

        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    }

    /**
     * When SH is explicitly provided in two-person hypermode:
     * - primary target is min(totalAssigned, SH)
     * - secondary gets the remainder
     * Also attempts to keep secondary remainder on primary's end date when feasible.
     */   
    private function enforceHypermodeTwoPersonShTarget(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }
        if (($taskAssignmentDetails['mode'] ?? '') !== 'HYPERMODE_OVERRIDE_EVEN_SPLIT') {
            return;
        }
        if (!is_numeric($task['SH'] ?? null)) {
            return;
        }
        $sh = (float) $task['SH'];
        if ($sh <= 0.0001) {
            return;
        }
        $taskStart = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()->toDateString()
            : null;
        $taskEnd = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(30)->endOfDay()->toDateString()
            : null;
        $dd = isset($task['DD']) && is_numeric($task['DD']) ? (int) $task['DD'] : 0;

        $primaryName = $taskAssignmentDetails['primary_employee'] ?? null;
        $secondaryName = $taskAssignmentDetails['secondary_employee'] ?? null;
        if (!$primaryName || !$secondaryName) {
            return;
        }
        $primaryModel = $allEmployees->first(fn($e) => $e->first_name === $primaryName);
        $secondaryModel = $allEmployees->first(fn($e) => $e->first_name === $secondaryName);
        if (!$primaryModel || !$secondaryModel) {
            return;
        }

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $totals = $stats['totals_by_employee'] ?? [];
        $existingDates = collect($stats['assignments'] ?? [])
            ->pluck('date')
            ->filter()
            ->unique()
            ->sort()
            ->values();
        $maxOriginalDate = $existingDates->isEmpty() ? null : $existingDates->last();
        $primaryTotal = (float) ($totals[$primaryName] ?? 0.0);
        $secondaryTotal = (float) ($totals[$secondaryName] ?? 0.0);
        $sum = $primaryTotal + $secondaryTotal;
        if ($sum <= 0.0001) {
            return;
        }

        $primaryTarget = min($sum, $sh);
        $needPrimary = $primaryTarget - $primaryTotal;
        if ($needPrimary > 0.0001) {
            $secondaryRows = [];
            foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                if (($a['employee'] ?? null) === $secondaryName && !empty($a['date'])) {
                    $secondaryRows[] = ['idx' => $idx, 'date' => $a['date']];
                }
            }
            usort($secondaryRows, fn($a, $b) => strcmp($b['date'], $a['date']));

            // Prefer existing primary assignment dates first (reduces fragmentation),
            // then include remaining primary availability dates.
            $primaryAssignedDates = collect($taskAssignmentDetails['assignments'] ?? [])
                ->where('employee', $primaryName)
                ->pluck('date')
                ->filter()
                ->unique()
                ->sortDesc()
                ->values();

            $candidateDates = $primaryAssignedDates
                ->concat(
                    collect($primaryModel->availabilities ?? [])
                        ->pluck('date')
                        ->filter()
                        ->sortDesc()
                        ->values()
                )
                ->filter(function ($d) use ($taskStart, $taskEnd) {
                    if (!$d) {
                        return false;
                    }
                    if ($taskStart && $d < $taskStart) {
                        return false;
                    }
                    if ($taskEnd && $d > $taskEnd) {
                        return false;
                    }
                    return true;
                })
                ->filter(function ($d) use ($maxOriginalDate) {
                    // Never extend task timeline during SH rebalance.
                    return !$maxOriginalDate || $d <= $maxOriginalDate;
                })
                ->unique()
                ->values()
                ->all();

            foreach ($secondaryRows as $row) {
                if ($needPrimary <= 0.0001) {
                    break;
                }
                $idx = $row['idx'];
                $fromDate = $row['date'];
                if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                    continue;
                }
                $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                if ($left <= 0.0001) {
                    continue;
                }

                $datesToTry = array_values(array_unique(array_merge([$fromDate], $candidateDates)));
                foreach ($datesToTry as $toDate) {
                    if ($needPrimary <= 0.0001 || $left <= 0.0001) {
                        break;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($primaryModel, $toDate);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $move = min($left, $needPrimary, $room);
                    if ($move <= 0.0001) {
                        continue;
                    }

                    $newSecondary = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                    if ($newSecondary <= 0.0001) {
                        unset($taskAssignmentDetails['assignments'][$idx]);
                    } else {
                        $taskAssignmentDetails['assignments'][$idx]['hours'] = $newSecondary;
                    }

                    $targetIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                        if (($a['employee'] ?? null) === $primaryName && ($a['date'] ?? null) === $toDate) {
                            $targetIdx = $j;
                            break;
                        }
                    }
                    if ($targetIdx !== null) {
                        $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                            (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                    } else {
                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $primaryName,
                            'date' => $toDate,
                            'hours' => $move,
                        ];
                    }

                    $this->restoreGlobalAvailability($secondaryModel, $fromDate, $move);
                    $this->updateGlobalAvailability($primaryModel, $toDate, $move);

                    $left -= $move;
                    $needPrimary -= $move;
                }
            }
        }

        // If primary exceeds SH target, move excess to secondary (strict cap on primary).
        $statsAfterUp = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $totalsAfterUp = $statsAfterUp['totals_by_employee'] ?? [];
        $primaryTotalAfterUp = (float) ($totalsAfterUp[$primaryName] ?? 0.0);
        $secondaryTotalAfterUp = (float) ($totalsAfterUp[$secondaryName] ?? 0.0);
        $sumAfterUp = $primaryTotalAfterUp + $secondaryTotalAfterUp;
        if ($sumAfterUp <= 0.0001) {
            return;
        }
        $primaryTargetAfterUp = min($sumAfterUp, $sh);
        $excessPrimary = $primaryTotalAfterUp - $primaryTargetAfterUp;

        if ($excessPrimary > 0.0001) {
            $primaryRows = [];
            foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                if (($a['employee'] ?? null) === $primaryName && !empty($a['date'])) {
                    $primaryRows[] = ['idx' => $idx, 'date' => $a['date']];
                }
            }
            usort($primaryRows, fn($a, $b) => strcmp($b['date'], $a['date']));

            // Prefer placing moved hours on existing secondary dates (reduces fragmentation),
            // and try same-day first to preserve alignment.
            $secondaryAssignedDates = collect($taskAssignmentDetails['assignments'] ?? [])
                ->where('employee', $secondaryName)
                ->pluck('date')
                ->filter()
                ->unique()
                ->sortDesc()
                ->values();

            $secondaryAvailabilityDates = collect($secondaryModel->availabilities ?? [])
                ->pluck('date')
                ->filter()
                ->sortDesc()
                ->values();

            foreach ($primaryRows as $row) {
                if ($excessPrimary <= 0.0001) {
                    break;
                }
                $idx = $row['idx'];
                $fromDate = $row['date'];
                if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                    continue;
                }
                $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                if ($left <= 0.0001) {
                    continue;
                }

                $candidateDates = collect([$fromDate])
                    ->concat($secondaryAssignedDates)
                    ->concat($secondaryAvailabilityDates)
                    ->filter(function ($d) use ($taskStart, $taskEnd) {
                        if (!$d) {
                            return false;
                        }
                        if ($taskStart && $d < $taskStart) {
                            return false;
                        }
                        if ($taskEnd && $d > $taskEnd) {
                            return false;
                        }
                        return true;
                    })
                    ->filter(function ($d) use ($maxOriginalDate) {
                        // Never extend task timeline during SH rebalance.
                        return !$maxOriginalDate || $d <= $maxOriginalDate;
                    })
                    ->unique()
                    ->values()
                    ->all();

                foreach ($candidateDates as $toDate) {
                    if ($excessPrimary <= 0.0001 || $left <= 0.0001) {
                        break;
                    }

                    // DD guard: do not move hours earlier than the effective task start.
                    if ($dd > 0 && $taskStart) {
                        $earliest = Carbon::parse($taskStart)->addDays($dd)->toDateString();
                        if ($toDate < $earliest) {
                            continue;
                        }
                    }

                    $room = $this->getGlobalRemainingHoursOnDate($secondaryModel, $toDate);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $move = min($left, $excessPrimary, $room);
                    if ($move <= 0.0001) {
                        continue;
                    }

                    $newPrimary = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                    if ($newPrimary <= 0.0001) {
                        unset($taskAssignmentDetails['assignments'][$idx]);
                    } else {
                        $taskAssignmentDetails['assignments'][$idx]['hours'] = $newPrimary;
                    }

                    $targetIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                        if (($a['employee'] ?? null) === $secondaryName && ($a['date'] ?? null) === $toDate) {
                            $targetIdx = $j;
                            break;
                        }
                    }
                    if ($targetIdx !== null) {
                        $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                            (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                    } else {
                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $secondaryName,
                            'date' => $toDate,
                            'hours' => $move,
                        ];
                    }

                    $this->restoreGlobalAvailability($primaryModel, $fromDate, $move);
                    $this->updateGlobalAvailability($secondaryModel, $toDate, $move);

                    $left -= $move;
                    $excessPrimary -= $move;
                }
            }

            $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
        }

        // If secondary has small remainder, try placing it on primary's end date.
        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $endDates = $stats['end_dates'] ?? [];
        $startDates = [];
        foreach (($stats['assignments'] ?? []) as $a) {
            $n = $a['employee'] ?? null;
            $d = $a['date'] ?? null;
            if (!$n || !$d) {
                continue;
            }
            if (!isset($startDates[$n]) || $d < $startDates[$n]) {
                $startDates[$n] = $d;
            }
        }
        $totals = $stats['totals_by_employee'] ?? [];
        $primaryEnd = $endDates[$primaryName] ?? null;
        $secondaryRemain = (float) ($totals[$secondaryName] ?? 0.0);
        if ($primaryEnd && $secondaryRemain > 0.0001) {
            if ($maxOriginalDate && $primaryEnd > $maxOriginalDate) {
                // Do not pull secondary remainder into a newly introduced later day.
                $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
                return;
            }
            $primaryStart = $startDates[$primaryName] ?? null;
            $secondaryMinAllowed = null;
            if ($dd > 0 && $primaryStart) {
                $secondaryMinAllowed = Carbon::parse($primaryStart)->addDays($dd)->toDateString();
            }
            // Respect DD: do not pull secondary earlier than its delayed window.
            if ($secondaryMinAllowed && $primaryEnd < $secondaryMinAllowed) {
                $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
                return;
            }
            $roomOnPrimaryEnd = $this->getGlobalRemainingHoursOnDate($secondaryModel, $primaryEnd);
            if ($roomOnPrimaryEnd > 0.0001) {
                $rows = [];
                foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                    if (($a['employee'] ?? null) === $secondaryName && ($a['date'] ?? null) !== $primaryEnd && !empty($a['date'])) {
                        $rows[] = ['idx' => $idx, 'date' => $a['date']];
                    }
                }
                usort($rows, fn($a, $b) => strcmp($b['date'], $a['date']));
                foreach ($rows as $row) {
                    if ($roomOnPrimaryEnd <= 0.0001) {
                        break;
                    }
                    $idx = $row['idx'];
                    $fromDate = $row['date'];
                    if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                        continue;
                    }
                    $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                    if ($left <= 0.0001) {
                        continue;
                    }
                    $move = min($left, $roomOnPrimaryEnd);
                    if ($move <= 0.0001) {
                        continue;
                    }

                    $newVal = $left - $move;
                    if ($newVal <= 0.0001) {
                        unset($taskAssignmentDetails['assignments'][$idx]);
                    } else {
                        $taskAssignmentDetails['assignments'][$idx]['hours'] = $newVal;
                    }

                    $targetIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                        if (($a['employee'] ?? null) === $secondaryName && ($a['date'] ?? null) === $primaryEnd) {
                            $targetIdx = $j;
                            break;
                        }
                    }
                    if ($targetIdx !== null) {
                        $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                            (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                    } else {
                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $secondaryName,
                            'date' => $primaryEnd,
                            'hours' => $move,
                        ];
                    }

                    $this->restoreGlobalAvailability($secondaryModel, $fromDate, $move);
                    $this->updateGlobalAvailability($secondaryModel, $primaryEnd, $move);
                    $roomOnPrimaryEnd -= $move;
                }
            }
        }

        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    }

    /**
     * Pack a task into earlier free dates for the same employee (fills gaps between tasks).
     * This does NOT reorder tasks globally; it only moves this task's own hours earlier where capacity exists.
     */
    private function compressTaskIntoEarlierGaps(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees) {
            return;
        }
        if (empty($taskAssignmentDetails['assignments'])) {
            return;
        }

        $taskStart = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()->toDateString()
            : null;
        $taskEnd = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(30)->endOfDay()->toDateString()
            : null;

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $rows = $stats['assignments'] ?? [];
        $maxAssignedDate = collect($rows)->pluck('date')->filter()->max();
        if (!$maxAssignedDate) {
            return;
        }

        // Group rows by employee
        $byEmp = [];
        foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
            $n = $a['employee'] ?? null;
            $d = $a['date'] ?? null;
            if ($n && $d) {
                $byEmp[$n][] = ['idx' => $idx, 'date' => $d];
            }
        }

        $slotNames = $this->getSelectedAssigneeNamesForTask($taskAssignmentDetails);
        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $slotNames);

        foreach ($byEmp as $name => $indexedRows) {
            $empModel = $allEmployees->first(fn($e) => $e->first_name === $name);
            if (!$empModel) {
                continue;
            }

            // Candidate early dates are the employee's availability dates within task window and <= current task max date.
            $candidateDates = collect($empModel->availabilities ?? [])
                ->pluck('date')
                ->filter()
                ->filter(function ($d) use ($taskStart, $taskEnd, $maxAssignedDate) {
                    if ($taskStart && $d < $taskStart) return false;
                    if ($taskEnd && $d > $taskEnd) return false;
                    return $d <= $maxAssignedDate;
                })
                ->unique()
                ->sort()
                ->values()
                ->all();

            if (empty($candidateDates)) {
                continue;
            }

            // Move from latest rows first into earliest candidate dates.
            usort($indexedRows, fn($a, $b) => strcmp($b['date'], $a['date']));

            foreach ($indexedRows as $row) {
                $idx = $row['idx'];
                $fromDate = $row['date'];
                if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                    continue;
                }
                $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                if ($left <= 0.0001) {
                    continue;
                }

                foreach ($candidateDates as $toDate) {
                    if ($left <= 0.0001) {
                        break;
                    }
                    if ($toDate >= $fromDate) {
                        break;
                    }
                    if (
                        !$this->isRationalDdAlignmentDate(
                            $name,
                            $toDate,
                            $ddStartsByName,
                            $taskAssignmentDetails['assignments'] ?? []
                        )
                    ) {
                        continue;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($empModel, $toDate);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $move = min($left, $room);
                    if ($move <= 0.0001) {
                        continue;
                    }

                    $newVal = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                    if ($newVal <= 0.0001) {
                        unset($taskAssignmentDetails['assignments'][$idx]);
                    } else {
                        $taskAssignmentDetails['assignments'][$idx]['hours'] = $newVal;
                    }

                    $targetIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                        if (($a['employee'] ?? null) === $name && ($a['date'] ?? null) === $toDate) {
                            $targetIdx = $j;
                            break;
                        }
                    }
                    if ($targetIdx !== null) {
                        $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                            (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                    } else {
                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $name,
                            'date' => $toDate,
                            'hours' => $move,
                        ];
                    }

                    // Free original date, consume earlier date.
                    $this->restoreGlobalAvailability($empModel, $fromDate, $move);
                    $this->updateGlobalAvailability($empModel, $toDate, $move);
                    $left -= $move;
                }
            }
        }

        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    }

    /**
     * Fill empty days inside the task's current assigned range by moving hours from later dates
     * into earlier gap days, possibly across the selected employees (when they have room).
     * This does NOT extend the task to later dates.
     */
    private function compressTaskAcrossEmployeesIntoEarlierGaps(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees || empty($taskAssignmentDetails['assignments'])) {
            return;
        }

        $selectedNames = $this->getSelectedAssigneeNamesForTask($taskAssignmentDetails);
        if (count($selectedNames) < 1) {
            return;
        }

        $taskStart = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()->toDateString()
            : null;
        $taskEnd = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(30)->endOfDay()->toDateString()
            : null;

        $stats = $this->computeAssignmentStats($taskAssignmentDetails['assignments'] ?? [], false);
        $rows = $stats['assignments'] ?? [];
        if (empty($rows)) {
            return;
        }
        $dates = collect($rows)->pluck('date')->filter()->unique()->sort()->values()->all();
        if (count($dates) < 1) {
            return;
        }
        $minAssignedDate = $dates[0];
        $maxDate = $dates[count($dates) - 1];
        $rangeStart = $minAssignedDate;
        if ($taskStart && $taskStart < $rangeStart) {
            $rangeStart = $taskStart;
        }

        // Gap dates from task start through last assigned day (includes empty days before first assignment).
        $cursor = Carbon::parse($rangeStart);
        $endCursor = Carbon::parse($maxDate);
        $gapDates = [];
        while ($cursor->lte($endCursor)) {
            $d = $cursor->toDateString();
            if ($taskStart && $d < $taskStart) {
                $cursor->addDay();
                continue;
            }
            if ($taskEnd && $d > $taskEnd) {
                break;
            }
            $gapDates[] = $d;
            $cursor->addDay();
        }

        // Build quick lookup: total hours assigned on each date for this task (selected employees only).
        $assignedByDate = [];
        foreach ($rows as $a) {
            $n = $a['employee'] ?? null;
            $d = $a['date'] ?? null;
            $h = (float) ($a['hours'] ?? 0.0);
            if (!$n || !$d || $h <= 0.0001 || !in_array($n, $selectedNames, true)) {
                continue;
            }
            $assignedByDate[$d] = ($assignedByDate[$d] ?? 0.0) + $h;
        }

        $donorRows = [];
        foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
            $n = $a['employee'] ?? null;
            $d = $a['date'] ?? null;
            if (!$n || !$d || !in_array($n, $selectedNames, true)) {
                continue;
            }
            if ($d > $rangeStart) {
                $donorRows[] = ['idx' => $idx, 'name' => $n, 'date' => $d];
            }
        }
        usort($donorRows, fn($a, $b) => strcmp($b['date'], $a['date']));

        $slotNames = $this->getSelectedAssigneeNamesForTask($taskAssignmentDetails);
        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $slotNames);

        // Recipient preference: primary -> secondary -> tertiary (stable).
        $recipientModels = [];
        foreach ($selectedNames as $name) {
            $m = $allEmployees->first(fn($e) => $e->first_name === $name);
            if ($m) {
                $recipientModels[] = ['name' => $name, 'model' => $m];
            }
        }
        if (empty($recipientModels)) {
            return;
        }

        $changed = false;
        foreach ($gapDates as $gap) {
            // Only fill dates that are completely empty for this task.
            if (($assignedByDate[$gap] ?? 0.0) > 0.0001) {
                continue;
            }

            foreach ($donorRows as $row) {
                $idx = $row['idx'];
                $donorName = $row['name'];
                $fromDate = $row['date'];
                if ($gap >= $fromDate) {
                    continue;
                }
                if (
                    !$this->isRationalDdAlignmentDate(
                        $donorName,
                        $gap,
                        $ddStartsByName,
                        $taskAssignmentDetails['assignments'] ?? []
                    )
                ) {
                    continue;
                }
                if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                    continue;
                }
                $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0);
                if ($left <= 0.0001) {
                    continue;
                }
                $donorModel = $allEmployees->first(fn($e) => $e->first_name === $donorName);
                if (!$donorModel) {
                    continue;
                }

                foreach ($recipientModels as $rec) {
                    $recName = $rec['name'];
                    $recModel = $rec['model'];
                    if (
                        !$this->isRationalDdAlignmentDate(
                            $recName,
                            $gap,
                            $ddStartsByName,
                            $taskAssignmentDetails['assignments'] ?? []
                        )
                    ) {
                        continue;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($recModel, $gap);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $move = min($left, $room);
                    if ($move <= 0.0001) {
                        continue;
                    }

                    $newDonor = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0.0) - $move;
                    if ($newDonor <= 0.0001) {
                        unset($taskAssignmentDetails['assignments'][$idx]);
                    } else {
                        $taskAssignmentDetails['assignments'][$idx]['hours'] = $newDonor;
                    }

                    $targetIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                        if (($a['employee'] ?? null) === $recName && ($a['date'] ?? null) === $gap) {
                            $targetIdx = $j;
                            break;
                        }
                    }
                    if ($targetIdx !== null) {
                        $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                            (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0.0) + $move;
                    } else {
                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $recName,
                            'date' => $gap,
                            'hours' => $move,
                        ];
                    }

                    $this->restoreGlobalAvailability($donorModel, $fromDate, $move);
                    $this->updateGlobalAvailability($recModel, $gap, $move);

                    $assignedByDate[$gap] = ($assignedByDate[$gap] ?? 0.0) + $move;
                    $changed = true;
                    break 2; // gap filled at least partially; move to next gap date
                }
            }
        }

        if ($changed) {
            $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
        }
    }

    /**
     * Pull task hours from later dates into the earliest feasible days (per employee)
     * to minimize calendar span while keeping total assigned hours unchanged.
     */
    private function compressTaskToShortestPeriod(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees || empty($taskAssignmentDetails['assignments'])) {
            return;
        }

        $taskStart = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()->toDateString()
            : null;
        $taskEnd = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(30)->endOfDay()->toDateString()
            : null;

        $slotNames = $this->getSelectedAssigneeNamesForTask($taskAssignmentDetails);
        $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $slotNames);

        $maxRounds = 200;
        for ($round = 0; $round < $maxRounds; $round++) {
            $changed = false;
            $donorRows = [];
            foreach ($taskAssignmentDetails['assignments'] as $idx => $a) {
                $name = $a['employee'] ?? null;
                $date = $a['date'] ?? null;
                $hours = (float) ($a['hours'] ?? 0);
                if (!$name || !$date || $hours <= 0.0001) {
                    continue;
                }
                if ($slotNames !== [] && !in_array($name, $slotNames, true)) {
                    continue;
                }
                $donorRows[] = ['idx' => $idx, 'name' => $name, 'date' => $date, 'hours' => $hours];
            }
            usort($donorRows, fn($a, $b) => strcmp($b['date'], $a['date']));

            foreach ($donorRows as $row) {
                $idx = $row['idx'];
                if (!isset($taskAssignmentDetails['assignments'][$idx])) {
                    continue;
                }
                $donorName = $row['name'];
                $fromDate = $row['date'];
                $donorModel = $allEmployees->first(fn($e) => $e->first_name === $donorName);
                if (!$donorModel) {
                    continue;
                }

                $left = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0);
                if ($left <= 0.0001) {
                    continue;
                }

                $candidateDates = collect($donorModel->availabilities ?? [])
                    ->pluck('date')
                    ->filter()
                    ->unique()
                    ->sort()
                    ->filter(function ($d) use ($fromDate, $taskStart, $taskEnd) {
                        if ($d >= $fromDate) {
                            return false;
                        }
                        if ($taskStart && $d < $taskStart) {
                            return false;
                        }
                        if ($taskEnd && $d > $taskEnd) {
                            return false;
                        }

                        return true;
                    })
                    ->values()
                    ->all();

                foreach ($candidateDates as $toDate) {
                    if ($left <= 0.0001) {
                        break;
                    }
                    if (
                        !$this->isRationalDdAlignmentDate(
                            $donorName,
                            $toDate,
                            $ddStartsByName,
                            $taskAssignmentDetails['assignments'] ?? []
                        )
                    ) {
                        continue;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($donorModel, $toDate);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $move = min($left, $room);
                    if ($move <= 0.0001) {
                        continue;
                    }

                    $newFrom = (float) ($taskAssignmentDetails['assignments'][$idx]['hours'] ?? 0) - $move;
                    if ($newFrom <= 0.0001) {
                        unset($taskAssignmentDetails['assignments'][$idx]);
                    } else {
                        $taskAssignmentDetails['assignments'][$idx]['hours'] = $newFrom;
                    }

                    $targetIdx = null;
                    foreach ($taskAssignmentDetails['assignments'] as $j => $a) {
                        if (($a['employee'] ?? null) === $donorName && ($a['date'] ?? null) === $toDate) {
                            $targetIdx = $j;
                            break;
                        }
                    }
                    if ($targetIdx !== null) {
                        $taskAssignmentDetails['assignments'][$targetIdx]['hours'] =
                            (float) ($taskAssignmentDetails['assignments'][$targetIdx]['hours'] ?? 0) + $move;
                    } else {
                        $taskAssignmentDetails['assignments'][] = [
                            'employee' => $donorName,
                            'date' => $toDate,
                            'hours' => $move,
                        ];
                    }

                    $this->restoreGlobalAvailability($donorModel, $fromDate, $move);
                    $this->updateGlobalAvailability($donorModel, $toDate, $move);
                    $left -= $move;
                    $changed = true;
                }
            }

            if (!$changed) {
                break;
            }
        }

        $this->compressTaskAcrossEmployeesIntoEarlierGaps($task, $taskAssignmentDetails, $allEmployees);
        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    }

    /**
     * Earliest timestamp to search for the next assignment day when minimizing task span.
     */
    private function resolveEarliestSchedulingAnchorTs(
        array $task,
        array $taskAssignmentDetails,
        array $emp,
        $employees,
        array $ddDelayedStarts,
        int $fallbackTs
    ): int {
        $taskStartTs = !empty($task['Doc_Supply']) ? strtotime($task['Doc_Supply']) : false;
        $anchorTs = $taskStartTs !== false ? $taskStartTs : $fallbackTs;

        $empName = $emp['model']->first_name ?? null;
        if ($empName) {
            foreach ($taskAssignmentDetails['assignments'] ?? [] as $row) {
                if (($row['employee'] ?? null) !== $empName || empty($row['date'])) {
                    continue;
                }
                $rowTs = strtotime((string) $row['date']);
                if ($rowTs !== false) {
                    $anchorTs = max($anchorTs, $rowTs + 86400);
                }
            }
        }

        $empIndex = $employees->search(fn($e) => ($e['id'] ?? null) === ($emp['id'] ?? null));
        if ($empIndex !== false && isset($ddDelayedStarts[$empIndex])) {
            $ddTs = strtotime((string) $ddDelayedStarts[$empIndex]);
            if ($ddTs !== false) {
                $anchorTs = max($anchorTs, $ddTs);
            }
        }

        return $anchorTs;
    }

    private function getEmployeeOAP($employeeModel, $task)
    {
        $number = $this->extractNumberFromTaskName($task['TaskName']);
        $nrm = $employeeModel->nrms->firstWhere('number', $number);
        return $nrm?->pivot?->OAP;
    }

    private function getEmployeeByName($name)
    {
        return Employee::where('first_name', $name)->first();
    }

    private function filterAvailabilities($employee, array $task)
    {
        $availabilities = $employee->availabilities ?? collect();

        $taskStart = Carbon::parse($task['Doc_Supply'])->startOfDay();
        $taskEnd = Carbon::parse($task['Completion'])->addDays(30)->endOfDay();

        // 🔥 EXCLUDE done availability days + ensure >0 Total
        $avail = $availabilities->filter(function ($a) use ($taskStart, $taskEnd) {
            $d = Carbon::parse($a->date);

            return
                $d->betweenIncluded($taskStart, $taskEnd) &&
                (float) $a->Total > 0 &&
                (int) $a->done !== 1;
        });

        $assignedAvailability = null;

        // 🔥 Fallback (also exclude done) — never allow dates before task start.
        if ($avail->isEmpty() && $this->features['availability_fallback']) {

            $closest = $availabilities
                ->filter(
                    function ($a) use ($taskStart, $taskEnd) {
                        $d = Carbon::parse($a->date);
                        return
                            $d->betweenIncluded($taskStart, $taskEnd) &&
                            (float) $a->Total > 0 &&
                            (int) $a->done !== 1;
                    }
                )
                ->sortBy(fn($a) => abs(Carbon::parse($a->date)->diffInSeconds($taskStart)))
                ->first();

            if ($closest) {
                $avail = collect([$closest]);
                $assignedAvailability = Carbon::parse($closest->date)->toDateString();
            }
        } else {
            $assignedAvailability = Carbon::parse(optional($avail->first())->date)->toDateString();
        }

        return [
            'availabilities' => $avail->sortBy(fn($a) => Carbon::parse($a->date))->values(),
            'assigned_date' => $assignedAvailability,
        ];
    }



    private function convertToHours($value)
    {
        if (is_numeric($value)) {
            return (float) $value;
        }
        if (strpos($value, ':') !== false) {
            [$hours, $minutes] = explode(':', $value);
            return (float) $hours + ($minutes / 60.0);
        }
        return 0.0;
    }

    private function updateSpentHrs(&$spentHrs, $employeeId, $taskId, $taskName, $hoursAssigned, $date)
    {
        $spentHrs[] = [
            'employee_id' => $employeeId,
            'task_id' => $taskId,
            'task_name' => $taskName,
            'date' => $date,
            'hours' => $hoursAssigned,
        ];
    }

    /**
     * Returns trainee/operative pair when exactly 2 assignees contain one trainee and one operative.
     */
    private function getTraineeOperativePair($employees, array $task): ?array
    {
        if (!$employees || $employees->count() !== 2) {
            return null;
        }
        $trainee = null;
        $operative = null;
        foreach ($employees as $emp) {
            $rate = $this->getEmployeePerformanceRate($emp, $task);
            if ($rate > 0 && $rate < 1.0 - 0.0001) {
                $trainee = $emp;
            } elseif ($rate >= 1.0 - 0.0001) {
                $operative = $emp;
            }
        }

        if (!$trainee || !$operative) {
            return null;
        }

        return [
            'trainee' => $trainee,
            'operative' => $operative,
        ];
    }

    /**
     * Resolve two-person synchronized mode pair only when we can identify
     * a real trainee+operative combination.
     */
    private function resolveSynchronizedTwoPersonPair($employees, array $task): ?array
    {
        return $this->getTraineeOperativePair($employees, $task);
    }

    /**
     * Assign one employee across dates in chosen direction.
     * forward=false: earliest->latest (trainee first), reverse=true: latest->earliest.
     * When $anchorDate is provided in reverse mode, date eligibility is collected from that date backward,
     * then assignment is applied in forward order so small tails land at the end date.
     *
     * @return array{assigned: float, last_date: ?string}
     */
    private function assignEmployeeByDateDirection(
        $employee,
        $dates,
        array &$availabilityMap,
        array &$remainingQuota,
        float &$remainingPlan,
        array &$taskAssignmentDetails,
        bool $reverse = false,
        ?string $anchorDate = null
    ): array {
        $result = ['assigned' => 0.0, 'last_date' => null];
        if (!$employee || $remainingPlan <= 0) {
            return $result;
        }
        $empId = $employee->id ?? null;
        if (!$empId) {
            return $result;
        }

        $orderedDates = $reverse ? collect($dates)->reverse()->values() : collect($dates)->values();
        if ($reverse && !empty($anchorDate)) {
            // For trainee+operative same-end-date mode:
            // keep chronological allocation (no backward backfill) to avoid introduced gaps.
            $orderedDates = collect($dates)
                ->filter(fn($d) => $d <= $anchorDate)
                ->values();
        }
        foreach ($orderedDates as $date) {
            // Exhaust this calendar day before moving on (same-day remainder was being skipped).
            while ($remainingPlan > 0) {
                $quota = (float) ($remainingQuota[$empId] ?? 0.0);
                if ($quota <= 0.0001) {
                    break;
                }

                $ava = $availabilityMap[$empId]->first(fn($a) => $a->date === $date);
                if (!$ava) {
                    break;
                }

                // Read live remaining hours from shared in-memory calendar.
                $available = $this->getGlobalRemainingHoursOnDate($employee, $date);
                if ($available <= 0.0001) {
                    break;
                }
                $assign = min($available, $quota, $remainingPlan);
                if ($assign <= 0.0001) {
                    break;
                }

                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $employee->first_name,
                    'date' => $date,
                    'hours' => $assign,
                ];
                $taskAssignmentDetails['end_dates'][$employee->first_name] = $date;
                if ($result['last_date'] === null || $date > $result['last_date']) {
                    $result['last_date'] = $date;
                }

                $ava->Total -= $assign;
                $remainingPlan -= $assign;
                $remainingQuota[$empId] = $quota - $assign;
                $this->updateGlobalAvailability($employee, $date, $assign);
                $result['assigned'] += $assign;
            }
        }
        if ($reverse && !empty($anchorDate) && $result['assigned'] > 0) {
            // Keep operative and trainee finish date aligned in anchored reverse mode.
            $result['last_date'] = $anchorDate;
            $taskAssignmentDetails['end_dates'][$employee->first_name] = $anchorDate;
        }
        return $result;
    }

    /**
     * Trainee date list in pair mode.
     * Keep all trainee-available dates to avoid dropping valid middle solo days.
     */
    private function buildTraineeDatesForPairMode($trainee, $operative, array $availabilityMap, $dates): array
    {
        $allDates = collect($dates)->values();
        $traineeId = $trainee->id ?? null;
        if (!$traineeId) {
            return $allDates->toArray();
        }

        $traineeAvail = ($availabilityMap[$traineeId] ?? collect())
            ->filter(fn($a) => (float) ($a->Total ?? 0) > 0.0001)
            ->pluck('date')
            ->filter()
            ->unique()
            ->values();
        if ($traineeAvail->isEmpty()) {
            return [];
        }

        $traineeSet = [];
        foreach ($traineeAvail as $dayValue) {
            $ymd = $this->normalizeAlgorithmDate($dayValue);
            if ($ymd !== null) {
                $traineeSet[$ymd] = true;
            }
        }

        return $allDates
            ->filter(function ($date) use ($traineeSet) {
                $ymd = $this->normalizeAlgorithmDate($date);

                return $ymd !== null && isset($traineeSet[$ymd]);
            })
            ->values()
            ->toArray();
    }

    /**
     * Distribute synchronized pair hours day-by-day once both are in-window.
     * Keeps C behavior (trainee may work before operative starts), then assigns both
     * together on shared dates so they trend to same finish day.
     */
    private function assignSynchronizedPairDayByDay(
        $trainee,
        $operative,
        $dates,
        array &$availabilityMap,
        array &$remainingQuota,
        float &$remainingPlan,
        array &$taskAssignmentDetails
    ): void {
        $traineeId = $trainee->id ?? null;
        $operativeId = $operative->id ?? null;
        if (!$traineeId || !$operativeId || $remainingPlan <= 0.0001) {
            return;
        }

        $allDates = collect($dates)->sort()->values();
        $operativeFirst = ($availabilityMap[$operativeId] ?? collect())
            ->filter(fn($a) => (float) ($a->Total ?? 0) > 0.0001)
            ->pluck('date')
            ->filter()
            ->sort()
            ->first();

        $traineeDates = $this->buildTraineeDatesForPairMode(
            $trainee,
            $operative,
            $availabilityMap,
            $allDates
        );

        // Phase 1: trainee before operative first date (C).
        if (!empty($operativeFirst)) {
            $preStartDates = collect($traineeDates)
                ->filter(fn($d) => $d < $operativeFirst)
                ->values()
                ->toArray();
            if (!empty($preStartDates) && $remainingPlan > 0.0001) {
                $this->assignEmployeeByDateDirection(
                    $trainee,
                    $preStartDates,
                    $availabilityMap,
                    $remainingQuota,
                    $remainingPlan,
                    $taskAssignmentDetails,
                    false
                );
            }
        }

        // Phase 2: shared day-by-day distribution.
        $sharedDates = collect($traineeDates)
            ->filter(fn($d) => empty($operativeFirst) ? true : ($d >= $operativeFirst))
            ->values();

        foreach ($sharedDates as $date) {
            if ($remainingPlan <= 0.0001) {
                break;
            }

            $tAvail = $this->getGlobalRemainingHoursOnDate($trainee, $date);
            $oAvail = $this->getGlobalRemainingHoursOnDate($operative, $date);
            if ($tAvail <= 0.0001 && $oAvail <= 0.0001) {
                continue;
            }

            $tQuota = max(0.0, (float) ($remainingQuota[$traineeId] ?? 0.0));
            $oQuota = max(0.0, (float) ($remainingQuota[$operativeId] ?? 0.0));
            $pairCap = min($remainingPlan, $tAvail + $oAvail);
            if ($pairCap <= 0.0001) {
                continue;
            }

            // Balanced base split, then spill by availability.
            $tAssign = min($tAvail, $pairCap / 2.0, $tQuota > 0.0001 ? $tQuota : $pairCap);
            $oAssign = min($oAvail, $pairCap - $tAssign, $oQuota > 0.0001 ? $oQuota : $pairCap);

            $left = $pairCap - ($tAssign + $oAssign);
            if ($left > 0.0001) {
                $extraT = min($left, max(0.0, $tAvail - $tAssign));
                if ($tQuota > 0.0001) {
                    $extraT = min($extraT, max(0.0, $tQuota - $tAssign));
                }
                $tAssign += $extraT;
                $left -= $extraT;
            }
            if ($left > 0.0001) {
                $extraO = min($left, max(0.0, $oAvail - $oAssign));
                if ($oQuota > 0.0001) {
                    $extraO = min($extraO, max(0.0, $oQuota - $oAssign));
                }
                $oAssign += $extraO;
                $left -= $extraO;
            }

            if ($tAssign > 0.0001) {
                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $trainee->first_name,
                    'date' => $date,
                    'hours' => $tAssign,
                ];
                $taskAssignmentDetails['end_dates'][$trainee->first_name] = $date;
                $remainingPlan -= $tAssign;
                $remainingQuota[$traineeId] = max(0.0, $tQuota - $tAssign);
                $this->updateGlobalAvailability($trainee, $date, $tAssign);
            }

            if ($oAssign > 0.0001 && $remainingPlan > -0.0001) {
                $taskAssignmentDetails['assignments'][] = [
                    'employee' => $operative->first_name,
                    'date' => $date,
                    'hours' => $oAssign,
                ];
                $taskAssignmentDetails['end_dates'][$operative->first_name] = $date;
                $remainingPlan -= $oAssign;
                $remainingQuota[$operativeId] = max(0.0, $oQuota - $oAssign);
                $this->updateGlobalAvailability($operative, $date, $oAssign);
            }
        }

        $tEnd = $taskAssignmentDetails['end_dates'][$trainee->first_name] ?? null;
        $oEnd = $taskAssignmentDetails['end_dates'][$operative->first_name] ?? null;
        if (!empty($tEnd) && !empty($oEnd)) {
            $same = max($tEnd, $oEnd);
            $taskAssignmentDetails['end_dates'][$trainee->first_name] = $same;
            $taskAssignmentDetails['end_dates'][$operative->first_name] = $same;
        }
    }

    /**
     * Integer hour targets per employee: even split.
     * (70/30 trainee–operative split disabled — was splitPlanTraineeOperative7030.)
     *
     * @param \Illuminate\Support\Collection $employees
     * @return int[]
     */
    /**
     * True when two override slots share plan under an explicit SH cap (primary min(plan,SH), secondary remainder).
     */
    private function isHypermodeTwoPersonShAsymmetricSplit($employees, array $targets, array $task): bool
    {
        if (!$employees || $employees->count() !== 2) {
            return false;
        }
        if (!$this->features['use_SH_limit'] || empty($task['SH']) || !is_numeric($task['SH'])) {
            return false;
        }
        if ((float) $task['SH'] <= 0.0001) {
            return false;
        }

        return abs((float) ($targets[0] ?? 0.0) - (float) ($targets[1] ?? 0.0)) > 0.0001;
    }

    /**
     * Hypermode override quotas: when SH is set on a two-person split, slot-1 gets min(plan, SH)
     * and slot-2 gets the remainder (not an even 50/50).
     */
    private function buildHypermodeOverrideFairTargets(float $plan, $employees, array $task): array
    {
        $employeeCount = $employees->count();
        if ($employeeCount <= 0) {
            return [];
        }

        $sh = null;
        if ($this->features['use_SH_limit'] && !empty($task['SH']) && is_numeric($task['SH'])) {
            $shVal = (float) $task['SH'];
            if ($shVal > 0.0001) {
                $sh = $shVal;
            }
        }

        if ($employeeCount === 2 && $sh !== null) {
            $primaryTarget = min($plan, $sh);
            $secondaryTarget = max(0.0, $plan - $primaryTarget);
            $p = (int) round($primaryTarget);
            $s = (int) round($secondaryTarget);
            $planInt = (int) round($plan);
            $overflow = ($p + $s) - $planInt;
            if ($overflow > 0) {
                $p = max(0, $p - $overflow);
            } elseif ($overflow < 0) {
                $s += abs($overflow);
            }

            return [$p, $s];
        }

        return $this->buildPlanTargetsForEmployees($plan, $employees, $task);
    }

    private function buildPlanTargetsForEmployees(float $plan, $employees, array $task): array
    {
        $employeeCount = $employees->count();
        if ($employeeCount <= 0) {
            return [];
        }

        // 70/30 split (commented out — use even split only)
        // $split = ($employeeCount === 2)
        //     ? $this->splitPlanTraineeOperative7030($plan, $employees, $task)
        //     : null;
        // if ($split !== null) {
        //     return $split;
        // }

        $baseTarget = $plan / $employeeCount;
        $targets = array_fill(0, $employeeCount, (int) ceil($baseTarget));
        $overflow = array_sum($targets) - $plan;
        if ($overflow > 0) {
            for ($i = $employeeCount - 1; $i >= 0 && $overflow > 0; $i--) {
                $deduct = min($overflow, $targets[$i]);
                $targets[$i] -= $deduct;
                $overflow -= $deduct;
            }
        }

        return $targets;
    }

    /**
     * Unused while 70/30 split is commented out: trainee 70%, operative 30% of $plan on 2.1 / 2.5 / 3.1.
     *
     * @return int[]|null  Index-aligned with $employees, or null if not exactly one trainee + one operative.
     */
    private function splitPlanTraineeOperative7030(float $plan, $employees, array $task): ?array
    {
        if (!$employees || $employees->count() !== 2 || !$this->isDefaultTraineePairActivityTask($task)) {
            return null;
        }

        $traineeIndices = [];
        $operativeIndices = [];
        foreach ($employees as $idx => $emp) {
            $rate = $this->getEmployeePerformanceRate($emp, $task);
            if ($rate > 0 && $rate < 1.0 - 0.0001) {
                $traineeIndices[] = $idx;
            } elseif ($rate >= 1.0 - 0.0001) {
                $operativeIndices[] = $idx;
            }
        }

        if (count($traineeIndices) !== 1 || count($operativeIndices) !== 1) {
            return null;
        }

        $traineeIdx = $traineeIndices[0];
        $operativeIdx = $operativeIndices[0];

        $planInt = (int) round($plan);
        if ($planInt <= 0) {
            return [0, 0];
        }

        $traineeHours = (int) round($planInt * 0.7);
        $operativeHours = max(0, $planInt - $traineeHours);

        $targets = [0, 0];
        $targets[$traineeIdx] = $traineeHours;
        $targets[$operativeIdx] = $operativeHours;

        return $targets;
    }

    private function extractNumberFromTaskName($taskName)
    {
        preg_match('/^\d+\.\d+/', $taskName, $matches);
        return $matches[0] ?? null;
    }

    private function taskDelayDays(array $task): int
    {
        return isset($task['DD']) && is_numeric($task['DD']) ? max(0, (int) $task['DD']) : 0;
    }

    /**
     * DD slot order: operative (slot 0) then trainee, then any tertiary — not raw primary/secondary slots.
     *
     * @param string[] $orderedNames
     * @return string[]
     */
    private function resolveDdOrderedAssigneeNames(array $task, $allEmployees, array $orderedNames): array
    {
        $orderedNames = array_values(array_filter($orderedNames));
        if (count($orderedNames) < 2 || !$allEmployees) {
            return $orderedNames;
        }

        $models = collect($orderedNames)
            ->map(fn($n) => $allEmployees->first(fn($e) => $e->first_name === $n))
            ->filter()
            ->values();
        if ($models->count() < 2) {
            return $orderedNames;
        }

        $pair = $this->getTraineeOperativePair($models, $task);
        if (!$pair) {
            return $orderedNames;
        }

        $result = [$pair['operative']->first_name, $pair['trainee']->first_name];
        foreach ($orderedNames as $name) {
            if (!in_array($name, $result, true)) {
                $result[] = $name;
            }
        }

        return $result;
    }

    /**
     * Hard guard: remove/replace assignment rows that violate per-employee DD earliest start.
     */
    private function enforceOverrideAssignmentsRespectDdStarts(
        array $task,
        array &$taskAssignmentDetails,
        $allEmployees
    ): void {
        if (!$allEmployees || $this->taskDelayDays($task) <= 0) {
            return;
        }

        $orderedNames = array_values(array_filter([
            $taskAssignmentDetails['primary_employee'] ?? null,
            $taskAssignmentDetails['secondary_employee'] ?? null,
            $taskAssignmentDetails['tertiary_employee'] ?? null,
        ]));
        if ($orderedNames === []) {
            $orderedNames = collect($taskAssignmentDetails['assignments'] ?? [])
                ->pluck('employee')
                ->filter()
                ->unique()
                ->values()
                ->all();
        }
        if ($orderedNames === []) {
            return;
        }

        $ddStartsByName = $taskAssignmentDetails['dd_starts_by_name'] ?? [];
        if ($ddStartsByName === []) {
            $ddStartsByName = $this->buildDdEarliestStartsByEmployeeName($task, $allEmployees, $orderedNames);
        }
        if ($ddStartsByName === []) {
            return;
        }

        $removedByEmployee = [];
        $kept = [];
        foreach ($taskAssignmentDetails['assignments'] ?? [] as $row) {
            $name = $row['employee'] ?? null;
            $date = $row['date'] ?? null;
            $hours = is_numeric($row['hours'] ?? null) ? (float) $row['hours'] : 0.0;
            if (!$name || !$date || $hours <= 0.0001) {
                continue;
            }
            $earliest = $ddStartsByName[$name] ?? null;
            if ($earliest && $date < $earliest) {
                $removedByEmployee[$name] = ($removedByEmployee[$name] ?? 0.0) + $hours;
                $empModel = $allEmployees->first(fn($e) => $e->first_name === $name);
                if ($empModel) {
                    $this->restoreGlobalAvailability($empModel, $date, $hours);
                }
                continue;
            }
            $kept[] = $row;
        }

        if ($removedByEmployee === []) {
            return;
        }

        $taskAssignmentDetails['assignments'] = $kept;
        foreach ($removedByEmployee as $name => $hours) {
            $empModel = $allEmployees->first(fn($e) => $e->first_name === $name);
            if (!$empModel || $hours <= 0.0001) {
                continue;
            }
            $earliest = $ddStartsByName[$name] ?? null;
            $left = (float) $hours;
            $guard = 0;
            while ($left > 0.0001 && $guard++ < 400) {
                $placed = false;
                $candidates = $this->filterAvailabilities($empModel, $task)['availabilities']
                    ->filter(fn($a) => (float) $this->convertToHours($a->Total ?? 0) > 0.0001)
                    ->sortBy(fn($a) => $a->date ?? $a->Date ?? '');
                foreach ($candidates as $ava) {
                    $d = $ava->date ?? $ava->Date ?? null;
                    if (!$d || ($earliest && $d < $earliest)) {
                        continue;
                    }
                    if (
                        !$this->isOverrideEmployeeDateEligible(
                            $empModel,
                            (string) $d,
                            $ddStartsByName,
                            $taskAssignmentDetails['assignments'] ?? []
                        )
                    ) {
                        continue;
                    }
                    $room = $this->getGlobalRemainingHoursOnDate($empModel, $d);
                    if ($room <= 0.0001) {
                        continue;
                    }
                    $chunk = min(8.0, $left, $room);
                    if ($chunk <= 0.0001) {
                        continue;
                    }
                    $taskAssignmentDetails['assignments'][] = [
                        'employee' => $name,
                        'date' => $d,
                        'hours' => $chunk,
                    ];
                    $this->updateGlobalAvailability($empModel, $d, $chunk);
                    $left -= $chunk;
                    $placed = true;
                    break;
                }
                if (!$placed) {
                    break;
                }
            }
        }

        $taskAssignmentDetails['assignments'] = array_values($taskAssignmentDetails['assignments']);
    }

    /**
     * Earliest calendar day for an employee inside the task window (ignores remaining hours).
     * Used for DD base dates so finalize guards do not shift when early days are already filled.
     */
    private function resolveEmployeeEarliestCalendarDateInTaskWindow($employee, array $task): ?string
    {
        if (!$employee) {
            return null;
        }

        $taskStartDate = !empty($task['Doc_Supply'])
            ? Carbon::parse($task['Doc_Supply'])->startOfDay()->toDateString()
            : null;
        $taskEndDate = !empty($task['Completion'])
            ? Carbon::parse($task['Completion'])->addDays(30)->endOfDay()->toDateString()
            : null;

        $earliest = collect($employee->availabilities ?? [])
            ->map(function ($a) {
                $date = $a->date ?? $a->Date ?? null;
                if (!$date || (int) ($a->done ?? 0) === 1) {
                    return null;
                }

                return $date;
            })
            ->filter()
            ->filter(function ($date) use ($taskStartDate, $taskEndDate) {
                if ($taskStartDate && $date < $taskStartDate) {
                    return false;
                }
                if ($taskEndDate && $date > $taskEndDate) {
                    return false;
                }

                return true;
            })
            ->sort()
            ->first();

        if ($taskStartDate && ($earliest === null || $earliest < $taskStartDate)) {
            return $taskStartDate;
        }

        return $earliest ?? $taskStartDate;
    }

    /**
     * @param string[] $orderedNames slot order: primary, secondary, tertiary
     * @return array<string, string> first_name => earliest allowed Y-m-d
     */
    private function buildDdEarliestStartsByEmployeeName(
        array $task,
        $allEmployees,
        array $orderedNames
    ): array {
        $dd = $this->taskDelayDays($task);
        if ($dd <= 0 || empty($orderedNames) || !$allEmployees) {
            return [];
        }

        $slotOrder = $this->resolveDdOrderedAssigneeNames($task, $allEmployees, $orderedNames);
        $primaryName = $slotOrder[0] ?? null;
        if (!$primaryName) {
            return [];
        }

        $primary = $allEmployees->first(fn($e) => $e->first_name === $primaryName);
        if (!$primary) {
            return [];
        }

        $baseDate = $this->resolveEmployeeEarliestCalendarDateInTaskWindow($primary, $task);
        if (!$baseDate) {
            return [];
        }

        $map = [];
        foreach (array_values($slotOrder) as $idx => $name) {
            if (!$name) {
                continue;
            }
            $map[$name] = $idx === 0
                ? $baseDate
                : ($this->getEmployeeDelayedStartDate($baseDate, $idx, $dd) ?? $baseDate);
        }

        return $map;
    }

    private function isRationalDdAlignmentDate(
        string $employeeName,
        string $date,
        array $ddStartsByName,
        array $assignments
    ): bool {
        if (!isset($ddStartsByName[$employeeName])) {
            return true;
        }
        $earliest = $ddStartsByName[$employeeName];
        if ($earliest && $date < $earliest) {
            return false;
        }

        return !$this->wouldDdMoveCreateLeadingGap($employeeName, $date, $ddStartsByName, $assignments);
    }

    private function isRationalDdSameDateAlignment(
        array $task,
        string $recipientName,
        string $donorName,
        string $date,
        array $ddStartsByName,
        array $assignments,
        bool $forEndAlignment = true
    ): bool {
        if ($this->taskDelayDays($task) <= 0) {
            return true;
        }

        // If vetoing this same-day move would leave a calendar hole on the task, allow it.
        if ($this->wouldBlockingSameDateLeaveAssignmentGap(
            $recipientName,
            $donorName,
            $date,
            $assignments,
            $forEndAlignment
        )) {
            return true;
        }

        if (!$this->isRationalDdAlignmentDate($recipientName, $date, $ddStartsByName, $assignments)) {
            return false;
        }

        $recipientStart = $ddStartsByName[$recipientName] ?? null;
        if ($recipientStart && $date < $recipientStart) {
            return false;
        }

        // DD staggers starts: never place a peer onto donor's day during START alignment.
        if (!$forEndAlignment && $recipientName !== $donorName) {
            return false;
        }

        // END alignment: shared finish day is allowed when recipient may work that date.
        return true;
    }

    /**
     * True when refusing a same-day hour move would leave a visible gap on this task's timeline.
     * In that case isRationalDdSameDateAlignment allows the move instead of vetoing it.
     */
    private function wouldBlockingSameDateLeaveAssignmentGap(
        string $recipientName,
        string $donorName,
        string $date,
        array $assignments,
        bool $forEndAlignment
    ): bool {
        if (!$forEndAlignment || $date === '') {
            return false;
        }

        $recipientOnDate = false;
        $donorOnDate = false;
        $firstRecipient = null;
        $lastRecipientBefore = null;

        foreach ($assignments as $row) {
            $emp = $row['employee'] ?? null;
            $d = $row['date'] ?? null;
            if (!$emp || !$d) {
                continue;
            }
            if ($emp === $recipientName) {
                if ($d === $date) {
                    $recipientOnDate = true;
                }
                if ($firstRecipient === null || $d < $firstRecipient) {
                    $firstRecipient = $d;
                }
                if ($d < $date && ($lastRecipientBefore === null || $d > $lastRecipientBefore)) {
                    $lastRecipientBefore = $d;
                }
            }
            if ($emp === $donorName && $d === $date) {
                $donorOnDate = true;
            }
        }

        if ($recipientOnDate || !$donorOnDate) {
            return false;
        }

        $dateTs = strtotime($date);
        if ($dateTs === false) {
            return false;
        }

        // Hole between recipient's last day before $date and $date itself.
        if ($lastRecipientBefore !== null) {
            $prevTs = strtotime($lastRecipientBefore);
            if ($prevTs !== false) {
                $gapDays = ($dateTs - $prevTs) / 86400;
                if ($gapDays > 1.0001) {
                    return true;
                }
            }
        }

        // Recipient's first booked day is after donor's finish day — share end date instead of leaving a gap.
        if ($firstRecipient !== null && $firstRecipient > $date) {
            return true;
        }

        return false;
    }

    private function wouldDdMoveCreateLeadingGap(
        string $employeeName,
        string $targetDate,
        array $ddStartsByName,
        array $assignments
    ): bool {
        if (!isset($ddStartsByName[$employeeName])) {
            return false;
        }

        $firstAssigned = null;
        foreach ($assignments as $row) {
            if (($row['employee'] ?? null) !== $employeeName) {
                continue;
            }
            $d = $row['date'] ?? null;
            if (!$d) {
                continue;
            }
            if ($firstAssigned === null || $d < $firstAssigned) {
                $firstAssigned = $d;
            }
        }

        if ($firstAssigned === null) {
            return false;
        }

        return $targetDate < $firstAssigned;
    }

    /**
     * Get the earliest allowed start date for an employee based on DD (Delay Days).
     * Employee index 0 starts normally, each subsequent employee is delayed by DD calendar days.
     * e.g. DD=5, emp 0 starts Feb 1, emp 1 starts Feb 6, emp 2 starts Feb 11.
     *
     * @param string $baseDate  The first employee's start date (Y-m-d)
     * @param int    $employeeIndex  0-based index of the employee
     * @param int    $dd  Delay days between employees
     * @return string|null  Delayed start date (Y-m-d) or null if no delay needed
     */
    private function getEmployeeDelayedStartDate($baseDate, $employeeIndex, $dd)
    {
        if (!$dd || $dd <= 0 || $employeeIndex <= 0 || !$baseDate) {
            return null;
        }
        $delayDays = $employeeIndex * (int) $dd;
        return Carbon::parse($baseDate)->addDays($delayDays)->format('Y-m-d');
    }

    /**
     * Apply DD (Delay Days) filtering to an availability map.
     * Filters out availability dates that are before each employee's delayed start.
     *
     * @param array      &$availabilityMap  Map of empId/slot => availability collection
     * @param array  $employeeKeys  Ordered keys (emp ids or slot numbers)
     * @param string     $baseDate  First employee's earliest available date
     * @param int        $dd  Delay days
     */
    private function applyDDToAvailabilityMap(array &$availabilityMap, $employeeKeys, $baseDate, $dd)
    {
        if ($dd <= 0 || !$baseDate) {
            return;
        }

        $idx = 0;
        foreach ($employeeKeys as $key) {
            if ($idx > 0) {
                $delayedStart = $this->getEmployeeDelayedStartDate($baseDate, $idx, $dd);
                if ($delayedStart && isset($availabilityMap[$key])) {
                    $availabilityMap[$key] = $availabilityMap[$key]
                        ->filter(fn($a) => ($a->date ?? $a->Date ?? '') >= $delayedStart)
                        ->values();
                }
            }
            $idx++;
        }
    }
}
