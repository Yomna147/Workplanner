<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class EmployeeAvailability extends Model
{
    protected $fillable = [
        'date',
        'strt1',
        'end1',
        'strt2',
        'end2',
        'strt3',
        'end3',
        'strt4',
        'end4',
        'total',
        'total_ava',
        'employee_id',
    ];

    protected $casts = [
        'date' => 'date',
    ];

    protected $appends = ['Total'];

    public function getTotalAttribute(): string
    {
        return $this->attributes['total'] ?? '00:00';
    }

    public function setTotalAttribute(?string $value): void
    {
        $this->attributes['total'] = $value ?? '00:00';
        $this->attributes['total_ava'] = $value ?? '00:00';
    }

    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class);
    }
}
