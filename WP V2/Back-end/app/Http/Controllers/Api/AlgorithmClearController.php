<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ProjectTask;
use App\Support\AlgorithmCache;
use App\Support\AlgorithmSealedAssignments;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AlgorithmClearController extends Controller
{
    public function clear(Request $request): JsonResponse
    {
        $sealed = AlgorithmSealedAssignments::snapshot($request);

        ProjectTask::query()
            ->where(function ($query) {
                $query->where('done', false)->orWhereNull('done');
            })
            ->whereDoesntHave('part.project', function ($query) {
                $query->where('status', 'completed');
            })
            ->update([
                'algorithm_1' => '',
                'algorithm_2' => '',
                'algorithm_3' => '',
            ]);

        AlgorithmCache::put([
            'assignmentDetails' => $sealed,
            'filteredTasks' => [],
        ], $request);
        ResourceHistogramController::clearFullPayloadCache($request);

        return response()->json([
            'message' => 'Cleared algorithm assignments for active tasks.',
        ]);
    }
}
