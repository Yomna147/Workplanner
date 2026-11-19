<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\GoogleDriveQuotationsService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;
use Throwable;

class GoogleDriveQuotationsController extends Controller
{
    public function __construct(
        private readonly GoogleDriveQuotationsService $service,
    ) {}

    public function index(): JsonResponse
    {
        if (function_exists('set_time_limit')) {
            @set_time_limit(300);
        }

        try {
            $files = $this->service->listQuotationSpreadsheets();
        } catch (RuntimeException $e) {
            return $this->driveError($e);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'message' => $e->getMessage() !== ''
                    ? $e->getMessage()
                    : 'Unable to list quotation files from Google Drive.',
            ], 502);
        }

        return response()->json([
            'data' => $files,
        ]);
    }

    public function search(Request $request): JsonResponse
    {
        if (function_exists('set_time_limit')) {
            @set_time_limit(300);
        }

        $validated = $request->validate([
            'q' => 'required|string|max:255',
            'exclude_ids' => 'nullable|array',
            'exclude_ids.*' => 'string|max:255',
        ]);

        try {
            $files = $this->service->searchQuotationSpreadsheets(
                $validated['q'],
                array_values($validated['exclude_ids'] ?? []),
            );
        } catch (RuntimeException $e) {
            return $this->driveError($e);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'message' => $e->getMessage() !== ''
                    ? $e->getMessage()
                    : 'Unable to search quotation files from Google Drive.',
            ], 502);
        }

        return response()->json([
            'data' => $files,
        ]);
    }

    public function sheetTitles(Request $request): JsonResponse
    {
        if (function_exists('set_time_limit')) {
            @set_time_limit(90);
        }

        $validated = $request->validate([
            'file_id' => 'required|string|max:255',
        ]);

        try {
            $titles = $this->service->listQuotationSheetTitles($validated['file_id']);
        } catch (RuntimeException $e) {
            return $this->driveError($e);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'message' => $e->getMessage() !== ''
                    ? $e->getMessage()
                    : 'Unable to list sheet tabs from Google Drive.',
            ], 502);
        }

        return response()->json([
            'data' => [
                'file_id' => $validated['file_id'],
                'sheet_titles' => $titles,
            ],
        ]);
    }

    public function import(Request $request): JsonResponse
    {
        if (function_exists('set_time_limit')) {
            @set_time_limit(180);
        }

        $validated = $request->validate([
            'file_id' => 'required|string|max:255',
            'sheet_name' => 'nullable|string|max:255',
        ]);

        try {
            $payload = $this->service->prepareQuotationImport(
                $validated['file_id'],
                trim((string) ($validated['sheet_name'] ?? 'Adjudication - TEMPL')),
            );
        } catch (RuntimeException $e) {
            return $this->driveError($e);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'message' => $e->getMessage() !== ''
                    ? $e->getMessage()
                    : 'Unable to import quotation file from Google Drive.',
            ], 502);
        }

        return response()->json([
            'data' => $payload,
        ]);
    }

    private function driveError(RuntimeException $e): JsonResponse
    {
        $status = $e->getCode();
        if (! is_int($status) || $status < 400 || $status > 599) {
            $status = 502;
        }

        return response()->json([
            'message' => $e->getMessage(),
        ], $status);
    }
}
