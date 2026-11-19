<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\TimeTrackingService;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;
use Throwable;

class TimeTrackingController extends Controller
{
    public function __construct(
        private readonly TimeTrackingService $service,
    ) {}

    /**
     * TT UserLogin — same as v1: loginname/password from the request body,
     * falling back to the server-side yomna service account.
     */
    public function login(Request $request): JsonResponse
    {
        try {
            $login = trim((string) $request->input('loginname', ''));
            $password = (string) $request->input('password', '');
            if ($login === '' || $password === '') {
                $token = $this->service->loginWithServiceAccount();
                $login = $this->service->serviceLoginName();
            } else {
                $token = $this->service->login($login, $password);
            }
        } catch (RuntimeException $e) {
            return $this->ttError($e);
        } catch (Throwable $e) {
            return $this->ttError(new RuntimeException(
                'Time Tracking login failed. The service may be unreachable.',
                0,
                $e
            ));
        }

        return response()->json([
            'token' => $token,
            'loginname' => $login,
            'base_url' => $this->service->baseUrl(),
        ]);
    }

    /** Postman: Getprojectlist */
    public function projects(Request $request): JsonResponse
    {
        return $this->proxy($request, fn (string $token) => $this->service->getProjectList($token));
    }

    /** Postman: Getuserlist */
    public function users(Request $request): JsonResponse
    {
        return $this->proxy(
            $request,
            fn (string $token) => $this->service->getUserList($token, $request->all()),
        );
    }

    /** Postman: IndividualSearch — single query */
    public function individualSearch(Request $request): JsonResponse
    {
        return $this->proxy(
            $request,
            fn (string $token) => $this->service->searchIndividualReport($token, $request->all()),
        );
    }

    /** Server-side bulk IndividualSearch (year/month batches) — same as v1 */
    public function individualSearchAll(Request $request): JsonResponse
    {
        return $this->proxy(
            $request,
            fn (string $token) => $this->service->searchAllReports($token, $request->all()),
        );
    }

    /**
     * @param  callable(string): mixed  $callback
     */
    private function proxy(Request $request, callable $callback): JsonResponse
    {
        try {
            $token = $this->extractTtToken($request);

            return response()->json($callback($token));
        } catch (RuntimeException $e) {
            return $this->ttError($e);
        } catch (Throwable $e) {
            return $this->ttError(new RuntimeException(
                'Time Tracking request failed. The service may be unreachable.',
                0,
                $e
            ));
        }
    }

    private function ttError(RuntimeException $e): JsonResponse
    {
        $previous = $e->getPrevious();
        $unreachable = $previous instanceof ConnectionException
            || str_contains(strtolower($e->getMessage()), 'unreachable');

        return response()->json([
            'message' => $e->getMessage(),
            'base_url' => $this->service->baseUrl(),
        ], $unreachable ? 502 : 500);
    }

    /**
     * v1 passed the TT JWT in Authorization (routes were public).
     * v2 uses Sanctum on Authorization for WP auth, so the TT JWT must be sent separately.
     */
    private function extractTtToken(Request $request): string
    {
        $ttToken = trim(str_replace('Bearer ', '', (string) $request->header('X-TT-Token', '')));

        if ($ttToken !== '') {
            return $ttToken;
        }

        throw new RuntimeException(
            'Missing Time Tracking token. Send the TT JWT in the X-TT-Token header '
            .'(Authorization is reserved for Work Planner Sanctum auth in v2).'
        );
    }
}
