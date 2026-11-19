<?php

namespace App\Services;

use App\Models\ActivityLog;
use Illuminate\Http\Request;

class ActivityLogService
{
    public static function log(
        Request $request,
        string $area,
        string $action,
        string $summary,
        ?string $subjectType = null,
        ?int $subjectId = null,
        ?array $changes = null,
        ?array $meta = null,
    ): ActivityLog {
        $user = $request->user();

        return ActivityLog::create([
            'user_id' => $user?->id,
            'user_name' => $user?->name ?? 'System',
            'area' => $area,
            'action' => $action,
            'subject_type' => $subjectType,
            'subject_id' => $subjectId,
            'summary' => $summary,
            'changes' => $changes,
            'meta' => $meta,
        ]);
    }
}
