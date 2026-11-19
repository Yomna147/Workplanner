<?php

namespace App\Console\Commands;

use App\Models\Employee;
use App\Services\AvailabilitySheetImportService;
use App\Services\GoogleSheetsValuesClient;
use App\Support\EmployeeNames;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

class ImportScheduledAvailabilities extends Command
{
    protected $signature = 'availabilities:import-scheduled
                            {--months= : Number of months to import starting from the current month (default: config)}';

    protected $description = 'Import employee availability from the TSA Google Sheet (current month + ahead)';

    public function handle(): int
    {
        $apiKey = (string) config('availability.google_sheets_api_key');
        $spreadsheetId = (string) config('availability.spreadsheet_id');

        if ($apiKey === '') {
            $this->error('GOOGLE_SHEETS_API_KEY is not configured in the backend .env file.');

            return self::FAILURE;
        }

        if ($spreadsheetId === '') {
            $this->error('AVAILABILITY_SPREADSHEET_ID is not configured.');

            return self::FAILURE;
        }

        $monthCount = (int) ($this->option('months') ?: config('availability.scheduled_months_ahead', 3));
        $monthCount = max(1, $monthCount);

        $employees = Employee::query()->orderBy('id')->get();
        EmployeeNames::warmEmployeeCache($employees);

        $client = new GoogleSheetsValuesClient($apiKey, $spreadsheetId);
        $service = new AvailabilitySheetImportService($client);

        try {
            $result = $service->importMonths($employees, $monthCount);
        } catch (\Throwable $exception) {
            Log::error('Scheduled availability import failed', [
                'message' => $exception->getMessage(),
            ]);

            $this->error($exception->getMessage());

            return self::FAILURE;
        } finally {
            EmployeeNames::clearEmployeeCache();
        }

        $sheetList = implode(', ', $result['sheets']);
        $message = "Imported {$result['imported_rows']} row(s) for {$result['employees']} employee(s) from: {$sheetList}";

        Log::info('Scheduled availability import completed', $result);
        $this->info($message);

        return self::SUCCESS;
    }
}
