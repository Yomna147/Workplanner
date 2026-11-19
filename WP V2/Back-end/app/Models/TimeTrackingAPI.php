<?php

namespace App\Models;

use Illuminate\Support\Facades\Http;

/**
 * Time Tracking API — aligned with TimeTracking Postman collection.
 * Base: https://timetracking.trevorsadd.co.uk
 */
class TimeTrackingAPI
{
    protected static string $baseUrl = 'https://timetracking.trevorsadd.co.uk';

    /** POST /account/login — subscription is {} */
    public static function login($username, $password)
    {
        $payload = [
            'loginname' => $username,
            'password' => $password,
            'subscription' => (object) [],
        ];

        $response = Http::withOptions(['verify' => false])
            ->post(self::$baseUrl . '/api/account/login', $payload);

        $body = $response->body();
        $json = $response->json();
        if (is_array($json) && isset($json['token'])) {
            return $json;
        }

        return ['token' => is_string($body) ? trim($body, '"') : $body];
    }

    /** POST /reports/GetView — Postman: IndividualSearch */
    public static function individualSearch(array $options = [])
    {
        $payload = self::buildReportSearchPayload($options);

        return Http::withToken(session('tokan'))
            ->withoutVerifying()
            ->post(self::$baseUrl . '/api/reports/GetView', $payload)
            ->json();
    }

    /** POST /project/search — auth only, no body (Postman: Getprojectlist) */
    public static function getProjectList()
    {
        return Http::withToken(session('tokan'))
            ->withoutVerifying()
            ->post(self::$baseUrl . '/api/project/search')
            ->json();
    }

    /** POST /Account/Getreportstousers — Postman: Getuserlist */
    public static function getUserList($employeeId, $firstName, $lastName, $loginName)
    {
        $payload = [
            'id' => $employeeId,
            'firstname' => $firstName,
            'lastname' => $lastName,
            'loginname' => $loginName,
        ];

        return Http::withToken(session('tokan'))
            ->withoutVerifying()
            ->post(self::$baseUrl . '/api/Account/Getreportstousers', $payload)
            ->json();
    }

    public static function buildReportSearchPayload(array $options = []): array
    {
        $startDate = $options['startDate'] ?? '';
        $endDate = $options['endDate'] ?? '';
        $userId = $options['userId'] ?? null;
        $projectId = $options['projectId'] ?? null;
        $loginname = $options['loginname'] ?? '';
        $pagesize = $options['pagesize'] ?? 10000;

        $filter = [
            [
                'table' => 'p',
                'column' => 'id',
                'value' => $projectId !== null && $projectId !== '' ? (string) $projectId : '',
                'paraname' => 'pid',
                'operation' => '=',
            ],
            [
                'table' => 't',
                'column' => 'date',
                'value' => $startDate,
                'paraname' => 'sdate',
                'operation' => '>=',
            ],
            [
                'table' => 'u',
                'column' => 'loginname',
                'value' => $loginname,
            ],
        ];

        if ($userId !== null && $userId !== '') {
            $filter[] = [
                'table' => 'u',
                'column' => 'id',
                'value' => (string) $userId,
                'operation' => 'In',
            ];
        } else {
            $filter[] = [
                'table' => 'u',
                'column' => 'id',
                'value' => '',
            ];
        }

        $filter[] = [
            'table' => 't',
            'column' => 'date',
            'value' => $endDate,
            'paraname' => 'edate',
            'operation' => '<=',
        ];
        $filter[] = [
            'table' => 'pr',
            'column' => 'id',
            'value' => '',
            'paraname' => 'prid',
            'operation' => '=',
        ];
        $filter[] = [
            'table' => 'a',
            'column' => 'id',
            'value' => '',
            'paraname' => 'aid',
            'operation' => '=',
        ];
        $filter[] = [
            'table' => 's',
            'column' => 'id',
            'value' => '',
            'paraname' => 'sid',
            'operation' => '=',
        ];

        return [
            'pageno' => 1,
            'ispage' => true,
            'pagesize' => $pagesize,
            'sortcol' => 't.date',
            'filter' => $filter,
            'Dfilter' => ['summary' => false],
            'count' => 0,
            'duration' => 0,
        ];
    }
}
