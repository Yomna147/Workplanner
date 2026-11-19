<?php

namespace App\Support;

use App\Models\Project;

class ProjectStatusSync
{
    public static function syncFromTasks(?Project $project): void
    {
        if (! $project) {
            return;
        }

        if ($project->status === 'on_hold') {
            return;
        }

        $totalTasks = $project->tasks()->count();
        $openTasks = $project->tasks()
            ->where(function ($query) {
                $query->where('done', false)->orWhereNull('done');
            })
            ->count();

        if ($totalTasks > 0 && $openTasks === 0) {
            if ($project->status !== 'completed') {
                $project->update(['status' => 'completed']);
            }

            return;
        }

        if ($project->status === 'completed' && $openTasks > 0) {
            $project->update(['status' => 'active']);
        }
    }

  /** Active for user-facing lists: not on hold, not completed, and has open work when tasks exist. */
    public static function isActiveForUserEntry(?Project $project): bool
    {
        if (! $project || $project->status === 'on_hold' || $project->status === 'completed') {
            return false;
        }

        $totalTasks = (int) ($project->tasks_count ?? 0);
        $openTasks = (int) ($project->open_tasks_count ?? 0);

        if ($totalTasks > 0 && $openTasks === 0) {
            return false;
        }

        return true;
    }
}
