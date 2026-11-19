<?php

namespace App\Support;

class PagePermissionCatalog
{
    public const ACTION_VIEW = 'view';

    /** Pages that were previously is_admin-only in the UI, regardless of role rows. */
    public const ADMIN_GATE_PAGES = [
        'Access Permissions',
        'Activity Log',
        'Role',
        'Email Notifications',
    ];

    /**
     * @return list<array{page: string, description: string, actions: list<array{key: string, label: string, description: string, group: string}>}>
     */
    public static function pages(): array
    {
        return [
            [
                'page' => 'Dashboard',
                'description' => 'Home page, stats, and shortcuts to pages the role can open.',
                'actions' => [],
            ],
            [
                'page' => 'Project Data Entry',
                'description' => 'Projects, parts, tasks, hours, and the allocation algorithm.',
                'actions' => [
                    ['key' => 'edit', 'label' => 'Edit projects, parts, and tasks', 'description' => 'Create projects, add parts, save task rows, copy, and update hours.', 'group' => 'editing'],
                    ['key' => 'run_algorithm', 'label' => 'Run algorithm', 'description' => 'Run the allocation algorithm from this page.', 'group' => 'editing'],
                    ['key' => 'delete', 'label' => 'Delete projects, parts, and tasks', 'description' => 'Remove a project, part, or selected tasks.', 'group' => 'additional'],
                    ['key' => 'view_edits_log', 'label' => 'View edits log', 'description' => 'Open Project Data Entry edit history.', 'group' => 'additional'],
                ],
            ],
            [
                'page' => 'Resource Histogram',
                'description' => 'Schedule chart: task bars, trainings, and saved schedule history.',
                'actions' => [
                    ['key' => 'edit_bars', 'label' => 'Edit histogram bars', 'description' => 'Drag, resize, reassign, save, and undo task bars. Includes the task editor.', 'group' => 'editing'],
                    ['key' => 'run_algorithm', 'label' => 'Run algorithm after save', 'description' => 'Offer to run the algorithm when saving bar edits.', 'group' => 'editing'],
                    ['key' => 'delete_trainings', 'label' => 'Delete trainings from the histogram', 'description' => 'Remove a training assignment or whole session from histogram panels.', 'group' => 'additional'],
                ],
            ],
            [
                'page' => 'Trainings',
                'description' => 'Training roster, gap view, and course catalog.',
                'actions' => [
                    ['key' => 'assign', 'label' => 'Create and edit training assignments', 'description' => 'New training, roster save, status changes, and gap-view edits.', 'group' => 'editing'],
                    ['key' => 'delete', 'label' => 'Delete trainings', 'description' => 'Remove a trainee row or a whole training session.', 'group' => 'additional'],
                    ['key' => 'manage_courses', 'label' => 'Manage course catalog', 'description' => 'Add, edit, or archive training courses.', 'group' => 'additional'],
                    ['key' => 'view_activity_log', 'label' => 'View trainings edit log', 'description' => 'Open training assignment history.', 'group' => 'additional'],
                    ['key' => 'receive_gap_alerts', 'label' => 'Receive gap alerts', 'description' => 'See capacity-gap banners and notifications.', 'group' => 'notifications'],
                    ['key' => 'assign_from_gaps', 'label' => 'Assign from gap alerts', 'description' => 'Create a training directly from a gap notification.', 'group' => 'notifications'],
                ],
            ],
            [
                'page' => 'User Availability',
                'description' => 'Operative timesheets and availability import.',
                'actions' => [
                    ['key' => 'edit', 'label' => 'Edit availability', 'description' => 'Add, edit, duplicate, and delete availability rows, then save.', 'group' => 'editing'],
                    ['key' => 'import', 'label' => 'Import availability', 'description' => 'Import from spreadsheet or scheduled sheet pull.', 'group' => 'editing'],
                    ['key' => 'duplicate_week', 'label' => 'Duplicate week', 'description' => 'Copy a week of hours onto another week.', 'group' => 'editing'],
                ],
            ],
            [
                'page' => 'DL Input Hours',
                'description' => 'DL plan hours on project tasks and the signed-in operative’s trainings.',
                'actions' => [
                    ['key' => 'edit', 'label' => 'Edit DL plan hours', 'description' => 'Change and save DL task fields.', 'group' => 'editing'],
                    ['key' => 'run_algorithm', 'label' => 'Run algorithm after save', 'description' => 'Offer to run the algorithm when saving DL updates.', 'group' => 'editing'],
                    ['key' => 'edit_own_trainings', 'label' => 'Edit own trainings', 'description' => 'Update the signed-in operative’s training rows on this page.', 'group' => 'editing'],
                ],
            ],
            [
                'page' => 'Project Progress',
                'description' => "Measurer's Time Planning — section expected hours by operative.",
                'actions' => [
                    ['key' => 'edit_hours', 'label' => 'Edit section hours', 'description' => 'Enter and save section expected hours (typically the operative’s own rows).', 'group' => 'editing'],
                    ['key' => 'view_all_employees', 'label' => 'View all operatives', 'description' => 'Pick any employee, not only the signed-in operative.', 'group' => 'additional'],
                    ['key' => 'approve_hours', 'label' => 'Approve section hours', 'description' => 'Tick DL approval. Hour fields stay read-only for approvers who are not admins.', 'group' => 'additional'],
                ],
            ],
            [
                'page' => 'Operatives Allocation',
                'description' => 'OAP / performance matrix, teams, NRM sections, and operatives.',
                'actions' => [
                    ['key' => 'edit', 'label' => 'Edit allocation values', 'description' => 'Change and save OAP or performance cells.', 'group' => 'editing'],
                    ['key' => 'delete_employees', 'label' => 'Delete operatives', 'description' => 'Remove selected employees from the allocation table.', 'group' => 'additional'],
                    ['key' => 'manage_employees', 'label' => 'Add / rename operatives', 'description' => 'Create employees and edit names.', 'group' => 'additional'],
                    ['key' => 'manage_teams', 'label' => 'Manage teams', 'description' => 'Create, rename, or delete teams.', 'group' => 'additional'],
                    ['key' => 'manage_nrms', 'label' => 'Manage NRM sections', 'description' => 'Create, rename, or delete NRM sections.', 'group' => 'additional'],
                ],
            ],
            [
                'page' => 'TT Project Hours',
                'description' => 'Time Tracking hours matched to Work Planner projects.',
                'actions' => [
                    ['key' => 'refresh', 'label' => 'Load / refresh from Time Tracking', 'description' => 'Pull live TT data and save it into Work Planner.', 'group' => 'editing'],
                ],
            ],
            [
                'page' => 'System Monitor',
                'description' => 'Application, database, and integration health.',
                'actions' => [
                    ['key' => 'probe', 'label' => 'Run live probes', 'description' => 'Refresh checks against Time Tracking and Google Sheets.', 'group' => 'editing'],
                ],
            ],
            [
                'page' => 'Access Permissions',
                'description' => 'User accounts, passwords, active flag, and role assignment.',
                'actions' => [
                    ['key' => 'manage_users', 'label' => 'Manage users', 'description' => 'Add, edit, deactivate, or delete users and assign roles.', 'group' => 'editing'],
                ],
            ],
            [
                'page' => 'Activity Log',
                'description' => 'Cross-page audit log of plan, histogram, and training edits.',
                'actions' => [],
            ],
            [
                'page' => 'Role',
                'description' => 'Role names and the page/action matrix.',
                'actions' => [
                    ['key' => 'manage_roles', 'label' => 'Manage roles and pages', 'description' => 'Create, edit, or delete roles and add pages to the catalogue.', 'group' => 'editing'],
                ],
            ],
            [
                'page' => 'Email Notifications',
                'description' => 'In-app and email notification rules.',
                'actions' => [
                    ['key' => 'manage_rules', 'label' => 'Manage notification rules', 'description' => 'Create, edit, test, or delete rules and delivery settings.', 'group' => 'editing'],
                ],
            ],
        ];
    }

