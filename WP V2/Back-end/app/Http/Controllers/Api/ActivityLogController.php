<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Support\PageAccess;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ActivityLogController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Activity Log', 'view']]);

        $validated = $request->validate([
            'area' => 'nullable|string|max:64',
            'user_id' => 'nullable|integer|exists:users,id',
            'date_from' => 'nullable|date',
            'date_to' => 'nullable|date',
            'limit' => 'nullable|integer|min:1|max:200',
            'page' => 'nullable|integer|min:1',
        ]);

        if (
            ! empty($validated['date_from'])
            && ! empty($validated['date_to'])
            && $validated['date_to'] < $validated['date_from']
        ) {
            return response()->json([
                'message' => 'The end date must be on or after the start date.',
            ], 422);
        }

        $limit = $validated['limit'] ?? 50;
        $page = $validated['page'] ?? 1;

        $query = ActivityLog::query()->orderByDesc('created_at');

        if (! empty($validated['area'])) {
            if ($validated['area'] === 'pde') {
                $query->whereIn('area', ['pde', 'algorithm', 'dl']);
            } else {
                $query->where('area', $validated['area']);
            }
        }

        if (! empty($validated['user_id'])) {
            $query->where('user_id', $validated['user_id']);
        }

        if (! empty($validated['date_from'])) {
            $query->whereDate('created_at', '>=', $validated['date_from']);
        }

        if (! empty($validated['date_to'])) {
            $query->whereDate('created_at', '<=', $validated['date_to']);
        }

        $total = (clone $query)->count();
        $logs = $query
            ->forPage($page, $limit)
            ->get();

        return response()->json([
            'data' => $logs,
            'meta' => [
                'total' => $total,
                'page' => $page,
                'limit' => $limit,
                'pages' => (int) ceil($total / $limit),
            ],
        ]);
    }

}
