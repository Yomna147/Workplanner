<?php

namespace App\Services;

use App\Models\Employee;
use App\Models\EmployeeAvailability;
use App\Support\EmployeeNames;
use Carbon\Carbon;
use Illuminate\Support\Collection;
use RuntimeException;

class AvailabilitySheetImportService
{
  /** @var list<string> */
  private const B_TEAM_KM = ['Faouad Diaa', 'Valeriya Dramalieva', 'Veselina Milanova'];

  /** @var list<string> */
  private const B_TEAM_AH = ['Mina Tawfik', 'Rehaf Hamed', 'Nour El Khatib', 'Stanley Prospere'];

  /** @var array<string, string> */
  private const SHEET_EMPLOYEE_ALIASES = [
    'b-team (km1)' => 'B-team KM',
    'b-team (km2)' => 'B-team KM',
    'b-team (km3)' => 'B-team KM',
    'b-team (ah1)' => 'B-team AH',
    'b-team (ah2)' => 'B-team AH',
    'b-team (ah3)' => 'B-team AH',
    'rauno r' => 'Rauno R',
    'todor t' => 'Todor Tanev',
    'shaimaa m' => 'Shaimaa Mohamed',
    'nora' => 'Nora Keshk',
    'gabriel g' => 'Gabriel Giurca',
    'manu v' => 'Manu Vijay',
    'khaled m' => 'Khaled Maged',
    'fouad d' => 'Faouad Diaa',
    'valeria d' => 'Valeriya Dramalieva',
    'veselina m' => 'Veselina Milanova',
    'amro h' => 'Amro Mahmoud',
    'mina t' => 'Mina Tawfik',
    'rehaf h' => 'Rehaf Hamed',
    'stanley p' => 'Stanley Prospere',
    'nour el khatib' => 'Nour El Khatib',
    'nour' => 'Nour El Khatib',
    'mayar n' => 'Mayar Nashaat',
    'maya' => 'Maya Wacily',
    'amal' => 'Amal Nagi',
    'nataliia' => 'Nataliia Markitan',
    'angela l' => 'Angela L',
    'alexander s' => 'Alexander Suvoroff',
  ];

  public function __construct(
    private readonly GoogleSheetsValuesClient $sheetsClient,
  ) {}

  /**
   * @return array{imported_rows: int, employees: int, sheet: string, month: string}
   */
  public function importSingleMonth(Collection $employees, Carbon $month, ?array $availableTabs = null): array
  {
    $availableTabs ??= $this->sheetsClient->listSheetTitles();
    $tabName = $this->resolveTabNameForMonth($month, $availableTabs);

    if (! $tabName) {
      throw new RuntimeException(
        'No matching sheet tab for '.$month->format('F Y').'. Available tabs: '.implode(', ', $availableTabs),
      );
    }

    $rows = $this->sheetsClient->fetchSheetRows($tabName);
    $payload = $this->parseAvailabilitySheet($rows, $tabName, $employees);
    $importedRows = $this->persistImports($payload);

    return [
      'imported_rows' => $importedRows,
      'employees' => count(array_unique(array_column($payload, 'employee_id'))),
      'sheet' => $tabName,
      'month' => $month->format('F Y'),
    ];
  }

  /**
   * @return array{imported_rows: int, employees: int, sheets: list<string>, sheet_results: list<array{imported_rows: int, employees: int, sheet: string, month: string}>}
   */
  public function importMonths(Collection $employees, int $monthCount = 3, ?Carbon $startMonth = null): array
  {
    $start = ($startMonth ?? now())->copy()->startOfMonth();
    $availableTabs = $this->sheetsClient->listSheetTitles();
    $sheetResults = [];

    for ($offset = 0; $offset < $monthCount; $offset++) {
      $month = $start->copy()->addMonths($offset);
      $sheetResults[] = $this->importSingleMonth($employees, $month, $availableTabs);
    }

    return [
      'imported_rows' => array_sum(array_column($sheetResults, 'imported_rows')),
      'employees' => max(array_column($sheetResults, 'employees')),
      'sheets' => array_column($sheetResults, 'sheet'),
      'sheet_results' => $sheetResults,
    ];
  }

