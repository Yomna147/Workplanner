<?php

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use RuntimeException;

class GoogleSheetsValuesClient
{
  public function __construct(
    private readonly string $apiKey,
    private readonly string $spreadsheetId,
  ) {}

  /**
   * @return list<string>
   */
  public function listSheetTitles(): array
  {
    $response = $this->http(30)->get(
      "https://sheets.googleapis.com/v4/spreadsheets/{$this->spreadsheetId}",
      [
        'key' => $this->apiKey,
        'fields' => 'sheets(properties(title))',
      ],
    );

    if (! $response->successful()) {
      $message = $response->json('error.message') ?? "HTTP {$response->status()}";
      throw new RuntimeException("Unable to read spreadsheet metadata: {$message}");
    }

    return collect($response->json('sheets', []))
      ->map(fn (array $sheet) => (string) ($sheet['properties']['title'] ?? ''))
      ->filter()
      ->values()
      ->all();
  }

  /**
   * @return list<list<string|null>>
   */
  public function fetchSheetRows(string $sheetTitle): array
  {
    $range = $this->buildFullSheetRange($sheetTitle);
    $response = $this->http(60)->get(
      'https://sheets.googleapis.com/v4/spreadsheets/'.$this->spreadsheetId.'/values/'.rawurlencode($range),
      ['key' => $this->apiKey],
    );

    if (! $response->successful()) {
      $message = $response->json('error.message') ?? "HTTP {$response->status()}";
      throw new RuntimeException("Unable to fetch sheet \"{$sheetTitle}\": {$message}");
    }

    $rows = $response->json('values', []);

    if ($rows === []) {
      throw new RuntimeException("No data found in sheet \"{$sheetTitle}\".");
    }

    return $rows;
  }

  private function buildFullSheetRange(string $sheetTitle): string
  {
    $response = $this->http(30)->get(
      "https://sheets.googleapis.com/v4/spreadsheets/{$this->spreadsheetId}",
      [
        'key' => $this->apiKey,
        'fields' => 'sheets(properties(title,gridProperties(rowCount,columnCount)))',
      ],
    );

    if (! $response->successful()) {
      $message = $response->json('error.message') ?? "HTTP {$response->status()}";
      throw new RuntimeException("Unable to read sheet dimensions: {$message}");
    }

    $sheet = collect($response->json('sheets', []))
      ->first(fn (array $item) => $this->normalizeTitle($item['properties']['title'] ?? '')
        === $this->normalizeTitle($sheetTitle));

    if (! $sheet) {
      throw new RuntimeException("Sheet tab \"{$sheetTitle}\" was not found.");
    }

    $rowCount = (int) ($sheet['properties']['gridProperties']['rowCount'] ?? 1000);
    $columnCount = (int) ($sheet['properties']['gridProperties']['columnCount'] ?? 26);
    $endColumn = $this->columnNumberToLabel($columnCount);

    return "'{$sheet['properties']['title']}'!A1:{$endColumn}{$rowCount}";
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
    $configured = config('availability.http_verify');
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

  private function normalizeTitle(string $title): string
  {
    return mb_strtolower(trim($title));
  }

  private function columnNumberToLabel(int $columnNumber): string
  {
    $label = '';
    $number = max(1, $columnNumber);

    while ($number > 0) {
      $number--;
      $label = chr(65 + ($number % 26)).$label;
      $number = intdiv($number, 26);
    }

    return $label;
  }
}
