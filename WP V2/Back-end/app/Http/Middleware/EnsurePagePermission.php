<?php

namespace App\Http\Middleware;

use App\Support\PageAccess;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class EnsurePagePermission
{
    /** Mutating paths that any authenticated user may call. */
    private const OPEN_MUTATIONS = [
        'logout',
    ];

    /**
     * @var list<array{methods: list<string>, pattern: string, any: list<array{0: string, 1?: string}>}>
     */
    private const RULES = [
        ['methods' => ['GET'], 'pattern' => '#^admin/system-monitor$#', 'any' => [['System Monitor', 'view']]],
        ['methods' => ['POST'], 'pattern' => '#^admin/system-monitor/probe$#', 'any' => [['System Monitor', 'probe']]],

        ['methods' => ['GET'], 'pattern' => '#^admin/activity-logs$#', 'any' => [['Activity Log', 'view']]],

        ['methods' => ['GET'], 'pattern' => '#^admin/email-notification-rules$#', 'any' => [['Email Notifications', 'view']]],
        ['methods' => ['POST', 'PUT', 'PATCH', 'DELETE'], 'pattern' => '#^admin/email-notification-rules#', 'any' => [['Email Notifications', 'manage_rules']]],

        ['methods' => ['GET'], 'pattern' => '#^admin/users$#', 'any' => [
            ['Access Permissions', 'view'],
            ['Activity Log', 'view'],
            ['Email Notifications', 'view'],
        ]],
        ['methods' => ['POST', 'DELETE'], 'pattern' => '#^admin/users#', 'any' => [['Access Permissions', 'manage_users']]],

        ['methods' => ['GET'], 'pattern' => '#^roles(/\d+)?$#', 'any' => [
            ['Role', 'view'],
            ['Access Permissions', 'view'],
        ]],
        ['methods' => ['POST', 'PUT', 'PATCH', 'DELETE'], 'pattern' => '#^roles#', 'any' => [['Role', 'manage_roles']]],
        ['methods' => ['GET'], 'pattern' => '#^pages$#', 'any' => [['Role', 'view']]],
        ['methods' => ['POST'], 'pattern' => '#^pages$#', 'any' => [['Role', 'manage_roles']]],

        ['methods' => ['POST'], 'pattern' => '#^algorithm/(run|run/init|run/step|save-results|clear)$#', 'any' => [
            ['Project Data Entry', 'run_algorithm'],
            ['Resource Histogram', 'run_algorithm'],
            ['DL Input Hours', 'run_algorithm'],
        ]],

        ['methods' => ['POST'], 'pattern' => '#^resource-histogram/save-bar-edits$#', 'any' => [['Resource Histogram', 'edit_bars']]],
        ['methods' => ['POST'], 'pattern' => '#^resource-histogram/activity-logs/\d+/revert$#', 'any' => [['Resource Histogram', 'edit_bars']]],

        ['methods' => ['POST', 'PUT', 'PATCH'], 'pattern' => '#^trainings(/\d+)?$#', 'any' => [
            ['Trainings', 'assign'],
            ['DL Input Hours', 'edit_own_trainings'],
        ]],
        ['methods' => ['DELETE'], 'pattern' => '#^trainings/\d+$#', 'any' => [
            ['Trainings', 'delete'],
            ['Resource Histogram', 'delete_trainings'],
        ]],
        ['methods' => ['POST', 'PUT', 'PATCH', 'DELETE'], 'pattern' => '#^training-courses#', 'any' => [['Trainings', 'manage_courses']]],

        ['methods' => ['POST'], 'pattern' => '#^timetracking-(login|projects)$#', 'any' => [
            ['TT Project Hours', 'refresh'],
            ['Project Data Entry', 'edit'],
            ['Project Data Entry', 'view'],
        ]],
        ['methods' => ['POST'], 'pattern' => '#^timetracking-#', 'any' => [['TT Project Hours', 'refresh']]],
        ['methods' => ['PUT', 'PATCH'], 'pattern' => '#^tt-hours-cache$#', 'any' => [['TT Project Hours', 'refresh']]],

        ['methods' => ['GET'], 'pattern' => '#^integrations/google-drive/quotations$#', 'any' => [
            ['Project Data Entry', 'edit'],
            ['Project Data Entry', 'view'],
        ]],
        ['methods' => ['GET'], 'pattern' => '#^integrations/google-drive/quotations/search$#', 'any' => [
            ['Project Data Entry', 'edit'],
            ['Project Data Entry', 'view'],
        ]],
        ['methods' => ['POST'], 'pattern' => '#^integrations/google-drive/quotations/import$#', 'any' => [
            ['Project Data Entry', 'edit'],
        ]],

        ['methods' => ['POST'], 'pattern' => '#^projects/rebalance-pp$#', 'any' => [['Project Data Entry', 'run_algorithm']]],
        ['methods' => ['POST'], 'pattern' => '#^projects/(with-tasks|copy)$#', 'any' => [['Project Data Entry', 'edit']]],
        ['methods' => ['POST'], 'pattern' => '#^projects$#', 'any' => [['Project Data Entry', 'edit']]],
        ['methods' => ['PUT', 'PATCH'], 'pattern' => '#^projects/\d+$#', 'any' => [
            ['Project Data Entry', 'edit'],
            ['DL Input Hours', 'edit'],
        ]],
        ['methods' => ['DELETE'], 'pattern' => '#^projects/\d+$#', 'any' => [['Project Data Entry', 'delete']]],

        ['methods' => ['POST'], 'pattern' => '#^projects/\d+/parts$#', 'any' => [['Project Data Entry', 'edit']]],
        ['methods' => ['DELETE'], 'pattern' => '#^parts/\d+$#', 'any' => [['Project Data Entry', 'delete']]],

        ['methods' => ['POST'], 'pattern' => '#^dl-quick-update/(tasks|submissions)$#', 'any' => [
            ['DL Input Hours', 'edit'],
        ]],

        ['methods' => ['POST'], 'pattern' => '#^parts/\d+/tasks/sync$#', 'any' => [
            ['Project Data Entry', 'edit'],
            ['DL Input Hours', 'edit'],
            ['Resource Histogram', 'edit_bars'],
        ]],
        ['methods' => ['POST'], 'pattern' => '#^parts/\d+/tasks$#', 'any' => [
            ['Project Data Entry', 'edit'],
            ['DL Input Hours', 'edit'],
        ]],
        ['methods' => ['PUT', 'PATCH'], 'pattern' => '#^project-tasks/\d+$#', 'any' => [
            ['Project Data Entry', 'edit'],
            ['DL Input Hours', 'edit'],
            ['Resource Histogram', 'edit_bars'],
        ]],
        ['methods' => ['DELETE'], 'pattern' => '#^project-tasks/\d+$#', 'any' => [['Project Data Entry', 'delete']]],

        ['methods' => ['POST'], 'pattern' => '#^nrms$#', 'any' => [
            ['Project Data Entry', 'edit'],
            ['Operatives Allocation', 'manage_nrms'],
        ]],
        ['methods' => ['PUT', 'PATCH', 'DELETE'], 'pattern' => '#^nrms/\d+$#', 'any' => [
            ['Project Data Entry', 'edit'],
            ['Operatives Allocation', 'manage_nrms'],
        ]],

        ['methods' => ['POST'], 'pattern' => '#^operatives-allocation/sync$#', 'any' => [['Operatives Allocation', 'edit']]],
        ['methods' => ['POST'], 'pattern' => '#^operatives-allocation/delete-employees$#', 'any' => [['Operatives Allocation', 'delete_employees']]],

        ['methods' => ['POST'], 'pattern' => '#^employees/\d+/section-task-hours/sync$#', 'any' => [
            ['Project Progress', 'edit_hours'],
            ['Project Progress', 'approve_hours'],
        ]],

        ['methods' => ['POST'], 'pattern' => '#^employees$#', 'any' => [['Operatives Allocation', 'manage_employees']]],
        ['methods' => ['PUT', 'PATCH'], 'pattern' => '#^employees/\d+$#', 'any' => [['Operatives Allocation', 'manage_employees']]],
        ['methods' => ['DELETE'], 'pattern' => '#^employees/\d+$#', 'any' => [['Operatives Allocation', 'delete_employees']]],

        ['methods' => ['POST'], 'pattern' => '#^availabilities/sync$#', 'any' => [['User Availability', 'edit']]],
        ['methods' => ['POST'], 'pattern' => '#^availabilities/import(-scheduled)?$#', 'any' => [['User Availability', 'import']]],
        ['methods' => ['DELETE'], 'pattern' => '#^availabilities/\d+$#', 'any' => [['User Availability', 'edit']]],
        ['methods' => ['POST'], 'pattern' => '#^employees/\d+/availabilities/duplicate-week$#', 'any' => [['User Availability', 'duplicate_week']]],

        ['methods' => ['POST', 'PUT', 'PATCH', 'DELETE'], 'pattern' => '#^teams#', 'any' => [['Operatives Allocation', 'manage_teams']]],
    ];

    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if (! $user) {
            return $next($request);
        }

        $method = strtoupper($request->method());
        $uri = $this->normalizeUri($request);
        $rule = $this->matchRule($method, $uri);

        if ($rule) {
            PageAccess::assert($user, $rule['any']);

            return $next($request);
        }

        if ($this->isMutation($method) && ! in_array($uri, self::OPEN_MUTATIONS, true)) {
            abort(403, 'You do not have permission to perform this action.');
        }

        return $next($request);
    }

    private function normalizeUri(Request $request): string
    {
        $uri = (string) ($request->route()?->uri() ?? $request->path());
        $uri = ltrim($uri, '/');
        if (str_starts_with($uri, 'api/')) {
            $uri = substr($uri, 4);
        }

        return $uri;
    }

    /**
     * @return array{any: list<array{0: string, 1?: string}>}|null
     */
    private function matchRule(string $method, string $uri): ?array
    {
        foreach (self::RULES as $rule) {
            if (! in_array($method, $rule['methods'], true)) {
                continue;
            }

            $pattern = $rule['pattern'];
            $testUri = $this->concreteUri($uri);

            if (preg_match($pattern, $testUri) === 1) {
                return $rule;
            }
        }

        return null;
    }

    /**
     * Convert route URI templates (projects/{project}) to a matchable path (projects/1).
     */
    private function concreteUri(string $uri): string
    {
        return preg_replace('/\{[^}]+\}/', '0', $uri) ?? $uri;
    }

    private function isMutation(string $method): bool
    {
        return in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true);
    }
}