  /**
   * @param  list<array{employee_id: int, rows: list<array<string, mixed>>}>  $imports
   */
  public function persistImports(array $imports): int
  {
    $imported = 0;

    foreach ($imports as $import) {
      Employee::query()->findOrFail($import['employee_id']);

      foreach ($import['rows'] as $row) {
        $total = $row['total'] ?? $row['total_ava'] ?? '00:00';

        EmployeeAvailability::query()->updateOrCreate(
          [
            'employee_id' => $import['employee_id'],
            'date' => $row['date'],
          ],
          [
            'strt1' => $row['strt1'] ?? null,
            'end1' => $row['end1'] ?? null,
            'strt2' => $row['strt2'] ?? null,
            'end2' => $row['end2'] ?? null,
            'strt3' => $row['strt3'] ?? null,
            'end3' => $row['end3'] ?? null,
            'strt4' => $row['strt4'] ?? null,
            'end4' => $row['end4'] ?? null,
            'total' => $total,
            'total_ava' => $total,
          ],
        );

        $imported++;
      }
    }

    return $imported;
  }

  /**
   * @param  list<string>  $availableTabs
   */
  public function resolveTabNameForMonth(Carbon $month, array $availableTabs): ?string
  {
    $candidates = array_unique([
      $month->format('F Y'),
      $month->format('M Y'),
      $month->format('F').' '.$month->year,
      $month->format('M').' '.$month->year,
    ]);

    $normalizedTabs = [];
    foreach ($availableTabs as $tab) {
      $normalizedTabs[mb_strtolower(trim($tab))] = $tab;
    }

    foreach ($candidates as $candidate) {
      $key = mb_strtolower(trim($candidate));
      if (isset($normalizedTabs[$key])) {
        return $normalizedTabs[$key];
      }
    }

    foreach ($availableTabs as $tab) {
      if (preg_match('/\b'.$month->year.'\b/', $tab)
        && stripos($tab, $month->format('M')) !== false) {
        return $tab;
      }
      if (preg_match('/\b'.$month->year.'\b/', $tab)
        && stripos($tab, $month->format('F')) !== false) {
        return $tab;
      }
    }

    return null;
  }

  /**
   * @param  list<list<string|null>>  $rows
   * @return list<array{employee_id: int, rows: list<array<string, mixed>>}>
   */
  private function parseAvailabilitySheet(array $rows, string $sheetName, Collection $employees): array
  {
    if ($rows === []) {
      throw new RuntimeException('No data found in the specified range.');
    }

    $year = $this->extractYearFromSheetName($sheetName);
    $headers = collect($rows[0] ?? [])
      ->slice(1)
      ->filter(fn ($header) => trim((string) $header) !== '')
      ->values()
      ->all();

    $payload = [];

    foreach (array_slice($rows, 1) as $row) {
      if ($this->rowContainsMarker($row, 'Do not touch the table below')) {
        break;
      }

      if ($this->isEmptySheetRow($row)) {
        continue;
      }

      $label = $this->resolveSheetEmployeeLabel($row);
      if ($label === '') {
        continue;
      }

      $matchedEmployees = $this->findEmployeesForSheetLabel($employees, $label);
      if ($matchedEmployees === []) {
        continue;
      }

      $dayRows = [];
      foreach ($headers as $index => $header) {
        $parsed = $this->parseDayAvailability($header, $row, $index, $year);
        if ($parsed) {
          $dayRows[] = $parsed;
        }
      }

      if ($dayRows === []) {
        continue;
      }

      foreach ($matchedEmployees as $employee) {
        $payload[] = [
          'employee_id' => $employee->id,
          'rows' => array_map(fn (array $day) => [
            'date' => $day['date'],
            'strt1' => $day['values']['start1'] ?: null,
            'end1' => $day['values']['end1'] ?: null,
            'strt2' => $day['values']['start2'] ?: null,
            'end2' => $day['values']['end2'] ?: null,
            'strt3' => null,
            'end3' => null,
            'strt4' => null,
            'end4' => null,
            'total' => $day['values']['formattedTotal'],
            'total_ava' => $day['values']['formattedTotal'],
          ], $dayRows),
        ];
      }
    }

    if ($payload === []) {
      throw new RuntimeException('No matching employees found in the spreadsheet.');
    }

    return $payload;
  }

  /**
   * @param  list<string|null>  $row
   */
  private function isEmptySheetRow(array $row): bool
  {
    foreach ($row as $cell) {
      if (trim((string) ($cell ?? '')) !== '') {
        return false;
      }
    }

    return true;
  }

