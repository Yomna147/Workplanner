<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DlUpdateSubmission extends Model
{
    protected $fillable = [
        'user_id',
        'dl_name',
        'project_id',
        'submitted_at',
        'task_count',
        'note',
        'meta',
    ];

    protected $casts = [
        'submitted_at' => 'datetime',
        'meta' => 'array',
        'task_count' => 'integer',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function project(): BelongsTo
    {
        return $this->belongsTo(Project::class);
    }
}
