<?php

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;

class GoogleDriveQuotationsService
{
    private const TOKEN_URL = 'https://oauth2.googleapis.com/token';

    private const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

    private const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

    private const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

    private const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    private const XLS_MIME = 'application/vnd.ms-excel';

    private const FOLDER_MIME = 'application/vnd.google-apps.folder';

    /** Year folder holds client/job subfolders with the sheets. */
    private const MAX_FOLDER_DEPTH = 1;

    private const CACHE_TTL_SECONDS = 900;

    private const REQUIRED_SHEET_NAME = 'Adjudication - TEMPL';

    /**
     * @return list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}>
     */
    public function listQuotationSpreadsheets(): array
    {
        $folderId = trim((string) config('google_drive.quotations_folder_id', ''));
        if ($folderId === '') {
            throw new RuntimeException(
                'GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID is not configured on the server.',
                503
            );
        }

        $yearFolder = trim((string) config('google_drive.quotations_year_folder', ''));
        $requiredSheet = trim((string) config('google_drive.required_sheet_name', self::REQUIRED_SHEET_NAME));
        [$windowFrom, $windowTo] = $this->quotationListWindow();
        $cacheKey = 'google_drive.quotations.v9.'.md5(
            $folderId.'|'.$yearFolder.'|'.$requiredSheet.'|'.$windowFrom->toDateString().'|'.$windowTo->toDateString()
        );

        try {
            return Cache::remember($cacheKey, self::CACHE_TTL_SECONDS, function () use ($folderId, $yearFolder, $requiredSheet, $windowFrom, $windowTo) {
                $files = $this->fetchQuotationSpreadsheets($folderId, $yearFolder, $windowFrom, $windowTo);
                $files = $this->filterFilesInDateWindow($files, $windowFrom, $windowTo);
                if ($requiredSheet === '') {
                    return $files;
                }

                return $this->filterFilesHavingSheet($files, $requiredSheet);
            });
        } catch (RuntimeException $e) {
            throw $e;
        } catch (Throwable $e) {
            throw new RuntimeException(
                'Unable to list quotation files from Google Drive: '.$e->getMessage(),
                502,
                $e
            );
        }
    }

    /**
     * Find quotation workbooks matching a project name outside the default month window.
     * Lists all year-folder files (metadata), filters by name, then peeks only candidates.
     *
     * @param  list<string>  $excludeIds
     * @return list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}>
     */
    public function searchQuotationSpreadsheets(string $query, array $excludeIds = []): array
    {
        $query = trim($query);
        if ($query === '') {
            return [];
        }

        $folderId = trim((string) config('google_drive.quotations_folder_id', ''));
        if ($folderId === '') {
            throw new RuntimeException(
                'GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID is not configured on the server.',
                503
            );
        }

        $yearFolder = trim((string) config('google_drive.quotations_year_folder', ''));
        $requiredSheet = trim((string) config('google_drive.required_sheet_name', self::REQUIRED_SHEET_NAME));
        $excludeLookup = [];
        foreach ($excludeIds as $id) {
            $id = trim((string) $id);
            if ($id !== '') {
                $excludeLookup[$id] = true;
            }
        }

        $cacheKey = 'google_drive.quotations.search.v3.'.md5(
            $folderId.'|'.$yearFolder.'|'.$requiredSheet.'|'.mb_strtolower($query).'|'.implode(',', array_keys($excludeLookup))
        );

        try {
            return Cache::remember($cacheKey, self::CACHE_TTL_SECONDS, function () use (
                $folderId,
                $yearFolder,
                $requiredSheet,
                $query,
                $excludeLookup
            ) {
                $files = $this->listAllQuotationFileMetadata($folderId, $yearFolder);
                $candidates = [];

                foreach ($files as $file) {
                    $id = (string) ($file['id'] ?? '');
                    if ($id !== '' && isset($excludeLookup[$id])) {
                        continue;
                    }
                    if (! $this->quotationNameMatchesProject($query, (string) ($file['name'] ?? ''))) {
                        continue;
                    }
                    $candidates[] = $file;
                }

                if ($candidates === []) {
                    return [];
                }

                // Prefer format-compatible adjudication sheets; keep name matches that fail
                // format checks so the UI can show a note.
                return $this->annotateFilesWithAdjudicationSheet($candidates, $requiredSheet, true);
            });
        } catch (RuntimeException $e) {
            throw $e;
        } catch (Throwable $e) {
            throw new RuntimeException(
                'Unable to search quotation files from Google Drive: '.$e->getMessage(),
                502,
                $e
            );
        }
    }

    /**
     * Cached metadata listing of all quotation files (no date / sheet filter).
     *
     * @return list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}>
     */
    private function listAllQuotationFileMetadata(string $folderId, string $yearFolder): array
    {
        $cacheKey = 'google_drive.quotations.meta.v1.'.md5($folderId.'|'.$yearFolder);

        return Cache::remember($cacheKey, self::CACHE_TTL_SECONDS, function () use ($folderId, $yearFolder) {
            return $this->fetchQuotationSpreadsheets($folderId, $yearFolder, null, null);
        });
    }

