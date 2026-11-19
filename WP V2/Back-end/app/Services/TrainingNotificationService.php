<?php

namespace App\Services;

use App\Models\EmailNotificationRule;
use App\Models\EmployeeTraining;
use App\Models\TrainingNotificationNotice;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Database\QueryException;

class TrainingNotificationService
{
    public function __construct(private EmailNotificationService $emailNotifications) {}

    /**
     * @param  array{status?: string, start_date?: string, end_date?: string}|null  $before
     * @return array{
     *   in_app: list<string>,
     *   emails_sent: int,
     *   triggered_rules: list<string>,
     *   email_errors: list<array{rule: string, error: string}>,
     *   summary: string
     * }
     */
    public function onSaved(?array $before, EmployeeTraining $after, ?User $actor, ?string $reason = null): array
    {
        $after->loadMissing(['employee.team']);
        $matches = [];

        $wasCompleted = ($before['status'] ?? null) === 'completed';
        if ($before !== null && ! $wasCompleted && $after->status === 'completed') {
            $match = $this->matchCompleted($after);
            if ($match !== null) {
                $matches[] = $match;
            }
        }

        if ($before !== null && $this->datesMoved($before, $after)) {
            $match = $this->matchRescheduled($before, $after, $actor, $reason);
            if ($match !== null) {
                $matches[] = $match;
            }
        }

        $matches = array_merge($matches, $this->dueMatches());

        if ($matches === []) {
            return $this->emptyResult();
        }

        return $this->emailNotifications->deliverMatches(
            'Training',
            $this->traineeName($after),
            $matches,
        );
    }

    /**
     * @return list<array{rule: EmailNotificationRule, item_name: string, detail: string}>
     */
    public function dueMatches(?int $onlyTrainingId = null): array
    {
        $today = Carbon::today();
        $overdueRule = $this->rule('training_overdue');
        $soonRule = $this->rule('training_starting_soon');
        $repeatDays = max(1, (int) ($overdueRule?->case_value ?? 2));
        $soonDays = max(1, (int) ($soonRule?->case_value ?? 2));

        $query = EmployeeTraining::query()
            ->with(['employee.team'])
            ->where('status', '!=', 'completed');
        if ($onlyTrainingId !== null) {
            $query->whereKey($onlyTrainingId);
        }

        $matches = [];
        foreach ($query->get() as $training) {
            $end = Carbon::parse($training->end_date)->startOfDay();
            $start = Carbon::parse($training->start_date)->startOfDay();

            if ($overdueRule !== null && $end->lt($today) && ! $this->wasRescheduled($training->id)) {
                if ($this->overdueQuietPeriodElapsed($training->id, $repeatDays)) {
                    $match = $this->remember($overdueRule, $training, "overdue:{$training->id}:{$today->toDateString()}", $this->overdueDetail($training, $today, $end));
                    if ($match !== null) {
                        $matches[] = $match;
                    }
                }
            }

            $daysUntil = (int) $today->diffInDays($start, false);
            if ($soonRule !== null && $daysUntil >= 1 && $daysUntil <= $soonDays) {
                $match = $this->remember($soonRule, $training, "starting:{$training->id}", $this->startingDetail($training, $daysUntil));
                if ($match !== null) {
                    $matches[] = $match;
                }
            }
        }

        return $matches;
    }

    /**
     * @return array{rule: EmailNotificationRule, item_name: string, detail: string}|null
     */
    private function matchCompleted(EmployeeTraining $training): ?array
    {
        $rule = $this->rule('training_completed');
        if ($rule === null) {
            return null;
        }

        $when = now()->format('d M Y H:i');

        return $this->remember(
            $rule,
            $training,
            "completed:{$training->id}",
            implode("\n", [
                'Team / DL: '.$this->teamName($training),
                "Completed: {$when}",
            ]),
        );
    }

    /**
     * @param  array{start_date?: string, end_date?: string}  $before
     * @return array{rule: EmailNotificationRule, item_name: string, detail: string}|null
     */
    private function matchRescheduled(array $before, EmployeeTraining $after, ?User $actor, ?string $reason): ?array
    {
        $rule = $this->rule('training_rescheduled');
        if ($rule === null) {
            return null;
        }

        $original = $this->rangeLabel($before['start_date'] ?? null, $before['end_date'] ?? null);
        $updated = $this->rangeLabel($after->start_date?->toDateString(), $after->end_date?->toDateString());
        $who = trim((string) ($actor?->name ?? '')) ?: 'System';
        $why = trim((string) $reason);
        if ($why === '') {
            $why = trim((string) $after->notes);
        }
        if ($why === '') {
            $why = 'Not given';
        }
        $slot = ($after->start_date?->toDateString() ?? '').':'.($after->end_date?->toDateString() ?? '');

        return $this->remember(
            $rule,
            $after,
            "rescheduled:{$after->id}:{$slot}",
            implode("\n", [
                'Team / DL: '.$this->teamName($after),
                "Original dates: {$original}",
                "New dates: {$updated}",
                "Moved by: {$who}",
                "Reason: {$why}",
            ]),
        );
    }

    private function overdueDetail(EmployeeTraining $training, Carbon $today, Carbon $end): string
    {
        $days = max(1, (int) $end->diffInDays($today));
        $assigned = $this->rangeLabel($training->start_date?->toDateString(), $training->end_date?->toDateString());

        return implode("\n", [
            'Mark complete or reschedule.',
            '',
            'Team / DL: '.$this->teamName($training),
            "Assigned dates: {$assigned}",
            "Days overdue: {$days}",
        ]);
    }

