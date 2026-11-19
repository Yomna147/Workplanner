<?php

namespace Database\Seeders;

use App\Models\Page;
use App\Models\Role;
use App\Models\RolePermission;
use App\Support\PagePermissionCatalog;
use Illuminate\Database\Seeder;

class StandardRolesSeeder extends Seeder
{
    /** @var list<string> */
    private const TEAM_LEADER_ROLES = [
        'NRM1 leader',
        'NRM2 leader',
        'NRM3&4 leader',
        'NRM8 leader',
        'Q&A leader',
        'Support leader',
        'Managers leader',
    ];

    /** Page permission levels: 0 = none, 2 = read, 3 = read + edit */
    private const TEAM_LEADER_PAGE_PERMISSIONS = [
        'Dashboard' => 2,
        'Resource Histogram' => 2,
        'DL Input Hours' => 3,
        'User Availability' => 3,
        'Project Progress' => 3,
    ];

    private const DL_PAGE_PERMISSIONS = [
        'Dashboard' => 2,
        'Resource Histogram' => 2,
        'DL Input Hours' => 3,
        'User Availability' => 3,
        'Project Progress' => 3,
    ];

    private const USER_PAGE_PERMISSIONS = [
        'Dashboard' => 2,
        'User Availability' => 3,
        'Project Progress' => 3,
    ];

    private const TRAINER_PAGE_PERMISSIONS = [
        'Dashboard' => 2,
        'Trainings' => 3,
        'Notifications' => 3,
        'Resource Histogram' => 2,
        'User Availability' => 2,
    ];

    public function run(): void
    {
        Page::updateOrCreate(
            ['name' => 'Trainings'],
            ['route' => '/trainings'],
        );

        $pages = Page::query()->orderBy('name')->get();

        foreach (self::TEAM_LEADER_ROLES as $roleName) {
            $this->ensureRolePermissions($roleName, self::TEAM_LEADER_PAGE_PERMISSIONS, $pages);
        }

        $this->ensureRolePermissions('DLs', self::DL_PAGE_PERMISSIONS, $pages, forcePages: [
            'Project Progress' => 3,
        ]);

        $this->ensureRolePermissions('user', self::USER_PAGE_PERMISSIONS, $pages, forcePages: [
            'Project Progress' => 3,
        ]);

        $this->ensureRolePermissions('Trainers', self::TRAINER_PAGE_PERMISSIONS, $pages, forcePages: [
            'Trainings' => 3,
        ]);
    }

    /**
     * @param  array<string, int>  $template
     * @param  array<string, int>  $forcePages  Always update these pages even when the role already exists.
     */
    private function ensureRolePermissions(
        string $roleName,
        array $template,
        $pages,
        array $forcePages = [],
    ): void {
        $role = Role::firstOrCreate(['name' => $roleName]);
        $isNewRole = $role->wasRecentlyCreated;

        $dlEdit = ($template['DL Input Hours'] ?? 0) >= 3
            || ($forcePages['DL Input Hours'] ?? 0) >= 3;

        foreach ($pages as $page) {
            $permission = $template[$page->name] ?? 0;
            $shouldWrite = $isNewRole || array_key_exists($page->name, $forcePages);

            if (array_key_exists($page->name, $forcePages)) {
                $permission = $forcePages[$page->name];
            }

            $payload = PagePermissionCatalog::payloadForLevel($page->name, $permission, [
                'has_dl_edit' => $dlEdit,
            ]);

            if (! $shouldWrite) {
                RolePermission::firstOrCreate(
                    ['role_id' => $role->id, 'page' => $page->name],
                    $payload,
                );
                continue;
            }

            RolePermission::updateOrCreate(
                ['role_id' => $role->id, 'page' => $page->name],
                $payload,
            );
        }
    }
}
