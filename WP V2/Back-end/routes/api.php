<?php

use App\Http\Controllers\Api\ActivityLogController;
use App\Http\Controllers\Api\AlgoController;
use App\Http\Controllers\Api\AlgorithmAssignmentReviewController;
use App\Http\Controllers\Api\AlgorithmClearController;
use App\Http\Controllers\Api\AlgorithmSaveController;
use App\Http\Controllers\Api\AdminSystemMonitorController;
use App\Http\Controllers\Api\AdminUserController;
use App\Http\Controllers\Api\OutlookEmailsController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\DashboardController;
use App\Http\Controllers\Api\DlQuickUpdateController;
use App\Http\Controllers\Api\EmailNotificationRuleController;
use App\Http\Controllers\Api\EmployeeAvailabilityController;
use App\Http\Controllers\Api\EmployeeController;
use App\Http\Controllers\Api\EmployeeSectionTaskController;
use App\Http\Controllers\Api\HealthController;
use App\Http\Controllers\Api\NrmController;
use App\Http\Controllers\Api\SalesToolIntegrationController;
use App\Http\Controllers\Api\NotificationInboxController;
use App\Http\Controllers\Api\OperativeAllocationController;
use App\Http\Controllers\Api\PartController;
use App\Http\Controllers\Api\ProjectCopyController;
use App\Http\Controllers\Api\ProjectController;
use App\Http\Controllers\Api\ProjectTaskController;
use App\Http\Controllers\Api\ResourceHistogramController;
use App\Http\Controllers\Api\RoleController;
use App\Http\Controllers\Api\TeamController;
use App\Http\Controllers\Api\TrainingController;
use App\Http\Controllers\Api\TrainingCourseController;
use App\Http\Controllers\Api\GoogleDriveQuotationsController;
use App\Http\Controllers\Api\TimeTrackingController;
use App\Http\Controllers\Api\TtHoursCacheController;
use App\Http\Controllers\Api\UserController;
use Illuminate\Support\Facades\Route;

Route::get('/health', HealthController::class);

Route::middleware('sales_tool')->prefix('integrations/sales-tool')->group(function () {
    Route::get('/ping', [SalesToolIntegrationController::class, 'ping']);
    Route::post('/projects/propose', [SalesToolIntegrationController::class, 'proposeProject']);
    // Legacy alias — proposes only (does not create a project).
    Route::post('/projects/upsert', [SalesToolIntegrationController::class, 'upsertProject']);
});

Route::post('/login', [AuthController::class, 'login']);
Route::post('/register', [AuthController::class, 'register']);

