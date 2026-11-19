<?php
/**
 * Insert dummy Trainings + System inbox notices for bell testing.
 * Run: php scripts/seed-dummy-notifications.php
 *
 * Safe to re-run: uses fixed dedupe_key prefixes and upserts by key.
 */
require __DIR__.'/../vendor/autoload.php';
$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\Employee;
use App\Models\Project;
use App\Models\ProjectTask;
use App\Models\ScheduledNotificationNotice;
use App\Models\TrainingNotificationNotice;
use App\Models\User;
use Illuminate\Support\Carbon;

$stamp = Carbon::now()->format('YmdHi');
$employee = Employee::query()->orderBy('id')->first();
$employeeId = $employee?->id;
$employeeName = $employee
    ? trim(($employee->first_name ?? '').' '.($employee->last_name ?? ''))
    : 'Sample Operative';

$admin = User::query()->where('login_name', 'Admin')->orWhere('is_admin', true)->orderBy('id')->first();
$dlUser = User::query()->whereHas('role', fn ($q) => $q->where('name', 'DLs'))->orderBy('id')->first()
    ?? $admin;

$task = ProjectTask::query()->orderByDesc('id')->first();
$project = Project::query()->orderByDesc('id')->first();

$created = [];

$upsertTraining = static function (array $attrs) use (&$created): void {
    $notice = TrainingNotificationNotice::query()->updateOrCreate(
        ['dedupe_key' => $attrs['dedupe_key']],
        $attrs
    );
    $created[] = 'training-'.$notice->id.' · '.$notice->title;
};

$upsertScheduled = static function (array $attrs) use (&$created): void {
    $notice = ScheduledNotificationNotice::query()->updateOrCreate(
        ['dedupe_key' => $attrs['dedupe_key']],
        $attrs
    );
    $created[] = 'scheduled-'.$notice->id.' · ['.$notice->audience.'] '.$notice->title;
};

// --- Trainings tab (training_notification_notices) ---
$upsertTraining([
    'dedupe_key' => 'dummy:training:starting_soon',
    'rule_code' => 'training_starting_soon',
    'employee_training_id' => null,
    'employee_id' => $employeeId,
    'audience' => 'rule',
    'title' => "{$employeeName} — Training starting soon · Safety induction (dummy)",
    'body' => "Starts in 1 day (".Carbon::tomorrow()->toDateString().").\n\nTeam / DL: Dummy Team\nAssigned: demo seed {$stamp}",
    'email_subject' => null,
    'email_body' => null,
    'read_at' => null,
]);

$upsertTraining([
    'dedupe_key' => 'dummy:training:overdue',
    'rule_code' => 'training_overdue',
    'employee_training_id' => null,
    'employee_id' => $employeeId,
    'audience' => 'rule',
    'title' => "{$employeeName} — Training overdue · First aid (dummy)",
    'body' => "Course ended yesterday and is still incomplete.\n\nTeam / DL: Dummy Team\nSeed: {$stamp}",
    'read_at' => null,
]);

$upsertTraining([
    'dedupe_key' => 'dummy:training:completed',
    'rule_code' => 'training_completed',
    'employee_training_id' => null,
    'employee_id' => $employeeId,
    'audience' => 'rule',
    'title' => "{$employeeName} — Training completed · NRM basics (dummy)",
    'body' => "Marked complete for demo.\n\nTeam / DL: Dummy Team\nSeed: {$stamp}",
    'read_at' => null,
]);

// --- Trainings tab (scheduled, audience=trainings) ---
$upsertScheduled([
    'dedupe_key' => 'dummy:scheduled:incomplete_training',
    'rule_code' => 'incomplete_training',
    'case_type' => 'incomplete_training_days',
    'audience' => 'trainings',
    'recipient_user_id' => null,
    'title' => "{$employeeName} — Training incomplete ≥ 3 days (dummy)",
    'body' => "Course still open for demo inbox.\nTeam / DL: Dummy Team\nSeed: {$stamp}",
    'employee_id' => $employeeId,
    'employee_training_id' => null,
    'project_task_id' => null,
    'project_id' => null,
    'read_at' => null,
]);

$upsertScheduled([
    'dedupe_key' => 'dummy:scheduled:capacity_gap',
    'rule_code' => 'capacity_gap',
    'case_type' => 'capacity_gap_hours',
    'audience' => 'trainings',
    'recipient_user_id' => null,
    'title' => "{$employeeName} has an upcoming low-load period (dummy)",
    'body' => "0h scheduled against a 120h plan. Available slots: demo window.\nSeed: {$stamp}",
    'employee_id' => $employeeId,
    'read_at' => null,
]);

// --- System tab (scheduled, audience=system) ---
$upsertScheduled([
    'dedupe_key' => 'dummy:scheduled:dl_overdue',
    'rule_code' => 'dl_update_overdue',
    'case_type' => 'dl_update_overdue',
    'audience' => 'system',
    'recipient_user_id' => $dlUser?->id,
    'title' => 'DL weekly update overdue (dummy)',
    'body' => "Sample DL has not submitted this week's update.\nTeam / DL: Dummy Team\nSeed: {$stamp}",
    'employee_id' => $employeeId,
    'project_task_id' => $task?->id,
    'project_id' => $project?->id,
    'read_at' => null,
]);

$upsertScheduled([
    'dedupe_key' => 'dummy:scheduled:histogram_override',
    'rule_code' => 'histogram_schedule_override',
    'case_type' => 'histogram_schedule_override',
    'audience' => 'system',
    'recipient_user_id' => null,
    'title' => 'Histogram override · 2 edits (dummy)',
    'body' => "Tasks: demo\n\n• Site setup · {$employeeName} · ".Carbon::today()->format('d M')."\nSeed: {$stamp}",
    'employee_id' => $employeeId,
    'project_task_id' => $task?->id,
    'project_id' => $project?->id,
    'read_at' => null,
]);

$upsertScheduled([
    'dedupe_key' => 'dummy:scheduled:new_project_docs',
    'rule_code' => 'new_project_docs',
    'case_type' => 'new_project_docs_ready',
    'audience' => 'system',
    'recipient_user_id' => null,
    'title' => ($project?->name ?? 'Demo project').' — Have all docs (dummy)',
    'body' => "Project marked as having all documents for inbox testing.\nSeed: {$stamp}",
    'project_id' => $project?->id,
    'project_task_id' => $task?->id,
    'read_at' => null,
]);

echo "Dummy notifications ready (".count($created)."):\n";
foreach ($created as $line) {
    echo "  - {$line}\n";
}
echo "\nOpen the navbar bell as Admin (Trainings + System tabs).\n";
echo "Employee used: {$employeeName} (id=".($employeeId ?? 'n/a').")\n";
echo "DL recipient_user_id: ".($dlUser?->id ?? 'n/a')." ({$dlUser?->login_name})\n";
