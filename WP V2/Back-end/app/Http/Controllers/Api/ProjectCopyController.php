<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\ProjectCopyService;
use App\Services\ProjectPpRebalanceService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class ProjectCopyController extends Controller
{
    public function __construct(private ProjectCopyService $copyService) {}

    public function store(Request $request, ProjectPpRebalanceService $ppRebalance): JsonResponse
    {
        $validated = $request->validate([
            'type' => [
                'required',
                Rule::in(['with_all_data', 'with_allocation', 'without_data', 'duplicate_part']),
            ],
            'source_project_id' => 'required|integer|exists:projects,id',
            'source_part_id' => 'nullable|integer|exists:parts,id',
            'project_name' => 'required_unless:type,duplicate_part|nullable|string|max:255',
            'part_name' => 'required|string|max:255',
            'color' => 'nullable|string|max:7',
            'pp' => 'nullable|numeric',
            'start_date' => 'nullable|date',
            'end_date' => 'nullable|date|after_or_equal:start_date',
        ]);

        $result = $this->copyService->copy($validated);

        if (($result['project']->status ?? 'active') === 'active') {
            if (isset($validated['pp']) && $validated['pp'] !== '' && $validated['pp'] !== null) {
                $ppRebalance->rebalance(
                    $result['project']->id,
                    (string) $validated['pp'],
                    false,
                );
            } else {
                $ppRebalance->rebalance(null, null, true);
            }
        }

        return response()->json(['data' => $result], 201);
    }
}
