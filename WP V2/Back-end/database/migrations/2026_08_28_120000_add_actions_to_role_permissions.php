<?php

use App\Support\PagePermissionCatalog;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('role_permissions', 'actions')) {
            Schema::table('role_permissions', function (Blueprint $table) {
                $table->json('actions')->nullable()->after('permission');
            });
        }

        $adminRoleId = DB::table('roles')
            ->whereIn('name', ['Administrator', 'Admin'])
            ->orderByRaw("CASE WHEN name = 'Administrator' THEN 0 ELSE 1 END")
            ->value('id');
        $hasNotify = Schema::hasColumn('role_permissions', 'notification_permission');

        $dlEditByRole = [];
        foreach (DB::table('role_permissions')->where('page', 'DL Input Hours')->get() as $row) {
            $dlEditByRole[(int) $row->role_id] = (int) $row->permission >= 3;
        }

        foreach (DB::table('role_permissions')->orderBy('id')->get() as $row) {
            $context = [
                'has_dl_edit' => (bool) ($dlEditByRole[(int) $row->role_id] ?? false),
            ];
            if ($hasNotify) {
                $context['notification_permission'] = (int) ($row->notification_permission ?? 0);
            }

            $isAdminRole = $adminRoleId && (int) $row->role_id === (int) $adminRoleId;
            $actions = $isAdminRole
                ? PagePermissionCatalog::actionKeys((string) $row->page)
                : PagePermissionCatalog::legacyActions((string) $row->page, (int) $row->permission, $context);

            if (
                $hasNotify
                && $row->page === 'Trainings'
                && (int) $row->permission >= 2
                && (int) ($row->notification_permission ?? 0) <= 0
            ) {
                $inherited = PagePermissionCatalog::legacyActions((string) $row->page, (int) $row->permission, [
                    'notification_permission' => (int) $row->permission,
                    'has_dl_edit' => $context['has_dl_edit'],
                ]);
                $actions = array_values(array_unique(array_merge($actions, $inherited)));
            }

            DB::table('role_permissions')->where('id', $row->id)->update([
                'actions' => json_encode(array_values($actions)),
            ]);
        }

        if ($adminRoleId) {
            DB::table('role_permissions')
                ->whereIn('page', PagePermissionCatalog::ADMIN_GATE_PAGES)
                ->where('role_id', '!=', $adminRoleId)
                ->update([
                    'permission' => 0,
                    'actions' => json_encode([]),
                ]);
        }
    }

    public function down(): void
    {
        if (Schema::hasColumn('role_permissions', 'actions')) {
            Schema::table('role_permissions', function (Blueprint $table) {
                $table->dropColumn('actions');
            });
        }
    }
};
