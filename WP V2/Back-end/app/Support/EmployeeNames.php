<?php

namespace App\Support;

use App\Models\Employee;
use App\Models\ProjectTask;
use Illuminate\Support\Collection;

class EmployeeNames
{
    /** @var Collection<int, Employee>|null */
    private static ?Collection $employeeCache = null;

    /** @var array<string, string|null> */
    private static array $canonicalizeCache = [];

    /** @var array<string, list<Employee>> */
    private static array $employeesByNormalizedKey = [];

    /**
     * Preload employees for repeated name resolution during algorithm runs.
     *
     * @param  iterable<Employee>|Collection<int, Employee>|null  $employees
     */
    public static function warmEmployeeCache(iterable|Collection|null $employees = null): void
    {
        self::$canonicalizeCache = [];
        self::$employeesByNormalizedKey = [];

        if ($employees instanceof Collection) {
            self::$employeeCache = $employees->values();
        } elseif ($employees !== null) {
            self::$employeeCache = collect($employees)->values();
        } else {
            self::$employeeCache = Employee::query()->orderBy('id')->get();
        }

        foreach (self::$employeeCache as $employee) {
            foreach (self::nameKeysForEmployee($employee) as $key) {
                if ($key === '') {
                    continue;
                }
                self::$employeesByNormalizedKey[$key][] = $employee;
            }
        }
    }

    public static function clearEmployeeCache(): void
    {
        self::$employeeCache = null;
        self::$canonicalizeCache = [];
        self::$employeesByNormalizedKey = [];
    }
    /** @var list<string> */
    public const ASSIGNEE_FIELDS = [
        'algorithm_1',
        'algorithm_2',
        'algorithm_3',
        'override_1',
        'override_2',
        'override_3',
    ];

    /** @var list<string> */
    public const TASK_PERSON_FIELDS = [
        ...self::ASSIGNEE_FIELDS,
        'owner',
        'dl_owner',
    ];

    /**
     * Canonical operative allocation display name => known aliases.
     *
     * @return array<string, list<string>>
     */
    public static function aliasMap(): array
    {
        return [
            'Rauno R' => ['Rauno'],
            'Todor Tanev' => ['Todor T'],
            'Shaimaa Mohamed' => ['Shaimaa M'],
            'Nora Keshk' => ['Nora'],
            'Gabriel Giurca' => ['Gabriel G'],
            'Manu Vijay' => ['Manu V'],
            'Khaled Maged' => ['Khaled M'],
            'Faouad Diaa' => ['Fouad D', 'B-team (KM1)', 'b-team (km1)', 'B-team KM'],
            'Valeriya Dramalieva' => ['Valeria D', 'B-team (KM2)', 'b-team (km2)'],
            'Veselina Milanova' => ['Veselina M', 'B-team (KM3)', 'b-team (km3)'],
            'Amro Mahmoud' => ['Amro H'],
            'Mina Tawfik' => ['Mina T', 'B-team (AH1)', 'B-Team (AH1)', 'b-team (ah1)', 'B-team AH'],
            'Rehaf Hamed' => ['Rehaf H', 'B-team (AH2)', 'B-Team (AH2)', 'b-team (ah2)'],
            'Nour El Khatib' => ['Nour', 'B-team (AH3)', 'B-Team (AH3)', 'b-team (ah3)'],
            'Stanley Prospere' => ['Stanley P'],
            'Mayar Nashaat' => ['Mayar N'],
            'Maya Wacily' => ['Maya'],
            'Amal Nagi' => ['Amal'],
            'Nataliia Markitan' => ['Nataliia'],
            'Angela L' => ['Angela'],
            'Alexander Suvoroff' => ['Alexander S'],
            'Abdelrahman Hakiem' => ['Abdelrahman Abdelhakiem', 'Abdelrahman A'],
            'Abdelsattar Alfarra' => ['Abdelsattar'],
            'Mohamed Khaled' => ['Mohamed'],
            'Kostadin Radulov' => ['Kostadin'],
            'Mina Tarek' => [],
            'Mostafa' => [],
            'Habiba A' => ['Habiba'],
            'Dalia Shalaan' => ['Dalia'],
            'Aycel' => [],
            'Emma F' => ['Emma'],
        ];
    }

