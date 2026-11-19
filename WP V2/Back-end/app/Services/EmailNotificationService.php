<?php

namespace App\Services;

use App\Mail\WorkplannerNotificationMail;
use App\Models\EmailNotificationDispatch;
use App\Models\EmailNotificationRule;
use App\Models\EmailNotificationSetting;
use App\Models\Part;
use App\Models\ProjectTask;
use App\Models\User;
use App\Support\EmailNotificationCaseTypes;
use Carbon\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

class EmailNotificationService
{
    /** @return array<string, mixed> */
    private function globalSettings(): array
    {
        $setting = EmailNotificationSetting::query()->where('key', 'global')->first();
        $value = $setting?->value;

        return is_array($value) ? $value : [];
    }

    public function isGlobalEmailEnabled(): bool
    {
        return (bool) ($this->globalSettings()['email_enabled'] ?? false);
    }

    public function getNotificationFromEmail(): ?string
    {
        $email = $this->getStoredFromEmail();
        if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return $email;
        }

        return null;
    }

    public function getStoredFromEmail(): string
    {
        return self::normalizeEmail($this->globalSettings()['from_email'] ?? '');
    }

    public static function normalizeEmail(mixed $value): string
    {
        if ($value === null || $value === '') {
            return '';
        }

        return preg_replace('/\s+/', '', trim((string) $value));
    }

    /** @return array{address: string, name: string} */
    public function resolveFromAddress(?string $override = null): array
    {
        if ($override !== null && $override !== '') {
            $override = self::normalizeEmail($override);
            if ($override === '' || ! filter_var($override, FILTER_VALIDATE_EMAIL)) {
                throw new \InvalidArgumentException('Invalid sender email address.');
            }

            return [
                'address' => $override,
                'name' => (string) config('mail.from.name'),
            ];
        }

        $address = $this->getNotificationFromEmail()
            ?? self::normalizeEmail(config('mail.from.address'));

        return [
            'address' => $address,
            'name' => (string) config('mail.from.name'),
        ];
    }

    /** @param array{email_enabled?: bool, from_email?: string|null} $patch */
    public function updateGlobalSettings(array $patch): void
    {
        $value = $this->globalSettings();

        if (array_key_exists('email_enabled', $patch)) {
            $value['email_enabled'] = (bool) $patch['email_enabled'];
        }

        if (array_key_exists('from_email', $patch)) {
            $value['from_email'] = self::normalizeEmail($patch['from_email'] ?? '');
        }

        EmailNotificationSetting::updateOrCreate(
            ['key' => 'global'],
            ['value' => $value],
        );
    }

    public function setGlobalEmailEnabled(bool $enabled): void
    {
        $this->updateGlobalSettings(['email_enabled' => $enabled]);
    }

    /**
     * @return array{recipient: string, from: string, mailer: string}
     */
    public function sendTestEmail(string $recipientEmail, ?string $fromEmailOverride = null): array
    {
        if (! filter_var($recipientEmail, FILTER_VALIDATE_EMAIL)) {
            throw new \InvalidArgumentException('Invalid recipient email address.');
        }

        $from = $this->resolveFromAddress($fromEmailOverride);
        $mailable = (new WorkplannerNotificationMail(
            'Sample Project',
            'Sample Part',
            [
                [
                    'rule_label' => 'Test notification',
                    'task_lines' => [
                        [
                            'task_name' => 'Sample task',
                            'detail' => 'This is a test email from Workplanner.',
                        ],
                    ],
                ],
            ],
        ))->from($from['address'], $from['name']);

        Mail::to($recipientEmail)->send($mailable);

        return [
            'recipient' => $recipientEmail,
            'from' => $from['address'],
            'mailer' => (string) config('mail.default'),
        ];
    }

    /**
     * @param  list<ProjectTask>  $tasks
     * @param  array<int, array{progress_per?: mixed, plan?: mixed, act?: mixed, completion?: mixed, done?: mixed}>  $previousById
     * @return array{
     *   in_app: list<string>,
     *   emails_sent: int,
     *   triggered_rules: list<string>,
     *   email_errors: list<array{rule: string, error: string}>
     * }
     */
    public function handleTasksSaved(Part $part, array $tasks, array $previousById = [], ?User $actor = null): array
    {
        $empty = [
            'in_app' => [],
            'emails_sent' => 0,
            'triggered_rules' => [],
            'email_errors' => [],
        ];

        if ($tasks === []) {
            return $empty;
        }

        $rules = EmailNotificationRule::query()
            ->where('enabled', true)
            ->whereIn('case_type', EmailNotificationCaseTypes::taskSyncValues())
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get();

        if ($rules->isEmpty()) {
            return $empty;
        }

        $globalEmail = $this->isGlobalEmailEnabled();
        $inAppNames = [];
        $emailsSent = 0;
        $triggeredRules = [];
        $emailErrors = [];
        /** @var array<string, list<array{rule_label: string, task_lines: list<array{task_name: string, detail: string}>}>> */
        $digestByEmail = [];
        /** @var list<array{0: EmailNotificationRule, 1: Collection<int, ProjectTask>}> */
        $pendingDispatches = [];

        $projectName = $part->project?->name ?? 'Project';
        $partName = $part->name ?? 'Part';

        foreach ($rules as $rule) {
            $this->clearDispatchesWhenBelowThreshold($rule, $tasks);

            $crossingTasks = $this->newlyCrossingTasks($rule, $tasks, $previousById);
            if ($crossingTasks->isEmpty()) {
                continue;
            }

            $notYetDispatched = $crossingTasks->filter(
                fn (ProjectTask $task) => ! $this->hasDispatch($rule, $task),
            )->values();

            if ($notYetDispatched->isEmpty()) {
                continue;
            }

            $triggeredRules[] = $rule->label;
            $recipientNames = $this->resolveRecipientNames($rule);
            $recipientEmails = $this->resolveRecipientEmails($rule);

            if ($rule->in_app_enabled) {
                foreach ($recipientNames as $name) {
                    $inAppNames[$name] = true;
                }
            }

            if ($globalEmail && $rule->email_enabled && $recipientEmails !== []) {
                $taskLines = $notYetDispatched->map(function (ProjectTask $task) use ($rule) {
                    return [
                        'task_name' => $task->task_name ?: 'Untitled task',
                        'detail' => $this->taskMatchDetail($rule, $task),
                    ];
                })->values()->all();

                $section = [
                    'rule_label' => $rule->label,
                    'task_lines' => $taskLines,
                ];

                foreach ($recipientEmails as $email) {
                    $digestByEmail[$email] ??= [];
                    $digestByEmail[$email][] = $section;
                }
            }

            $pendingDispatches[] = [$rule, $notYetDispatched];
        }

        if ($digestByEmail !== []) {
            $from = null;
            try {
                $from = $this->resolveFromAddress();
            } catch (\Throwable $exception) {
                Log::warning('Email notification digest failed', [
                    'error' => $exception->getMessage(),
                    'recipients' => array_keys($digestByEmail),
                ]);
                $emailErrors[] = [
                    'rule' => 'digest',
                    'error' => $exception->getMessage(),
                ];
            }

            if ($from !== null) {
                foreach ($digestByEmail as $email => $sections) {
                    try {
                        $mailable = (new WorkplannerNotificationMail(
                            $projectName,
                            $partName,
                            $sections,
                        ))->from($from['address'], $from['name']);

                        Mail::to($email)->send($mailable);
                        $emailsSent += 1;
                    } catch (\Throwable $exception) {
                        Log::warning('Email notification digest failed', [
                            'error' => $exception->getMessage(),
                            'recipient' => $email,
                        ]);
                        $emailErrors[] = [
                            'rule' => 'digest',
                            'error' => $exception->getMessage(),
                        ];
                    }
                }
            }
        }

        foreach ($pendingDispatches as [$rule, $notYetDispatched]) {
            foreach ($notYetDispatched as $task) {
                $this->recordDispatch($rule, $task);
            }
        }

        return [
            'in_app' => array_keys($inAppNames),
            'emails_sent' => $emailsSent,
            'triggered_rules' => $triggeredRules,
            'email_errors' => $emailErrors,
        ];
    }

    /**
     * @param  list<ProjectTask>  $tasks
     * @param  array<int, array{progress_per?: mixed, plan?: mixed, act?: mixed, completion?: mixed, done?: mixed}>  $previousById
     */
    private function newlyCrossingTasks(
        EmailNotificationRule $rule,
        array $tasks,
        array $previousById,
    ): Collection {
        return collect($tasks)->filter(function (ProjectTask $task) use ($rule, $previousById) {
            if (! $this->taskMatchesRule($rule, $task)) {
                return false;
            }

            $previous = $previousById[(int) $task->id] ?? null;
            if ($previous === null) {
                return true;
            }

            return ! $this->snapshotMatchesRule($rule, $previous);
        })->values();
    }

    /** @param  list<ProjectTask>  $tasks */
    private function clearDispatchesWhenBelowThreshold(EmailNotificationRule $rule, array $tasks): void
    {
        $belowIds = collect($tasks)
            ->filter(fn (ProjectTask $task) => ! $this->taskMatchesRule($rule, $task))
            ->map(fn (ProjectTask $task) => (int) $task->id)
            ->filter(fn (int $id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        if ($belowIds === []) {
            return;
        }

        EmailNotificationDispatch::query()
            ->where('email_notification_rule_id', $rule->id)
            ->whereIn('project_task_id', $belowIds)
            ->delete();
    }

    private function hasDispatch(EmailNotificationRule $rule, ProjectTask $task): bool
    {
        return EmailNotificationDispatch::query()
            ->where('email_notification_rule_id', $rule->id)
            ->where('project_task_id', (int) $task->id)
            ->exists();
    }

    private function recordDispatch(EmailNotificationRule $rule, ProjectTask $task): void
    {
        EmailNotificationDispatch::query()->updateOrCreate(
            [
                'email_notification_rule_id' => $rule->id,
                'project_task_id' => (int) $task->id,
            ],
            ['notified_at' => now()],
        );
    }

    private function taskMatchesRule(EmailNotificationRule $rule, ProjectTask $task): bool
    {
        return $this->snapshotMatchesRule($rule, [
            'progress_per' => $task->progress_per,
            'plan' => $task->plan,
            'act' => $task->act,
            'completion' => $task->completion,
            'done' => (bool) $task->done,
            'dl' => $task->dl,
            'dl_dl' => $task->dl_dl,
            'rfi' => $task->rfi,
            'dl_rfi' => $task->dl_rfi,
            'override_1' => $task->override_1,
            'override_2' => $task->override_2,
            'override_3' => $task->override_3,
            'dl_override_1' => $task->dl_override_1,
            'dl_override_2' => $task->dl_override_2,
            'dl_override_3' => $task->dl_override_3,
            'dl_owner' => $task->dl_owner,
        ]);
    }

    /**
     * @param  array<string, mixed>  $snapshot
     */
    private function snapshotMatchesRule(EmailNotificationRule $rule, array $snapshot): bool
    {
        return match (EmailNotificationCaseTypes::resolveEvaluator($rule->case_type)) {
            'progress_threshold' => $this->numericValue($snapshot['progress_per'] ?? null) >= (float) $rule->case_value,
            'over_plan_pct' => $this->isOverPlanSnapshot($snapshot, (float) $rule->case_value),
            'completion_approaching_days' => $this->isCompletionApproaching($snapshot, (float) $rule->case_value),
            'completion_overdue_days' => $this->isCompletionOverdue($snapshot, (float) $rule->case_value),
            'task_done' => $this->isTaskComplete($snapshot),
            'dl_override_filled' => $this->hasAnyOverride($snapshot),
            'dl_hours_threshold' => $this->dlHoursValue($snapshot) >= (float) $rule->case_value,
            'dl_rfi_on' => $this->isFlagOn($snapshot['rfi'] ?? null) || $this->isFlagOn($snapshot['dl_rfi'] ?? null),
            'dl_owner_claimed' => $this->hasText($snapshot['dl_owner'] ?? null),
            default => false,
        };
    }

    private function taskMatchDetail(EmailNotificationRule $rule, ProjectTask $task): string
    {
        return match (EmailNotificationCaseTypes::resolveEvaluator($rule->case_type)) {
            'progress_threshold' => sprintf(
                'Progress %s%% (threshold %s%%)',
                $this->formatNumber($this->numericValue($task->progress_per)),
                $this->formatNumber((float) $rule->case_value),
            ),
            'over_plan_pct' => sprintf(
                'Actual %sh vs plan %sh (over %s%%)',
                $this->formatNumber($this->numericValue($task->act)),
                $this->formatNumber($this->numericValue($task->plan)),
                $this->formatNumber($this->overPlanPercent($task)),
            ),
            'completion_approaching_days' => sprintf(
                'Completion %s (within %s days)',
                $this->completionLabel($task->completion),
                $this->formatNumber((float) $rule->case_value),
            ),
            'completion_overdue_days' => sprintf(
                'Completion %s (overdue ≥ %s days)',
                $this->completionLabel($task->completion),
                $this->formatNumber((float) $rule->case_value),
            ),
            'task_done' => 'Task marked done',
            'dl_override_filled' => sprintf(
                'Overrides: %s',
                collect([
                    trim((string) ($task->override_1 ?? $task->dl_override_1 ?? '')),
                    trim((string) ($task->override_2 ?? $task->dl_override_2 ?? '')),
                    trim((string) ($task->override_3 ?? $task->dl_override_3 ?? '')),
                ])->filter()->values()->implode(' · ') ?: 'set',
            ),
            'dl_hours_threshold' => sprintf(
                'DL hours %sh (threshold %sh)',
                $this->formatNumber($this->dlHoursValue([
                    'dl' => $task->dl,
                    'dl_dl' => $task->dl_dl,
                ])),
                $this->formatNumber((float) $rule->case_value),
            ),
            'dl_rfi_on' => 'RFI flagged on',
            'dl_owner_claimed' => sprintf('DL owner: %s', trim((string) ($task->dl_owner ?? '')) ?: 'claimed'),
            default => 'Threshold met',
        };
    }

    /** @param array<string, mixed> $snapshot */
    private function hasAnyOverride(array $snapshot): bool
    {
        foreach ([
            'override_1', 'override_2', 'override_3',
            'dl_override_1', 'dl_override_2', 'dl_override_3',
        ] as $key) {
            if ($this->hasText($snapshot[$key] ?? null)) {
                return true;
            }
        }

        return false;
    }

    /** @param array<string, mixed> $snapshot */
    private function dlHoursValue(array $snapshot): float
    {
        $primary = $this->numericValue($snapshot['dl'] ?? null);
        if ($primary > 0) {
            return $primary;
        }

        return $this->numericValue($snapshot['dl_dl'] ?? null);
    }

    private function hasText(mixed $value): bool
    {
        return trim((string) ($value ?? '')) !== '';
    }

    private function isFlagOn(mixed $value): bool
    {
        if ($value === true || $value === 1) {
            return true;
        }

        $normalized = strtolower(trim((string) ($value ?? '')));

        return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
    }

    /**
     * @param  array{
     *   progress_per?: mixed,
     *   plan?: mixed,
     *   act?: mixed,
     *   completion?: mixed,
     *   done?: mixed
     * }  $snapshot
     */
    private function isTaskComplete(array $snapshot): bool
    {
        if (! empty($snapshot['done'])) {
            return true;
        }

        return $this->numericValue($snapshot['progress_per'] ?? null) >= 100.0;
    }

    /**
     * @param  array{
     *   progress_per?: mixed,
     *   plan?: mixed,
     *   act?: mixed,
     *   completion?: mixed,
     *   done?: mixed
     * }  $snapshot
     */
    private function isCompletionApproaching(array $snapshot, float $withinDays): bool
    {
        if ($this->isTaskComplete($snapshot)) {
            return false;
        }

        $daysUntil = $this->daysUntilCompletion($snapshot['completion'] ?? null);
        if ($daysUntil === null) {
            return false;
        }

        $limit = max(0.0, $withinDays);

        return $daysUntil > 0 && $daysUntil <= $limit;
    }

    /**
     * @param  array{
     *   progress_per?: mixed,
     *   plan?: mixed,
     *   act?: mixed,
     *   completion?: mixed,
     *   done?: mixed
     * }  $snapshot
     */
    private function isCompletionOverdue(array $snapshot, float $minDaysPast): bool
    {
        if ($this->isTaskComplete($snapshot)) {
            return false;
        }

        $daysUntil = $this->daysUntilCompletion($snapshot['completion'] ?? null);
        if ($daysUntil === null) {
            return false;
        }

        $daysPast = -$daysUntil;
        $minPast = max(0.0, $minDaysPast);

        return $daysPast >= $minPast;
    }

    private function daysUntilCompletion(mixed $completion): ?int
    {
        $raw = trim((string) ($completion ?? ''));
        if ($raw === '') {
            return null;
        }

        try {
            $date = Carbon::parse(substr($raw, 0, 10))->startOfDay();
        } catch (\Throwable) {
            return null;
        }

        return (int) now()->startOfDay()->diffInDays($date, false);
    }

    private function completionLabel(mixed $completion): string
    {
        $raw = trim((string) ($completion ?? ''));

        return $raw !== '' ? substr($raw, 0, 10) : 'unset';
    }

    /** @param array{progress_per?: mixed, plan?: mixed, act?: mixed} $snapshot */
    private function isOverPlanSnapshot(array $snapshot, float $threshold): bool
    {
        $plan = $this->numericValue($snapshot['plan'] ?? null);
        $act = $this->numericValue($snapshot['act'] ?? null);

        if ($plan <= 0 || $act <= $plan) {
            return false;
        }

        return ((($act - $plan) / $plan) * 100) >= $threshold;
    }

    private function overPlanPercent(ProjectTask $task): float
    {
        $plan = $this->numericValue($task->plan);
        $act = $this->numericValue($task->act);

        if ($plan <= 0) {
            return 0.0;
        }

        return (($act - $plan) / $plan) * 100;
    }

    private function numericValue(mixed $value): float
    {
        if ($value === null || $value === '') {
            return 0.0;
        }

        return is_numeric($value) ? (float) $value : 0.0;
    }

    private function formatNumber(float $value): string
    {
        return rtrim(rtrim(number_format($value, 1, '.', ''), '0'), '.');
    }

    /** @return list<string> */
    private function resolveRecipientNames(EmailNotificationRule $rule): array
    {
        return collect($rule->recipient_names ?? [])
            ->merge($this->usersForRule($rule)->map(fn (User $user) => trim($user->first_name ?: $user->name ?: '')))
            ->map(fn ($name) => trim((string) $name))
            ->filter()
            ->unique()
            ->values()
            ->all();
    }

    /** @return list<string> */
    private function resolveRecipientEmails(EmailNotificationRule $rule): array
    {
        return collect($rule->recipient_emails ?? [])
            ->merge($this->usersForRule($rule)->pluck('email'))
            ->map(fn ($email) => self::normalizeEmail($email))
            ->filter(fn ($email) => $email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL))
            ->unique()
            ->values()
            ->all();
    }

    /** @return Collection<int, User> */
    private function usersForRule(EmailNotificationRule $rule): Collection
    {
        $ids = $this->normalizeIdList($rule->recipient_user_ids ?? []);
        $roleIds = $this->normalizeIdList($rule->recipient_role_ids ?? []);

        if ($ids === [] && $roleIds === []) {
            return collect();
        }

        return User::query()
            ->where('active', true)
            ->where(function ($query) use ($ids, $roleIds) {
                if ($ids !== []) {
                    $query->whereIn('id', $ids);
                }
                if ($roleIds !== []) {
                    $method = $ids !== [] ? 'orWhereIn' : 'whereIn';
                    $query->{$method}('role_id', $roleIds);
                }
            })
            ->get();
    }

    /** @return list<int> */
    private function normalizeIdList(mixed $value): array
    {
        return collect(is_array($value) ? $value : [])
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();
    }
}
