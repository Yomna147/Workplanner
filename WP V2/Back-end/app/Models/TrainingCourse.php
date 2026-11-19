<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class TrainingCourse extends Model
{
    protected $fillable = [
        'title',
        'course_link',
        'description',
        'duration',
        'hours_per_day',
        'priority',
        'urgency',
        'is_active',
        'color',
    ];

    protected function casts(): array
    {
        return [
            'hours_per_day' => 'decimal:2',
            'is_active' => 'boolean',
        ];
    }

    public function assignments(): HasMany
    {
        return $this->hasMany(EmployeeTraining::class, 'training_course_id');
    }
}
