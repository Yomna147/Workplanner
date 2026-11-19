<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Sales Tool integration
    |--------------------------------------------------------------------------
    |
    | Used for System Monitor health probes and the ST → WP project upsert API.
    | The integration token must match WORKPLANNER_INTEGRATION_TOKEN on Sales Tool.
    |
    | Live sync reads eligible CRM deals from the Sales Tool MySQL database
    | (connection: sales_tool) and upserts pending proposals on Home load/refresh.
    |
    */
    'base_url' => rtrim((string) env('SALES_TOOL_BASE_URL', ''), '/'),
    'integration_token' => (string) env('SALES_TOOL_INTEGRATION_TOKEN', ''),

    /** When true, GET /sales-tool/proposals?sync_from_st=1 pulls live deals from ST DB. */
    'live_sync_enabled' => filter_var(env('SALES_TOOL_LIVE_SYNC', true), FILTER_VALIDATE_BOOLEAN),

    /** Max deals to propose per sync request. */
    'live_sync_limit' => max(1, (int) env('SALES_TOOL_LIVE_SYNC_LIMIT', 80)),
];