Route::middleware(['auth:sanctum', 'page'])->group(function () {
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::get('/me', [AuthController::class, 'me']);

    Route::get('/users/options', [UserController::class, 'options']);

    Route::post('/algorithm/clear', [AlgorithmClearController::class, 'clear']);
    Route::post('/algorithm/run', [AlgoController::class, 'runalgori']);
    Route::post('/algorithm/run/init', [AlgoController::class, 'runInit']);
    Route::post('/algorithm/run/step', [AlgoController::class, 'runStep']);
    Route::post('/algorithm/save-results', [AlgorithmSaveController::class, 'saveResults']);
    Route::get('/algorithm/assignments', [AlgorithmAssignmentReviewController::class, 'index']);

    Route::get('/dashboard/stats', [DashboardController::class, 'stats']);
    Route::get('/sales-tool/proposals', [SalesToolIntegrationController::class, 'indexPending']);
    Route::post('/sales-tool/proposals/refresh-quotations', [SalesToolIntegrationController::class, 'refreshPendingQuotations']);
    Route::get('/sales-tool/proposals/{salesToolProposal}', [SalesToolIntegrationController::class, 'show']);
    Route::post('/sales-tool/proposals/{salesToolProposal}/refresh-quotations', [SalesToolIntegrationController::class, 'refreshQuotations']);
    Route::post('/sales-tool/proposals/{salesToolProposal}/dismiss', [SalesToolIntegrationController::class, 'dismiss']);
    Route::post('/sales-tool/proposals/{salesToolProposal}/accept', [SalesToolIntegrationController::class, 'accept']);
    Route::get('/outlook/awaiting-projects', [OutlookEmailsController::class, 'awaitingProjects']);
    Route::get('/dl-quick-update', [DlQuickUpdateController::class, 'index']);
    Route::post('/dl-quick-update/tasks', [DlQuickUpdateController::class, 'updateTasks']);
    Route::post('/dl-quick-update/submissions', [DlQuickUpdateController::class, 'submit']);
    Route::get('/resource-histogram', [ResourceHistogramController::class, 'index']);
    Route::post('/resource-histogram/save-bar-edits', [ResourceHistogramController::class, 'saveBarEdits']);
    Route::get('/resource-histogram/activity-logs', [ResourceHistogramController::class, 'activityLogs']);
    Route::post('/resource-histogram/activity-logs/{activityLog}/revert', [ResourceHistogramController::class, 'revertActivityLog']);

    Route::get('/trainings', [TrainingController::class, 'index']);
    Route::get('/notifications/inbox', [NotificationInboxController::class, 'index']);
    Route::post('/notifications/inbox/dismiss', [NotificationInboxController::class, 'dismiss']);
    Route::post('/trainings', [TrainingController::class, 'store']);
    Route::put('/trainings/{training}', [TrainingController::class, 'update']);
    Route::delete('/trainings/{training}', [TrainingController::class, 'destroy']);
    Route::get('/training-courses', [TrainingCourseController::class, 'index']);
    Route::post('/training-courses', [TrainingCourseController::class, 'store']);
    Route::put('/training-courses/{trainingCourse}', [TrainingCourseController::class, 'update']);
    Route::delete('/training-courses/{trainingCourse}', [TrainingCourseController::class, 'destroy']);

    Route::post('/timetracking-login', [TimeTrackingController::class, 'login']);
    Route::post('/timetracking-projects', [TimeTrackingController::class, 'projects']);
    Route::post('/timetracking-users', [TimeTrackingController::class, 'users']);
    Route::post('/timetracking-report-search', [TimeTrackingController::class, 'individualSearch']);
    Route::post('/timetracking-report-search-all', [TimeTrackingController::class, 'individualSearchAll']);

    Route::get('/integrations/google-drive/quotations', [GoogleDriveQuotationsController::class, 'index']);
    Route::get('/integrations/google-drive/quotations/search', [GoogleDriveQuotationsController::class, 'search']);
    Route::get('/integrations/google-drive/quotations/sheet-titles', [GoogleDriveQuotationsController::class, 'sheetTitles']);
    Route::post('/integrations/google-drive/quotations/import', [GoogleDriveQuotationsController::class, 'import']);

    Route::get('/tt-hours-cache', [TtHoursCacheController::class, 'show']);
    Route::put('/tt-hours-cache', [TtHoursCacheController::class, 'store']);

    Route::get('/projects/tt-comparison', [ProjectController::class, 'ttComparison']);
    Route::get('/projects/create-prefill', [ProjectController::class, 'createPrefill']);
    Route::apiResource('projects', ProjectController::class);
    Route::post('/projects/with-tasks', [ProjectController::class, 'storeWithTasks']);
    Route::post('/projects/rebalance-pp', [ProjectController::class, 'rebalancePp']);
    Route::post('/projects/copy', [ProjectCopyController::class, 'store']);
    Route::get('/nrms', [NrmController::class, 'index']);
    Route::post('/nrms', [NrmController::class, 'store']);
    Route::put('/nrms/{nrm}', [NrmController::class, 'update']);
    Route::delete('/nrms/{nrm}', [NrmController::class, 'destroy']);

    Route::get('/operatives-allocation', [OperativeAllocationController::class, 'index']);
    Route::post('/operatives-allocation/sync', [OperativeAllocationController::class, 'sync']);
    Route::post('/operatives-allocation/delete-employees', [OperativeAllocationController::class, 'destroyEmployees']);
    Route::get('/projects/{project}/parts', [PartController::class, 'index']);
    Route::post('/projects/{project}/parts', [PartController::class, 'store']);
    Route::delete('/parts/{part}', [PartController::class, 'destroy']);

    Route::get('/parts/{part}/tasks', [ProjectTaskController::class, 'index']);
    Route::post('/parts/{part}/tasks', [ProjectTaskController::class, 'store']);
    Route::post('/parts/{part}/tasks/sync', [ProjectTaskController::class, 'sync']);
    Route::put('/project-tasks/{projectTask}', [ProjectTaskController::class, 'update']);
    Route::delete('/project-tasks/{projectTask}', [ProjectTaskController::class, 'destroy']);
    Route::get('/employees/{employee}/availabilities', [EmployeeAvailabilityController::class, 'index']);
    Route::get('/employees/{employee}/section-task-assignments', [EmployeeSectionTaskController::class, 'index']);
    Route::post('/employees/{employee}/section-task-hours/sync', [EmployeeSectionTaskController::class, 'sync']);
    Route::apiResource('employees', EmployeeController::class);
    Route::post('/availabilities/sync', [EmployeeAvailabilityController::class, 'sync']);
    Route::post('/availabilities/import', [EmployeeAvailabilityController::class, 'importBulk']);
    Route::post('/availabilities/import-scheduled', [EmployeeAvailabilityController::class, 'importScheduled']);
    Route::delete('/availabilities/{employeeAvailability}', [EmployeeAvailabilityController::class, 'destroy']);
    Route::post('/employees/{employee}/availabilities/duplicate-week', [EmployeeAvailabilityController::class, 'duplicateWeek']);
    Route::apiResource('teams', TeamController::class)->except(['show']);

    Route::get('/admin/system-monitor', [AdminSystemMonitorController::class, 'show']);
    Route::post('/admin/system-monitor/probe', [AdminSystemMonitorController::class, 'probe']);

    Route::get('/admin/outlook-emails', [OutlookEmailsController::class, 'index']);
    Route::get('/admin/outlook-emails/awaiting-projects', [OutlookEmailsController::class, 'awaitingProjects']);
    Route::get('/admin/outlook-emails/message', [OutlookEmailsController::class, 'show']);
    Route::get('/admin/outlook-emails/attachment', [OutlookEmailsController::class, 'attachment']);

    Route::get('/admin/activity-logs', [ActivityLogController::class, 'index']);

    Route::get('/admin/email-notification-rules', [EmailNotificationRuleController::class, 'index']);
    Route::post('/admin/email-notification-rules/settings', [EmailNotificationRuleController::class, 'updateSettings']);
    Route::post('/admin/email-notification-rules/test-email', [EmailNotificationRuleController::class, 'sendTestEmail']);
    Route::post('/admin/email-notification-rules/case-types', [EmailNotificationRuleController::class, 'storeCaseType']);
    Route::put('/admin/email-notification-rules/case-types/{caseType}', [EmailNotificationRuleController::class, 'updateCaseType']);
    Route::delete('/admin/email-notification-rules/case-types/{caseType}', [EmailNotificationRuleController::class, 'destroyCaseType']);
    Route::post('/admin/email-notification-rules', [EmailNotificationRuleController::class, 'store']);
    Route::put('/admin/email-notification-rules/{emailNotificationRule}', [EmailNotificationRuleController::class, 'update']);
    Route::delete('/admin/email-notification-rules/{emailNotificationRule}', [EmailNotificationRuleController::class, 'destroy']);

    Route::get('/admin/users', [AdminUserController::class, 'index']);
    Route::post('/admin/users/sync', [AdminUserController::class, 'sync']);
    Route::delete('/admin/users/{user}', [AdminUserController::class, 'destroy']);

    Route::get('/roles', [RoleController::class, 'index']);
    Route::post('/roles', [RoleController::class, 'store']);
    Route::get('/roles/{role}', [RoleController::class, 'show']);
    Route::put('/roles/{role}', [RoleController::class, 'update']);
    Route::delete('/roles/{role}', [RoleController::class, 'destroy']);
    Route::get('/pages', [RoleController::class, 'pages']);
    Route::post('/pages', [RoleController::class, 'storePage']);
});
