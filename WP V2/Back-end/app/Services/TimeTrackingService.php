<?php

namespace App\Services;

use App\Models\TimeTrackingAPI;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;

class TimeTrackingService
{
    protected string $baseUrl;

    public function __construct()
    {
        $this->baseUrl = (string) config('timetracking.base_url', 'https://timetracking.trevorsadd.co.uk');
    }

    public function baseUrl(): string
    {
        return $this->baseUrl;
    }

    public function serviceLoginName(): string
    {
        return (string) config('timetracking.login', '');
    }

    public function loginWithServiceAccount(): string
    {
        $login = $this->serviceLoginName();
        $password = (string) config('timetracking.password', '');

        if ($login === '' || $password === '') {
            throw new RuntimeException(
                'Time Tracking credentials are not configured. Set TIMETRACKING_LOGIN and TIMETRACKING_PASSWORD in Back-end .env.'
            );
        }

        return $this->login($login, $password);
    }

    public function login($username, $password, int $timeoutSeconds = 60)
    {
        $url = $this->endpoint('/account/login');

        $response = $this->sendTt(
            fn () => $this->ttClient($timeoutSeconds)->acceptJson()->asJson()->post($url, [
                'loginname' => $username,
                'password' => $password,
                'subscription' => (object) [],
            ]),
            $url,
            'login',
        );

        $json = $response->json();
        \Log::info('[TT Login]', [
            'url' => $url,
            'status' => $response->status(),
            'loginname' => $username,
            'body_preview' => is_string($response->body()) ? substr($response->body(), 0, 200) : null,
        ]);

        if (! $response->successful()) {
            $message = is_array($json) ? ($json['message'] ?? $json['error'] ?? null) : null;
            throw new RuntimeException(
                $message
                    ?: "Time Tracking login failed (HTTP {$response->status()}) at {$url}"
            );
        }

        return $this->parseLoginToken($response, $url);
    }

    /**
     * Confirm the Time Tracking service account can authenticate. Does not return the token.
     */
    public function healthCheck(int $timeoutSeconds = 12): void
    {
        $login = $this->serviceLoginName();
        $password = (string) config('timetracking.password', '');
        if ($login === '' || $password === '') {
            throw new RuntimeException(
                'Time Tracking credentials are not configured. Set TIMETRACKING_LOGIN and TIMETRACKING_PASSWORD in Back-end .env.'
            );
        }

        $this->login($login, $password, $timeoutSeconds);
    }

    /** POST /project/search — auth header only (Postman: Getprojectlist). */
    public function getProjectList($token)
    {
        $url = $this->endpoint('/project/search');

        $response = $this->sendTt(
            fn () => $this->ttClient(90)->withToken($token)->post($url),
            $url,
            'getProjectList',
        );

        \Log::info('[TT Projects]', ['url' => $url, 'status' => $response->status()]);

        if (! $response->successful()) {
            throw new RuntimeException("Time Tracking getProjectList failed (HTTP {$response->status()}) at {$url}");
        }

        return $response->json();
    }

    public function getUserList($token, array $user)
    {
        $url = $this->endpoint('/Account/Getreportstousers');

        $response = $this->sendTt(
            fn () => $this->ttClient(90)->withToken($token)->post($url, $user),
            $url,
            'getUserList',
        );

        \Log::info('[TT Users]', ['url' => $url, 'status' => $response->status()]);

        if (! $response->successful()) {
            throw new RuntimeException("Time Tracking getUserList failed (HTTP {$response->status()}) at {$url}");
        }

        return $response->json();
    }

    public function searchIndividualReport($token, array $filters)
    {
        $url = $this->endpoint('/reports/GetView');

        $response = $this->sendTt(
            fn () => $this->ttClient(490)->withToken($token)->post($url, $filters),
            $url,
            'searchIndividualReport',
        );

        $body = $response->body();
        \Log::info('[TT Reports]', [
            'url' => $url,
            'status' => $response->status(),
            'body_preview' => strlen($body) > 500 ? substr($body, 0, 500).'…' : $body,
        ]);

        if (! $response->successful()) {
            throw new RuntimeException("Time Tracking searchIndividualReport failed (HTTP {$response->status()}) at {$url}");
        }

        return $response->json();
    }