    /**
     * @return array<string, array{description: string, actions: list<array{key: string, label: string, description: string, group: string}>}>
     */
    public static function keyed(): array
    {
        $keyed = [];
        foreach (self::pages() as $page) {
            $keyed[$page['page']] = [
                'description' => $page['description'],
                'actions' => $page['actions'],
            ];
        }

        return $keyed;
    }

    /**
     * @return list<string>
     */
    public static function actionKeys(string $pageName): array
    {
        $page = self::keyed()[$pageName] ?? null;
        if (! $page) {
            return [];
        }

        return array_values(array_map(static fn (array $action) => $action['key'], $page['actions']));
    }

    /**
     * Actions granted automatically when a role has Read + Edit (3) and no explicit action list.
     *
     * @return list<string>
     */
    public static function defaultEditActions(string $pageName): array
    {
        $page = self::keyed()[$pageName] ?? null;
        if (! $page) {
            return [];
        }

        $keys = [];
        foreach ($page['actions'] as $action) {
            if (($action['group'] ?? 'editing') === 'editing') {
                $keys[] = $action['key'];
            }
        }

        return $keys;
    }

    /**
     * Resolve stored 0/2/3 (+ optional notification level) into an action list.
     *
     * @param  array{notification_permission?: int, has_dl_edit?: bool}  $context
     * @return list<string>
     */
    public static function legacyActions(string $pageName, int $permission, array $context = []): array
    {
        if ($permission < 2) {
            return [];
        }

        if ($permission < 3) {
            return self::legacyViewOnlyExtras($pageName, $context);
        }

        $actions = self::defaultEditActions($pageName);
        $actions = array_merge($actions, self::legacyViewOnlyExtras($pageName, $context));

        if ($pageName === 'Project Progress' && ! empty($context['has_dl_edit'])) {
            $actions[] = 'view_all_employees';
            $actions[] = 'approve_hours';
        }

        return array_values(array_unique($actions));
    }

