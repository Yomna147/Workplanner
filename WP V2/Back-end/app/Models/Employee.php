<?php

namespace App\Models;

use App\Support\EmployeeNames;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Employee extends Model
{
    protected $fillable = [
        'first_name',
        'last_name',
        'email',
        'position',
        'team_id',
    ];

    protected $casts = [
        'position' => 'integer',
    ];

    protected $appends = [
        'name',
    ];

    public function getNameAttribute(): string
    {
        return EmployeeNames::displayName($this->first_name, $this->last_name);
    }

    public function team(): BelongsTo
    {
        return $this->belongsTo(Team::class);
    }

    public function availabilities(): HasMany
    {
        return $this->hasMany(EmployeeAvailability::class)->orderBy('date');
    }

    public function nrms(): BelongsToMany
    {
        return $this->belongsToMany(Nrm::class, 'employee_nrm')
            ->withPivot('OAP', 'performance_percentage')
            ->withTimestamps();
    }
}