    /**
     * Fetch IndividualSearch rows for one date slice (months within startDate–endDate).
     * Frontend requests year-by-year; never loads 2017→today in a single response.
     */
    public function searchAllReports($token, array $options = []): array
    {
        @ini_set('memory_limit', '768M');
        @set_time_limit(900);

        $startDate = $options['startDate'] ?? date('Y').'-01-01';
        $endDate = $options['endDate'] ?? date('Y-m-d');
        $pagesize = (int) ($options['pagesize'] ?? 10000);
        $userId = $options['userId'] ?? null;
        $projectId = $options['projectId'] ?? null;
        $loginname = $options['loginname'] ?? '';

        $months = $this->buildMonthRanges($startDate, $endDate);
        $all = [];
        $monthIndex = 0;
        $reportsUrl = $this->endpoint('/reports/GetView');

        foreach ($months as $range) {
            $monthIndex++;
            $pageno = 1;

            $chunkCount = $pagesize;
            while ($chunkCount >= $pagesize) {
                $payload = TimeTrackingAPI::buildReportSearchPayload([
                    'startDate' => $range['start'],
                    'endDate' => $range['end'],
                    'userId' => $userId,
                    'projectId' => $projectId,
                    'loginname' => $loginname,
                    'pagesize' => $pagesize,
                ]);
                $payload['pageno'] = $pageno;

                $response = $this->sendTt(
                    fn () => $this->ttClient(120)->withToken($token)->post($reportsUrl, $payload),
                    $reportsUrl,
                    'searchAllReports',
                );

                if (! $response->successful()) {
                    \Log::warning('[TT Reports Slice] month failed', [
                        'url' => $reportsUrl,
                        'month' => $range['start'],
                        'status' => $response->status(),
                    ]);
                    break;
                }

                $json = $response->json();
                $chunk = (is_array($json) && isset($json['data']) && is_array($json['data']))
                    ? $json['data']
                    : [];
                $chunkCount = count($chunk);

                foreach ($chunk as $row) {
                    if (! is_array($row)) {
                        continue;
                    }
                    $slim = $this->slimReportRow($row);
                    if ($slim !== null) {
                        $all[] = $slim;
                    }
                }

                unset($response, $json, $chunk);
                $pageno++;
            }

            if ($monthIndex % 6 === 0) {
                \Log::info('[TT Reports Slice] progress', [
                    'base_url' => $this->baseUrl,
                    'range' => "{$startDate} → {$endDate}",
                    'months_done' => $monthIndex,
                    'months_total' => count($months),
                    'rows' => count($all),
                ]);
            }
        }

        \Log::info('[TT Reports Slice] complete', [
            'base_url' => $this->baseUrl,
            'range' => "{$startDate} → {$endDate}",
            'months' => count($months),
            'rows' => count($all),
        ]);

        return ['data' => $all];
    }

    /** Strip nested TT payload — full rows exhaust PHP memory when merged. */
    protected function slimReportRow(array $row): ?array
    {
        $p = is_array($row['p'] ?? null) ? $row['p'] : null;
        $a = is_array($row['a'] ?? null) ? $row['a'] : null;
        $t = is_array($row['t'] ?? null) ? $row['t'] : null;
        if ($p === null && $t === null) {
            return null;
        }

        $rawU = is_array($row['u'] ?? null) ? $row['u'] : [];
        $userId = (isset($rawU['id']) && (int) $rawU['id'] > 0)
            ? (int) $rawU['id']
            : (isset($t['userid']) ? (int) $t['userid'] : null);

        return [
            'p' => [
                'id' => $p['id'] ?? null,
                'name' => $p['name'] ?? '',
            ],
            'a' => [
                'id' => $a['id'] ?? null,
                'name' => $a['name'] ?? '',
            ],
            't' => [
                'duration' => $t['duration'] ?? 0,
                'date' => isset($t['date']) ? substr((string) $t['date'], 0, 10) : '',
                'userid' => $userId,
            ],
            'u' => [
                'id' => $userId,
                'firstname' => $rawU['firstname'] ?? '',
                'lastname' => $rawU['lastname'] ?? '',
                'loginname' => $rawU['loginname'] ?? '',
            ],
        ];
    }

