<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Models\EmployeeAvailability;
use App\Services\AvailabilitySheetImportService;
use App\Services\GoogleSheetsValuesClient;
use App\Support\EmployeeNames;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class EmployeeAvailabilityController extends Controller
{
    public function index(Request $request, Employee $employee): JsonResponse
    {
        $validated = $request->validate([
            'from' => 'nullable|date',
            'to' => 'nullable|date',
        ]);

        $query = EmployeeAvailability::query()
            ->where('employee_id', $employee->id)
            ->orderBy('date');

        if (! empty($validated['from'])) {
            $query->where('date', '>=', $validated['from']);
        }

        if (! empty($validated['to'])) {
            $query->where('date', '<=', $validated['to']);
        }

        return response()->json([
            'data' => $query->get(),
        ]);
    }

    public function sync(Request $request): JsonResponse
    {
        $entries = $request->all();

        if (! is_array($entries) || $entries === []) {
            return response()->json(['message' => 'No availability data provided.'], 422);
        }

        $employeeId = $entries[0]['employee_id'] ?? null;

        if (! $employeeId) {
            return response()->json(['message' => 'Employee id is required.'], 422);
        }

        Employee::findOrFail($employeeId);

        $datesInPayload = [];
        foreach ($entries as $item) {
            $date = isset($item['date']) ? Carbon::parse($item['date'])->toDateString() : null;
            if ($date) {
                if (in_array($date, $datesInPayload, true)) {
                    return response()->json([
                        'message' => "Duplicate date in request: {$date}. Only one row per day is allowed.",
                    ], 422);
                }
                $datesInPayload[] = $date;
            }
        }

        foreach ($entries as $item) {
            $validated = validator($item, [
                'id' => 'nullable|integer|exists:employee_availabilities,id',
                'employee_id' => 'required|exists:employees,id',
                'date' => 'required|date',
                'strt1' => 'nullable|string|max:10',
                'end1' => 'nullable|string|max:10',
                'strt2' => 'nullable|string|max:10',
                'end2' => 'nullable|string|max:10',
                'strt3' => 'nullable|string|max:10',
                'end3' => 'nullable|string|max:10',
                'strt4' => 'nullable|string|max:10',
                'end4' => 'nullable|string|max:10',
                'total' => 'nullable|string|max:10',
                'total_ava' => 'nullable|string|max:10',
                'Total' => 'nullable|string|max:10',
            ])->validate();

            $total = $validated['total'] ?? $validated['total_ava'] ?? $validated['Total'] ?? '00:00';

            $payload = [
                'employee_id' => $validated['employee_id'],
                'date' => $validated['date'],
                'strt1' => $validated['strt1'] ?? null,
                'end1' => $validated['end1'] ?? null,
                'strt2' => $validated['strt2'] ?? null,
                'end2' => $validated['end2'] ?? null,
                'strt3' => $validated['strt3'] ?? null,
                'end3' => $validated['end3'] ?? null,
                'strt4' => $validated['strt4'] ?? null,
                'end4' => $validated['end4'] ?? null,
                'total' => $total,
                'total_ava' => $total,
            ];

            if (! empty($validated['id'])) {
                $record = EmployeeAvailability::where('employee_id', $employeeId)
                    ->findOrFail($validated['id']);

                $conflict = EmployeeAvailability::where('employee_id', $employeeId)
                    ->where('date', $validated['date'])
                    ->where('id', '!=', $validated['id'])
                    ->exists();

                if ($conflict) {
                    return response()->json([
                        'message' => 'Availability already exists for '.$validated['date'].'.',
                    ], 422);
                }

                $record->update($payload);
            } else {
                EmployeeAvailability::updateOrCreate(
                    [
                        'employee_id' => $validated['employee_id'],
                        'date' => $validated['date'],
                    ],
                    $payload,
                );
            }
        }

        $availabilities = EmployeeAvailability::where('employee_id', $employeeId)
            ->orderBy('date')
            ->get();

        ResourceHistogramController::clearFullPayloadCache($request);

        return response()->json([
            'message' => 'Data updated successfully',
            'data' => $availabilities,
        ]);
    }

    public function destroy(Request $request, EmployeeAvailability $employeeAvailability): JsonResponse
    {
        $employeeAvailability->delete();
        ResourceHistogramController::clearFullPayloadCache($request);

        return response()->json(['message' => 'Availability deleted']);
    }

    public function duplicateWeek(Request $request, Employee $employee): JsonResponse
    {
        $validated = $request->validate([
            'source_week_start' => 'required|date',
            'target_week_start' => 'required|date',
        ]);

        $sourceStart = Carbon::parse($validated['source_week_start'])->startOfWeek();
        $sourceEnd = $sourceStart->copy()->endOfWeek();
        $targetStart = Carbon::parse($validated['target_week_start'])->startOfWeek();

        $sourceRows = EmployeeAvailability::where('employee_id', $employee->id)
            ->whereBetween('date', [$sourceStart->toDateString(), $sourceEnd->toDateString()])
            ->get();

        $created = [];

        foreach ($sourceRows as $row) {
            $sourceDate = Carbon::parse($row->date);
            $offsetDays = $sourceStart->diffInDays($sourceDate);
            $newDate = $targetStart->copy()->addDays($offsetDays);

            $created[] = EmployeeAvailability::updateOrCreate(
                [
                    'employee_id' => $employee->id,
                    'date' => $newDate->toDateString(),
                ],
                [
                    'strt1' => $row->strt1,
                    'end1' => $row->end1,
                    'strt2' => $row->strt2,
                    'end2' => $row->end2,
                    'strt3' => $row->strt3,
                    'end3' => $row->end3,
                    'strt4' => $row->strt4,
                    'end4' => $row->end4,
                    'total' => $row->total,
                    'total_ava' => $row->total_ava,
                ],
            );
        }

        ResourceHistogramController::clearFullPayloadCache($request);

        return response()->json([
            'message' => 'Week duplicated successfully',
            'data' => $created,
        ]);
    }

    public function importBulk(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'imports' => 'required|array|min:1',
            'imports.*.employee_id' => 'required|integer|exists:employees,id',
            'imports.*.rows' => 'required|array|min:1',
            'imports.*.rows.*.date' => 'required|date',
            'imports.*.rows.*.strt1' => 'nullable|string|max:10',
            'imports.*.rows.*.end1' => 'nullable|string|max:10',
            'imports.*.rows.*.strt2' => 'nullable|string|max:10',
            'imports.*.rows.*.end2' => 'nullable|string|max:10',
            'imports.*.rows.*.strt3' => 'nullable|string|max:10',
            'imports.*.rows.*.end3' => 'nullable|string|max:10',
            'imports.*.rows.*.strt4' => 'nullable|string|max:10',
            'imports.*.rows.*.end4' => 'nullable|string|max:10',
            'imports.*.rows.*.total' => 'nullable|string|max:10',
            'imports.*.rows.*.total_ava' => 'nullable|string|max:10',
        ]);

        $imported = 0;

        foreach ($validated['imports'] as $import) {
            Employee::findOrFail($import['employee_id']);

            foreach ($import['rows'] as $row) {
                $total = $row['total'] ?? $row['total_ava'] ?? '00:00';

                EmployeeAvailability::updateOrCreate(
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

        ResourceHistogramController::clearFullPayloadCache($request);

        return response()->json([
            'message' => 'Availability imported successfully',
            'imported_rows' => $imported,
        ]);
    }

    public function importScheduled(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'months' => 'nullable|integer|min:1|max:12',
            'month_offset' => 'nullable|integer|min:0|max:11',
        ]);

        $apiKey = (string) config('availability.google_sheets_api_key');
        $spreadsheetId = (string) config('availability.spreadsheet_id');

        if ($apiKey === '') {
            return response()->json([
                'message' => 'GOOGLE_SHEETS_API_KEY is not configured on the server.',
            ], 500);
        }

        if ($spreadsheetId === '') {
            return response()->json([
                'message' => 'AVAILABILITY_SPREADSHEET_ID is not configured on the server.',
            ], 500);
        }

        $employees = Employee::query()->orderBy('id')->get();
        EmployeeNames::warmEmployeeCache($employees);

        $client = new GoogleSheetsValuesClient($apiKey, $spreadsheetId);
        $service = new AvailabilitySheetImportService($client);

        try {
            if (array_key_exists('month_offset', $validated)) {
                $month = now()->startOfMonth()->addMonths((int) $validated['month_offset']);
                $result = $service->importSingleMonth($employees, $month);
            } else {
                $monthCount = (int) ($validated['months'] ?? config('availability.scheduled_months_ahead', 3));
                $result = $service->importMonths($employees, $monthCount);
            }
        } catch (\Throwable $exception) {
            return response()->json([
                'message' => $exception->getMessage(),
            ], 422);
        } finally {
            EmployeeNames::clearEmployeeCache();
        }

        ResourceHistogramController::clearFullPayloadCache($request);

        return response()->json([
            'message' => 'Scheduled availability import completed',
            ...$result,
        ]);
    }
}
