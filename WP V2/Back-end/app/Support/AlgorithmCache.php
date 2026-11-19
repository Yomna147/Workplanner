<?php

namespace App\Support;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

/**
 * Completed algorithm assignment results are shared across all users so the
 * Resource Histogram is populated for every login without re-running the algo.
 *
 * In-progress stepped runs remain per-user via AlgoController session keys.
 */
class AlgorithmCache
{
    public const SHARED_KEY = 'cachedData:shared';

    public static function key(?Request $request = null): string
    {
        return self::SHARED_KEY;
    }

    /**
     * @return array<string, mixed>|null
     */
    public static function get(?Request $request = null): ?array
    {
        $shared = Cache::get(self::SHARED_KEY);
        if (self::hasAssignmentDetails($shared)) {
            return $shared;
        }

        // One-time migration: promote the newest non-empty per-user cache.
        $legacy = self::findLegacyCachedData($request);
        if (self::hasAssignmentDetails($legacy)) {
            Cache::forever(self::SHARED_KEY, $legacy);

            return $legacy;
        }

        return is_array($shared) ? $shared : null;
    }

    /**
     * @param  array<string, mixed>  $data
     */
    public static function put(array $data, ?Request $request = null): void
    {
        Cache::forever(self::SHARED_KEY, $data);
    }

    public static function forget(?Request $request = null): void
    {
        Cache::forget(self::SHARED_KEY);

        // Also drop legacy per-user keys so clears are complete.
        foreach (self::legacyCandidateKeys($request) as $key) {
            Cache::forget($key);
        }
    }

    /**
     * Drop cached assignment rows for deleted tasks so histogram bars
     * (including "Unknown project") do not linger after project/part deletes.
     *
     * @param  array<int, int|string>  $taskIds
     */
    public static function forgetAssignmentsForTaskIds(array $taskIds, ?Request $request = null): void
    {
        $ids = collect($taskIds)
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        if ($ids === []) {
            return;
        }

        $cached = self::get($request);
        if (! is_array($cached)) {
            return;
        }

        $details = is_array($cached['assignmentDetails'] ?? null)
            ? $cached['assignmentDetails']
            : [];

        if ($details === []) {
            return;
        }

        $idSet = array_fill_keys($ids, true);
        $filtered = array_values(array_filter(
            $details,
            fn ($detail) => ! isset($idSet[(int) ($detail['task_id'] ?? 0)]),
        ));

        if (count($filtered) === count($details)) {
            return;
        }

        self::put([
            ...$cached,
            'assignmentDetails' => $filtered,
        ], $request);

        AlgorithmSealedAssignments::forgetForTaskIds($ids);
    }

    /**
     * @param  mixed  $cached
     */
    private static function hasAssignmentDetails(mixed $cached): bool
    {
        return is_array($cached)
            && is_array($cached['assignmentDetails'] ?? null)
            && $cached['assignmentDetails'] !== [];
    }

    /**
     * @return array<string, mixed>|null
     */
    private static function findLegacyCachedData(?Request $request = null): ?array
    {
        foreach (self::legacyCandidateKeys($request) as $key) {
            $cached = Cache::get($key);
            if (self::hasAssignmentDetails($cached)) {
                return $cached;
            }
        }

        return null;
    }

    /**
     * @return list<string>
     */
    private static function legacyCandidateKeys(?Request $request = null): array
    {
        $keys = ['cachedData:guest', 'cachedData:1'];

        $userId = $request?->user()?->id ?? auth()->id();
        if ($userId) {
            array_unshift($keys, 'cachedData:'.$userId);
        }

        try {
            foreach (User::query()->orderByDesc('id')->limit(50)->pluck('id') as $id) {
                $keys[] = 'cachedData:'.$id;
            }
        } catch (\Throwable) {
            // Users table may be unavailable during early boot/tests.
        }

        return array_values(array_unique($keys));
    }
}
