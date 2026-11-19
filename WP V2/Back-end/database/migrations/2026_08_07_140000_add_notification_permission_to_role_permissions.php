<?php

use App\Models\Role;
use App\Models\RolePermission;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('role_permissions', function (Blueprint $table) {
            $table->unsignedTinyInteger('notification_permission')->default(0)->after('permission');
        });

        RolePermission::query()
            ->where('page', 'Notifications')
            ->get()
            ->each(function (RolePermission $notificationRow) {
                RolePermission::query()
                    ->where('role_id', $notificationRow->role_id)
                    ->where('page', 'Trainings')
                    ->update(['notification_permission' => $notificationRow->permission]);
            });

        RolePermission::query()
            ->where('page', 'Trainings')
            ->where('permission', '>=', 2)
            ->where('notification_permission', 0)
            ->get()
            ->each(function (RolePermission $row) {
                $row->update(['notification_permission' => $row->permission]);
            });

        $trainersRole = Role::query()->where('name', 'Trainers')->first();
        if ($trainersRole) {
            RolePermission::query()->updateOrCreate(
                ['role_id' => $trainersRole->id, 'page' => 'Trainings'],
                ['permission' => 3, 'notification_permission' => 3],
            );
        }
    }

    public function down(): void
    {
        Schema::table('role_permissions', function (Blueprint $table) {
            $table->dropColumn('notification_permission');
        });
    }
};
