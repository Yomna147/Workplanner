<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class TtHoursCache extends Model
{
    public const SCOPE_GLOBAL = 'global';

    protected $fillable = [
        'scope_key',
        'fetched_at',
        'date_start',
        'date_end',
        'version',
        'payload',
        'updated_by',
    ];

    protected function casts(): array
    {
        return [
            'fetched_at' => 'datetime',
            'date_start' => 'date',
            'date_end' => 'date',
            'version' => 'integer',
            'payload' => 'array',
        ];
    }

    public function updatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }
}
