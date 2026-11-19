<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\SystemMonitorService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AdminSystemMonitorController extends Controller
{
    public function __construct(
        private readonly SystemMonitorService $monitor,
    ) {}

    public function show(Request $request): JsonResponse
    {
        $this->ensureCanMonitor($request);

        return response()->json([
            'data' => $this->monitor->snapshot(),
        ]);
    }

    public function probe(Request $request): JsonResponse
    {
        $this->ensureCanMonitor($request, 'probe');

        $validated = $request->validate([
            'targets' => 'nullable|array',
            'targets.*' => 'in:timetracking,google_sheets,google_drive_quotations',
        ]);

        $targets = $validated['targets'] ?? ['timetracking', 'google_sheets', 'google_drive_quotations'];

        return response()->json([
            'data' => $this->monitor->probe($targets),
        ]);
    }

    private function ensureCanMonitor(Request $request, string $action = 'view'): void
    {
        $user = $request->user();
        if (! $user?->canPageAction('System Monitor', $action)) {
            abort(403, 'You do not have permission to view the system monitor.');
        }
    }
}
