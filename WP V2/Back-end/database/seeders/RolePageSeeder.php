<?php

namespace Database\Seeders;

use App\Models\Page;
use App\Models\Role;
use App\Models\RolePermission;
use App\Support\PagePermissionCatalog;
use Illuminate\Database\Seeder;

class RolePageSeeder extends Seeder
{
    public function run(): void
    {
        $pages = [
            ['name' => 'Dashboard', 'route' => '/'],
            ['name' => 'Access Permissions', 'route' => '/admin/access-permissions'],
            ['name' => 'Activity Log', 'route' => '/admin/activity-log'],
            ['name' => 'Role', 'route' => '/admin/roles'],
            ['name' => 'Project Data Entry', 'route' => '/projects'],
            ['name' => 'Resource Histogram', 'route' => '/resource-histogram'],
            ['name' => 'Trainings', 'route' => '/trainings'],
            ['name' => 'System Monitor', 'route' => '/admin/system-monitor'],
            ['name' => 'Outlook Emails', 'route' => '/admin/outlook-emails'],
            ['name' => 'Work Plan View', 'route' => null],
            ['name' => 'User Availability', 'route' => '/user-availability'],
            ['name' => 'DL Input Hours', 'route' => '/dl-input-hours'],
            ['name' => 'Project Progress', 'route' => '/project-progress'],
            ['name' => 'TT Project Hours', 'route' => '/tt-project-hours'],
            ['name' => 'Operatives Allocation', 'route' => '/operatives-allocation'],
            ['name' => 'Email Notifications', 'route' => '/admin/email-notifications'],
            ['name' => 'Notifications', 'route' => null],
        ];

        foreach ($pages as $page) {
            Page::updateOrCreate(['name' => $page['name']], ['route' => $page['route']]);
        }

        $adminRole = Role::query()
            ->whereIn('name', ['Administrator', 'Admin'])
            ->orderByRaw("CASE WHEN name = 'Administrator' THEN 0 ELSE 1 END")
            ->first()
            ?? Role::firstOrCreate(['name' => 'Administrator']);

        foreach (Page::all() as $page) {
            RolePermission::updateOrCreate(
                ['role_id' => $adminRole->id, 'page' => $page->name],
                PagePermissionCatalog::payloadForLevel($page->name, 3, ['all_actions' => true]),
            );
        }

        $this->call(StandardRolesSeeder::class);
    }
}
