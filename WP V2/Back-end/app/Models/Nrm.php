<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Nrm extends Model
{
    protected $fillable = [
        'number',
        'name',
        'sc_name',
        'pri',
    ];

    public function employees(): BelongsToMany
    {
        return $this->belongsToMany(Employee::class, 'employee_nrm')
            ->withPivot('OAP', 'performance_percentage')
            ->withTimestamps();
    }
}
