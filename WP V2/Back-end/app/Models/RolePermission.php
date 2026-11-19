<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class RolePermission extends Model
{
    protected $fillable = [
        'role_id',
        'page',
        'permission',
        'notification_permission',
        'actions',
    ];

    protected $casts = [
        'permission' => 'integer',
        'notification_permission' => 'integer',
        'actions' => 'array',
    ];

    public function role(): BelongsTo
    {
        return $this->belongsTo(Role::class);
    }
}
