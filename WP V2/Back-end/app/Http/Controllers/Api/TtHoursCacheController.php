<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\TtHoursCache;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class TtHoursCacheController extends Controller
{
    public function show(): JsonResponse
    {
        $cache = TtHoursCache::query()
            ->where('scope_key', TtHoursCache::SCOPE_GLOBAL)
            ->first();

        if (! $cache) {
            return response()->json(['data' => null]);
        }

        return response()->json([
            'data' => $this->formatCacheResponse($cache),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'fetchedAt' => ['required', 'integer', 'min:1'],
            'version' => ['nullable', 'integer', 'min:1'],
            'dateRange' => ['nullable', 'array'],
            'dateRange.start' => ['nullable', 'string'],
            'dateRange.end' => ['nullable', 'string'],
            'summaries' => ['required', 'array'],
            'ttUsers' => ['nullable', 'array'],
        ]);

        $payload = [
            'summaries' => $validated['summaries'],
            'ttUsers' => $validated['ttUsers'] ?? [],
        ];

        $dateStart = $this->normalizeCacheDate($validated['dateRange']['start'] ?? null);
        $dateEnd = $this->normalizeCacheDate($validated['dateRange']['end'] ?? null);

        $cache = TtHoursCache::query()->updateOrCreate(
            ['scope_key' => TtHoursCache::SCOPE_GLOBAL],
            [
                'fetched_at' => Carbon::createFromTimestamp((int) floor(((int) $validated['fetchedAt']) / 1000)),
                'date_start' => $dateStart,
                'date_end' => $dateEnd,
                'version' => (int) ($validated['version'] ?? 1),
                'payload' => $payload,
                'updated_by' => $request->user()?->id,
            ],
        );

        return response()->json([
            'message' => 'TT hours cache saved.',
            'data' => $this->formatCacheResponse($cache),
        ]);
    }

    private function normalizeCacheDate(mixed $value): ?string
    {
        if (! is_string($value) || trim($value) === '') {
            return null;
        }

        $value = trim($value);
        if (! preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
            return null;
        }

        return $value;
    }

    private function formatCacheResponse(TtHoursCache $cache): array
    {
        $payload = $cache->payload ?? [];

        return [
            'version' => $cache->version,
            'fetchedAt' => $this->fetchedAtToMs($cache->fetched_at),
            'dateRange' => [
                'start' => $cache->date_start?->format('Y-m-d') ?? '',
                'end' => $cache->date_end?->format('Y-m-d') ?? '',
            ],
            'summaries' => $payload['summaries'] ?? [],
            'ttUsers' => $payload['ttUsers'] ?? [],
            'summaryCount' => count($payload['summaries'] ?? []),
            'updatedBy' => $cache->updated_by,
            'updatedAt' => $cache->updated_at?->toIso8601String(),
        ];
    }

    private function fetchedAtToMs(?Carbon $value): ?int
    {
        if (! $value) {
            return null;
        }

        return (int) round($value->getTimestamp() * 1000);
    }
}