    /**
     * Mirror of front-end findMatchingQuotations name rules.
     */
    private function quotationNameMatchesProject(string $projectName, string $fileName): bool
    {
        $job = $this->leadingJobNumberText($projectName);
        $title = $this->projectTitleForMatch($projectName);
        $titleNorm = $this->normalizeMatchText($title);

        if ($job === '' && mb_strlen($titleNorm) < 3) {
            return false;
        }

        $fileNorm = $this->normalizeMatchText($fileName);
        if ($fileNorm === '') {
            return false;
        }

        if ($job !== '' && str_contains($fileNorm, $job)) {
            return true;
        }

        if (mb_strlen($titleNorm) >= 3 && str_contains($fileNorm, $titleNorm)) {
            return true;
        }

        if (mb_strlen($titleNorm) >= 3) {
            $tokens = array_values(array_filter(
                preg_split('/\s+/', $titleNorm) ?: [],
                static fn (string $token): bool => mb_strlen($token) >= 4
            ));
            if ($tokens !== []) {
                foreach ($tokens as $token) {
                    if (! str_contains($fileNorm, $token)) {
                        return false;
                    }
                }

                return true;
            }
        }

        return false;
    }

    private function leadingJobNumberText(string $name): string
    {
        if (preg_match('/^(\d{4,})/', trim($name), $matches) === 1) {
            return $matches[1];
        }

        return '';
    }

    private function projectTitleForMatch(string $name): string
    {
        $title = preg_replace('/^\d{4,}\s*[-–—:_]?\s*/u', '', trim($name)) ?? '';
        $title = preg_replace('/\s+/u', ' ', $title) ?? $title;

        return trim($title);
    }

    private function normalizeMatchText(string $value): string
    {
        $normalized = mb_strtolower(trim($value));
        $normalized = preg_replace('/[_\-–—]+/u', ' ', $normalized) ?? $normalized;
        $normalized = preg_replace('/\s+/u', ' ', $normalized) ?? $normalized;

        return trim($normalized);
    }

    /**
     * List worksheet tab names for a Drive quotation (Google Sheet or Excel).
     *
     * @return list<string>
     */
    public function listQuotationSheetTitles(string $fileId): array
    {
        $fileId = trim($fileId);
        if ($fileId === '') {
            throw new RuntimeException('Quotation file id is required.', 422);
        }

        $credentials = $this->loadServiceAccountCredentials();
        $accessToken = $this->fetchAccessToken($credentials);
        $meta = $this->getFileMetadata($accessToken, $fileId);
        $mime = (string) ($meta['mimeType'] ?? '');

        if ($mime === self::SPREADSHEET_MIME) {
            $binary = $this->exportGoogleSheetAsXlsx($accessToken, $fileId);

            return $this->excelSheetTitlesFromBinary($binary);
        }

        if (! $this->isExcelMime($mime)) {
            throw new RuntimeException(
                'Selected quotation is not a Google Sheet or Excel (.xlsx/.xls) file.',
                422
            );
        }

        $binary = $this->downloadFileBinary($accessToken, $fileId);

        return $this->excelSheetTitlesFromBinary($binary);
    }

    /**
     * Import a Drive quotation (Google Sheet or Excel) and return sheet rows (+ tab names).
     * Native Google Sheets are exported to xlsx then parsed; Office files are downloaded.
     *
     * @return array{id: string, name: string, mimeType: string, sheet_name: string, sheet_titles: list<string>, rows: list<list<mixed>>, webViewLink: string, converted: bool, use_sheets_api: bool}
     */
    public function importExcelQuotation(string $fileId, string $sheetName = 'Adjudication - TEMPL'): array
    {
        return $this->prepareQuotationImport($fileId, $sheetName);
    }

    /**
     * Prepare a Drive quotation for Create Project import based on mime type.
     *
     * @return array{id: string, name: string, mimeType: string, sheet_name: string, sheet_titles: list<string>, rows: list<list<mixed>>, webViewLink: string, converted: bool, use_sheets_api: bool}
     */
    public function prepareQuotationImport(string $fileId, string $sheetName = 'Adjudication - TEMPL'): array
    {
        $fileId = trim($fileId);
        if ($fileId === '') {
            throw new RuntimeException('Quotation file id is required.', 422);
        }

        $credentials = $this->loadServiceAccountCredentials();
        $accessToken = $this->fetchAccessToken($credentials);
        $meta = $this->getFileMetadata($accessToken, $fileId);
        $mime = (string) ($meta['mimeType'] ?? '');
        $requiredSheet = trim((string) config('google_drive.required_sheet_name', self::REQUIRED_SHEET_NAME));
        $wantedSheet = $sheetName !== '' ? $sheetName : $requiredSheet;
        $webViewLink = (string) ($meta['webViewLink'] ?? '');

        if ($mime === self::SPREADSHEET_MIME) {
            try {
                $binary = $this->exportGoogleSheetAsXlsx($accessToken, $fileId);
                $parsed = $this->parseExcelBinary($binary, $wantedSheet, true);

                return [
                    'id' => $fileId,
                    'name' => (string) ($meta['name'] ?? $fileId),
                    'mimeType' => $mime,
                    'sheet_name' => $parsed['sheet_name'],
                    'sheet_titles' => $parsed['sheet_titles'],
                    'rows' => $parsed['rows'],
                    'webViewLink' => $webViewLink !== ''
                        ? $webViewLink
                        : 'https://docs.google.com/spreadsheets/d/'.$fileId.'/edit',
                    'converted' => false,
                    'use_sheets_api' => false,
                ];
            } catch (Throwable $e) {
                // Fall back so the client can still import via the Sheets API.
                report($e);

                return [
                    'id' => $fileId,
                    'name' => (string) ($meta['name'] ?? $fileId),
                    'mimeType' => $mime,
                    'sheet_name' => $wantedSheet,
                    'sheet_titles' => [],
                    'rows' => [],
                    'webViewLink' => $webViewLink !== ''
                        ? $webViewLink
                        : 'https://docs.google.com/spreadsheets/d/'.$fileId.'/edit',
                    'converted' => false,
                    'use_sheets_api' => true,
                ];
            }
        }

        if (! $this->isExcelMime($mime)) {
            throw new RuntimeException(
                'Selected quotation is not a Google Sheet or Excel (.xlsx/.xls) file.',
                422
            );
        }

        $binary = $this->downloadFileBinary($accessToken, $fileId);
        $parsed = $this->parseExcelBinary($binary, $wantedSheet, true);

        return [
            'id' => $fileId,
            'name' => (string) ($meta['name'] ?? $fileId),
            'mimeType' => $mime,
            'sheet_name' => $parsed['sheet_name'],
            'sheet_titles' => $parsed['sheet_titles'],
            'rows' => $parsed['rows'],
            'webViewLink' => $webViewLink,
            'converted' => false,
            'use_sheets_api' => false,
        ];
    }

