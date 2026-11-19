<?php

namespace App\Console\Commands;

use App\Support\EmployeeNames;
use Illuminate\Console\Command;

class NormalizeEmployeeNamesCommand extends Command
{
    protected $signature = 'employees:normalize-names';

    protected $description = 'Normalize project task employee fields to operative allocation display names';

    public function handle(): int
    {
        $updated = EmployeeNames::syncAllTaskAssignees();
        $this->info("Updated assignee names on {$updated} task(s).");

        return self::SUCCESS;
    }
}
