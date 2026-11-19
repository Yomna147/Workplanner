<?php

namespace App\Support;

/**
 * Keep Done and progress % aligned on save:
 * - Done on  → 100%
 * - 100%     → Done on
 * - < 100%   → Done off
 *
 * Matches Front-end syncTaskDoneAndProgress (completed must mean 100%).
 * Client-cancelled mid-job exception is not modeled yet — needs a cancel flag.
 */
class TaskDoneProgressSync
{
    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public static function applyToPayload(array $payload): array
    {
        $payload = self::syncPair($payload, 'done', 'progress_per', booleanDone: true, updateLeftHours: true);
        $payload = self::syncPair($payload, 'dl_done', 'dl_progress_per', booleanDone: false, updateLeftHours: false);

        return $payload;
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private static function syncPair(
        array $payload,
        string $doneKey,
        string $percentKey,
        bool $booleanDone,
        bool $updateLeftHours,
    ): array {
        $hasDone = array_key_exists($doneKey, $payload);
        $hasPercent = array_key_exists($percentKey, $payload);

        if (! $hasDone && ! $hasPercent) {
            return $payload;
        }

        $percent = self::parsePercent($payload[$percentKey] ?? null);
        $doneTruthy = $hasDone && self::isTruthyDone($payload[$doneKey] ?? null);

        // Skip empty DL mirror pair so we do not invent 0% / not-done stamps.
        if (! $booleanDone && ! $doneTruthy && $percent === null) {
            return $payload;
        }

        $done = $hasDone
            ? $doneTruthy
            : ($percent !== null && $percent >= 100);

        if ($done) {
            $percent = 100;
        } elseif ($percent !== null && $percent >= 100) {
            $done = true;
            $percent = 100;
        } elseif ($percent !== null) {
            $done = false;
        } else {
            $percent = $done ? 100 : 0;
        }

        if ($booleanDone) {
            $payload[$doneKey] = $done;
        } else {
            $payload[$doneKey] = $done ? '1' : '0';
        }

        $payload[$percentKey] = (string) $percent;

        if ($updateLeftHours) {
            $plan = self::numericPlan($payload);
            if ($plan !== null) {
                $payload['progress_left_hours'] = (string) max(0, (int) round($plan * (1 - $percent / 100)));
            }
        }

        return $payload;
    }

    private static function parsePercent(mixed $raw): ?int
    {
        $text = trim((string) ($raw ?? ''));
        if ($text === '') {
            return null;
        }

        $text = rtrim($text, '%');
        if (! is_numeric($text)) {
            return null;
        }

        return (int) max(0, min(100, round((float) $text)));
    }

    private static function isTruthyDone(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        $normalized = strtolower(trim((string) ($value ?? '')));

        return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private static function numericPlan(array $payload): ?float
    {
        foreach (['plan', 'progress_plan'] as $key) {
            $raw = trim((string) ($payload[$key] ?? ''));
            if ($raw !== '' && is_numeric($raw)) {
                $plan = (float) $raw;

                return $plan > 0 ? $plan : null;
            }
        }

        return null;
    }
}