    private function exportGoogleSheetAsXlsx(string $accessToken, string $fileId): string
    {
        $response = $this->http(120)
            ->withToken($accessToken)
            ->withHeaders(['Accept' => '*/*'])
            ->get(self::DRIVE_FILES_URL.'/'.$fileId.'/export', [
                'mimeType' => self::XLSX_MIME,
            ]);

        if (! $response->successful()) {
            $message = $response->json('error.message')
                ?? $response->body()
                ?: 'Google Drive export failed.';
            throw new RuntimeException(
                'Unable to export Google Sheet for tab list: '.$message,
                $response->status() >= 400 ? $response->status() : 502
            );
        }

        $body = $response->body();
        if ($body === '') {
            throw new RuntimeException('Exported Google Sheet is empty.', 502);
        }

        return $body;
    }

    /**
     * @return list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}>
     */
    private function fetchQuotationSpreadsheets(
        string $folderId,
        string $yearFolder,
        ?\Carbon\CarbonInterface $windowFrom = null,
        ?\Carbon\CarbonInterface $windowTo = null
    ): array {
        $credentials = $this->loadServiceAccountCredentials();
        $accessToken = $this->fetchAccessToken($credentials);

        $startFolderId = $folderId;

        if ($yearFolder !== '') {
            $yearMatch = null;
            foreach ($this->listChildren($accessToken, $folderId) as $child) {
                if (($child['mimeType'] ?? '') !== self::FOLDER_MIME) {
                    continue;
                }
                $name = trim((string) ($child['name'] ?? ''));
                if ($this->folderMatchesYear($name, $yearFolder)) {
                    $yearMatch = $child;
                    break;
                }
            }

            if ($yearMatch === null) {
                throw new RuntimeException(
                    "Could not find a \"{$yearFolder}\" quotations folder under the configured Drive folder.",
                    404
                );
            }

            $startFolderId = (string) $yearMatch['id'];
        }

        $filesById = [];
        $startChildren = $this->listChildren($accessToken, $startFolderId);
        $subfolderIds = [];

        foreach ($startChildren as $child) {
            $mapped = $this->mapQuotationFile($child);
            if ($mapped !== null) {
                $filesById[$mapped['id']] = $mapped;
                continue;
            }

            $id = trim((string) ($child['id'] ?? ''));
            $mime = (string) ($child['mimeType'] ?? '');
            if ($id !== '' && $mime === self::FOLDER_MIME && self::MAX_FOLDER_DEPTH >= 1) {
                $subfolderIds[] = $id;
            }
        }

        foreach ($this->listChildrenMany($accessToken, $subfolderIds, $windowFrom, $windowTo) as $child) {
            $mapped = $this->mapQuotationFile($child);
            if ($mapped !== null) {
                $filesById[$mapped['id']] = $mapped;
            }
        }

        $files = array_values($filesById);
        usort($files, static fn (array $a, array $b) => strcasecmp($a['name'], $b['name']));

        return $files;
    }

    /**
     * @return array{0: \Carbon\CarbonInterface, 1: \Carbon\CarbonInterface}
     */
    private function quotationListWindow(): array
    {
        $monthsBack = max(0, (int) config('google_drive.list_months_back', 1));
        // Full last calendar month(s) through end of the current month.
        $from = now()->copy()->startOfMonth()->subMonthsNoOverflow($monthsBack)->startOfDay();
        $to = now()->copy()->endOfMonth()->endOfDay();

        return [$from, $to];
    }

    /**
     * Keep quotations dated from last month through end of the current month.
     * Uses Drive modifiedTime when present; falls back to YYYY.MM.DD filename prefix.
     *
     * @param  list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}>  $files
     * @return list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}>
     */
    private function filterFilesInDateWindow(array $files, \Carbon\CarbonInterface $from, \Carbon\CarbonInterface $to): array
    {
        $kept = [];

        foreach ($files as $file) {
            $date = $this->quotationFileDate($file);
            if ($date === null) {
                // Keep undated files so listing is not emptied by missing metadata.
                $kept[] = $file;
                continue;
            }
            if ($date->lt($from) || $date->gt($to)) {
                continue;
            }
            $kept[] = $file;
        }

        return $kept;
    }

