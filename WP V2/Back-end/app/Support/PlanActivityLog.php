<?php

namespace App\Support;

class PlanActivityLog
{
    /**
     * Fields that mean a Divisional Leader actually edited plan data on a task.
     * Owner-only / algorithm-only side effects must not count.
     */
    public static function isDlPlanField(string $field): bool
    {
        $field = strtolower(trim($field));
        if ($field === '') {
            return false;
        }

        // Auto-stamped on every DL cell edit — not proof of a plan hour change.
        if ($field === 'dl_owner' || $field === 'owner') {
            return false;
        }

        return $field === 'dl'
            || $field === 'rfi'
            || str_starts_with($field, 'dl_');
    }

    /**
     * @param  array<string, mixed>|null  $item
     */
    public static function updatedTaskHasDlPlanEdit(?array $item): bool
    {
        if (! is_array($item)) {
            return false;
        }

        foreach (array_keys($item['changes'] ?? []) as $field) {
            if (self::isDlPlanField((string) $field)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array<string, mixed>|null  $changes
     */
    public static function looksLikeDlPlanEdit(?array $changes): bool
    {
        if (! is_array($changes)) {
            return false;
        }

        foreach ($changes['updated'] ?? [] as $item) {
            if (self::updatedTaskHasDlPlanEdit(is_array($item) ? $item : null)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array<string, mixed>|null  $changes
     * @return list<int>
     */
    public static function taskIdsFromChanges(?array $changes): array
    {
        if (! is_array($changes)) {
            return [];
        }

        $ids = [];

        foreach (['created', 'updated', 'deleted'] as $bucket) {
            foreach ($changes[$bucket] ?? [] as $item) {
                if (! is_array($item)) {
                    continue;
                }

                $id = (int) ($item['id'] ?? 0);
                if ($id > 0) {
                    $ids[] = $id;
                }
            }
        }

        return array_values(array_unique($ids));
    }

    /**
     * Task ids that had real DL plan-field edits (hours / DL mirrors), not
     * every task touched in the same sync (e.g. algorithm reassignment).
     *
     * @param  array<string, mixed>|null  $meta
     * @param  array<string, mixed>|null  $changes
     * @return list<int>
     */
    public static function taskIdsFromLog(?array $meta, ?array $changes): array
    {
        return self::dlEditedTaskIdsFromChanges($changes);
    }

    /**
     * @param  array<string, mixed>|null  $changes
     * @return list<int>
     */
    public static function dlEditedTaskIdsFromChanges(?array $changes): array
    {
        if (! is_array($changes)) {
            return [];
        }

        $ids = [];

        foreach ($changes['updated'] ?? [] as $item) {
            if (! is_array($item) || ! self::updatedTaskHasDlPlanEdit($item)) {
                continue;
            }

            $id = (int) ($item['id'] ?? 0);
            if ($id > 0) {
                $ids[] = $id;
            }
        }

        return array_values(array_unique($ids));
    }
}
