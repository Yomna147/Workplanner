<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class EnsureSalesToolIntegration
{
    public function handle(Request $request, Closure $next): Response
    {
        $expected = trim((string) config('sales_tool.integration_token', ''));
        if ($expected === '') {
            return response()->json([
                'message' => 'Sales Tool integration token is not configured on WorkPlanner.',
            ], 503);
        }

        $header = (string) $request->header('Authorization', '');
        $token = '';
        if (str_starts_with($header, 'Bearer ')) {
            $token = trim(substr($header, 7));
        }
        if ($token === '') {
            $token = trim((string) $request->header('X-Sales-Tool-Token', ''));
        }

        if ($token === '' || ! hash_equals($expected, $token)) {
            return response()->json(['message' => 'Unauthorized.'], 401);
        }

        return $next($request);
    }
}