    /**
     * Prefer Drive modifiedTime for the month window; filename date is a fallback.
     *
     * @param  array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}  $file
     */
    private function quotationFileDate(array $file): ?\Carbon\CarbonInterface
    {
        $modified = trim((string) ($file['modifiedTime'] ?? ''));
        if ($modified !== '') {
            try {
                return \Carbon\Carbon::parse($modified);
            } catch (Throwable) {
                // Fall through to filename date.
            }
        }

        $name = (string) ($file['name'] ?? '');
        if (preg_match('/^(\d{4})[.\-](\d{2})[.\-](\d{2})\b/', $name, $matches) === 1) {
            try {
                return \Carbon\Carbon::createFromDate(
                    (int) $matches[1],
                    (int) $matches[2],
                    (int) $matches[3]
                )->startOfDay();
            } catch (Throwable) {
                return null;
            }
        }

        return null;
    }

    /**
     * Keep workbooks that contain an Adjudication - TEMPL tab, or another tab with the
     * same structure/style as that template. Attaches sheet_name on each kept file.
     *
     * @param  list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}>  $files
     * @return list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string, sheet_name: string|null, format_compatible: bool}>
     */
    private function filterFilesHavingSheet(array $files, string $requiredSheet): array
    {
        return $this->annotateFilesWithAdjudicationSheet($files, $requiredSheet, false);
    }

    /**
     * @param  list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}>  $files
     * @return list<array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string, sheet_name: string|null, format_compatible: bool}>
     */
    private function annotateFilesWithAdjudicationSheet(
        array $files,
        string $requiredSheet,
        bool $keepIncompatibleNameMatches
    ): array {
        if ($files === []) {
            return [];
        }

        $credentials = $this->loadServiceAccountCredentials();
        $accessToken = $this->fetchAccessToken($credentials);
        $kept = [];
        $chunkSize = 8;

        foreach (array_chunk($files, $chunkSize) as $chunk) {
            $binaries = $this->downloadFilesBinaryMany($accessToken, $chunk);

            foreach ($chunk as $file) {
                $id = $file['id'];
                $binary = $binaries[$id] ?? null;
                if (! is_string($binary) || $binary === '') {
                    if ($keepIncompatibleNameMatches) {
                        $kept[] = $this->withAdjudicationMeta($file, null, false);
                    }
                    continue;
                }

                try {
                    $resolved = $this->resolveCompatibleAdjudicationSheet($binary, $requiredSheet);
                } catch (Throwable) {
                    $resolved = null;
                }

                if ($resolved !== null) {
                    $kept[] = $this->withAdjudicationMeta($file, $resolved['sheet_name'], true);
                    continue;
                }

                if ($keepIncompatibleNameMatches) {
                    $kept[] = $this->withAdjudicationMeta($file, null, false);
                }
            }
        }

        usort($kept, static fn (array $a, array $b) => strcasecmp($a['name'], $b['name']));

        return $kept;
    }

    /**
     * @param  array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}  $file
     * @return array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string, sheet_name: string|null, format_compatible: bool}
     */
    private function withAdjudicationMeta(array $file, ?string $sheetName, bool $compatible): array
    {
        $file['sheet_name'] = $sheetName;
        $file['format_compatible'] = $compatible;

        return $file;
    }

    /**
     * Find a worksheet that matches Adjudication - TEMPL naming or the same structure.
     * Uses zip peeks only (no PhpSpreadsheet) so listing stays within memory limits.
     *
     * @return array{sheet_name: string}|null
     */
    private function resolveCompatibleAdjudicationSheet(string $binary, string $preferredSheet): ?array
    {
        $preferredNormalized = mb_strtolower(trim($preferredSheet !== '' ? $preferredSheet : self::REQUIRED_SHEET_NAME));

        try {
            $titles = $this->excelSheetTitlesFromBinary($binary);
        } catch (Throwable) {
            $titles = [];
        }

        foreach ($titles as $title) {
            $titleNorm = mb_strtolower(trim($title));
            if ($titleNorm === $preferredNormalized) {
                return ['sheet_name' => $title];
            }
        }

        foreach ($titles as $title) {
            $titleNorm = mb_strtolower(trim($title));
            if (str_contains($titleNorm, 'adjudication')) {
                return ['sheet_name' => $title];
            }
        }

        // Differently named tabs: accept only if workbook text matches the template markers.
        if ($titles !== [] && $this->xlsxMatchesAdjudicationTemplateMarkers($binary)) {
            return ['sheet_name' => $titles[0]];
        }

        return null;
    }

