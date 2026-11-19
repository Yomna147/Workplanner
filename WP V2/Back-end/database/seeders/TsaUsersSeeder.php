<?php

namespace Database\Seeders;

use App\Models\Employee;
use App\Models\Page;
use App\Models\Role;
use App\Models\RolePermission;
use App\Models\User;
use App\Support\EmployeeNames;
use App\Support\PagePermissionCatalog;
use Illuminate\Database\Seeder;
use Illuminate\Support\Str;

class TsaUsersSeeder extends Seeder
{
    public const DEFAULT_PASSWORD = 'TSA@DL12';

    /** @var list<string> */
    private array $adminPages = [
        'Access Permissions',
        'Role',
        'Activity Log',
        'Email Notifications',
    ];

    public function run(): void
    {
        $role = $this->ensureStandardUserRole();
        $usedLoginNames = User::query()
            ->pluck('login_name')
            ->filter()
            ->map(fn (string $name) => strtolower($name))
            ->all();

        Employee::query()
            ->orderBy('id')
            ->each(function (Employee $employee) use ($role, &$usedLoginNames) {
                $this->provisionEmployeeUser($employee, $role, $usedLoginNames);
            });

        User::query()->each(function (User $user) use ($role) {
            $user->password = self::DEFAULT_PASSWORD;
            $user->password_plain = self::DEFAULT_PASSWORD;
            $user->active = true;

            if (! $user->is_admin && ! $user->role_id) {
                $user->role_id = $role->id;
            }

            $user->save();
        });

        $this->command?->info('Provisioned '.Employee::count().' employee login(s) with password '.self::DEFAULT_PASSWORD.'.');
    }

    private function ensureStandardUserRole(): Role
    {
        $role = Role::firstOrCreate(['name' => 'Standard User']);

        foreach (Page::orderBy('name')->get() as $page) {
            $permission = in_array($page->name, $this->adminPages, true) ? 0 : 3;

            RolePermission::updateOrCreate(
                ['role_id' => $role->id, 'page' => $page->name],
                PagePermissionCatalog::payloadForLevel($page->name, $permission),
            );
        }

        return $role;
    }

    /**
     * @param  list<string>  $usedLoginNames
     */
    private function provisionEmployeeUser(Employee $employee, Role $role, array &$usedLoginNames): void
    {
        $displayName = EmployeeNames::displayName($employee);

        $user = User::query()
            ->where('first_name', $employee->first_name)
            ->where('last_name', $employee->last_name)
            ->first();

        if (! $user && $employee->email) {
            $user = User::query()->where('email', $employee->email)->first();
        }

        $loginName = $user?->login_name ?: $this->buildLoginName($employee, $usedLoginNames);

        if (! $user) {
            $user = new User();
        }

        $user->fill([
            'first_name' => $employee->first_name,
            'last_name' => $employee->last_name,
            'login_name' => $loginName,
            'name' => $displayName !== '' ? $displayName : $loginName,
            'email' => $employee->email ?: $user->email,
            'active' => true,
            'role_id' => $user->is_admin ? $user->role_id : $role->id,
            'password' => self::DEFAULT_PASSWORD,
            'password_plain' => self::DEFAULT_PASSWORD,
        ]);

        $user->save();
    }

    /**
     * @param  list<string>  $usedLoginNames
     */
    private function buildLoginName(Employee $employee, array &$usedLoginNames): string
    {
        $candidates = array_values(array_filter([
            $this->normalizeLoginCandidate($employee->first_name),
            $this->normalizeLoginCandidate($employee->first_name.$employee->last_name),
            $this->normalizeLoginCandidate($employee->first_name.'.'.$employee->last_name),
        ]));

        foreach ($candidates as $base) {
            $name = $base;
            $suffix = 2;

            while ($this->loginNameTaken($name, $usedLoginNames)) {
                $name = $base.$suffix;
                $suffix++;
            }

            $usedLoginNames[] = strtolower($name);

            return $name;
        }

        $fallback = 'user'.$employee->id;
        $usedLoginNames[] = strtolower($fallback);

        return $fallback;
    }

    private function normalizeLoginCandidate(?string $value): string
    {
        $slug = Str::slug(trim((string) $value), '');

        return strtolower(preg_replace('/[^a-z0-9._-]/', '', $slug) ?? '');
    }

    /**
     * @param  list<string>  $usedLoginNames
     */
    private function loginNameTaken(string $loginName, array $usedLoginNames): bool
    {
        $normalized = strtolower($loginName);

        if (in_array($normalized, $usedLoginNames, true)) {
            return true;
        }

        return User::query()
            ->whereRaw('LOWER(login_name) = ?', [$normalized])
            ->exists();
    }
}
