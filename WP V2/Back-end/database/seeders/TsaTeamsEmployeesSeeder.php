<?php

namespace Database\Seeders;

use App\Models\Employee;
use App\Models\Team;
use App\Support\EmployeeNames;
use Illuminate\Database\Seeder;

class TsaTeamsEmployeesSeeder extends Seeder
{
    /**
     * TSA availability plan roster (canonical display names).
     *
     * @var array<string, list<string>>
     */
    private array $roster = [
        'NRM1 substructure' => [
            'Kostadin Radulov',
            'Abdelsattar Alfarra',
            'Mohamed Khaled',
        ],
        'NRM2 superstructure' => [
            'Mina Tarek',
            'Todor Tanev',
            'Shaimaa Mohamed',
            'Mostafa',
            'Nora Keshk',
            'Gabriel Giurca',
            'Manu Vijay',
            'Habiba A',
        ],
        'NRM3&4 finishes, FFE' => [
            'Khaled Maged',
            'Faouad Diaa',
            'Valeriya Dramalieva',
            'Veselina Milanova',
        ],
        'NRM8 Externals, drainage' => [
            'Amro Mahmoud',
            'Mina Tawfik',
            'Rehaf Hamed',
            'Nour El Khatib',
            'Stanley Prospere',
        ],
        'Q&A team' => [
            'Mayar Nashaat',
            'Maya Wacily',
            'Amal Nagi',
            'Dalia Shalaan',
        ],
        'Support (all sections)' => [
            'Alexander Suvoroff',
            'Nataliia Markitan',
        ],
        'Administration' => [
            'Angela L',
            'Rauno R',
            'Aycel',
            'Emma F',
        ],
    ];

    public function run(): void
    {
        Team::where('name', 'Sales and Admin')->update(['name' => 'Administration']);

        $usedEmployeeIds = [];

        foreach ($this->roster as $teamName => $members) {
            $team = Team::firstOrCreate(['name' => $teamName]);

            foreach ($members as $position => $fullName) {
                $fullName = trim($fullName);
                if ($fullName === '') {
                    continue;
                }

                [$firstName, $lastName] = $this->splitName($fullName);

                $employee = $this->findEmployeeByAliases($team->id, $fullName, $usedEmployeeIds);

                if ($employee) {
                    $usedEmployeeIds[] = $employee->id;
                    $previousName = EmployeeNames::displayName($employee);

                    $employee->update([
                        'first_name' => $firstName,
                        'last_name' => $lastName,
                        'team_id' => $team->id,
                        'position' => $position + 1,
                    ]);

                    $employee->refresh();
                    EmployeeNames::renameInTasks(
                        $previousName,
                        EmployeeNames::displayName($employee),
                    );

                    continue;
                }

                $created = Employee::create([
                    'first_name' => $firstName,
                    'last_name' => $lastName,
                    'team_id' => $team->id,
                    'position' => $position + 1,
                ]);

                $usedEmployeeIds[] = $created->id;
            }
        }

        $this->removeObsoleteEmployees();
    }

    private function removeObsoleteEmployees(): void
    {
        $obsoleteNames = [
            'Abdelrahman Hakiem',
            'Abdelrahman Shakra',
            'Ahmed Abdou',
            'Alex Operative',
            'Jordan Trainee',
        ];

        foreach ($obsoleteNames as $fullName) {
            [$first, $last] = $this->splitName($fullName);

            Employee::query()
                ->where('first_name', $first)
                ->when(
                    $last,
                    fn ($query) => $query->where('last_name', $last),
                    fn ($query) => $query->whereNull('last_name'),
                )
                ->delete();
        }

        Employee::query()
            ->where('first_name', 'Alex')
            ->where('last_name', 'Operative')
            ->delete();

        Employee::query()
            ->where('first_name', 'Jordan')
            ->where('last_name', 'Trainee')
            ->delete();

        Employee::query()
            ->where('first_name', 'Rauno')
            ->whereNull('last_name')
            ->delete();
    }

    /**
     * @param  list<int>  $excludeIds
     */
    private function findEmployeeByAliases(int $teamId, string $fullName, array $excludeIds = []): ?Employee
    {
        $aliases = $this->aliasesFor($fullName);

        foreach ($aliases as $alias) {
            [$first, $last] = $this->splitName($alias);

            $match = Employee::where('team_id', $teamId)
                ->whereNotIn('id', $excludeIds)
                ->where('first_name', $first)
                ->when(
                    $last,
                    fn ($query) => $query->where('last_name', $last),
                    fn ($query) => $query->whereNull('last_name'),
                )
                ->first();

            if ($match) {
                return $match;
            }

            $firstOnly = Employee::where('team_id', $teamId)
                ->whereNotIn('id', $excludeIds)
                ->where('first_name', $alias)
                ->first();

            if ($firstOnly) {
                return $firstOnly;
            }
        }

        $needle = mb_strtolower($fullName);

        return Employee::where('team_id', $teamId)
            ->whereNotIn('id', $excludeIds)
            ->get()
            ->first(function (Employee $employee) use ($needle) {
                $display = mb_strtolower(EmployeeNames::displayName($employee));

                return $display === $needle;
            });
    }

    /**
     * @return list<string>
     */
    private function aliasesFor(string $fullName): array
    {
        return array_values(array_unique([
            $fullName,
            ...(EmployeeNames::aliasMap()[$fullName] ?? []),
        ]));
    }

    /**
     * @return array{0: string, 1: ?string}
     */
    private function splitName(string $fullName): array
    {
        $parts = preg_split('/\s+/', trim($fullName), 2);

        return [
            $parts[0],
            $parts[1] ?? null,
        ];
    }
}
