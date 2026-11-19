<?php

use App\Models\Page;
use App\Models\Role;
use App\Models\RolePermission;
use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    public function up(): void
    {
        Page::updateOrCreate(
            ['name' => 'Notifications'],
            ['route' => null],
        );

        $adminRole = Role::query()->where('name', 'Administrator')->first();
        if ($adminRole) {
            RolePermission::updateOrCreate(
                ['role_id' => $adminRole->id, 'page' => 'Notifications'],
                ['permission' => 3],
            );
        }

        RolePermission::query()
            ->where('page', 'Trainings')
            ->where('permission', '>=', 2)
            ->get()
            ->each(function (RolePermission $permission) {
                RolePermission::updateOrCreate(
                    ['role_id' => $permission->role_id, 'page' => 'Notifications'],
                    ['permission' => $permission->permission],
                );
            });
    }

    public function down(): void
    {
        RolePermission::query()->where('page', 'Notifications')->delete();
        Page::query()->where('name', 'Notifications')->delete();
    }
};
