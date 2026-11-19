<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Google Drive — quotation spreadsheets
    |--------------------------------------------------------------------------
    |
    | Service account JSON key (file path or inline JSON) plus the shared
    | Drive folder that holds quotation Google Sheets.
    |
    | Grant the service account Editor access on that folder so Excel
    | Quotation forms can be saved as Google Sheets for import.
    |
    */
    'service_account_json' => env('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON', ''),

    'quotations_folder_id' => env('GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID', ''),

    /*
    | Only list spreadsheets under the year subfolder of the root quotations folder
    | (e.g. "2026 Quotations"). Leave empty to list the whole tree.
    */
    'quotations_year_folder' => env('GOOGLE_DRIVE_QUOTATIONS_YEAR_FOLDER', ''),

    /*
    | Only list / import workbooks that contain this sheet tab.
    */
    'required_sheet_name' => env('GOOGLE_DRIVE_REQUIRED_SHEET_NAME', 'Adjudication - TEMPL'),

    /*
    | Only list quotations whose date falls in [now - N months, end of current month].
    | Uses YYYY.MM.DD / YYYY-MM-DD filename prefix when present, else Drive modifiedTime.
    */
    'list_months_back' => (int) env('GOOGLE_DRIVE_LIST_MONTHS_BACK', 1),

    /*
    | SSL verify for Drive HTTP calls. Same pattern as availability Sheets client.
    | Default looks for storage/app/certs/cacert.pem then PHP ini curl.cainfo.
    */
    'http_verify' => env('GOOGLE_DRIVE_HTTP_VERIFY', true),
];
