<?php

namespace App\Support;

use App\Models\EmailNotificationSetting;
use Illuminate\Support\Str;

/**
 * Configurable email / in-app notification case types for planners.
 *
 * task_sync — evaluated when project tasks are saved.
 * scheduled — configured here for planners; evaluation needs a separate job/trigger.
 *
 * Custom When options can be added in Admin; they reuse a built-in evaluator.
 */
class EmailNotificationCaseTypes
{
    public const CUSTOM_SETTING_KEY = 'custom_case_types';

    /**
     * @return list<array{
     *   value: string,
     *   label: string,
     *   unit: string,
     *   default: float|int,
     *   scope: 'task_sync'|'scheduled',
     *   hide_value?: bool,
     *   description: string,
     *   help: string,
     *   example: string,
     *   evaluator: string,
     *   custom?: bool
     * }>
     */
    public static function builtIn(): array
    {
        $cases = [
            [
                'value' => 'progress_threshold',
                'label' => 'Task progress ≥',
                'unit' => '%',
                'default' => 80,
                'scope' => 'task_sync',
                'description' => 'Task progress reaches or exceeds the threshold.',
                'help' => 'Fires once when a saved task newly crosses this progress %. Used for ops (~80%) and management (~95%) reviews. Does not re-send until progress drops below the threshold and crosses again.',
                'example' => 'Example: 80 → notify when progress hits 80% or more.',
            ],
            [
                'value' => 'over_plan_pct',
                'label' => 'Over plan by ≥',
                'unit' => '%',
                'default' => 10,
                'scope' => 'task_sync',
                'description' => 'Actual hours exceed plan by at least this percentage.',
                'help' => 'Compares Act vs Plan on the task. Fires when (Act − Plan) / Plan × 100 reaches the threshold. Plan must be greater than zero. Same idea as the TT / PDE over-plan warning.',
                'example' => 'Example: 10 → notify when Act is at least 10% above Plan.',
            ],
            [
                'value' => 'completion_approaching_days',
                'label' => 'Completion within',
                'unit' => 'days',
                'default' => 3,
                'scope' => 'task_sync',
                'description' => 'Incomplete task with completion date within the next N days.',
                'help' => 'Matches incomplete tasks whose Completion date is still in the future but within N days. Same signal as the dashed red ring on the resource histogram. Skips tasks that are done or at 100%.',
                'example' => 'Example: 3 → notify when completion is 1–3 days away.',
            ],
            [
                'value' => 'completion_overdue_days',
                'label' => 'Completion overdue ≥',
                'unit' => 'days',
                'default' => 0,
                'scope' => 'task_sync',
                'description' => 'Incomplete task past its completion date by at least N days.',
                'help' => 'Matches incomplete tasks whose Completion date is today or earlier. Same signal as the solid red ring on the histogram. Use 0 for due today or already late; raise the value to wait until it is N days late.',
                'example' => 'Example: 0 → notify as soon as completion is due or overdue.',
            ],
            [
                'value' => 'task_done',
                'label' => 'Task marked done',
                'unit' => '',
                'default' => 1,
                'scope' => 'task_sync',
                'hide_value' => true,
                'description' => 'Task is marked done / completed.',
                'help' => 'Fires when a task is newly marked Done or reaches 100% progress on save. Useful to alert planners that work is complete and capacity may free up.',
                'example' => 'No threshold — triggers on the done / 100% transition.',
            ],
            [
                'value' => 'dl_override_filled',
                'label' => 'DL / project override set',
                'unit' => '',
                'default' => 1,
                'scope' => 'task_sync',
                'hide_value' => true,
                'description' => 'A project override field (Override 1–3) is filled on the task.',
                'help' => 'Fires when Override 1, 2, or 3 (or the DL mirror columns) newly has a value. Used when DLs or planners record staffing / project overrides on a task.',
                'example' => 'No threshold — triggers when any override field becomes non-empty.',
            ],
            [
                'value' => 'dl_hours_threshold',
                'label' => 'DL hours ≥',
                'unit' => 'h',
                'default' => 8,
                'scope' => 'task_sync',
                'description' => 'DL hours on the task reach or exceed the threshold.',
                'help' => 'Uses the DL hours field (dl / dl_dl). Fires once when the value newly crosses the threshold on save.',
                'example' => 'Example: 8 → notify when DL hours are at least 8.',
            ],
            [
                'value' => 'dl_rfi_on',
                'label' => 'RFI flagged on',
                'unit' => '',
                'default' => 1,
                'scope' => 'task_sync',
                'hide_value' => true,
                'description' => 'RFI is turned on for the task.',
                'help' => 'Fires when RFI newly becomes Yes/on during a DL or PDE save.',
                'example' => 'No threshold — triggers on the RFI off → on transition.',
            ],
            [
                'value' => 'dl_owner_claimed',
                'label' => 'DL claimed task owner',
                'unit' => '',
                'default' => 1,
                'scope' => 'task_sync',
                'hide_value' => true,
                'description' => 'A DL has locked / claimed ownership on the task.',
                'help' => 'Fires when dl_owner is newly set. After that, PDE auto-assign should not overwrite the owner.',
                'example' => 'No threshold — triggers when DL ownership is first claimed.',
            ],
            [
                'value' => 'capacity_gap_hours',
                'label' => 'Free capacity ≥',
                'unit' => 'h',
                'default' => 8,
                'scope' => 'scheduled',
                'description' => 'NRM operative has at least this many free hours in the training gap window.',
                'help' => 'Planner training-gap alert: an NRM operative has enough free hours in the look-ahead window (currently ~3 weeks) to take training. Same idea as the Trainings gap banner / navbar alerts. Email evaluation for this case is scheduled (not on every task save).',
                'example' => 'Example: 8 → notify when free capacity is at least 8 hours.',
            ],
            [
                'value' => 'incomplete_training_days',
                'label' => 'Training incomplete ≥',
                'unit' => 'days',
                'default' => 0,
                'scope' => 'scheduled',
                'description' => 'Training started and still not completed.',
                'help' => 'Planner counterpart to the operative incomplete-training login reminder. Fires when a training has started (or started N days ago) and status is still not completed. Email evaluation is scheduled.',
                'example' => 'Example: 0 → notify from the training start day while still incomplete.',
            ],
            [
                'value' => 'dl_update_overdue',
                'label' => 'DL weekly update overdue',
                'unit' => '',
                'default' => 1,
                'scope' => 'scheduled',
                'hide_value' => true,
                'description' => 'A DL has not submitted their weekly quick update and is overdue.',
                'help' => 'Alerts planners/management when a Discipline Lead’s weekly Quick Update is overdue. DLs already see this in their login / DL list; this case is for notifying planners by email. Evaluation is scheduled.',
                'example' => 'No threshold — triggers when DL status is overdue.',
            ],
            [
                'value' => 'dl_edited_after_submit',
                'label' => 'DL edited after weekly submit',
                'unit' => '',
                'default' => 1,
                'scope' => 'scheduled',
                'hide_value' => true,
                'description' => 'A DL changed task data after submitting the weekly Quick Update.',
                'help' => 'Matches the “Edited after submit” Quick Update status. Useful so planners know the submitted week may be stale. Evaluation is scheduled.',
                'example' => 'No threshold — triggers when status becomes stale after submit.',
            ],
            [
                'value' => 'histogram_schedule_override',
                'label' => 'Histogram schedule edit / override',
                'unit' => '',
                'default' => 1,
                'scope' => 'scheduled',
                'hide_value' => true,
                'description' => 'A planner saved a resource-histogram bar edit that overrides schedule.',
                'help' => 'Covers durable histogram schedule overrides (drag/edit on the resource histogram). Evaluation is scheduled / on histogram save wiring.',
                'example' => 'No threshold — triggers when a schedule override is saved.',
            ],
            [
                'value' => 'training_project_override',
                'label' => 'Training overrides project work',
                'unit' => '',
                'default' => 1,
                'scope' => 'scheduled',
                'hide_value' => true,
                'description' => 'Training was confirmed over existing planned project tasks.',
                'help' => 'Fires when confirm_override is used to schedule training on top of project assignments. Project tasks are kept; this alert is for planners reviewing conflicts. Evaluation is scheduled / on training save.',
                'example' => 'No threshold — triggers when a training override is confirmed.',
            ],
            [
                'value' => 'trainee_over_capacity_hours',
                'label' => 'Trainee over capacity ≥',
                'unit' => 'h',
                'default' => 1,
                'scope' => 'scheduled',
                'description' => 'Trainee/junior booked hours exceed weekly capacity.',
                'help' => 'Alerts when a trainee or junior is booked above their weekly capacity by at least N hours. DLs already get a login modal; this case notifies planners. Evaluation is scheduled.',
                'example' => 'Example: 1 → notify when over capacity by 1 hour or more.',
            ],
        ];

        return array_map(static function (array $case) {
            $case['evaluator'] = $case['value'];
            $case['custom'] = false;

            return $case;
        }, $cases);
    }

