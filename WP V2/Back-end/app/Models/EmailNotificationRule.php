<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class EmailNotificationRule extends Model
{
    protected $fillable = [
        'code',
        'label',
        'description',
        'case_type',
        'case_value',
        'enabled',
        'in_app_enabled',
        'email_enabled',
        'recipient_user_ids',
        'recipient_emails',
        'recipient_names',
        'for_role_ids',
        'recipient_role_ids',
        'sort_order',
    ];

    protected function casts(): array
    {
        return [
            'case_value' => 'float',
            'enabled' => 'boolean',
            'in_app_enabled' => 'boolean',
            'email_enabled' => 'boolean',
            'recipient_user_ids' => 'array',
            'recipient_emails' => 'array',
            'recipient_names' => 'array',
            'for_role_ids' => 'array',
            'recipient_role_ids' => 'array',
            'sort_order' => 'integer',
        ];
    }
}