    /** @return list<array{start: string, end: string}> */
    protected function buildMonthRanges(string $startDate, string $endDate): array
    {
        $ranges = [];
        $cursor = new \DateTime($startDate);
        $cursor->modify('first day of this month');
        $end = new \DateTime($endDate);
        $end->modify('first day of this month');

        while ($cursor <= $end) {
            $monthStart = $cursor->format('Y-m-01');
            $next = (clone $cursor)->modify('+1 month');
            $ranges[] = [
                'start' => $monthStart,
                'end' => $next->format('Y-m-d'),
            ];
            $cursor->modify('+1 month');
        }

        return $ranges;
    }

    /**
     * @param  \Illuminate\Http\Client\Response  $response
     */
    private function parseLoginToken($response, string $url): string
    {
        $json = $response->json();
        $token = null;
        if (is_string($json) && $json !== '') {
            $token = trim($json, "\" \n\r\t");
        } elseif (is_array($json)) {
            $token = $json['token'] ?? null;
        }
        if (! is_string($token) || $token === '') {
            $token = trim((string) $response->body(), "\" \n\r\t");
        }

        if (! is_string($token) || $token === '' || ! str_starts_with($token, 'eyJ')) {
            $preview = is_string($token) ? substr($token, 0, 80) : '';
            $looksLikeHtml = str_contains(strtolower($preview), '<!doctype')
                || str_contains(strtolower($preview), '<html');
            throw new RuntimeException(
                $looksLikeHtml
                    ? "Time Tracking login returned the TimeSheet web app instead of a token from {$url}."
                    : ($preview !== '' && ! str_starts_with($preview, 'eyJ')
                        ? "Time Tracking login rejected: {$preview}"
                        : "Time Tracking login returned no token from {$url}")
            );
        }

        return $token;
    }

    private function ttClient(int $timeoutSeconds = 60): PendingRequest
    {
        $timeout = max(3, $timeoutSeconds);
        $connect = min(12, $timeout);
        $options = [
            'verify' => false,
            'connect_timeout' => $connect,
            'timeout' => $timeout,
            // Prefer IPv4 — Windows PHP/cURL often stalls on IPv6 during connect.
            'force_ip_resolve' => 'v4',
        ];

        return Http::withOptions($options);
    }

    /**
     * @param  callable(): Response  $send
     */
    private function sendTt(callable $send, string $url, string $action): Response
    {
        try {
            return $send();
        } catch (ConnectionException $e) {
            \Log::warning('[TT Connection]', [
                'action' => $action,
                'url' => $url,
                'error' => $e->getMessage(),
            ]);

            throw new RuntimeException(
                "Time Tracking is unreachable at {$url}. The host did not respond in time. Check the network, VPN, or firewall and try again.",
                0,
                $e
            );
        } catch (Throwable $e) {
            if ($e instanceof RuntimeException) {
                throw $e;
            }

            throw new RuntimeException(
                "Time Tracking {$action} failed: ".$e->getMessage(),
                0,
                $e
            );
        }
    }

    /**
     * TimeSheet now serves the Vue app at the site root. The API lives under /api.
     * POST /account/login returns the HTML shell; POST /api/account/login returns the JWT.
     */
    private function endpoint(string $path): string
    {
        $base = rtrim($this->baseUrl, '/');
        $path = '/' . ltrim($path, '/');
        if (preg_match('#/api$#i', $base)) {
            return $base . $path;
        }

        return $base . '/api' . $path;
    }
}