    /** @return list<array<string, mixed>> */
    public static function custom(): array
    {
        $setting = EmailNotificationSetting::query()
            ->where('key', self::CUSTOM_SETTING_KEY)
            ->first();
        $rows = $setting?->value;

        if (! is_array($rows)) {
            return [];
        }

        $builtInByValue = collect(self::builtIn())->keyBy('value');
        $normalized = [];

        foreach ($rows as $row) {
            if (! is_array($row)) {
                continue;
            }

            $value = trim((string) ($row['value'] ?? ''));
            $label = trim((string) ($row['label'] ?? ''));
            $evaluator = trim((string) ($row['evaluator'] ?? ''));
            $base = $builtInByValue->get($evaluator);

            if ($value === '' || $label === '' || ! $base) {
                continue;
            }

            $normalized[] = [
                'value' => $value,
                'label' => $label,
                'unit' => (string) ($row['unit'] ?? $base['unit'] ?? ''),
                'default' => is_numeric($row['default'] ?? null) ? $row['default'] + 0 : ($base['default'] ?? 0),
                'scope' => (string) ($row['scope'] ?? $base['scope'] ?? 'task_sync'),
                'hide_value' => (bool) ($row['hide_value'] ?? $base['hide_value'] ?? false),
                'description' => trim((string) ($row['description'] ?? $base['description'] ?? '')),
                'help' => trim((string) ($row['help'] ?? $base['help'] ?? '')),
                'example' => trim((string) ($row['example'] ?? $base['example'] ?? '')),
                'evaluator' => $evaluator,
                'custom' => true,
            ];
        }

        return $normalized;
    }