    /**
     * Lightweight marker check via xlsx zip (sharedStrings / workbook text).
     */
    private function xlsxMatchesAdjudicationTemplateMarkers(string $binary): bool
    {
        $markers = [
            'quoted hrs',
            'summary: section hours',
            'snr est',
            'jr est',
            'admin before production',
            'measurement',
            'questions and checking',
            'presentation',
            'timescales',
            'quote to send',
            'sub-total hours',
            'trevor sadd',
        ];

        $tmp = tempnam(sys_get_temp_dir(), 'wpqm');
        if ($tmp === false) {
            return false;
        }

        try {
            if (file_put_contents($tmp, $binary) === false) {
                return false;
            }
            if (! class_exists(\ZipArchive::class)) {
                return false;
            }

            $zip = new \ZipArchive();
            if ($zip->open($tmp) !== true) {
                return false;
            }

            $haystack = '';
            $shared = $zip->getFromName('xl/sharedStrings.xml');
            if (is_string($shared) && $shared !== '') {
                $haystack .= ' '.mb_strtolower($shared);
            }

            // Sample a few worksheet XMLs for inline strings / sparse workbooks.
            for ($i = 1; $i <= 4; $i++) {
                $sheetXml = $zip->getFromName("xl/worksheets/sheet{$i}.xml");
                if (is_string($sheetXml) && $sheetXml !== '') {
                    $haystack .= ' '.mb_strtolower(substr($sheetXml, 0, 200000));
                }
            }
            $zip->close();

            if ($haystack === '') {
                return false;
            }

            $hits = 0;
            foreach ($markers as $marker) {
                if (str_contains($haystack, $marker)) {
                    $hits++;
                }
            }

            return $hits >= 3;
        } catch (Throwable) {
            return false;
        } finally {
            @unlink($tmp);
        }
    }

    /**
     * Score how closely a sheet matches the Adjudication - TEMPL layout/style.
     */
    private function scoreAdjudicationSheetStructure(\PhpOffice\PhpSpreadsheet\Worksheet\Worksheet $worksheet): int
    {
        $markers = [
            'quoted hrs',
            'summary: section hours',
            'snr est',
            'jr est',
            'admin before production',
            'measurement',
            'questions and checking',
            'presentation',
            'planning',
            'timescales',
            'quote to send',
            'billable total',
            'sub-total hours',
            'total hours',
            'trevor sadd',
        ];

        $haystack = '';
        $maxRow = min(120, (int) $worksheet->getHighestDataRow());
        $maxCol = min(12, \PhpOffice\PhpSpreadsheet\Cell\Coordinate::columnIndexFromString(
            $worksheet->getHighestDataColumn() ?: 'A'
        ));

        for ($row = 1; $row <= $maxRow; $row++) {
            for ($col = 1; $col <= $maxCol; $col++) {
                $coord = \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($col).$row;
                try {
                    $value = $worksheet->getCell($coord)->getValue();
                } catch (Throwable) {
                    continue;
                }
                if ($value === null || $value === '') {
                    continue;
                }
                $haystack .= ' '.mb_strtolower(trim((string) $value));
            }
        }

        $score = 0;
        foreach ($markers as $marker) {
            if (str_contains($haystack, $marker)) {
                $score++;
            }
        }

        if ($this->sheetHasEstTimeValues($worksheet)) {
            $score += 2;
        }

        return $score;
    }

