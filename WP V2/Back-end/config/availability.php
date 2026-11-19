<?php

return [

  /*
  |--------------------------------------------------------------------------
  | TSA availability Google Sheet
  |--------------------------------------------------------------------------
  |
  | Used by the scheduled import (availabilities:import-scheduled) and can be
  | overridden per environment. The sheet must be shared: Anyone with the link
  | → Viewer.
  |
  */

  'spreadsheet_id' => env(
    'AVAILABILITY_SPREADSHEET_ID',
    '1Tb09YWWG-w8V4QCYZyrmz-uXvYeRl-ZJa5DW5C1QAf8',
  ),

  'google_sheets_api_key' => env('GOOGLE_SHEETS_API_KEY', env('VITE_GOOGLE_SHEETS_API_KEY')),

  /** How many calendar months to import starting from the current month. */
  'scheduled_months_ahead' => (int) env('AVAILABILITY_SCHEDULED_MONTHS', 3),

  /*
  | Path to a CA bundle for Google Sheets HTTPS (fixes cURL error 60 on Windows).
  | Set AVAILABILITY_HTTP_VERIFY=false only as a last resort for local debugging.
  | Default looks for storage/app/certs/cacert.pem then PHP ini curl.cainfo.
  */
  'http_verify' => env('AVAILABILITY_HTTP_VERIFY', true),

];
