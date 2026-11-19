<?php

namespace Database\Seeders;

use App\Models\Employee;
use App\Models\Nrm;
use App\Support\EmployeeNames;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class OapSeeder extends Seeder
{
    /**
     * Sheet labels that map to canonical operative allocation employees.
     *
     * @var array<string, string>
     */
    private array $sheetNameAliases = [
        'B-team (KM1)' => 'Faouad Diaa',
        'B-team (KM2)' => 'Valeriya Dramalieva',
        'B-team (KM3)' => 'Veselina Milanova',
        'B-Team (AH1)' => 'Mina Tawfik',
        'B-Team (AH2)' => 'Rehaf Hamed',
        'B-Team (AH3)' => 'Nour El Khatib',
        'Abdelrahman Hak...' => 'Abdelrahman Hakiem',
        'Abdelrahman Sha...' => 'Abdelrahman Shakra',
    ];

    /**
     * Operative allocation OAP values from the TSA roster sheet.
     * Processed in order; later rows for the same employee override earlier values.
     *
     * @var array<string, array<string, string>>
     */
    private array $rows = [
        'Kostadin Radulov' => ['1.1' => '1.0'],
        'Abdelsattar Alfarra' => ['1.1' => '2.0'],
        'Mohamed Khaled' => ['1.1' => '3.0'],

        'Mina Tarek' => ['2.1' => '2.0', '2.2' => '2.0', '2.3' => '1.0'],
        'Abdelrahman Hakiem' => ['2.1' => '1.0'],
        'Todor Tanev' => [
            '2.1' => '3.0', '2.2' => '3.0', '2.3' => '2.0', '2.5' => '5.0', '2.6' => '5.0',
            '2.8' => '6.0', '7.0' => '1.0', '8.8' => 'x',
        ],
        'Shaimaa Mohamed' => ['2.5' => '2.0', '2.6' => '4.0', '2.8' => '4.0'],
        'Mostafa' => [
            '2.1' => '4.0', '2.2' => '4.0', '2.3' => '3.0', '2.5' => '4.0',
            '2.6' => '3.0', '2.8' => '3.0', '7.0' => '2.0',
        ],
        'Nora Keshk' => ['2.5' => '3.0', '2.6' => '2.0', '2.8' => '2.0', '7.0' => '4.0'],
        'Abdelrahman Shakra' => ['2.5' => '1.0'],
        'Gabriel Giurca' => ['2.6' => '7.0', '2.7' => '2.0', '5.15' => '1.0'],
        'Manu Vijay' => ['2.8' => 'x'],
        'Habiba A' => ['2.8' => '1.0'],

        'B-team (KM1)' => [
            '2.4' => '3.0', '2.6' => 'Tr', '2.8' => 'Tr', '3.2' => '1.0', '3.3' => '1.0',
            '4.1' => '1.0', '5.1' => '1.0', '8.1' => '7.0', '8.2' => '7.0', '8.3' => '7.0',
            '8.4' => '7.0', '8.8' => '7.0',
        ],
        'B-team (KM2)' => [
            '2.4' => '1.0', '2.6' => 'Tr', '2.8' => 'Tr', '3.2' => '2.0', '3.3' => '2.0',
            '4.1' => '2.0', '5.1' => '2.0',
        ],
        'B-team (KM3)' => [
            '2.4' => '2.0', '2.6' => 'Tr', '2.7' => '5.0', '2.8' => 'Tr', '3.1' => '4.0',
            '3.2' => '3.0', '3.3' => '3.0', '4.1' => '3.0', '5.1' => '3.0',
        ],
        'Khaled Maged' => [
            '2.1' => 'ReTr', '2.4' => '4.0', '2.6' => '6.0', '2.7' => '4.0', '2.8' => '5.0',
            '3.1' => '5.0', '3.2' => '4.0', '3.3' => '4.0', '4.1' => '4.0', '5.1' => '4.0',
            '5.15' => '2.0', '8.1' => 'x', '8.2' => 'x', '8.3' => 'x', '8.4' => 'x', '8.8' => 'x',
        ],
        'Faouad Diaa' => ['3.1' => 'x', '3.2' => 'x', '3.3' => 'x'],
        'Veselina Milanova' => ['3.1' => '3.0', '3.2' => 'x', '3.3' => 'x'],
        'Ahmed Abdou' => ['3.1' => '1.0'],

        'Amro Mahmoud' => [
            '1.1' => '4.0', '7.0' => '4.0', '8.1' => '4.0', '8.2' => '4.0', '8.3' => '4.0',
            '8.4' => '4.0', '8.8' => '4.0',
        ],
        'B-Team (AH1)' => [
            '1.1' => '5.0', '5.1' => 'Tr', '5.15' => 'Tr', '8.1' => '1.0', '8.2' => '1.0',
            '8.3' => '1.0', '8.4' => '1.0', '8.5' => '1.0', '8.8' => '1.0',
        ],
        'B-Team (AH2)' => [
            '8.1' => '2.0', '8.2' => '2.0', '8.3' => '2.0', '8.4' => '2.0', '8.5' => '2.0', '8.8' => '2.0',
        ],
        'B-Team (AH3)' => [
            '8.1' => '3.0', '8.2' => '3.0', '8.3' => '3.0', '8.4' => '3.0', '8.5' => '3.0', '8.8' => '3.0',
        ],
        'Mina Tawfik' => [
            '1.1' => '3.5', '2.1' => '4.0', '8.1' => 'x', '8.2' => 'x', '8.3' => 'x', '8.4' => 'x',
            '8.5' => '3.0', '8.6' => '3.0', '8.8' => 'x',
        ],
        'Rehaf Hamed' => ['7.0' => '3.0', '8.5' => '2.0', '8.6' => '1.0'],
        'Stanley Prospere' => ['8.5' => '1.0', '8.6' => '2.0'],
        'Nour El Khatib' => ['2.1' => '5.0', '2.2' => '5.0', '8.5' => '4.0', '8.6' => '4.0'],
    ];

    public function run(): void
    {
        $nrms = Nrm::query()->get()->keyBy('number');
        $merged = [];

        foreach ($this->rows as $sheetName => $values) {
            $employee = $this->resolveEmployee($sheetName);
            if (! $employee) {
                $this->command?->warn("Skipping OAP row — employee not found: {$sheetName}");

                continue;
            }

            if (! isset($merged[$employee->id])) {
                $merged[$employee->id] = [];
            }

            foreach ($values as $nrmNumber => $oap) {
                $merged[$employee->id][$nrmNumber] = $oap;
            }
        }

        DB::transaction(function () use ($merged, $nrms) {
            foreach ($merged as $employeeId => $oapByNrm) {
                $employee = Employee::find($employeeId);
                if (! $employee) {
                    continue;
                }

                $sync = [];
                foreach ($oapByNrm as $nrmNumber => $oap) {
                    $nrm = $nrms->get($nrmNumber);
                    if (! $nrm) {
                        continue;
                    }

                    $sync[$nrm->id] = [
                        'OAP' => $oap,
                        'performance_percentage' => null,
                    ];
                }

                if ($sync !== []) {
                    $employee->nrms()->sync($sync);
                }
            }
        });

        $this->command?->info('OAP values seeded for '.count($merged).' employee(s).');
    }

    private function resolveEmployee(string $sheetName): ?Employee
    {
        $target = $this->sheetNameAliases[$sheetName] ?? $sheetName;

        return EmployeeNames::findByAnyName($target);
    }
}
