<?php

namespace Database\Seeders;

use App\Models\Employee;
use App\Models\EmployeeAvailability;
use App\Models\Part;
use App\Models\Project;
use App\Models\ProjectTask;
use App\Models\Team;
use Carbon\Carbon;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class AlgorithmTestProjectsSeeder extends Seeder
{
    /** @var array<int, string> */
    private array $colors = [
        '#2563EB',
        '#059669',
        '#D97706',
        '#7C3AED',
        '#DC2626',
    ];

    public function run(): void
    {
        $today = Carbon::today();

        $definitions = [
            [
                'name' => 'Algo Test: Riverside Substructure',
                'team' => 'NRM1 substructure',
                'pp' => '0.10',
                'description' => 'NRM 1.1 tasks for substructure operative allocation tests.',
                'tasks' => [
                    ['task_name' => '1.1 Substructure – foundations A', 'nrm_pri' => '0.11', 'est' => 24, 'start' => 0, 'span' => 8, 'override_1' => 'Mohamed Khaled'],
                    ['task_name' => '1.1 Substructure – foundations B', 'nrm_pri' => '0.11', 'est' => 32, 'start' => 3, 'span' => 10],
                    ['task_name' => '1.1 Substructure – ground beams', 'nrm_pri' => '0.11', 'est' => 40, 'start' => 7, 'span' => 12],
                    ['task_name' => '1.1 Substructure – pile caps', 'nrm_pri' => '0.11', 'est' => 28, 'start' => 12, 'span' => 9, 'override_1' => 'Kostadin Radulov'],
                ],
            ],
            [
                'name' => 'Algo Test: Tower Superstructure',
                'team' => 'NRM2 superstructure',
                'pp' => '0.15',
                'description' => 'NRM 2.x frame and envelope tasks with overlapping windows.',
                'tasks' => [
                    ['task_name' => '2.1 Frame – core walls', 'nrm_pri' => '0.65', 'est' => 48, 'start' => 0, 'span' => 14],
                    ['task_name' => '2.2 Upper floors – level 3', 'nrm_pri' => '0.66', 'est' => 36, 'start' => 5, 'span' => 12],
                    ['task_name' => '2.5 External walls – east elevation', 'nrm_pri' => '0.64', 'est' => 56, 'start' => 8, 'span' => 16, 'override_1' => 'Mina Tarek'],
                    ['task_name' => '2.6 Windows – typical floors', 'nrm_pri' => '0.61', 'est' => 40, 'start' => 14, 'span' => 12],
                    ['task_name' => '2.8 Internal doors – level 2', 'nrm_pri' => '0.62', 'est' => 24, 'start' => 18, 'span' => 8],
                ],
            ],
            [
                'name' => 'Algo Test: Interior Finishes',
                'team' => 'NRM3&4 finishes, FFE',
                'pp' => '0.08',
                'description' => 'NRM 3.x finish packages for multi-operative split tests.',
                'tasks' => [
                    ['task_name' => '3.1 Wall finishes – lobby', 'nrm_pri' => '0.42', 'est' => 32, 'start' => 2, 'span' => 10],
                    ['task_name' => '3.2 Floor finishes – apartments', 'nrm_pri' => '0.45', 'est' => 48, 'start' => 6, 'span' => 14, 'override_1' => 'Khaled Maged'],
                    ['task_name' => '3.3 Ceiling finishes – corridors', 'nrm_pri' => '0.46', 'est' => 28, 'start' => 10, 'span' => 9],
                    ['task_name' => '4.1 Fittings – kitchen packs', 'nrm_pri' => '0.43', 'est' => 20, 'start' => 15, 'span' => 7],
                    ['task_name' => '5.1 Sanitaryware – bathrooms', 'nrm_pri' => '0.44', 'est' => 24, 'start' => 18, 'span' => 8],
                ],
            ],
            [
                'name' => 'Algo Test: External Works',
                'team' => 'NRM8 Externals, drainage',
                'pp' => '0.05',
                'description' => 'NRM 8.x externals and drainage with staggered completion dates.',
                'tasks' => [
                    ['task_name' => '8.1 Site preparation – levels', 'nrm_pri' => '0.23', 'est' => 32, 'start' => 0, 'span' => 10],
                    ['task_name' => '8.2 Hard surfaces – car park', 'nrm_pri' => '0.24', 'est' => 40, 'start' => 8, 'span' => 12, 'override_1' => 'Amro Mahmoud'],
                    ['task_name' => '8.6 External drainage – main runs', 'nrm_pri' => '0.21', 'est' => 36, 'start' => 12, 'span' => 11],
                    ['task_name' => '8.8 Minor buildings – gatehouse', 'nrm_pri' => '0.28', 'est' => 28, 'start' => 20, 'span' => 9],
                ],
            ],
            [
                'name' => 'Algo Test: Mixed Priority Bundle',
                'team' => 'NRM2 superstructure',
                'pp' => '0.20',
                'description' => 'Cross-NRM bundle with overrides and competing priorities.',
                'tasks' => [
                    ['task_name' => '1.1 Substructure – transfer slab', 'nrm_pri' => '0.11', 'est' => 16, 'start' => 0, 'span' => 6],
                    ['task_name' => '2.1 Frame – steel erection', 'nrm_pri' => '0.65', 'est' => 64, 'start' => 4, 'span' => 18, 'override_1' => 'Todor Tanev'],
                    ['task_name' => '2.4 Stairs and ramps', 'nrm_pri' => '0.68', 'est' => 32, 'start' => 10, 'span' => 10],
                    ['task_name' => '3.2 Floor finishes – plant room', 'nrm_pri' => '0.45', 'est' => 20, 'start' => 16, 'span' => 7],
                    ['task_name' => '7.0 Alterations – existing link', 'nrm_pri' => '0.41', 'est' => 24, 'start' => 20, 'span' => 8, 'override_2' => 'Nora Keshk'],
                    ['task_name' => '8.5 Site furniture – seating', 'nrm_pri' => '0.27', 'est' => 12, 'start' => 24, 'span' => 5],
                ],
            ],
        ];

        DB::transaction(function () use ($definitions, $today) {
            foreach ($definitions as $index => $definition) {
                $this->seedProject($definition, $this->colors[$index] ?? '#3B82F6', $today);
            }

            $this->seedWeekdayAvailability($today, 120);
        });

        $this->backfillSampleProjectTaskPriorities();

        $this->command?->info('Seeded 5 algorithm test projects with tasks and weekday availability.');
    }

    private function backfillSampleProjectTaskPriorities(): void
    {
        $samples = [
            'Sample Project A' => [
                'Site setup' => ['rap' => '0.05', 'pp' => '0.12'],
            ],
            'Sample Project B' => [
                'Steel frame' => ['rap' => '0.08', 'pp' => '0.06'],
            ],
        ];

        foreach ($samples as $projectName => $tasks) {
            $project = Project::where('name', $projectName)->first();
            if (! $project) {
                continue;
            }

            $partIds = Part::where('project_id', $project->id)->pluck('id');

            foreach ($tasks as $taskName => $priority) {
                $task = ProjectTask::query()
                    ->whereIn('part_id', $partIds)
                    ->where('task_name', $taskName)
                    ->first();

                if (! $task) {
                    continue;
                }

                $rap = $priority['rap'];
                $pp = $priority['pp'];

                $task->update([
                    'rap' => $rap,
                    'pp' => $pp,
                    'pri' => $this->taskPriFromRapPp($rap, $pp),
                ]);
            }
        }
    }

    /** @param array<string, mixed> $definition */
    private function seedProject(array $definition, string $color, Carbon $today): void
    {
        $team = Team::where('name', $definition['team'])->first();

        $project = Project::updateOrCreate(
            ['name' => $definition['name']],
            [
                'color' => $color,
                'status' => 'active',
                'description' => $definition['description'] ?? null,
                'team_id' => $team?->id,
            ],
        );

        $part = Part::firstOrCreate(
            ['project_id' => $project->id, 'name' => 'Main'],
            ['project_id' => $project->id, 'name' => 'Main'],
        );

        foreach ($definition['tasks'] as $taskDef) {
            $docSupply = $this->nextWeekday($today, (int) $taskDef['start']);
            $completion = $this->nextWeekday($docSupply, max(1, (int) $taskDef['span'] - 1));
            $est = (string) $taskDef['est'];
            $plan = (string) $taskDef['est'];
            $pp = (string) ($definition['pp'] ?? '0.10');
            $rap = (string) $taskDef['nrm_pri'];
            $pri = $this->taskPriFromRapPp($rap, $pp);

            $priorityFields = [
                'rap' => $rap,
                'pp' => $pp,
                'pri' => $pri,
            ];

            $existingTask = ProjectTask::query()
                ->where('part_id', $part->id)
                ->where('task_name', $taskDef['task_name'])
                ->first();

            if ($existingTask) {
                if (! $existingTask->rap || ! $existingTask->pp) {
                    $existingTask->update($priorityFields);
                }
                continue;
            }

            ProjectTask::create([
                'part_id' => $part->id,
                'task_name' => $taskDef['task_name'],
                'est' => $est,
                'plan' => $plan,
                ...$priorityFields,
                'doc_supply' => $docSupply->toDateString(),
                'completion' => $completion->toDateString(),
                'dd' => '0',
                'buf' => '0',
                'adj' => '0',
                'sh' => '8',
                'al' => '1',
                'done' => false,
                'override_1' => $taskDef['override_1'] ?? null,
                'override_2' => $taskDef['override_2'] ?? null,
                'override_3' => $taskDef['override_3'] ?? null,
            ]);
        }
    }

    private function taskPriFromRapPp(string $rap, string $pp): string
    {
        return (string) ((float) $rap + (float) $pp);
    }

    private function nextWeekday(Carbon $anchor, int $offsetDays): Carbon
    {
        $date = $anchor->copy();
        $remaining = max(0, $offsetDays);

        while ($remaining > 0) {
            $date->addDay();
            if (! $date->isWeekend()) {
                $remaining -= 1;
            }
        }

        while ($date->isWeekend()) {
            $date->addDay();
        }

        return $date;
    }

    private function seedWeekdayAvailability(Carbon $start, int $weekdayCount): void
    {
        $employeeIds = Employee::query()->pluck('id');
        if ($employeeIds->isEmpty()) {
            return;
        }

        $dates = [];
        $cursor = $start->copy();
        while (count($dates) < $weekdayCount) {
            if (! $cursor->isWeekend()) {
                $dates[] = $cursor->toDateString();
            }
            $cursor->addDay();
        }

        foreach ($employeeIds as $employeeId) {
            foreach ($dates as $date) {
                EmployeeAvailability::updateOrCreate(
                    [
                        'employee_id' => $employeeId,
                        'date' => $date,
                    ],
                    [
                        'strt1' => '08:00',
                        'end1' => '16:00',
                        'total' => '08:00',
                        'total_ava' => '08:00',
                    ],
                );
            }
        }
    }
}
