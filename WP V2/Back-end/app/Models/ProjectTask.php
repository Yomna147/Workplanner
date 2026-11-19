<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ProjectTask extends Model
{
    protected $fillable = [
        'part_id',
        'task_name',
        'est',
        'hrs_per',
        'red',
        'dl',
        'rfi',
        'pd',
        'buf',
        'adj',
        'plan',
        'doc_supply',
        'con',
        'completion',
        'pp',
        'rap',
        'pri',
        'hbs',
        'ats',
        'ots',
        'dd',
        'sp',
        'ts',
        'sh',
        'al',
        'algorithm_1',
        'algorithm_2',
        'algorithm_3',
        'override_1',
        'override_2',
        'override_3',
        'override_share_1',
        'override_share_2',
        'override_share_3',
        'dl_override_1',
        'dl_override_2',
        'dl_override_3',
        'dl_dl',
        'dl_rfi',
        'dl_con',
        'dl_progress_updated',
        'dl_progress_per',
        'dl_done',
        'dl_owner',
        'dl_project_completion_date',
        'progress_updated',
        'progress_per',
        'progress_left_hours',
        'progress_plan',
        'act',
        'pre',
        'duration_left',
        'done',
        'owner',
        'project_completion_date',
        'sec_hrs_02',
        'sec_hrs_03',
        'sec_hrs_04',
        'sec_hrs_05',
        'sec_hrs_06',
        'sec_hrs_07',
        'sec_hrs_extra',
        'sec_hrs_total',
        'dl_sec_hrs_approved',
        'dl_sec_hrs_02',
        'dl_sec_hrs_03',
        'dl_sec_hrs_04',
        'dl_sec_hrs_05',
        'dl_sec_hrs_06',
    ];

    protected $casts = [
        'done' => 'boolean',
        'dl_sec_hrs_approved' => 'boolean',
    ];

    public function part(): BelongsTo
    {
        return $this->belongsTo(Part::class);
    }
}
