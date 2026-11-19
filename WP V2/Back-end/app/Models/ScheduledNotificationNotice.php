<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ScheduledNotificationNotice extends Model
{
    protected $fillable = [
        'dedupe_key',
        'rule_code',
        'case_type',
        'audience',
        'recipient_user_id',
        'title',
        'body',
        'employee_id',
        'employee_training_id',
        'project_task_id',
        'project_id',
        'read_at',
    ];

    protected function casts(): array
    {
        return [
            'read_at' => 'datetime',
        ];
    }
}
