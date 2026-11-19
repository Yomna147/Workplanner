<?php

namespace App\Support;

use App\Models\ProjectTask;
use Carbon\Carbon;

class AlgorithmTaskMapper
{
    /** @param array<string, mixed> $task */
    public static function toLegacy(array $task): array
    {
        $docSupply = $task['doc_supply'] ?? null;
        $completion = $task['completion'] ?? null;

        $sharePercent = self::normalizeSharePercent(
            self::firstNonEmpty($task['sh'] ?? null, $task['hbs'] ?? null),
        );
        $plan = is_numeric($task['plan'] ?? null) ? (float) $task['plan'] : null;
        $shareHours = $sharePercent !== null && $plan !== null
            ? round($plan * ($sharePercent / 100), 4)
            : null;

        return [
            'id' => $task['id'] ?? null,
            'TaskName' => $task['task_name'] ?? '',
            'Pri' => $task['pri'] ?? null,
            'Doc_Supply' => self::formatDate($docSupply),
            'Completion' => self::formatDate($completion),
            'Plan' => $task['plan'] ?? null,
            'Algorithm_1' => $task['algorithm_1'] ?? null,
            'Algorithm_2' => $task['algorithm_2'] ?? null,
            'Algorithm_3' => $task['algorithm_3'] ?? null,
            'Override_1' => $task['override_1'] ?? null,
            'Override_2' => $task['override_2'] ?? null,
            'Override_3' => $task['override_3'] ?? null,
            'DL_Override1' => $task['dl_override_1'] ?? null,
            'DL_Override2' => $task['dl_override_2'] ?? null,
            'DL_Override3' => $task['dl_override_3'] ?? null,
            'TS' => self::firstNonEmpty($task['ts'] ?? null, $task['ats'] ?? null),
            'SH' => $shareHours,
            'Hbs' => $shareHours,
            'SH_Percent' => $sharePercent,
            'AL' => self::firstNonEmpty($task['al'] ?? null, $task['ots'] ?? null),
            'DD' => $task['dd'] ?? null,
            'hrsPer' => $task['hrs_per'] ?? null,
            'Buf' => $task['buf'] ?? null,
            'Adj' => $task['adj'] ?? null,
            'Red' => $task['red'] ?? null,
            'Done' => ! empty($task['done']) ? 1 : 0,
            'created_at' => $task['created_at'] ?? null,
            'parts_id' => $task['part_id'] ?? null,
            'project_id' => $task['project_id'] ?? null,
            'project_name' => $task['project_name'] ?? null,
            'Owner' => self::firstNonEmpty($task['dl_owner'] ?? null, $task['owner'] ?? null),
            'dl_owner' => self::stringOrNull($task['dl_owner'] ?? null),
        ];
    }

    /** @return array<string, mixed> */
    public static function fromLegacy(array $task): array
    {
        $ts = self::stringOrNull($task['TS'] ?? null);
        $al = self::stringOrNull($task['AL'] ?? null);
        $sharePercent = self::stringOrNull(
            $task['SH_Percent'] ?? $task['SH'] ?? $task['Hbs'] ?? null,
        );

        return array_filter([
            'algorithm_1' => self::stringOrEmpty($task['Algorithm_1'] ?? null),
            'algorithm_2' => self::stringOrEmpty($task['Algorithm_2'] ?? null),
            'algorithm_3' => self::stringOrEmpty($task['Algorithm_3'] ?? null),
            'ts' => $ts,
            'ats' => $ts,
            'sh' => $sharePercent,
            'hbs' => $sharePercent,
            'al' => $al,
            'ots' => $al,
            'owner' => self::stringOrNull($task['Owner'] ?? null),
        ], static fn ($value) => $value !== null);
    }

    public static function hasEstHours(array $task): bool
    {
        $est = $task['est'] ?? null;
        if ($est === null || trim((string) $est) === '') {
            return false;
        }

        return is_numeric($est) && (float) $est > 0;
    }

    public static function loadActiveTasks(): array
    {
        return ProjectTask::query()
            ->where('done', false)
            ->whereHas('part.project')
            ->whereNotNull('plan')
            ->where('plan', '!=', '')
            ->whereNotNull('doc_supply')
            ->where('doc_supply', '!=', '')
            ->whereNotNull('completion')
            ->where('completion', '!=', '')
            ->with(['part:id,project_id', 'part.project:id,name'])
            ->orderBy('pri')
            ->orderBy('created_at')
            ->orderBy('id')
            ->get()
            ->map(function (ProjectTask $task) {
                $data = $task->toArray();
                $data['project_id'] = $task->part?->project_id;
                $data['project_name'] = $task->part?->project?->name;

                return self::toLegacy($data);
            })
            ->filter(function (array $task) {
                if (! is_numeric($task['Plan'] ?? null)) {
                    return false;
                }

                return (float) $task['Plan'] > 0;
            })
            ->values()
            ->all();
    }

    private static function formatDate(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        try {
            return Carbon::parse($value)->format('Y-m-d');
        } catch (\Throwable) {
            return is_string($value) ? $value : null;
        }
    }

    private static function stringOrEmpty(mixed $value): string
    {
        return $value === null ? '' : (string) $value;
    }

    private static function stringOrNull(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return (string) $value;
    }

    private static function normalizeSharePercent(?string $value): ?float
    {
        if ($value === null || ! is_numeric($value)) {
            return null;
        }

        return min(100.0, max(0.0, (float) $value));
    }

    private static function firstNonEmpty(mixed ...$values): ?string
    {
        foreach ($values as $value) {
            if ($value !== null && $value !== '') {
                return (string) $value;
            }
        }

        return null;
    }
}
