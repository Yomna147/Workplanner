<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class EmployeeTraining extends Model
{
    protected $fillable = [
        'employee_id',
        'training_course_id',
        'assigned_by_user_id',
        'assigned_by_name',
        'title',
        'course_link',
        'description',
        'duration',
        'status',
        'priority',
        'urgency',
        'confirm_override',
        'start_date',
        'end_date',
        'hours_per_day',
        'day_segment',
        'notes',
    ];

    protected function casts(): array
    {
        return [
            'start_date' => 'date:Y-m-d',
            'end_date' => 'date:Y-m-d',
            'hours_per_day' => 'decimal:2',
            'day_segment' => 'integer',
            'confirm_override' => 'boolean',
        ];
    }

    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class);
    }

    public function trainingCourse(): BelongsTo
    {
        return $this->belongsTo(TrainingCourse::class);
    }
}