    /**
     * @param  array{notification_permission?: int}  $context
     * @return list<string>
     */
    private static function legacyViewOnlyExtras(string $pageName, array $context): array
    {
        if ($pageName !== 'Trainings') {
            return [];
        }

        $notify = (int) ($context['notification_permission'] ?? 0);
        if ($notify <= 0) {
            return [];
        }

        $actions = ['receive_gap_alerts'];
        if ($notify >= 3) {
            $actions[] = 'assign_from_gaps';
        }

        return $actions;
    }

    public static function sanitizeActions(string $pageName, mixed $actions): array
    {
        $allowed = array_flip(self::actionKeys($pageName));
        if (! is_array($actions) || $allowed === []) {
            return [];
        }

        $clean = [];
        foreach ($actions as $action) {
            $key = is_string($action) ? $action : '';
            if ($key !== '' && isset($allowed[$key])) {
                $clean[$key] = $key;
            }
        }

        return array_values($clean);
    }

    /**
     * Seed / persist helper: permission level plus derived actions.
     *
     * @param  array{notification_permission?: int, has_dl_edit?: bool, all_actions?: bool}  $context
     * @return array{permission: int, actions: list<string>, notification_permission?: int}
     */
    public static function payloadForLevel(string $pageName, int $permission, array $context = []): array
    {
        $permission = $permission >= 3 ? 3 : ($permission >= 2 ? 2 : 0);
        $actions = ! empty($context['all_actions']) && $permission >= 2
            ? self::actionKeys($pageName)
            : self::legacyActions($pageName, $permission, $context);

        if (
            $pageName === 'Trainings'
            && $permission >= 2
            && empty($context['all_actions'])
            && (int) ($context['notification_permission'] ?? 0) <= 0
        ) {
            $actions = self::legacyActions($pageName, $permission, [
                ...$context,
                'notification_permission' => $permission,
            ]);
        }

        $payload = [
            'permission' => $permission,
            'actions' => $actions,
        ];

        $payload['notification_permission'] = self::notificationLevelFromActions($pageName, $actions);

        return $payload;
    }

    public static function permissionLevelFromActions(int $viewLevel, array $actions): int
    {
        if ($viewLevel < 2) {
            return 0;
        }

        return $actions === [] ? 2 : 3;
    }

    public static function notificationLevelFromActions(string $pageName, array $actions): int
    {
        if ($pageName !== 'Trainings') {
            return 0;
        }

        if (in_array('assign_from_gaps', $actions, true)) {
            return 3;
        }

        if (in_array('receive_gap_alerts', $actions, true)) {
            return 2;
        }

        return 0;
    }

    /**
     * Payload for the Roles admin UI.
     *
     * @return list<array{page: string, description: string, actions: list<array{key: string, label: string, description: string, group: string}>}>
     */
    public static function forClient(): array
    {
        return self::pages();
    }
}
