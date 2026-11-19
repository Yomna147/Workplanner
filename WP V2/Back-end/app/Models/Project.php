<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasManyThrough;

class Project extends Model
{
    protected $fillable = [
        'name',
        'color',
        'status',
        'description',
        'team_id',
        'have_all_docs',
    ];

    protected $casts = [
        'have_all_docs' => 'boolean',
    ];

    public function team(): BelongsTo
    {
        return $this->belongsTo(Team::class);
    }

    public function parts(): HasMany
    {
        return $this->hasMany(Part::class);
    }

    public function tasks(): HasManyThrough
    {
        return $this->hasManyThrough(ProjectTask::class, Part::class);
    }
}
