<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\EmailNotificationDispatch;
use App\Models\Employee;
use App\Models\ProjectTask;
use App\Models\ScheduledNotificationNotice;
use App\Models\TrainingNotificationNotice;
use App\Models\User;
use App\Support\EmployeeNames;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class NotificationInboxController extends Controller
{
    /**
     * Training cases stay on the Trainings tab. Everything else is a system notice.
     *
     * @var list<string>
     */
    private const TRAINING_CASE_TYPES = [
        'training_completed',
        'training_rescheduled',
        'training_overdue',
        'training_starting_soon',
        'incomplete_training_days',
        'capacity_gap_hours',
        'training_project_override',
        'trainee_over_capacity_hours',
    ];

    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $canPlannerInbox = $user && $user->canPageAction('Trainings');
        $canDlInbox = $user && (
            strcasecmp(trim((string) ($user->role?->name ?? '')), 'DLs') === 0
            || $user->canPageAction('DL Input Hours')
        );

        if (! $user || (! $canPlannerInbox && ! $canDlInbox)) {
            return response()->json([
                'data' => [
                    'trainings' => [],
                    'system' => [],
                ],
            ]);
        }

        $isTrainer = $this->isTrainerRole($user);

        return response()->json([
            'data' => [
                // Planners see all training notices; DLs see incomplete trainings for themselves.
                'trainings' => $canPlannerInbox
                    ? $this->trainingNotices($canPlannerInbox)
                    : $this->dlOwnTrainingNotices($user, $canPlannerInbox),
                // Trainers only care about training notices — not project/DL system digests.
                'system' => $isTrainer
                    ? []
                    : $this->systemNotices($user, $canPlannerInbox),
            ],
        ]);
    }

    /**
     * Dismiss (hide) one inbox notice. Id format: training-{id} | scheduled-{id} | task-{id}.
     */
    public function dismiss(Request $request): JsonResponse
    {
        $user = $request->user();
        $canPlannerInbox = $user && $user->canPageAction('Trainings');
        $canDlInbox = $user && (
            strcasecmp(trim((string) ($user->role?->name ?? '')), 'DLs') === 0
            || $user->canPageAction('DL Input Hours')
        );

        if (! $user || (! $canPlannerInbox && ! $canDlInbox)) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        $rawId = trim((string) $request->input('id', ''));
        if ($rawId === '') {
            return response()->json(['message' => 'Notification id is required.'], 422);
        }

        if (preg_match('/^training-(\d+)$/', $rawId, $matches)) {
            $notice = TrainingNotificationNotice::query()->find((int) $matches[1]);
            if (! $notice) {
                return response()->json(['message' => 'Notification not found.'], 404);
            }
            if ($notice->read_at === null) {
                $notice->read_at = now();
                $notice->save();
            }

            return response()->json(['message' => 'Dismissed.', 'id' => $rawId]);
        }

        if (preg_match('/^scheduled-(\d+)$/', $rawId, $matches)) {
            $notice = ScheduledNotificationNotice::query()->find((int) $matches[1]);
            if (! $notice) {
                return response()->json(['message' => 'Notification not found.'], 404);
            }

            // DLs may only dismiss notices addressed to them (or their own training rows).
            if (! $canPlannerInbox) {
                $ownEmployeeIds = $this->employeeIdsForUser($user);
                $allowed = ((int) ($notice->recipient_user_id ?? 0) === (int) $user->id)
                    || (
                        $notice->audience === 'trainings'
                        && $notice->employee_id
                        && in_array((int) $notice->employee_id, $ownEmployeeIds, true)
                    );
                if (! $allowed) {
                    return response()->json(['message' => 'Forbidden.'], 403);
                }
            }

            if ($notice->read_at === null) {
                $notice->read_at = now();
                $notice->save();
            }

            return response()->json(['message' => 'Dismissed.', 'id' => $rawId]);
        }

        if (preg_match('/^task-(\d+)$/', $rawId, $matches)) {
            if (! $canPlannerInbox) {
                return response()->json(['message' => 'Forbidden.'], 403);
            }
            $dispatch = EmailNotificationDispatch::query()->find((int) $matches[1]);
            if (! $dispatch) {
                return response()->json(['message' => 'Notification not found.'], 404);
            }
            $dispatch->delete();

            return response()->json(['message' => 'Dismissed.', 'id' => $rawId]);
        }

        return response()->json(['message' => 'Unknown notification id.'], 422);
    }

    private function isTrainerRole(?User $user): bool
    {
        if (! $user || $user->is_admin) {
            return false;
        }

        $roleName = strtolower(trim((string) ($user->role?->name ?? '')));

        return in_array($roleName, ['trainer', 'trainers'], true);
    }

    /**
     * @return list<array{id: int|string, title: string, body: string, created_at: string|null, href: string|null}>
     */
    private function trainingNotices(bool $canPlannerInbox): array
    {
        $training = TrainingNotificationNotice::query()
            ->whereNull('read_at')
            ->orderByDesc('id')
            ->limit(40)
            ->get(['id', 'title', 'body', 'created_at', 'rule_code', 'employee_training_id', 'employee_id'])
            ->map(fn (TrainingNotificationNotice $notice) => [
                'id' => 'training-'.$notice->id,
                'title' => $notice->title,
                'body' => $notice->body,
                'created_at' => $notice->created_at?->toIso8601String(),
                'href' => $this->hrefForTrainingRule(
                    (string) ($notice->rule_code ?? ''),
                    $notice->employee_training_id ? (int) $notice->employee_training_id : null,
                    $notice->employee_id ? (int) $notice->employee_id : null,
                    $canPlannerInbox,
                ),
            ])
            ->filter(fn (array $notice) => $this->noticeHasContent($notice));

        $scheduled = ScheduledNotificationNotice::query()
            ->where('audience', 'trainings')
            ->whereNull('read_at')
            ->orderByDesc('id')
            ->limit(40)
            ->get(['id', 'title', 'body', 'created_at', 'case_type', 'rule_code', 'employee_training_id', 'employee_id', 'project_task_id', 'project_id'])
            ->map(fn (ScheduledNotificationNotice $notice) => $this->serializeScheduledNotice($notice, $canPlannerInbox))
            ->filter(fn (array $notice) => $this->noticeHasContent($notice));

        return $training
            ->concat($scheduled)
            ->sortByDesc('created_at')
            ->take(40)
            ->values()
            ->all();
    }

    /**
     * DLs see incomplete-training notices for their matching employee row only.
     *
     * @return list<array{id: int|string, title: string, body: string, created_at: string|null, href: string|null}>
     */
    private function dlOwnTrainingNotices(User $user, bool $canPlannerInbox): array
    {
        $employeeIds = $this->employeeIdsForUser($user);
        if ($employeeIds === []) {
            return [];
        }

        return ScheduledNotificationNotice::query()
            ->where('audience', 'trainings')
            ->whereNull('read_at')
            ->whereIn('employee_id', $employeeIds)
            ->orderByDesc('id')
            ->limit(40)
            ->get(['id', 'title', 'body', 'created_at', 'case_type', 'rule_code', 'employee_training_id', 'employee_id', 'project_task_id', 'project_id'])
            ->map(fn (ScheduledNotificationNotice $notice) => $this->serializeScheduledNotice($notice, $canPlannerInbox))
            ->filter(fn (array $notice) => $this->noticeHasContent($notice))
            ->values()
            ->all();
    }

    /**
     * @return list<int>
     */
    private function employeeIdsForUser(User $user): array
    {
        $labels = array_values(array_filter([
            trim((string) ($user->name ?? '')),
            trim(trim((string) ($user->first_name ?? '')).' '.trim((string) ($user->last_name ?? ''))),
            trim((string) ($user->first_name ?? '')),
            trim((string) ($user->login_name ?? '')),
        ]));

        if ($labels === []) {
            return [];
        }

        return Employee::query()
            ->get(['id', 'first_name', 'last_name'])
            ->filter(function (Employee $employee) use ($labels) {
                $employeeName = EmployeeNames::displayName($employee->first_name, $employee->last_name);
                foreach ($labels as $label) {
                    if (EmployeeNames::namesMatch($label, $employeeName)) {
                        return true;
                    }
                }

                return false;
            })
            ->pluck('id')
            ->map(fn ($id) => (int) $id)
            ->values()
            ->all();
    }

    /**
     * Planners see all system notices. DLs only see notices addressed to them
     * (e.g. their own weekly update overdue).
     *
     * @return list<array{id: int|string, title: string, body: string, created_at: string|null, href: string|null}>
     */
    private function systemNotices(User $user, bool $canPlannerInbox): array
    {
        $fromTasks = collect();
        if ($canPlannerInbox) {
            $dispatches = EmailNotificationDispatch::query()
                ->with('rule:id,label,case_type')
                ->orderByDesc('notified_at')
                ->limit(40)
                ->get()
                ->filter(function (EmailNotificationDispatch $dispatch) {
                    $caseType = $dispatch->rule?->case_type;

                    return $caseType !== null && ! in_array($caseType, self::TRAINING_CASE_TYPES, true);
                })
                ->values();

            $taskNames = ProjectTask::query()
                ->whereIn('id', $dispatches->pluck('project_task_id')->filter()->all())
                ->pluck('task_name', 'id');

            $fromTasks = $dispatches->map(function (EmailNotificationDispatch $dispatch) use ($taskNames, $canPlannerInbox) {
                $taskName = trim((string) ($taskNames[$dispatch->project_task_id] ?? ''));
                $caseType = (string) ($dispatch->rule?->case_type ?? '');

                return [
                    'id' => 'task-'.$dispatch->id,
                    'title' => $dispatch->rule?->label ?: 'System notification',
                    'body' => $taskName !== '' ? $taskName : 'Task notification',
                    'created_at' => $dispatch->notified_at?->toIso8601String(),
                    'href' => $this->hrefForCase(
                        $caseType,
                        null,
                        null,
                        $dispatch->project_task_id ? (int) $dispatch->project_task_id : null,
                        null,
                        $canPlannerInbox,
                    ),
                ];
            });
        }

        $scheduledQuery = ScheduledNotificationNotice::query()
            ->where('audience', 'system')
            ->whereNull('read_at')
            ->orderByDesc('id')
            ->limit(40);

        if (! $canPlannerInbox) {
            $scheduledQuery->where('recipient_user_id', (int) $user->id);
        }

        $fromScheduled = $scheduledQuery
            ->get(['id', 'title', 'body', 'created_at', 'case_type', 'rule_code', 'employee_training_id', 'employee_id', 'project_task_id', 'project_id'])
            ->map(fn (ScheduledNotificationNotice $notice) => $this->serializeScheduledNotice($notice, $canPlannerInbox))
            ->filter(fn (array $notice) => $this->noticeHasContent($notice));

        return $fromTasks
            ->filter(fn (array $notice) => $this->noticeHasContent($notice))
            ->concat($fromScheduled)
            ->sortByDesc('created_at')
            ->take(40)
            ->values()
            ->all();
    }

    /**
     * @return array{id: string, title: string, body: string, created_at: string|null, href: string|null}
     */
    private function serializeScheduledNotice(ScheduledNotificationNotice $notice, bool $canPlannerInbox): array
    {
        return [
            'id' => 'scheduled-'.$notice->id,
            'title' => $notice->title,
            'body' => $notice->body,
            'created_at' => $notice->created_at?->toIso8601String(),
            'href' => $this->hrefForCase(
                (string) ($notice->case_type ?: $notice->rule_code),
                $notice->employee_training_id ? (int) $notice->employee_training_id : null,
                $notice->employee_id ? (int) $notice->employee_id : null,
                $notice->project_task_id ? (int) $notice->project_task_id : null,
                $notice->project_id ? (int) $notice->project_id : null,
                $canPlannerInbox,
            ),
        ];
    }

    /**
     * @param  array{title?: string|null, body?: string|null}  $notice
     */
    private function noticeHasContent(array $notice): bool
    {
        return trim((string) ($notice['title'] ?? '')) !== ''
            || trim((string) ($notice['body'] ?? '')) !== '';
    }

    private function hrefForTrainingRule(
        string $ruleCode,
        ?int $trainingId,
        ?int $employeeId,
        bool $canPlannerInbox,
    ): string {
        return $this->hrefForCase($ruleCode, $trainingId, $employeeId, null, null, $canPlannerInbox);
    }

    private function hrefForCase(
        string $caseType,
        ?int $trainingId,
        ?int $employeeId,
        ?int $projectTaskId,
        ?int $projectId,
        bool $canPlannerInbox,
    ): string {
        $case = trim($caseType);

        return match (true) {
            in_array($case, [
                'incomplete_training_days',
                'incomplete_training',
                'training_completed',
                'training_rescheduled',
                'training_overdue',
                'training_starting_soon',
            ], true) => $this->trainingPageHref($trainingId, $employeeId, $canPlannerInbox),
            in_array($case, ['capacity_gap_hours', 'trainee_over_capacity_hours'], true) => $canPlannerInbox
                ? '/trainings'
                : '/dl-input-hours?view=trainings',
            $case === 'training_project_override' => $trainingId
                ? $this->trainingPageHref($trainingId, $employeeId, $canPlannerInbox)
                : '/resource-histogram',
            in_array($case, ['dl_update_overdue', 'dl_edited_after_submit'], true) => '/dl-input-hours',
            $case === 'new_project_docs_ready' => $projectId
                ? '/dl-input-hours?project='.$projectId
                : '/dl-input-hours',
            default => $projectId
                ? '/dl-input-hours?project='.$projectId
                : ($projectTaskId
                    ? '/resource-histogram'
                    : ($canPlannerInbox ? '/trainings' : '/dl-input-hours')),
        };
    }

    private function trainingPageHref(?int $trainingId, ?int $employeeId, bool $canPlannerInbox): string
    {
        if ($canPlannerInbox) {
            $params = ['view' => 'roster'];
            if ($trainingId) {
                $params['training'] = (string) $trainingId;
            }

            return '/trainings?'.http_build_query($params);
        }

        $params = ['view' => 'trainings'];
        if ($trainingId) {
            $params['training'] = (string) $trainingId;
        }
        if ($employeeId) {
            $params['employee'] = (string) $employeeId;
        }

        return '/dl-input-hours?'.http_build_query($params);
    }
}
