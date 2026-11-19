<?php

/**
 * Microsoft Graph / Outlook app credentials.
 * Mirrored from Sales Tool:
 * - Deals & Enquiries → enquiries@trevorsadd.co.uk (OUTLOOK_* / CLIENT_*)
 * - Angela (Leads) → angela.lane@trevorsadd.co.uk (MICROSOFT_*)
 */
return [
    /*
    | SSL verify for Microsoft Graph token checks.
    | Uses storage/app/certs/cacert.pem when present (same pattern as Google Drive).
    */
    'http_verify' => env('OUTLOOK_HTTP_VERIFY', true),

    'deals' => [
        'tenant_id' => env('OUTLOOK_DEALS_TENANT_ID', env('OUTLOOK_TENANT_ID', env('TENANT_ID'))),
        'client_id' => env('OUTLOOK_DEALS_CLIENT_ID', env('OUTLOOK_CLIENT_ID', env('CLIENT_ID'))),
        'client_secret' => env('OUTLOOK_DEALS_CLIENT_SECRET', env('OUTLOOK_CLIENT_SECRET', env('CLIENT_SECRET'))),
        'mailbox' => env('OUTLOOK_DEALS_MAILBOX', env('OUTLOOK_USER_EMAIL', env('USER_EMAIL', 'enquiries@trevorsadd.co.uk'))),
        'label' => 'Outlook — Deals & Enquiries',
        'used_for' => 'CRM deals, Outstanding Quotations, and the Emails page',
        'auth' => 'Microsoft Graph app (server credentials)',
    ],
    'leads' => [
        'tenant_id' => env('OUTLOOK_LEADS_TENANT_ID', env('MICROSOFT_TENANT_ID')),
        'client_id' => env('OUTLOOK_LEADS_CLIENT_ID', env('MICROSOFT_CLIENT_ID')),
        'client_secret' => env('OUTLOOK_LEADS_CLIENT_SECRET', env('MICROSOFT_CLIENT_SECRET')),
        'mailbox' => env('OUTLOOK_LEADS_MAILBOX', env('MICROSOFT_MAILBOX', 'angela.lane@trevorsadd.co.uk')),
        'label' => 'Outlook — Angela (Leads)',
        'used_for' => "CRM Leads related emails from Angela's mailbox",
        'auth' => 'Microsoft Graph app (server credentials)',
    ],
];
