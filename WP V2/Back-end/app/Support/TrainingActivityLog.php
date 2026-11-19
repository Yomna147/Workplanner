<?php

namespace App\Support;

use App\Models\EmployeeTraining;
use Carbon\Carbon;

class TrainingActivityLog
{
    private const STATUS_LABELS = [
        'not_started' => 'Not started',
        'scheduled' => 'Scheduled',
        'in_progress' => 'In progress',
        'almost_complete' => 'Almost complete',
        'completed' => 'Completed',
    ];

    private const FIELD_LABELS = [
        'employee_id' => 'Operative',
        'title' => 'Title',
        'course_link' => 'Course link',
        'description' => 'Description',
        'duration' => 'Duration',
        'status' => 'Status',
        'priority' => 'Priority',
        'urgency' => 'Urgency',
        'start_date' => 'Start',
        'end_date' => 'End',
        'hours_per_day' => 'Hours per day',
        'day_segment' => 'Day section',
        'notes' => 'Notes',
        'confirm_override' => 'Override occupied slot',
    ];

    private const TRACKED_FIELDS = [
        'employee_id',
        'title',
        'course_link',
        'description',
        'duration',
        'status',
        'priority',
        'urgency',
        'start_date',
        'end_date',
        'hours_per_day',
        'day_segment',
        'notes',
        'confirm_override',
    ];

    /**
     * @return array<string, mixed>
     */
    public static function snapshot(EmployeeTraining $training): array
    {
        $values = [];
        foreach (self::TRACKED_FIELDS as $field) {
            $values[$field] = self::normalizeValue($field, $training->{$field} ?? null);
        }

        return $values;
    }

    /**
     * @param  array<string, mixed>  $before
     * @param  array<string, mixed>  $after
     * @return array<string, array{from:mixed,to:mixed}>
     */
    public static function diff(array $before, array $after): array
    {
        $changes = [];

        foreach (self::TRACKED_FIELDS as $field) {
            $from = self::normalizeValue($field, $before[$field] ?? null);
            $to = self::normalizeValue($field, $after[$field] ?? null);
            if ((string) $from !== (string) $to) {
                $changes[$field] = ['from' => $from, 'to' => $to];
            }
        }

        return $changes;
    }

    /**
     * @return array<string, array{from:null,to:mixed}>
     */
    public static function createdChanges(EmployeeTraining $training): array
    {
        $changes = [];
        foreach (self::snapshot($training) as $field => $value) {
            if ($field === 'employee_id') {
                continue;
            }
            if ($value === null || $value === '' || $value === false) {
                continue;
            }
            $changes[$field] = ['from' => null, 'to' => $value];
        }

        return $changes;
    }

    /**
     * @param  array<string, array{from:mixed,to:mixed}>  $changes
     */
    public static function summarizeCreated(
        EmployeeTraining $training,
        string $employeeName,
        string $overrideNote = '',
        array $changes = [],
        string $actorName = '',
    ): string {
        $actor = $actorName !== '' ? $actorName : 'Someone';
        $course = $training->title ?: 'Untitled course';
        $when = self::formatTimestamp($training->created_at ?? now());
        $assignee = trim($employeeName) !== '' ? trim($employeeName) : 'an operative';
        $before = trim($overrideNote);

        if ($before !== '') {
            return self::formatOverrideSummary($actor, $before, $course, $assignee, $when);
        }

        return "{$actor} assigned {$course} to {$assignee} on {$when}.";
    }

    /**
     * @param  array<string, array{from:mixed,to:mixed}>  $changes
     */
    public static function summarizeUpdated(
        EmployeeTraining $training,
        string $employeeName,
        array $changes,
        string $overrideNote = '',
        string $actorName = '',
    ): string {
        $actor = $actorName !== '' ? $actorName : 'Someone';
        $course = $training->title ?: 'Untitled course';
        $when = self::formatTimestamp(now());
        $assignee = trim($employeeName) !== '' ? trim($employeeName) : 'an operative';
        $before = trim($overrideNote);
        $rescheduled = self::changesIncludeScheduleMove($changes);

        if ($rescheduled) {
            return "{$actor} rescheduled {$course} for {$assignee} on {$when}.";
        }

        if ($before !== '') {
            return self::formatOverrideSummary($actor, $before, $course, $assignee, $when);
        }

        return "{$actor} updated {$course} for {$assignee} on {$when}.";
    }

    /**
     * @param  array<string, array{from:mixed,to:mixed}>  $changes
     */
    public static function resolveUpdateAction(array $changes, string $overrideNote = ''): string
    {
        if (self::changesIncludeScheduleMove($changes)) {
            return 'rescheduled';
        }

        if (trim($overrideNote) !== '') {
            return 'overridden';
        }

        return 'updated';
    }

    /**
     * @param  array<string, array{from:mixed,to:mixed}>  $changes
     */
    public static function changesIncludeScheduleMove(array $changes): bool
    {
        foreach (['start_date', 'end_date'] as $field) {
            if (! isset($changes[$field]) || ! is_array($changes[$field])) {
                continue;
            }
            $from = (string) ($changes[$field]['from'] ?? '');
            $to = (string) ($changes[$field]['to'] ?? '');
            if ($from !== '' && $to !== '' && $from !== $to) {
                return true;
            }
        }

        return false;
    }