    /** @return list<array<string, mixed>> */
    public static function all(): array
    {
        return [...self::builtIn(), ...self::custom()];
    }

    public static function find(string $caseType): ?array
    {
        foreach (self::all() as $case) {
            if (($case['value'] ?? '') === $caseType) {
                return $case;
            }
        }

        return null;
    }

    public static function resolveEvaluator(string $caseType): string
    {
        $case = self::find($caseType);

        return (string) ($case['evaluator'] ?? $caseType);
    }

    /** @return list<string> */
    public static function builtInValues(): array
    {
        return array_values(array_map(static fn (array $case) => $case['value'], self::builtIn()));
    }

    /** @return list<string> */
    public static function values(): array
    {
        return array_values(array_map(static fn (array $case) => $case['value'], self::all()));
    }

    /** @return list<string> */
    public static function taskSyncValues(): array
    {
        return array_values(array_map(
            static fn (array $case) => $case['value'],
            array_filter(self::all(), static fn (array $case) => ($case['scope'] ?? '') === 'task_sync'),
        ));
    }

    public static function isTaskSync(string $caseType): bool
    {
        return in_array($caseType, self::taskSyncValues(), true);
    }

    /**
     * @param  array{label: string, evaluator: string, default?: float|int, description?: string, help?: string}  $input
     * @return array<string, mixed>
     */
    public static function createCustom(array $input): array
    {
        $label = trim((string) ($input['label'] ?? ''));
        $evaluator = trim((string) ($input['evaluator'] ?? ''));
        $base = collect(self::builtIn())->firstWhere('value', $evaluator);

        if ($label === '' || ! $base) {
            throw new \InvalidArgumentException('Choose a label and a valid When behavior.');
        }

        $slug = Str::slug($label, '_');
        if ($slug === '') {
            $slug = 'custom_when';
        }
        $value = 'custom_'.$slug;
        $existing = collect(self::values());
        $suffix = 1;
        $candidate = $value;
        while ($existing->contains($candidate)) {
            $suffix += 1;
            $candidate = $value.'_'.$suffix;
        }

        $case = [
            'value' => $candidate,
            'label' => $label,
            'unit' => $base['unit'],
            'default' => array_key_exists('default', $input) && is_numeric($input['default'])
                ? $input['default'] + 0
                : $base['default'],
            'scope' => $base['scope'],
            'hide_value' => (bool) ($base['hide_value'] ?? false),
            'description' => trim((string) ($input['description'] ?? $base['description'])),
            'help' => trim((string) ($input['help'] ?? $base['help'])),
            'example' => $base['example'],
            'evaluator' => $evaluator,
            'custom' => true,
        ];

        $custom = self::custom();
        $custom[] = $case;
        self::saveCustom($custom);

        return $case;
    }

    /**
     * @param  array{label?: string, default?: float|int, description?: string, help?: string}  $input
     * @return array<string, mixed>
     */
    public static function updateCustom(string $value, array $input): array
    {
        $custom = self::custom();
        $index = collect($custom)->search(static fn (array $case) => ($case['value'] ?? '') === $value);
        if ($index === false) {
            throw new \InvalidArgumentException('Custom When type not found.');
        }

        $case = $custom[$index];
        if (array_key_exists('label', $input) && trim((string) $input['label']) !== '') {
            $case['label'] = trim((string) $input['label']);
        }
        if (array_key_exists('default', $input) && is_numeric($input['default'])) {
            $case['default'] = $input['default'] + 0;
        }
        if (array_key_exists('description', $input)) {
            $case['description'] = trim((string) $input['description']);
        }
        if (array_key_exists('help', $input)) {
            $case['help'] = trim((string) $input['help']);
        }

        $custom[$index] = $case;
        self::saveCustom(array_values($custom));

        return $case;
    }

    public static function deleteCustom(string $value): void
    {
        $custom = array_values(array_filter(
            self::custom(),
            static fn (array $case) => ($case['value'] ?? '') !== $value,
        ));
        self::saveCustom($custom);
    }

    /** @param list<array<string, mixed>> $custom */
    private static function saveCustom(array $custom): void
    {
        EmailNotificationSetting::updateOrCreate(
            ['key' => self::CUSTOM_SETTING_KEY],
            ['value' => array_values($custom)],
        );
    }
}
