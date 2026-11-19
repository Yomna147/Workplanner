<?php

namespace App\Console\Commands;

use App\Models\Project;
use App\Support\ProjectStatusSync;
use Illuminate\Console\Command;

class SyncProjectStatuses extends Command
{
    protected $signature = 'projects:sync-status';

    protected $description = 'Sync project completed/active status from task done flags';

    public function handle(): int
    {
        $count = 0;

        Project::query()->each(function (Project $project) use (&$count) {
            $before = $project->status;
            ProjectStatusSync::syncFromTasks($project);
            $project->refresh();

            if ($project->status !== $before) {
                $count++;
            }
        });

        $this->info("Synced {$count} project status(es) from task data.");

        return self::SUCCESS;
    }
}