    public static function displayName(Employee|string|null $first, ?string $last = null): string
    {
        if ($first instanceof Employee) {
            return self::displayName($first->first_name, $first->last_name);
        }

        $first = trim((string) ($first ?? ''));
        $last = trim((string) ($last ?? ''));

        if ($first === '' && $last === '') {
            return '';
        }

        return $last === '' ? $first : "{$first} {$last}";
    }

    public static function findByAnyName(?string $value): ?Employee
    {
        $needle = self::normalizeKey($value);
        if ($needle === '') {
            return null;
        }

        if (isset(self::$employeesByNormalizedKey[$needle])) {
            return self::pickBestEmployeeMatch($needle, self::$employeesByNormalizedKey[$needle]);
        }

        $employees = self::$employeeCache ?? Employee::query()->orderBy('id')->get();
        $aliasMatches = [];

        foreach ($employees as $employee) {
            if (! in_array($needle, self::nameKeysForEmployee($employee), true)) {
                continue;
            }

            $display = self::displayName($employee);
            if (self::isBTeamSlotName($display)
                && (self::normalizeKey($display) === $needle
                    || self::normalizeKey($employee->first_name) === $needle)) {
                return $employee;
            }

            if (self::normalizeKey($display) === $needle) {
                return $employee;
            }

            $aliasMatches[] = $employee;
        }

        return $aliasMatches[0] ?? null;
    }

    /**
     * @param  list<Employee>  $matches
     */
    private static function pickBestEmployeeMatch(string $needle, array $matches): ?Employee
    {
        if ($matches === []) {
            return null;
        }

        $aliasMatches = [];

        foreach ($matches as $employee) {
            $display = self::displayName($employee);
            if (self::isBTeamSlotName($display)
                && (self::normalizeKey($display) === $needle
                    || self::normalizeKey($employee->first_name) === $needle)) {
                return $employee;
            }

            if (self::normalizeKey($display) === $needle) {
                return $employee;
            }

            $aliasMatches[] = $employee;
        }

        return $aliasMatches[0] ?? null;
    }