    private function startingDetail(EmployeeTraining $training, int $daysUntil): string
    {
        $start = $training->start_date?->format('j M Y') ?? 'Not set';
        $dayWord = $daysUntil === 1 ? '1 day' : "{$daysUntil} days";

        return implode("\n", [
            "Starts in {$dayWord} ({$start}).",
            '',
            'Team / DL: '.$this->teamName($training),
            'Assigned: '.$this->rangeLabel(
                $training->start_date?->toDateString(),
                $training->end_date?->toDateString(),
            ),
        ]);
    }

    /**
     * @return array{rule: EmailNotificationRule, item_name: string, detail: string}|null
     */
    private function remember(EmailNotificationRule $rule, EmployeeTraining $training, string $dedupeKey, string $detail): ?array
    {
        if (! $rule->enabled) {
            return null;
        }

        $trainee = $this->traineeName($training);
        $first = trim((string) (preg_split('/\s+/', $trainee)[0] ?? ''));
        $course = $this->courseName($training);
        // Name + rule + course live in the title only — do not repeat them in the body.
        $title = $first !== ''
            ? "{$first} — {$rule->label} · {$course}"
            : "{$rule->label} · {$course}";
        $detail = $this->stripRepeatedTrainingFields($detail, $trainee, $course);
        $title = trim($title);
        $detail = trim($detail);
        // Never persist blank notices.
        if ($title === '' && $detail === '') {
            return null;
        }
        if ($title === '') {
            $title = trim((string) $rule->label) ?: 'Training notification';
        }

        try {
            TrainingNotificationNotice::query()->create([
                'dedupe_key' => $dedupeKey,
                'rule_code' => $rule->code,
                'employee_training_id' => $training->id,
                'audience' => 'rule',
                'employee_id' => $training->employee_id,
                'title' => $title,
                'body' => $detail,
            ]);
        } catch (QueryException) {
            return null;
        }

        return [
            'rule' => $rule,
            'item_name' => $trainee,
            'detail' => $detail,
        ];
    }

    /**
     * Drop Trainee / Course lines when those already appear in the title.
     */
    private function stripRepeatedTrainingFields(string $detail, string $trainee, string $course): string
    {
        $lines = preg_split("/\r\n|\n|\r/", $detail) ?: [];
        $filtered = [];
        foreach ($lines as $line) {
            $trimmed = trim($line);
            if ($trimmed === '') {
                $filtered[] = '';
                continue;
            }
            if (preg_match('/^Trainee\s*:/i', $trimmed)) {
                continue;
            }
            if (preg_match('/^Course\s*:/i', $trimmed)) {
                continue;
            }
            // One-line legacy bodies: "Trainee: X. Team / DL: … Course: Y. …"
            if (str_contains($trimmed, 'Trainee:') && str_contains($trimmed, 'Course:')) {
                $trimmed = preg_replace('/\s*Trainee:\s*[^.]+\.\s*/i', '', $trimmed) ?? $trimmed;
                $trimmed = preg_replace('/\s*Course:\s*[^.]+?\.\s*/i', '', $trimmed) ?? $trimmed;
                $trimmed = trim($trimmed);
                if ($trimmed === '') {
                    continue;
                }
            }
            $filtered[] = $trimmed;
        }

        // Collapse excess blank lines.
        $out = [];
        $blank = false;
        foreach ($filtered as $line) {
            if ($line === '') {
                if ($blank) {
                    continue;
                }
                $blank = true;
                $out[] = '';
                continue;
            }
            $blank = false;
            $out[] = $line;
        }

        return trim(implode("\n", $out));
    }

    /**
     * @return array{
     *   in_app: list<string>,
     *   emails_sent: int,
     *   triggered_rules: list<string>,
     *   email_errors: list<array{rule: string, error: string}>,
     *   summary: string
     * }
     */
    private function emptyResult(): array
    {
        return [
            'in_app' => [],
            'emails_sent' => 0,
            'triggered_rules' => [],
            'email_errors' => [],
            'summary' => '',
        ];
    }

    private function overdueQuietPeriodElapsed(int $trainingId, int $repeatDays): bool
    {
        $latest = TrainingNotificationNotice::query()
            ->where('rule_code', 'training_overdue')
            ->where('employee_training_id', $trainingId)
            ->orderByDesc('id')
            ->first();

        if ($latest === null) {
            return true;
        }

        return $latest->created_at->lte(now()->subDays($repeatDays));
    }

    private function wasRescheduled(int $trainingId): bool
    {
        return TrainingNotificationNotice::query()
            ->where('rule_code', 'training_rescheduled')
            ->where('employee_training_id', $trainingId)
            ->exists();
    }

    /**
     * @param  array{start_date?: string, end_date?: string}  $before
     */
    private function datesMoved(array $before, EmployeeTraining $after): bool
    {
        return ($before['start_date'] ?? null) !== $after->start_date?->toDateString()
            || ($before['end_date'] ?? null) !== $after->end_date?->toDateString();
    }

    private function rule(string $code): ?EmailNotificationRule
    {
        return EmailNotificationRule::query()->where('code', $code)->first();
    }

    private function traineeName(EmployeeTraining $training): string
    {
        return trim((string) ($training->employee?->name ?? '')) ?: 'Unknown trainee';
    }

    private function teamName(EmployeeTraining $training): string
    {
        return trim((string) ($training->employee?->team?->name ?? '')) ?: 'Not set';
    }

    private function courseName(EmployeeTraining $training): string
    {
        return trim((string) $training->title) ?: 'Untitled course';
    }

    private function rangeLabel(?string $start, ?string $end): string
    {
        $startLabel = $start ? Carbon::parse($start)->format('d M Y') : 'Not set';
        $endLabel = $end ? Carbon::parse($end)->format('d M Y') : 'Not set';

        return "{$startLabel} – {$endLabel}";
    }
}
