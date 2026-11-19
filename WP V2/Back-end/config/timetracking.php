<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Time Tracking API (TSA TimeSheet)
    |--------------------------------------------------------------------------
    |
    | https://timetracking.trevorsadd.co.uk
    | All Work Planner users fetch TT data through the service account below.
    |
    */
    'base_url' => rtrim(env('TIMETRACKING_BASE_URL', 'https://timetracking.trevorsadd.co.uk'), '/'),

    'login' => env('TIMETRACKING_LOGIN', 'yomna'),
    'password' => env('TIMETRACKING_PASSWORD', ''),
];