  /**
   * @param  list<string|null>  $row
   */
  private function rowContainsMarker(array $row, string $marker): bool
  {
    foreach ($row as $cell) {
      if (str_contains((string) $cell, $marker)) {
        return true;
      }
    }

    return false;
  }

  /**
   * @param  list<string|null>  $row
   */
  private function resolveSheetEmployeeLabel(array $row): string
  {
    $colB = trim((string) ($row[1] ?? ''));
    $colA = trim((string) ($row[0] ?? ''));

    foreach ([$colB, $colA] as $candidate) {
      $alias = self::SHEET_EMPLOYEE_ALIASES[mb_strtolower(trim($candidate))] ?? null;
      if ($alias) {
        return $alias;
      }
    }

    return $colA !== '' ? $colA : $colB;
  }

  /**
   * @return list<Employee>
   */
  private function findEmployeesForSheetLabel(Collection $employees, string $label): array
  {
    $normalized = mb_strtolower(trim($label));

    if ($normalized === 'b-team km') {
      return $this->employeesMatchingCanonical($employees, self::B_TEAM_KM);
    }

    if ($normalized === 'b-team ah') {
      return $this->employeesMatchingCanonical($employees, self::B_TEAM_AH);
    }

    $match = EmployeeNames::findByAnyName($label);

    return $match ? [$match] : [];
  }

  /**
   * @param  list<string>  $canonicalNames
   * @return list<Employee>
   */
  private function employeesMatchingCanonical(Collection $employees, array $canonicalNames): array
  {
    return $employees
      ->filter(function (Employee $employee) use ($canonicalNames) {
        foreach ($canonicalNames as $name) {
          if (EmployeeNames::namesMatch(EmployeeNames::displayName($employee), $name)) {
            return true;
          }
        }

        return false;
      })
      ->values()
      ->all();
  }

  /**
   * @param  list<string|null>  $row
   * @return array{date: string, values: array{start1: string, end1: string, start2: string, end2: string, formattedTotal: string}}|null
   */
  private function parseDayAvailability(string $header, array $row, int $index, int $year): ?array
  {
    $date = $this->parseSheetDateHeader($header, $year);
    if (! $date) {
      return null;
    }

    $col1 = (string) ($row[$index * 2 + 1] ?? '');
    $col2 = (string) ($row[$index * 2 + 2] ?? '');
    $combined = trim("{$col1} {$col2}");

    preg_match_all('/\d+/', $combined, $matches);
    $intValues = array_map('intval', $matches[0] ?? []);

    $start1 = $intValues[0] ?? null;
    $end1 = $intValues[1] ?? null;
    $start2 = $intValues[2] ?? null;
    $end2 = $intValues[3] ?? null;

    $hours1 = ($start1 !== null && $end1 !== null) ? max($end1 - $start1, 0) : 0;
    $hours2 = ($start2 !== null && $end2 !== null) ? max($end2 - $start2, 0) : 0;

    // Skip blank day cells so empty sheet columns do not overwrite availability.
    if ($start1 === null && $end1 === null && $start2 === null && $end2 === null) {
      return null;
    }

    return [
      'date' => $date,
      'values' => [
        'start1' => $this->formatHourValue($start1),
        'end1' => $this->formatHourValue($end1),
        'start2' => $this->formatHourValue($start2),
        'end2' => $this->formatHourValue($end2),
        'formattedTotal' => $this->formatTotalHours($hours1 + $hours2),
      ],
    ];
  }

  private function parseSheetDateHeader(string $header, int $year): ?string
  {
    $text = trim($header);
    if ($text === '') {
      return null;
    }

    try {
      $date = Carbon::parse("{$text} {$year}");
    } catch (\Throwable) {
      return null;
    }

    return $date->toDateString();
  }

  private function extractYearFromSheetName(string $sheetName): int
  {
    if (preg_match('/\b((?:19|20)\d{2})\b/', $sheetName, $matches)) {
      return (int) $matches[1];
    }

    return (int) now()->year;
  }

  private function formatHourValue(?int $value): string
  {
    if ($value === null) {
      return '';
    }

    return str_pad((string) $value, 2, '0', STR_PAD_LEFT).':00';
  }

  private function formatTotalHours(int $hours): string
  {
    $safe = max(0, $hours);

    return $this->formatHourValue($safe);
  }
}
