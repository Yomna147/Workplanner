<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class EmailNotificationDispatch extends Model
{
    protected $fillable = [
        'email_notification_rule_id',
        'project_task_id',
        'notified_at',
    ];

    protected function casts(): array
    {
        return [
            'notified_at' => 'datetime',
            'project_task_id' => 'integer',
        ];
    }

    public function rule(): BelongsTo
    {
        return $this->belongsTo(EmailNotificationRule::class, 'email_notification_rule_id');
    }
}