    /**
     * Compact before-label used in override summaries (not a full sentence).
     *
     * @param  list<array<string, mixed>>  $conflicts
     */
    public static function summarizeOverrideNote(
        array $conflicts,
        bool $confirmOverride,
        string $afterLabel = '',
        string $actorName = '',
        string $employeeName = '',
    ): string {
        if (! $confirmOverride) {
            return '';
        }

        $before = self::summarizeOverrideBeforeLabels($conflicts);
        if ($before === '' || $before === 'existing planned work') {
            return 'existing planned work';
        }

        return $before;
    }

    /**
     * Normalize client/server conflict payloads into a common audit shape.
     *
     * @param  list<array<string, mixed>>  $conflicts
     * @return list<array<string, mixed>>
     */
    public static function normalizeOverrideConflicts(array $conflicts): array
    {
        $normalized = [];

        foreach ($conflicts as $conflict) {
            if (! is_array($conflict)) {
                continue;
            }

            $tasks = [];
            foreach (($conflict['tasks'] ?? []) as $task) {
                if (is_string($task)) {
                    $name = trim($task);
                    if ($name !== '') {
                        $tasks[] = ['task_name' => $name, 'project_name' => ''];
                    }
                    continue;
                }
                if (! is_array($task)) {
                    continue;
                }
                $name = trim((string) ($task['task_name'] ?? $task['name'] ?? ''));
                if ($name === '') {
                    continue;
                }
                $tasks[] = [
                    'task_id' => isset($task['task_id']) ? (int) $task['task_id'] : null,
                    'task_name' => $name,
                    'project_name' => trim((string) ($task['project_name'] ?? $task['project'] ?? '')),
                ];
            }

            $trainings = [];
            foreach (($conflict['trainings'] ?? []) as $title) {
                if (is_array($title)) {
                    $title = $title['title'] ?? $title['name'] ?? '';
                }
                $trimmed = trim((string) $title);
                if ($trimmed !== '') {
                    $trainings[] = $trimmed;
                }
            }

            $message = trim((string) ($conflict['message'] ?? ''));
            if ($tasks === [] && $trainings === [] && $message === '') {
                continue;
            }

            $normalized[] = [
                'tasks' => $tasks,
                'trainings' => $trainings,
                'message' => $message,
            ];
        }

        return $normalized;
    }

    /**
     * @param  list<array<string, mixed>>  $conflicts
     * @return list<string>
     */
    public static function overrideBeforeLabelItems(array $conflicts): array
    {
        $labels = [];

        foreach ($conflicts as $conflict) {
            foreach (($conflict['tasks'] ?? []) as $task) {
                $name = trim((string) ($task['task_name'] ?? ''));
                if ($name === '') {
                    $name = 'Untitled task';
                }
                $project = trim((string) ($task['project_name'] ?? ''));
                // Lead with project so override logs name what was displaced.
                $label = $project !== '' ? "{$project} — {$name}" : $name;
                $labels[$label] = $label;
            }

            foreach (($conflict['trainings'] ?? []) as $title) {
                $trainingTitle = trim((string) $title);
                if ($trainingTitle === '') {
                    continue;
                }
                $label = "Training: {$trainingTitle}";
                $labels[$label] = $label;
            }
        }

        if ($labels === []) {
            $messages = array_values(array_filter(array_map(
                fn (array $conflict) => trim((string) ($conflict['message'] ?? '')),
                $conflicts,
            )));

            return $messages === [] ? ['existing planned work'] : [$messages[0]];
        }

        $shown = array_slice(array_values($labels), 0, 5);
        if (count($labels) > 5) {
            $shown[] = '…';
        }

        return $shown;
    }

    /**
     * @param  list<array<string, mixed>>  $conflicts
     */
    public static function summarizeOverrideBeforeLabels(array $conflicts): string
    {
        return implode("\n", self::overrideBeforeLabelItems($conflicts));
    }

    private static function formatOverrideSummary(
        string $actor,
        string $before,
        string $course,
        string $assignee,
        string $when,
    ): string {
        $items = preg_split("/\r\n|\n|\r/", $before) ?: [];
        $items = array_values(array_filter(array_map('trim', $items), static fn (string $item) => $item !== ''));

        if ($items === []) {
            $items = ['existing planned work'];
        }

        // Support older semicolon-joined override notes still stored in logs.
        if (count($items) === 1 && str_contains($items[0], '; ')) {
            $items = array_values(array_filter(array_map('trim', explode('; ', $items[0]))));
        }

        if (count($items) === 1 && $items[0] === 'existing planned work') {
            return "{$actor} overrode existing planned work with {$course} for {$assignee} on {$when}.";
        }

        // Keep the title short — replaced projects/trainings are listed in the UI.
        $primary = $items[0];
        $extra = count($items) - 1;
        $target = $extra > 0
            ? "{$primary} (+{$extra} more)"
            : $primary;

        return "{$actor} overrode {$target} with {$course} for {$assignee} on {$when}.";
    }

