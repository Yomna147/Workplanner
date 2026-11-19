<?php

namespace Database\Seeders;

use App\Models\Employee;
use App\Models\EmployeeTraining;
use App\Models\Team;
use App\Models\TrainingCourse;
use App\Support\EmployeeNames;
use App\Support\TrainingSampleGapPlanner;
use Carbon\Carbon;
use Illuminate\Database\Seeder;

class SampleTrainingsSeeder extends Seeder
{
    private const SAMPLE_PREFIX = '[Sample] ';

    private function isNrmSectionTeamName(?string $name): bool
    {
        return (bool) preg_match('/nrm\s*\d/i', trim((string) $name));
    }

    private function isNrmSectionOperative(Employee $employee): bool
    {
        $teamName = $employee->relationLoaded('team')
            ? ($employee->team?->name ?? '')
            : (string) (Team::query()->whereKey($employee->team_id)->value('name') ?? '');

        return $this->isNrmSectionTeamName($teamName);
    }

    public function run(): void
    {
        EmployeeTraining::query()
            ->where('title', 'like', self::SAMPLE_PREFIX.'%')
            ->delete();

        EmployeeNames::warmEmployeeCache();

        $employees = Employee::query()
            ->with('team')
            ->orderBy('id')
            ->get();

        $nrmOperatives = $employees
            ->filter(fn (Employee $employee) => $this->isNrmSectionOperative($employee))
            ->values();

        if ($nrmOperatives->isEmpty()) {
            $this->command?->warn('No NRM section operatives found — skipped sample trainings.');

            return;
        }

        $resolve = function (string $needle, int $fallbackIndex = 0) use ($nrmOperatives): ?Employee {
            $match = EmployeeNames::findByAnyName($needle);
            if ($match) {
                $match->loadMissing('team');
                if ($this->isNrmSectionOperative($match)) {
                    return $match;
                }
            }

            return $nrmOperatives->get($fallbackIndex % max(1, $nrmOperatives->count()));
        };

        $today = Carbon::today();
        $planner = new TrainingSampleGapPlanner();
        $planner->warm(
            $today->copy()->subDays(120),
            $today->copy()->addDays(120),
        );

        $sessions = [
            [
                'title' => 'BIM Level 2 Fundamentals',
                'course_link' => 'https://learn.example.com/bim-level-2',
                'description' => 'Group session covering BIM execution plans and common data environments.',
                'duration' => 'Multi-day',
                'status' => 'scheduled',
                'priority' => 'P1',
                'urgency' => 'U2',
                'weekday_span' => 3,
                'hours_per_day' => 5.33,
                'employees' => ['Mohamed Khaled', 'Kostadin Radulov', 'Mina Tarek'],
                'search' => ['from' => 7, 'to' => 45, 'backward' => false],
            ],
            [
                'title' => 'Health & Safety Refresher',
                'course_link' => 'https://learn.example.com/hs-refresher',
                'description' => 'Annual site safety and hazard awareness refresher.',
                'duration' => '1-2 hours',
                'status' => 'completed',
                'priority' => 'P2',
                'urgency' => 'U1',
                'weekday_span' => 1,
                'hours_per_day' => 2,
                'employees' => ['Abdelsattar Alfarra'],
                'search' => ['from' => -75, 'to' => -14, 'backward' => true],
            ],
            [
                'title' => 'Revit Structure Advanced',
                'course_link' => 'https://learn.example.com/revit-structure',
                'description' => 'Advanced modelling workflows for structural deliverables.',
                'duration' => 'Full day',
                'status' => 'in_progress',
                'priority' => 'P1',
                'urgency' => 'U1',
                'weekday_span' => 3,
                'hours_per_day' => 2.67,
                'employees' => ['Todor Tanev'],
                'search' => ['from' => -45, 'to' => 45, 'backward' => false, 'near_today' => true],
            ],
            [
                'title' => 'ISO 19650 Information Management',
                'course_link' => 'https://learn.example.com/iso-19650',
                'description' => 'Half-day overview of information requirements and exchange.',
                'duration' => 'Half day',
                'status' => 'not_started',
                'priority' => 'P2',
                'urgency' => 'U2',
                'weekday_span' => 1,
                'hours_per_day' => 4,
                'employees' => ['Faouad Diaa', 'Khaled Maged'],
                'search' => ['from' => 10, 'to' => 60, 'backward' => false],
            ],
            [
                'title' => 'Excel Power Query for QS',
                'course_link' => null,
                'description' => 'Short skills booster for quantity surveying spreadsheets.',
                'duration' => '2-4 hours',
                'status' => 'scheduled',
                'priority' => 'P2',
                'urgency' => 'U1',
                'weekday_span' => 1,
                'hours_per_day' => 4,
                'employees' => ['Nora Keshk'],
                'search' => ['from' => 1, 'to' => 21, 'backward' => false],
            ],
            [
                'title' => 'Leadership Skills Workshop',
                'course_link' => 'https://learn.example.com/leadership',
                'description' => 'Three-day workshop for senior NRM section operatives.',
                'duration' => 'Multi-day',
                'status' => 'scheduled',
                'priority' => 'P1',
                'urgency' => 'U2',
                'weekday_span' => 3,
                'hours_per_day' => 5.33,
                'employees' => [
                    'Amro Mahmoud',
                    'Rehaf Hamed',
                    'Valeriya Dramalieva',
                    'Mina Tawfik',
                    'Stanley Prospere',
                    'Nour El Khatib',
                    'Veselina Milanova',
                    'Gabriel Giurca',
                    'Shaimaa Mohamed',
                ],
                'search' => ['from' => 21, 'to' => 90, 'backward' => false],
            ],
            [
                'title' => 'AutoCAD Standards Update',
                'course_link' => 'https://learn.example.com/autocad-standards',
                'description' => 'Completed update on drawing standards and layer conventions.',
                'duration' => 'Full day',
                'status' => 'completed',
                'priority' => 'P2',
                'urgency' => 'U1',
                'weekday_span' => 1,
                'hours_per_day' => 8,
                'employees' => ['Gabriel Giurca'],
                'search' => ['from' => -120, 'to' => -30, 'backward' => true],
            ],
            [
                'title' => 'Mental Health First Aid',
                'course_link' => 'https://learn.example.com/mhfa',
                'description' => 'Half-day awareness training for workplace wellbeing.',
                'duration' => 'Half day',
                'status' => 'not_started',
                'priority' => 'P1',
                'urgency' => 'U1',
                'weekday_span' => 1,
                'hours_per_day' => 4,
                'employees' => ['Shaimaa Mohamed'],
                'search' => ['from' => 14, 'to' => 75, 'backward' => false],
            ],
            [
                'title' => 'Navisworks Clash Detection',
                'course_link' => 'https://learn.example.com/navisworks-clash',
                'description' => 'Short practical session on clash review and reporting.',
                'duration' => '2-4 hours',
                'status' => 'scheduled',
                'priority' => 'P1',
                'urgency' => 'U2',
                'weekday_span' => 1,
                'hours_per_day' => 4,
                'employees' => ['Khaled Maged'],
                'search' => ['from' => 1, 'to' => 14, 'backward' => false],
            ],
            [
                'title' => 'Company Onboarding – TSA Tools',
                'course_link' => 'https://intranet.example.com/onboarding',
                'description' => 'Multi-day onboarding for NRM section operatives on internal tools.',
                'duration' => 'Multi-day',
                'status' => 'in_progress',
                'priority' => 'P2',
                'urgency' => 'U1',
                'weekday_span' => 3,
                'hours_per_day' => 5.33,
                'employees' => ['Mostafa', 'Habiba A'],
                'search' => ['from' => -3, 'to' => 10, 'backward' => false, 'include_today' => true],
            ],
        ];

        $created = 0;
        $skipped = 0;

        foreach ($sessions as $index => $session) {
            $resolvedEmployees = [];
            $displayNames = [];

            foreach ($session['employees'] as $employeeIndex => $employeeName) {
                $employee = $resolve($employeeName, $index + $employeeIndex);
                if (! $employee) {
                    continue;
                }
                $resolvedEmployees[] = $employee;
                $displayNames[] = EmployeeNames::displayName($employee);
            }

            $resolvedEmployees = collect($resolvedEmployees)
                ->unique(fn (Employee $employee) => $employee->id)
                ->values()
                ->all();
            $displayNames = array_values(array_unique($displayNames));

            if ($resolvedEmployees === []) {
                $skipped += 1;
                $this->command?->warn(
                    'Skipped sample session "'.$session['title'].'" — no NRM section operatives resolved.',
                );

                continue;
            }

            $search = $session['search'];
            $searchStart = $today->copy()->addDays((int) $search['from']);
            $searchEnd = $today->copy()->addDays((int) $search['to']);

            if (! empty($search['near_today'])) {
                $window = $planner->findNearestSharedGapWindow(
                    $displayNames,
                    (int) $session['weekday_span'],
                    $searchStart,
                    $searchEnd,
                    $today,
                );
            } else {
                $mustIncludeDay = ! empty($search['include_today']) && ! $today->isWeekend()
                    ? $today->toDateString()
                    : null;

                $window = $planner->findSharedGapWindow(
                    $displayNames,
                    (int) $session['weekday_span'],
                    $searchStart,
                    $searchEnd,
                    (bool) ($search['backward'] ?? false),
                    $mustIncludeDay,
                );
            }

            if ($window === null) {
                $skipped += count($resolvedEmployees);
                $this->command?->warn(
                    'Skipped sample session "'
                    .$session['title']
                    .'" — no shared free weekdays found for assigned operatives.',
                );

                continue;
            }

            foreach ($resolvedEmployees as $employee) {
                $startDate = Carbon::parse($window['start_date']);
                $endDate = Carbon::parse($window['end_date']);
                $status = $session['status'];

                if ($endDate->lt($today)) {
                    $status = 'completed';
                } elseif ($startDate->gt($today)) {
                    $status = in_array($status, ['not_started', 'scheduled'], true) ? $status : 'scheduled';
                } elseif ($status === 'not_started') {
                    $status = 'scheduled';
                } elseif (! in_array($status, ['in_progress', 'almost_complete', 'scheduled', 'completed'], true)) {
                    $status = 'in_progress';
                }

                EmployeeTraining::create([
                    'employee_id' => $employee->id,
                    'training_course_id' => TrainingCourse::query()->where('title', $session['title'])->value('id'),
                    'title' => self::SAMPLE_PREFIX.$session['title'],
                    'course_link' => $session['course_link'],
                    'description' => $session['description'],
                    'duration' => $session['duration'],
                    'status' => $status,
                    'priority' => $session['priority'],
                    'urgency' => $session['urgency'],
                    'confirm_override' => false,
                    'start_date' => $window['start_date'],
                    'end_date' => $window['end_date'],
                    'hours_per_day' => $session['hours_per_day'],
                    'notes' => 'Seeded sample training aligned to operative free capacity.',
                ]);

                $created++;
            }

            $this->command?->line(
                sprintf(
                    '  %s → %s to %s (%d operatives)',
                    $session['title'],
                    $window['start_date'],
                    $window['end_date'],
                    count($resolvedEmployees),
                ),
            );
        }

        EmployeeNames::clearEmployeeCache();

        $this->command?->info(
            "Created {$created} sample training assignments across "
            .count($sessions)
            .' sessions'
            .($skipped > 0 ? " ({$skipped} skipped — no free-time window)." : '.'),
        );
    }
}