    private function sheetHasEstTimeValues(\PhpOffice\PhpSpreadsheet\Worksheet\Worksheet $worksheet): bool
    {
        $estCol = 7; // Column G — EST hours in the Adjudication template.
        $maxRow = min(200, (int) $worksheet->getHighestDataRow());
        $hits = 0;

        for ($row = 1; $row <= $maxRow; $row++) {
            $coord = \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($estCol).$row;
            try {
                $raw = $worksheet->getCell($coord)->getValue();
            } catch (Throwable) {
                continue;
            }
            $value = trim((string) $raw);
            if ($value !== '' && preg_match('/^\d{1,3}:\d{2}$/', $value) === 1) {
                $hits++;
                if ($hits >= 3) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * @param  list<array{id: string, mimeType: string}>  $files
     * @return array<string, string> fileId => binary
     */
    private function downloadFilesBinaryMany(string $accessToken, array $files): array
    {
        if ($files === []) {
            return [];
        }

        $results = [];
        $responses = Http::pool(function ($pool) use ($files, $accessToken) {
            $requests = [];
            foreach ($files as $index => $file) {
                $id = (string) ($file['id'] ?? '');
                $mime = (string) ($file['mimeType'] ?? '');
                if ($id === '') {
                    continue;
                }

                $pending = $pool
                    ->as("file_{$index}")
                    ->withOptions(['verify' => $this->resolveSslVerifyPath()])
                    ->withToken($accessToken)
                    ->withHeaders(['Accept' => '*/*'])
                    ->timeout(90);

                if ($mime === self::SPREADSHEET_MIME) {
                    $requests[] = $pending->get(self::DRIVE_FILES_URL.'/'.$id.'/export', [
                        'mimeType' => self::XLSX_MIME,
                    ]);
                } else {
                    $requests[] = $pending->get(self::DRIVE_FILES_URL.'/'.$id, [
                        'alt' => 'media',
                        'supportsAllDrives' => 'true',
                    ]);
                }
            }

            return $requests;
        });

        foreach ($files as $index => $file) {
            $id = (string) ($file['id'] ?? '');
            $response = $responses["file_{$index}"] ?? $responses[$index] ?? null;
            if ($id === '' || ! is_object($response) || ! method_exists($response, 'successful')) {
                continue;
            }
            if (! $response->successful()) {
                continue;
            }
            $body = $response->body();
            if (is_string($body) && $body !== '') {
                $results[$id] = $body;
            }
        }

        return $results;
    }

    /**
     * Fast sheet-name peek from an .xlsx zip (no full spreadsheet parse).
     *
     * @return list<string>
     */
    private function excelSheetTitlesFromBinary(string $binary): array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'wpqs');
        if ($tmp === false) {
            return [];
        }

        try {
            if (file_put_contents($tmp, $binary) === false) {
                return [];
            }

            if (! class_exists(\ZipArchive::class)) {
                $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($tmp);
                $titles = [];
                foreach ($spreadsheet->getWorksheetIterator() as $worksheet) {
                    $title = trim((string) $worksheet->getTitle());
                    if ($title !== '') {
                        $titles[] = $title;
                    }
                }

                return $titles;
            }

            $zip = new \ZipArchive();
            if ($zip->open($tmp) !== true) {
                return [];
            }

            $xml = $zip->getFromName('xl/workbook.xml');
            $zip->close();
            if (! is_string($xml) || $xml === '') {
                return [];
            }

            $titles = [];
            if (preg_match_all('/<sheet\b[^>]*\bname=(["\'])(.*?)\1/i', $xml, $matches)) {
                foreach ($matches[2] as $rawName) {
                    $title = trim(html_entity_decode($rawName, ENT_QUOTES | ENT_XML1));
                    if ($title !== '') {
                        $titles[] = $title;
                    }
                }
            }

            return $titles;
        } catch (Throwable) {
            return [];
        } finally {
            @unlink($tmp);
        }
    }

    /**
     * @param  array<string, mixed>  $file
     * @return array{id: string, name: string, webViewLink: string, modifiedTime: string|null, mimeType: string, kind: string}|null
     */
    private function mapQuotationFile(array $file): ?array
    {
        $id = trim((string) ($file['id'] ?? ''));
        $mime = (string) ($file['mimeType'] ?? '');
        if ($id === '' || ! $this->isQuotationMime($mime)) {
            return null;
        }

        return [
            'id' => $id,
            'name' => (string) ($file['name'] ?? $id),
            'webViewLink' => (string) ($file['webViewLink'] ?? ''),
            'modifiedTime' => isset($file['modifiedTime']) ? (string) $file['modifiedTime'] : null,
            'mimeType' => $mime,
            'kind' => $this->isExcelMime($mime) ? 'excel' : 'google_sheet',
        ];
    }

    private function isQuotationMime(string $mime): bool
    {
        return $mime === self::SPREADSHEET_MIME || $this->isExcelMime($mime);
    }

    private function isExcelMime(string $mime): bool
    {
        return $mime === self::XLSX_MIME || $mime === self::XLS_MIME;
    }

    private function quotationMimeQuery(): string
    {
        return sprintf(
            "(mimeType='%s' or mimeType='%s' or mimeType='%s')",
            self::SPREADSHEET_MIME,
            self::XLSX_MIME,
            self::XLS_MIME
        );
    }

    private function folderMatchesYear(string $folderName, string $year): bool
    {
        $normalizedYear = preg_replace('/\D+/', '', $year) ?: $year;
        if ($normalizedYear === '') {
            return false;
        }

        return (bool) preg_match('/^'.preg_quote($normalizedYear, '/').'\b/i', trim($folderName));
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function listChildren(string $accessToken, string $folderId): array
    {
        $escapedFolderId = str_replace("'", "\\'", $folderId);
        $query = sprintf(
            "'%s' in parents and trashed=false and (mimeType='%s' or %s)",
            $escapedFolderId,
            self::FOLDER_MIME,
            $this->quotationMimeQuery()
        );

        $children = [];
        $pageToken = null;

        do {
            $params = [
                'q' => $query,
                'fields' => 'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)',
                'pageSize' => 1000,
                'supportsAllDrives' => 'true',
                'includeItemsFromAllDrives' => 'true',
                'orderBy' => 'folder,name',
            ];
            if ($pageToken) {
                $params['pageToken'] = $pageToken;
            }

            $response = $this->http(45)
                ->withToken($accessToken)
                ->acceptJson()
                ->get(self::DRIVE_FILES_URL, $params);

            if (! $response->successful()) {
                $message = $response->json('error.message')
                    ?? $response->body()
                    ?: 'Google Drive files.list failed.';
                throw new RuntimeException(
                    'Unable to list quotation files from Google Drive: '.$message,
                    $response->status() >= 400 ? $response->status() : 502
                );
            }

            $payload = $response->json() ?? [];
            foreach ($payload['files'] ?? [] as $file) {
                if (is_array($file)) {
                    $children[] = $file;
                }
            }

            $pageToken = $payload['nextPageToken'] ?? null;
        } while ($pageToken);

        return $children;
    }

    /**
     * Parallel files.list for many folders (huge speedup vs sequential calls).
     *
     * @param  list<string>  $folderIds
     * @return list<array<string, mixed>>
     */
    private function listChildrenMany(
        string $accessToken,
        array $folderIds,
        ?\Carbon\CarbonInterface $windowFrom = null,
        ?\Carbon\CarbonInterface $windowTo = null
    ): array {
        $folderIds = array_values(array_unique(array_filter(array_map('strval', $folderIds))));
        if ($folderIds === []) {
            return [];
        }

        $modifiedClause = '';
        if ($windowFrom !== null && $windowTo !== null) {
            // Slightly widen Drive query so filename-dated files near the edges are not dropped early.
            $apiFrom = $windowFrom->copy()->subWeeks(2)->utc()->format('Y-m-d\TH:i:s\Z');
            $apiTo = $windowTo->copy()->utc()->format('Y-m-d\TH:i:s\Z');
            $modifiedClause = sprintf(
                " and modifiedTime >= '%s' and modifiedTime <= '%s'",
                $apiFrom,
                $apiTo
            );
        }

        $children = [];
        $chunkSize = 12;

        foreach (array_chunk($folderIds, $chunkSize) as $chunk) {
            $responses = Http::pool(function ($pool) use ($chunk, $accessToken, $modifiedClause) {
                $requests = [];
                foreach ($chunk as $index => $folderId) {
                    $escapedFolderId = str_replace("'", "\\'", $folderId);
                    $query = sprintf(
                        "'%s' in parents and trashed=false and %s%s",
                        $escapedFolderId,
                        $this->quotationMimeQuery(),
                        $modifiedClause
                    );

                    $requests[] = $pool
                        ->as("folder_{$index}")
                        ->withOptions(['verify' => $this->resolveSslVerifyPath()])
                        ->withToken($accessToken)
                        ->acceptJson()
                        ->timeout(45)
                        ->get(self::DRIVE_FILES_URL, [
                            'q' => $query,
                            'fields' => 'files(id,name,mimeType,webViewLink,modifiedTime)',
                            'pageSize' => 1000,
                            'supportsAllDrives' => 'true',
                            'includeItemsFromAllDrives' => 'true',
                            'orderBy' => 'name',
                        ]);
                }

                return $requests;
            });

            foreach ($responses as $response) {
                if (! is_object($response) || ! method_exists($response, 'successful')) {
                    continue;
                }
                if (! $response->successful()) {
                    $message = $response->json('error.message')
                        ?? $response->body()
                        ?: 'Google Drive files.list failed.';
                    throw new RuntimeException(
                        'Unable to list quotation files from Google Drive: '.$message,
                        $response->status() >= 400 ? $response->status() : 502
                    );
                }

                foreach ($response->json('files') ?? [] as $file) {
                    if (is_array($file)) {
                        $children[] = $file;
                    }
                }
            }
        }

        return $children;
    }

    /**
     * @return array{id: string, name: string, mimeType: string, webViewLink: string}
     */
    private function getFileMetadata(string $accessToken, string $fileId): array
    {
        $response = $this->http(30)
            ->withToken($accessToken)
            ->acceptJson()
            ->get(self::DRIVE_FILES_URL.'/'.$fileId, [
                'fields' => 'id,name,mimeType,webViewLink',
                'supportsAllDrives' => 'true',
            ]);

        if (! $response->successful()) {
            $message = $response->json('error.message')
                ?? $response->body()
                ?: 'Google Drive files.get failed.';
            throw new RuntimeException(
                'Unable to read quotation file metadata: '.$message,
                $response->status() >= 400 ? $response->status() : 502
            );
        }

        return [
            'id' => (string) ($response->json('id') ?? $fileId),
            'name' => (string) ($response->json('name') ?? $fileId),
            'mimeType' => (string) ($response->json('mimeType') ?? ''),
            'webViewLink' => (string) ($response->json('webViewLink') ?? ''),
        ];
    }

    private function downloadFileBinary(string $accessToken, string $fileId): string
    {
        $response = $this->http(120)
            ->withToken($accessToken)
            ->withHeaders(['Accept' => '*/*'])
            ->get(self::DRIVE_FILES_URL.'/'.$fileId, [
                'alt' => 'media',
                'supportsAllDrives' => 'true',
            ]);

        if (! $response->successful()) {
            $message = $response->json('error.message')
                ?? $response->body()
                ?: 'Google Drive download failed.';
            throw new RuntimeException(
                'Unable to download quotation Excel file: '.$message,
                $response->status() >= 400 ? $response->status() : 502
            );
        }

        $body = $response->body();
        if ($body === '') {
            throw new RuntimeException('Downloaded quotation Excel file is empty.', 502);
        }

        return $body;
    }

    /**
     * @return array{sheet_name: string, sheet_titles: list<string>, rows: list<list<mixed>>}
     */
    private function parseExcelBinary(string $binary, string $requestedSheetName, bool $requireExactSheet = false): array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'wpqx');
        if ($tmp === false) {
            throw new RuntimeException('Unable to create a temporary file for Excel import.', 500);
        }

        try {
            if (file_put_contents($tmp, $binary) === false) {
                throw new RuntimeException('Unable to write quotation Excel file to temp storage.', 500);
            }

            $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($tmp);
            $titles = [];
            foreach ($spreadsheet->getWorksheetIterator() as $worksheet) {
                $title = trim((string) $worksheet->getTitle());
                if ($title !== '') {
                    $titles[] = $title;
                }
            }

            if ($titles === []) {
                throw new RuntimeException('Excel quotation has no worksheets.', 422);
            }

            $wanted = trim($requestedSheetName);
            if ($wanted === '') {
                $wanted = self::REQUIRED_SHEET_NAME;
            }
            $wantedNormalized = mb_strtolower($wanted);
            $sheet = null;
            $resolvedName = $titles[0];

            foreach ($spreadsheet->getWorksheetIterator() as $worksheet) {
                $title = trim((string) $worksheet->getTitle());
                if (mb_strtolower($title) === $wantedNormalized) {
                    $sheet = $worksheet;
                    $resolvedName = $title;
                    break;
                }
            }

            if ($sheet === null) {
                foreach ($spreadsheet->getWorksheetIterator() as $worksheet) {
                    $title = trim((string) $worksheet->getTitle());
                    if (str_contains(mb_strtolower($title), 'adjudication')) {
                        $sheet = $worksheet;
                        $resolvedName = $title;
                        break;
                    }
                }
            }

            if ($sheet === null) {
                $bestScore = 0;
                foreach ($spreadsheet->getWorksheetIterator() as $worksheet) {
                    $title = trim((string) $worksheet->getTitle());
                    if ($title === '') {
                        continue;
                    }
                    $score = $this->scoreAdjudicationSheetStructure($worksheet);
                    if ($score > $bestScore) {
                        $bestScore = $score;
                        $sheet = $worksheet;
                        $resolvedName = $title;
                    }
                }
                if ($bestScore < 4) {
                    $sheet = null;
                }
            }

            if ($sheet === null) {
                throw new RuntimeException(
                    'No Adjudication - TEMPL compatible sheet found. Available tabs: '.implode(', ', $titles),
                    422
                );
            }

            $matrix = $sheet->toArray(null, true, true, false);
            $rows = [];
            foreach ($matrix as $row) {
                if (! is_array($row)) {
                    continue;
                }
                $cells = array_map(static function ($cell) {
                    if ($cell === null) {
                        return '';
                    }
                    if (is_bool($cell)) {
                        return $cell ? '1' : '0';
                    }
                    if (is_scalar($cell)) {
                        return (string) $cell;
                    }

                    return '';
                }, $row);
                if (implode('', $cells) === '') {
                    continue;
                }
                $rows[] = array_values($cells);
            }

            if ($rows === []) {
                throw new RuntimeException('No data found in the Excel sheet "'.$resolvedName.'".', 422);
            }

            return [
                'sheet_name' => $resolvedName,
                'sheet_titles' => $titles,
                'rows' => $rows,
            ];
        } catch (RuntimeException $e) {
            throw $e;
        } catch (Throwable $e) {
            throw new RuntimeException(
                'Unable to convert quotation Excel file: '.$e->getMessage(),
                502,
                $e
            );
        } finally {
            @unlink($tmp);
        }
    }

