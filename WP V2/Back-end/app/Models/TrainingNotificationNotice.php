<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class TrainingNotificationNotice extends Model
{
    protected $fillable = [
        'dedupe_key',
        'rule_code',
        'employee_training_id',
        'employee_id',
        'audience',
        'title',
        'body',
        'email_subject',
        'email_body',
        'read_at',
    ];

    protected function casts(): array
    {
        return [
            'read_at' => 'datetime',
        ];
    }
}
