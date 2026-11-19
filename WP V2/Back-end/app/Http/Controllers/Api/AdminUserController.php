<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Models\User;
use App\Support\PageAccess;
use App\Support\TeamOrder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

class AdminUserController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [
            ['Access Permissions', 'view'],
            ['Activity Log', 'view'],
            ['Email Notifications', 'view'],
        ]);

        $includePassword = $request->user()?->canPageAction('Access Permissions', 'manage_users') ?? false;
        $employees = Employee::with('team')->get();

        $users = User::with('role')
            ->get()
            ->map(function (User $user) use ($employees, $includePassword) {
                $formatted = $this->formatUser($user, $includePassword);
                $formatted['team'] = $this->resolveTeamName($user, $employees);

                return $formatted;
            })
            ->sort(fn (array $a, array $b) => $this->compareUsersByTeam($a, $b))
            ->values();

        return response()->json(['data' => $users]);
    }

    public function sync(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Access Permissions', 'manage_users']]);
        $validated = $request->validate([
            'users' => 'required|array',
            'users.*.id' => 'nullable|integer|exists:users,id',
            'users.*.first_name' => 'required|string|max:100',
            'users.*.last_name' => 'required|string|max:100',
            'users.*.login_name' => 'required|string|max:100',
            'users.*.email' => 'nullable|email|max:255',
            'users.*.password' => 'nullable|string|min:6',
            'users.*.active' => 'required|boolean',
            'users.*.role_id' => 'nullable|integer|exists:roles,id',
        ]);

        $saved = [];

        foreach ($validated['users'] as $userData) {
            $duplicate = User::where('login_name', $userData['login_name'])
                ->when(! empty($userData['id']), fn ($query) => $query->where('id', '!=', $userData['id']))
                ->first();

            if ($duplicate) {
                return response()->json([
                    'message' => "Duplicate entry: login name '{$userData['login_name']}' already exists.",
                ], 409);
            }

            if (! empty($userData['email'])) {
                $emailDuplicate = User::where('email', $userData['email'])
                    ->when(! empty($userData['id']), fn ($query) => $query->where('id', '!=', $userData['id']))
                    ->first();

                if ($emailDuplicate) {
                    return response()->json([
                        'message' => "Duplicate entry: email '{$userData['email']}' already exists.",
                    ], 409);
                }
            }

            if (empty($userData['id']) && empty($userData['password'])) {
                return response()->json([
                    'message' => 'Password is required for new users.',
                ], 422);
            }

            $user = ! empty($userData['id'])
                ? User::findOrFail($userData['id'])
                : new User();

            $fullName = trim($userData['first_name'].' '.$userData['last_name']);

            $user->fill([
                'first_name' => $userData['first_name'],
                'last_name' => $userData['last_name'],
                'login_name' => $userData['login_name'],
                'name' => $fullName !== '' ? $fullName : $userData['login_name'],
                'email' => $userData['email'] ?: null,
                'active' => $userData['active'],
                'role_id' => $userData['role_id'] ?? null,
            ]);

            if (! empty($userData['password'])) {
                $user->password = Hash::make($userData['password']);
                $user->password_plain = $userData['password'];
            } elseif (empty($userData['id'])) {
                return response()->json([
                    'message' => 'Password is required for new users.',
                ], 422);
            }

            $user->save();
            $saved[] = $this->formatUser($user->load('role'), true);
        }

        return response()->json([
            'message' => 'Users saved successfully.',
            'data' => $saved,
        ]);
    }

    public function destroy(Request $request, User $user): JsonResponse
    {
        PageAccess::assert($request->user(), [['Access Permissions', 'manage_users']]);

        if ($user->is_admin) {
            return response()->json(['message' => 'You cannot delete a super admin.'], 403);
        }

        $user->delete();

        return response()->json(['message' => 'User deleted successfully.']);
    }

    private function formatUser(User $user, bool $includePassword = false, ?string $team = null): array
    {
        return [
            'id' => $user->id,
            'first_name' => $user->first_name,
            'last_name' => $user->last_name,
            'login_name' => $user->login_name,
            'email' => $user->email,
            'password' => $includePassword ? ($user->password_plain ?? '') : '',
            'active' => (bool) $user->active,
            'role_id' => $user->role_id,
            'is_admin' => (bool) $user->is_admin,
            'role' => $user->role,
            'team' => $team,
        ];
    }

    /**
     * @param  \Illuminate\Support\Collection<int, Employee>  $employees
     */
    private function resolveTeamName(User $user, $employees): ?string
    {
        $employee = $employees->first(function (Employee $employee) use ($user) {
            if (
                $employee->first_name === $user->first_name
                && $employee->last_name === $user->last_name
            ) {
                return true;
            }

            return $user->email
                && $employee->email
                && strcasecmp($employee->email, $user->email) === 0;
        });

        return $employee?->team?->name;
    }

    private function compareUsersByTeam(array $a, array $b): int
    {
        if ($a['is_admin'] !== $b['is_admin']) {
            return $a['is_admin'] ? -1 : 1;
        }

        $teamA = (string) ($a['team'] ?? '');
        $teamB = (string) ($b['team'] ?? '');

        if ($teamA === '' && $teamB !== '') {
            return 1;
        }
        if ($teamB === '' && $teamA !== '') {
            return -1;
        }

        $teamCmp = TeamOrder::compare($teamA, $teamB);
        if ($teamCmp !== 0) {
            return $teamCmp;
        }

        $first = strcasecmp((string) ($a['first_name'] ?? ''), (string) ($b['first_name'] ?? ''));
        if ($first !== 0) {
            return $first;
        }

        return strcasecmp((string) ($a['last_name'] ?? ''), (string) ($b['last_name'] ?? ''));
    }
}
