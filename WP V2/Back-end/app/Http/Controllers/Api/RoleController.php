<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Page;
use App\Models\Role;
use App\Models\RolePermission;
use App\Models\User;
use App\Support\PageAccess;
use App\Support\PagePermissionCatalog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Schema;

class RoleController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [
            ['Role', 'view'],
            ['Access Permissions', 'view'],
        ]);

        return response()->json([
            'data' => Role::with('permissions')->orderBy('name')->get(),
            'catalog' => PagePermissionCatalog::forClient(),
        ]);
    }

    public function show(Request $request, Role $role): JsonResponse
    {
        PageAccess::assert($request->user(), [['Role', 'view']]);

        return response()->json([
            'data' => [
                'role' => $role,
                'permissions' => RolePermission::where('role_id', $role->id)->orderBy('page')->get(),
            ],
            'catalog' => PagePermissionCatalog::forClient(),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Role', 'manage_roles']]);

        return $this->saveRole($request);
    }

    public function update(Request $request, Role $role): JsonResponse
    {
        PageAccess::assert($request->user(), [['Role', 'manage_roles']]);
        $request->merge(['id' => $role->id]);

        return $this->saveRole($request, $role);
    }

    public function destroy(Request $request, Role $role): JsonResponse
    {
        PageAccess::assert($request->user(), [['Role', 'manage_roles']]);
        if (User::where('role_id', $role->id)->exists()) {
            return response()->json([
                'message' => 'Cannot delete a role that is assigned to users.',
            ], 409);
        }

        $role->permissions()->delete();
        $role->delete();

        return response()->json(['message' => 'Role deleted successfully.']);
    }

    public function pages(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Role', 'view']]);

        return response()->json([
            'data' => Page::query()
                ->where(function ($query) {
                    $query->where(function ($inner) {
                        $inner->whereNotNull('route')->where('route', '!=', '');
                    })->orWhereIn('name', array_column(PagePermissionCatalog::pages(), 'page'));
                })
                ->orderBy('name')
                ->get(),
            'catalog' => PagePermissionCatalog::forClient(),
        ]);
    }

    public function storePage(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Role', 'manage_roles']]);
        $validated = $request->validate([
            'name' => 'required|string|max:255|unique:pages,name',
            'route' => 'nullable|string|max:255',
        ]);

        $page = Page::create($validated);

        return response()->json(['data' => $page], 201);
    }

    private function saveRole(Request $request, ?Role $existingRole = null): JsonResponse
    {
        $validated = $request->validate([
            'id' => 'nullable|integer|exists:roles,id',
            'name' => 'required|string|max:255',
            'permissions' => 'nullable|array',
            'permissions.*.id' => 'nullable|integer|exists:role_permissions,id',
            'permissions.*.page' => 'required|string|max:255',
            'permissions.*.permission' => 'required|integer|in:0,2,3',
            'permissions.*.notification_permission' => 'nullable|integer|in:0,2,3',
            'permissions.*.actions' => 'nullable|array',
            'permissions.*.actions.*' => 'string|max:64',
        ]);

        $roleId = $validated['id'] ?? $existingRole?->id;

        $duplicate = Role::where('name', $validated['name'])
            ->when($roleId, fn ($query) => $query->where('id', '!=', $roleId))
            ->first();

        if ($duplicate) {
            return response()->json([
                'message' => "Duplicate entry: role '{$validated['name']}' already exists.",
            ], 409);
        }

        $role = $roleId ? Role::findOrFail($roleId) : new Role();
        $role->name = $validated['name'];
        $role->save();

        if (! empty($validated['permissions'])) {
            foreach ($validated['permissions'] as $permissionData) {
                $permissionRow = ! empty($permissionData['id'])
                    ? RolePermission::find($permissionData['id'])
                    : new RolePermission();

                if (! $permissionRow) {
                    $permissionRow = new RolePermission();
                }

                $pageName = (string) ($permissionData['page'] ?? '');
                $viewLevel = (int) $permissionData['permission'];
                $actions = PagePermissionCatalog::sanitizeActions(
                    $pageName,
                    $permissionData['actions'] ?? [],
                );
                if ($viewLevel < 2) {
                    $actions = [];
                }
                $level = PagePermissionCatalog::permissionLevelFromActions($viewLevel, $actions);

                $payload = [
                    'role_id' => $role->id,
                    'page' => $pageName,
                    'permission' => $level,
                ];

                if (Schema::hasColumn('role_permissions', 'actions')) {
                    $payload['actions'] = $actions;
                }

                if (Schema::hasColumn('role_permissions', 'notification_permission')) {
                    $notification = PagePermissionCatalog::notificationLevelFromActions($pageName, $actions);
                    if (
                        $notification <= 0
                        && array_key_exists('notification_permission', $permissionData)
                    ) {
                        $notification = (int) ($permissionData['notification_permission'] ?? 0);
                    }
                    $payload['notification_permission'] = $notification;
                }

                $permissionRow->fill($payload);
                $permissionRow->save();
            }
        }

        return response()->json([
            'message' => 'Role and permissions saved successfully.',
            'data' => [
                'role' => $role,
                'permissions' => RolePermission::where('role_id', $role->id)->orderBy('page')->get(),
            ],
        ]);
    }

}
