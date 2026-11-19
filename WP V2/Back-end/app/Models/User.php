<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use App\Support\PagePermissionCatalog;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, Notifiable;

    /**
     * The attributes that are mass assignable.
     *
     * @var list<string>
     */
    protected $fillable = [
        'name',
        'first_name',
        'last_name',
        'login_name',
        'email',
        'password',
        'password_plain',
        'active',
        'role_id',
        'is_admin',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var list<string>
     */
    protected $hidden = [
        'password',
        'password_plain',
        'remember_token',
    ];

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'active' => 'boolean',
            'is_admin' => 'boolean',
        ];
    }

    public function role(): BelongsTo
    {
        return $this->belongsTo(Role::class);
    }

    public function canViewPage(string $pageName, int $minimum = 2): bool
    {
        if ($this->is_admin) {
            return true;
        }

        $this->loadMissing('role.permissions');
        $permission = (int) ($this->role?->permissions?->firstWhere('page', $pageName)?->permission ?? 0);

        return $permission >= $minimum;
    }

    /**
     * @return list<string>
     */
    public function pageActions(string $pageName): array
    {
        if ($this->is_admin) {
            return PagePermissionCatalog::actionKeys($pageName);
        }

        $this->loadMissing('role.permissions');
        $row = $this->role?->permissions?->firstWhere('page', $pageName);
        if (! $row || (int) $row->permission < 2) {
            return [];
        }

        if (is_array($row->actions)) {
            return PagePermissionCatalog::sanitizeActions($pageName, $row->actions);
        }

        $dlPermission = (int) ($this->role?->permissions?->firstWhere('page', 'DL Input Hours')?->permission ?? 0);

        return PagePermissionCatalog::legacyActions($pageName, (int) $row->permission, [
            'notification_permission' => (int) ($row->notification_permission ?? 0),
            'has_dl_edit' => $dlPermission >= 3,
        ]);
    }

    public function canPageAction(string $pageName, string $action = PagePermissionCatalog::ACTION_VIEW): bool
    {
        if ($this->is_admin) {
            return true;
        }

        if ($action === PagePermissionCatalog::ACTION_VIEW || $action === '') {
            return $this->canViewPage($pageName);
        }

        if (! $this->canViewPage($pageName)) {
            return false;
        }

        return in_array($action, $this->pageActions($pageName), true);
    }

    /**
     * @param  list<array{0: string, 1?: string}|array{page: string, action?: string}>  $checks
     */
    public function canAnyPageAction(array $checks): bool
    {
        if ($this->is_admin) {
            return true;
        }

        foreach ($checks as $check) {
            if (isset($check['page'])) {
                $page = (string) $check['page'];
                $action = (string) ($check['action'] ?? PagePermissionCatalog::ACTION_VIEW);
            } else {
                $page = (string) ($check[0] ?? '');
                $action = (string) ($check[1] ?? PagePermissionCatalog::ACTION_VIEW);
            }

            if ($page !== '' && $this->canPageAction($page, $action)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Email is used for notification delivery, not authentication.
     */
    public function routeNotificationForMail($notification = null): ?string
    {
        return $this->email ?: null;
    }
}