    /**
     * @return array{client_email: string, private_key: string}
     */
    private function loadServiceAccountCredentials(): array
    {
        $raw = trim((string) config('google_drive.service_account_json', ''));
        if ($raw === '') {
            throw new RuntimeException(
                'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not configured on the server.',
                503
            );
        }

        if (is_file($raw) && is_readable($raw)) {
            $raw = (string) file_get_contents($raw);
        }

        $decoded = json_decode($raw, true);
        if (! is_array($decoded)) {
            throw new RuntimeException(
                'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not valid JSON or a readable file path.',
                503
            );
        }

        $email = trim((string) ($decoded['client_email'] ?? ''));
        $privateKey = (string) ($decoded['private_key'] ?? '');
        if ($email === '' || $privateKey === '') {
            throw new RuntimeException(
                'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON must include client_email and private_key.',
                503
            );
        }

        return [
            'client_email' => $email,
            'private_key' => $privateKey,
        ];
    }

    /**
     * @param  array{client_email: string, private_key: string}  $credentials
     */
    private function fetchAccessToken(array $credentials): string
    {
        $now = time();
        $header = $this->base64UrlEncode(json_encode(['alg' => 'RS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR));
        $claim = $this->base64UrlEncode(json_encode([
            'iss' => $credentials['client_email'],
            'scope' => self::SCOPE,
            'aud' => self::TOKEN_URL,
            'iat' => $now,
            'exp' => $now + 3600,
        ], JSON_THROW_ON_ERROR));

        $unsigned = $header.'.'.$claim;
        $signature = '';
        $ok = openssl_sign($unsigned, $signature, $credentials['private_key'], OPENSSL_ALGO_SHA256);
        if (! $ok) {
            throw new RuntimeException(
                'Unable to sign Google service-account JWT. Check the private key.',
                503
            );
        }

        $jwt = $unsigned.'.'.$this->base64UrlEncode($signature);

        $response = $this->http(20)
            ->asForm()
            ->acceptJson()
            ->post(self::TOKEN_URL, [
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion' => $jwt,
            ]);

        if (! $response->successful()) {
            $message = $response->json('error_description')
                ?? $response->json('error')
                ?? $response->body()
                ?: 'Google OAuth token exchange failed.';
            throw new RuntimeException(
                'Unable to authenticate with Google Drive: '.$message,
                $response->status() >= 400 ? $response->status() : 502
            );
        }

        $token = trim((string) ($response->json('access_token') ?? ''));
        if ($token === '') {
            throw new RuntimeException('Google Drive token response did not include access_token.', 502);
        }

        return $token;
    }

    private function http(int $timeoutSeconds): PendingRequest
    {
        return Http::timeout($timeoutSeconds)->withOptions([
            'verify' => $this->resolveSslVerifyPath(),
        ]);
    }

    /**
     * Prefer an explicit CA bundle so Windows/local PHP without curl.cainfo still works.
     */
    private function resolveSslVerifyPath(): string|bool
    {
        $configured = config('google_drive.http_verify');
        if ($configured === false || $configured === 0 || $configured === '0' || $configured === 'false') {
            return false;
        }

        if (is_string($configured) && $configured !== '' && $configured !== '1' && $configured !== 'true') {
            return is_file($configured) ? $configured : true;
        }

        $candidates = array_filter([
            storage_path('app/certs/cacert.pem'),
            (string) env('CURL_CA_BUNDLE', ''),
            (string) ini_get('curl.cainfo'),
            (string) ini_get('openssl.cafile'),
        ]);

        foreach ($candidates as $path) {
            if (is_string($path) && $path !== '' && is_file($path)) {
                return $path;
            }
        }

        return true;
    }

    private function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}
