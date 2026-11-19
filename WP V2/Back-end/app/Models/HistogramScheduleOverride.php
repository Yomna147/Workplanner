<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class HistogramScheduleOverride extends Model
{
    protected $fillable = [
        'task_id',
        'employee',
        'hours_by_day',
    ];

    protected $casts = [
        'hours_by_day' => 'array',
        'task_id' => 'integer',
    ];

    public function task(): BelongsTo
    {
        return $this->belongsTo(ProjectTask::class, 'task_id');
    }
}
