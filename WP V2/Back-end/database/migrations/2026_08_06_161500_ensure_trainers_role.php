<?php

use App\Models\Page;
use App\Models\Role;
use App\Models\RolePermission;
use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    /** @var array<string, int> */
    private const TRAINER_PAGE_PERMISSIONS = [
        'Dashboard' => 2,
        'Trainings' => 3,
        'Notifications' => 3,
        'Resource Histogram' => 2,
        'User Availability' => 2,
    ];

    public function up(): void
    {
        Page::updateOrCreate(
            ['name' => 'Trainings'],
            ['route' => '/trainings'],
        );

        $role = Role::firstOrCreate(['name' => 'Trainers']);

        foreach (Page::query()->orderBy('name')->get() as $page) {
            $permission = self::TRAINER_PAGE_PERMISSIONS[$page->name] ?? 0;

            RolePermission::updateOrCreate(
                ['role_id' => $role->id, 'page' => $page->name],
                ['permission' => $permission],
            );
        }
    }

    public function down(): void
    {
        $role = Role::query()->where('name', 'Trainers')->first();
        if (! $role) {
            return;
        }

        if (\App\Models\User::query()->where('role_id', $role->id)->exists()) {
            return;
        }

        RolePermission::query()->where('role_id', $role->id)->delete();
        $role->delete();
    }
};