    public static function summarizeDeleted(string $title, string $employeeName, string $actorName = ''): string
    {
        $actor = $actorName !== '' ? $actorName : 'Someone';
        $course = $title !== '' ? $title : 'Untitled course';
        $when = self::formatTimestamp(now());
        $assignee = trim($employeeName);

        if ($assignee !== '') {
            return "{$actor} deleted {$course} for {$assignee} on {$when}.";
        }

        return "{$actor} deleted {$course} on {$when}.";
    }

    /**
     * @param  list<string>  $assigneeNames
     */
    public static function summarizeCourseDeleted(
        string $title,
        int $assignmentCount,
        string $actorName = '',
        array $assigneeNames = [],
    ): string {
        $actor = $actorName !== '' ? $actorName : 'Someone';
        $course = $title !== '' ? $title : 'Untitled course';
        $when = self::formatTimestamp(now());

        $names = [];
        foreach ($assigneeNames as $name) {
            $trimmed = trim((string) $name);
            if ($trimmed !== '' && ! in_array($trimmed, $names, true)) {
                $names[] = $trimmed;
            }
        }

        if ($assignmentCount <= 0 && $names === []) {
            $detail = '0 assignments';
        } elseif (count($names) === 1) {
            $detail = '1 assignment: '.$names[0];
        } elseif (count($names) > 1) {
            $count = max($assignmentCount, count($names));
            $detail = "{$count} assignments: ".implode(', ', $names);
        } elseif ($assignmentCount === 1) {
            $detail = '1 assignment';
        } else {
            $detail = "{$assignmentCount} assignments";
        }

        return "{$actor} deleted course {$course} ({$detail}) on {$when}.";
    }

    /**
     * @param  array<string, array{from:mixed,to:mixed}>  $changes
     * @return list<string>
     */
    public static function summarizeChangeParts(array $changes): array
    {
        $parts = [];
        $orderedFields = array_values(array_unique([
            'priority',
            'urgency',
            'start_date',
            'end_date',
            ...array_keys($changes),
        ]));

        foreach ($orderedFields as $field) {
            if (! isset($changes[$field]) || $field === 'confirm_override') {
                continue;
            }

            if ($field === 'priority') {
                $parts[] = 'Priority changed from '
                    .self::formatValue('priority', $changes['priority']['from'] ?? null)
                    .' to '
                    .self::formatValue('priority', $changes['priority']['to'] ?? null);
                continue;
            }

            if ($field === 'urgency') {
                $parts[] = 'Urgency changed from '
                    .self::formatValue('urgency', $changes['urgency']['from'] ?? null)
                    .' to '
                    .self::formatValue('urgency', $changes['urgency']['to'] ?? null);
                continue;
            }

            $change = $changes[$field];
            $parts[] = sprintf(
                '%s changed from %s to %s',
                self::fieldLabel($field),
                self::formatValue($field, $change['from'] ?? null),
                self::formatValue($field, $change['to'] ?? null),
            );
        }

        return $parts;
    }

    public static function fieldLabel(string $field): string
    {
        return self::FIELD_LABELS[$field] ?? str_replace('_', ' ', ucfirst($field));
    }

    public static function formatValue(string $field, mixed $value): string
    {
        if ($value === null || $value === '') {
            return '—';
        }

        if ($field === 'status') {
            return self::STATUS_LABELS[(string) $value] ?? str_replace('_', ' ', (string) $value);
        }

        if ($field === 'hours_per_day') {
            $number = (float) $value;
            $formatted = fmod($number, 1.0) === 0.0
                ? (string) (int) $number
                : rtrim(rtrim(number_format($number, 2, '.', ''), '0'), '.');

            return $formatted.'h';
        }

        if ($field === 'confirm_override') {
            return filter_var($value, FILTER_VALIDATE_BOOLEAN) ? 'Yes' : 'No';
        }

        if ($field === 'day_segment') {
            $segment = is_numeric($value) ? (int) $value : 0;
            $segment = max(0, min(3, $segment));

            return 'Section '.($segment + 1);
        }

        if (in_array($field, ['start_date', 'end_date'], true)) {
            try {
                return Carbon::parse((string) $value)->format('j M Y');
            } catch (\Throwable) {
                return (string) $value;
            }
        }

        return (string) $value;
    }

    private static function formatTimestamp(mixed $value): string
    {
        try {
            return Carbon::parse($value)->format('j M Y \a\t H:i');
        } catch (\Throwable) {
            return now()->format('j M Y \a\t H:i');
        }
    }

    private static function normalizeValue(string $field, mixed $value): mixed
    {
        if ($value instanceof \DateTimeInterface) {
            return $value->format('Y-m-d');
        }

        if ($field === 'hours_per_day' && is_numeric($value)) {
            return round((float) $value, 2);
        }

        if ($field === 'confirm_override') {
            return (bool) $value;
        }

        if (is_string($value)) {
            $trimmed = trim($value);

            return $trimmed === '' ? null : $trimmed;
        }

        return $value;
    }
}