    public static function canonicalize(?string $value): ?string
    {
        $trimmed = trim((string) ($value ?? ''));
        if ($trimmed === '') {
            return null;
        }

        $cacheKey = self::normalizeKey($trimmed);
        if (array_key_exists($cacheKey, self::$canonicalizeCache)) {
            return self::$canonicalizeCache[$cacheKey];
        }

        if (self::isBTeamSlotName($trimmed)) {
            $employee = self::findByAnyName($trimmed);
            if ($employee && self::isBTeamSlotName(self::displayName($employee))) {
                $result = self::displayName($employee);
                self::$canonicalizeCache[$cacheKey] = $result;

                return $result;
            }

            self::$canonicalizeCache[$cacheKey] = $trimmed;

            return $trimmed;
        }

        $employee = self::findByAnyName($trimmed);
        if (! $employee) {
            self::$canonicalizeCache[$cacheKey] = $trimmed;

            return $trimmed;
        }

        $display = self::displayName($employee);
        $result = $display !== '' ? $display : $trimmed;
        self::$canonicalizeCache[$cacheKey] = $result;

        return $result;
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    public static function normalizeTaskPayload(array &$payload): void
    {
        foreach (self::TASK_PERSON_FIELDS as $field) {
            if (! array_key_exists($field, $payload)) {
                continue;
            }

            $payload[$field] = self::canonicalize($payload[$field]);
        }
    }

    public static function renameInTasks(string $fromName, string $toName): void
    {
        $from = trim($fromName);
        $to = trim($toName);

        if ($from === '' || $to === '' || self::normalizeKey($from) === self::normalizeKey($to)) {
            return;
        }

        $aliases = self::aliasesForName($from);

        ProjectTask::query()->chunkById(200, function ($tasks) use ($aliases, $to) {
            foreach ($tasks as $task) {
                $updates = [];

                foreach (self::TASK_PERSON_FIELDS as $field) {
                    $current = trim((string) ($task->{$field} ?? ''));
                    if ($current === '') {
                        continue;
                    }

                    if (in_array(self::normalizeKey($current), $aliases, true)) {
                        $updates[$field] = $to;
                    }
                }

                if ($updates !== []) {
                    $task->update($updates);
                }
            }
        });
    }

    public static function syncAllTaskAssignees(): int
    {
        $updated = 0;

        ProjectTask::query()->chunkById(200, function ($tasks) use (&$updated) {
            foreach ($tasks as $task) {
                $updates = [];

                foreach (self::TASK_PERSON_FIELDS as $field) {
                    $current = $task->{$field};
                    if ($current === null || trim((string) $current) === '') {
                        continue;
                    }

                    $canonical = self::canonicalize($current);
                    if ($canonical !== null && $canonical !== $current) {
                        $updates[$field] = $canonical;
                    }
                }

                if ($updates !== []) {
                    $task->update($updates);
                    $updated++;
                }
            }
        });

        return $updated;
    }

    /**
     * @return list<string>
     */
    public static function nameKeysForEmployee(Employee $employee): array
    {
        $canonical = self::displayName($employee);
        $keys = [
            self::normalizeKey($canonical),
            self::normalizeKey($employee->first_name),
            self::normalizeKey($employee->last_name),
        ];

        foreach (self::aliasMap()[$canonical] ?? [] as $alias) {
            $keys[] = self::normalizeKey($alias);
        }

        return array_values(array_unique(array_filter($keys)));
    }

    /**
     * @return list<string>
     */
    private static function aliasesForName(string $name): array
    {
        $aliases = [self::normalizeKey($name)];
        $employee = self::findByAnyName($name);

        if ($employee) {
            $aliases = array_merge($aliases, self::nameKeysForEmployee($employee));
        }

        return array_values(array_unique(array_filter($aliases)));
    }

    private static function normalizeKey(?string $value): string
    {
        return mb_strtolower(trim((string) ($value ?? '')));
    }

    public static function isBTeamSlotName(?string $value): bool
    {
        return (bool) preg_match('/^b[-\s]?team\s*\(/i', trim((string) ($value ?? '')));
    }

    public static function namesMatch(?string $left, ?string $right): bool
    {
        $left = trim((string) ($left ?? ''));
        $right = trim((string) ($right ?? ''));

        if ($left === '' || $right === '') {
            return false;
        }

        if (self::normalizeKey($left) === self::normalizeKey($right)) {
            return true;
        }

        $leftCanon = self::canonicalize($left) ?? $left;
        $rightCanon = self::canonicalize($right) ?? $right;

        return self::normalizeKey($leftCanon) === self::normalizeKey($rightCanon);
    }

    /**
     * @param  ProjectTask|array<string, mixed>  $task
     */
    public static function findAssigneeOverrideSlotForName(ProjectTask|array $task, string $assigneeName): string
    {
        $assigneeName = trim($assigneeName);
        if ($assigneeName === '') {
            return 'override_1';
        }

        $read = static function (string $field) use ($task): string {
            if (is_array($task)) {
                return trim((string) ($task[$field] ?? ''));
            }

            return trim((string) ($task->{$field} ?? ''));
        };

        // Primary rule: Algorithm N → Override N.
        foreach ([1, 2, 3] as $slot) {
            $algorithm = $read("algorithm_{$slot}");
            if ($algorithm !== '' && self::namesMatch($algorithm, $assigneeName)) {
                return "override_{$slot}";
            }
        }

        foreach ([1, 2, 3] as $slot) {
            $override = $read("override_{$slot}");
            if ($override !== '' && self::namesMatch($override, $assigneeName)) {
                return "override_{$slot}";
            }
        }

        return 'override_1';
    }

    public static function applyHistogramReassignOverride(
        ProjectTask $task,
        string $previousEmployee,
        string $nextEmployee,
    ): bool {
        $previousEmployee = trim($previousEmployee);
        $nextEmployee = trim($nextEmployee);

        if ($previousEmployee === '' || $nextEmployee === '' || self::namesMatch($previousEmployee, $nextEmployee)) {
            return false;
        }

        $slot = self::findAssigneeOverrideSlotForName($task, $previousEmployee);
        $stored = self::isBTeamSlotName($nextEmployee)
            ? $nextEmployee
            : (self::canonicalize($nextEmployee) ?? $nextEmployee);

        $task->update([$slot => $stored]);

        return true;
    }
}
