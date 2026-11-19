<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Models\Project;
use App\Models\Team;
use Illuminate\Http\JsonResponse;

class DashboardController extends Controller
{
    public function stats(): JsonResponse
    {
        // Match WP /projects default list: not completed, and still "undone"
        // (has at least one open task, or no tasks yet).
        $activeProjects = Project::query()
            ->where('status', '!=', 'completed')
            ->where(function ($query) {
                $query->whereHas('tasks', function ($taskQuery) {
                    $taskQuery->where(function ($doneQuery) {
                        $doneQuery->where('done', false)->orWhereNull('done');
                    });
                })->orWhereDoesntHave('tasks');
            })
            ->count();

        return response()->json([
            'data' => [
                'projects' => Project::count(),
                'employees' => Employee::count(),
                'teams' => Team::count(),
                'active_projects' => $activeProjects,
            ],
        ]);
    }
}
