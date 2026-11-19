<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\EmployeeTraining;
use App\Models\TrainingCourse;
use App\Services\ActivityLogService;
use App\Support\TrainingActivityLog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class TrainingCourseController extends Controller
{
    private const DURATIONS = ['1-2 hours', '2-4 hours', 'Half day', 'Full day', 'Multi-day', 'Custom'];

    private const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

    private const URGENCIES = ['U0', 'U1', 'U2', 'U3'];

    private const DEFAULT_COLOR = '#2563EB';

    public function index(Request $request): JsonResponse
    {
        $query = TrainingCourse::query()->withCount('assignments')->orderBy('title');

        if (! $request->user()?->canPageAction('Trainings', 'manage_courses')) {
            $query->where('is_active', true);
        }

        return response()->json([
            'data' => $query->get()->map(fn (TrainingCourse $course) => $this->formatCourse($course))->values()->all(),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->assertAdmin($request);

        $validated = $request->validate([
            'title' => 'required|string|max:255|unique:training_courses,title',
            'course_link' => 'required|url|max:2048',
            'description' => 'required|string|max:5000',
            'duration' => ['nullable', 'string', Rule::in(self::DURATIONS)],
            'hours_per_day' => 'nullable|numeric|min:0.25|max:80',
            'priority' => ['nullable', 'string', Rule::in(self::PRIORITIES)],
            'urgency' => ['nullable', 'string', Rule::in(self::URGENCIES)],
            'is_active' => 'nullable|boolean',
            'color' => ['nullable', 'string', 'regex:/^#[0-9A-Fa-f]{6}$/'],
        ]);

        $course = TrainingCourse::create([
            'title' => trim($validated['title']),
            'course_link' => $validated['course_link'] ?? null,
            'description' => $validated['description'] ?? null,
            'duration' => $validated['duration'] ?? '1-2 hours',
            'hours_per_day' => $validated['hours_per_day'] ?? 8,
            'priority' => $validated['priority'] ?? 'P2',
            'urgency' => $validated['urgency'] ?? 'U1',
            'is_active' => $validated['is_active'] ?? true,
            'color' => $this->normalizeColor($validated['color'] ?? null),
        ]);

        return response()->json([
            'data' => $this->formatCourse($course),
            'message' => 'Training course added.',
        ], 201);
    }

    public function update(Request $request, TrainingCourse $trainingCourse): JsonResponse
    {
        $this->assertAdmin($request);

        $validated = $request->validate([
            'title' => 'sometimes|required|string|max:255|unique:training_courses,title,'.$trainingCourse->id,
            'course_link' => 'required|url|max:2048',
            'description' => 'required|string|max:5000',
            'duration' => ['nullable', 'string', Rule::in(self::DURATIONS)],
            'hours_per_day' => 'nullable|numeric|min:0.25|max:80',
            'priority' => ['nullable', 'string', Rule::in(self::PRIORITIES)],
            'urgency' => ['nullable', 'string', Rule::in(self::URGENCIES)],
            'is_active' => 'nullable|boolean',
            'color' => ['nullable', 'string', 'regex:/^#[0-9A-Fa-f]{6}$/'],
        ]);

        if (array_key_exists('title', $validated)) {
            $validated['title'] = trim($validated['title']);
        }

        if (array_key_exists('color', $validated)) {
            $validated['color'] = $this->normalizeColor($validated['color']);
        }

        $previousTitle = $trainingCourse->title;
        $course = DB::transaction(function () use ($trainingCourse, $validated, $previousTitle) {
            $trainingCourse->update($validated);
            $fresh = $trainingCourse->fresh();
            $nextTitle = $fresh?->title ?? $trainingCourse->title;
            if ($nextTitle !== $previousTitle) {
                EmployeeTraining::query()
                    ->where('training_course_id', $trainingCourse->id)
                    ->update(['title' => $nextTitle]);
            }

            return $fresh;
        });

        return response()->json([
            'data' => $this->formatCourse($course),
            'message' => 'Training course updated.',
        ]);
    }

    public function destroy(Request $request, TrainingCourse $trainingCourse): JsonResponse
    {
        $this->assertCanDeleteCourse($request);

        $assignments = $trainingCourse->assignments()->with('employee:id,first_name,last_name')->get();
        $assignmentCount = $assignments->count();
        $title = $trainingCourse->title;
        $courseId = $trainingCourse->id;
        $actorName = $request->user()?->name ?? 'System';

        DB::transaction(function () use ($request, $assignments, $trainingCourse, $title, $courseId, $assignmentCount, $actorName) {
            $assigneeNames = [];

            foreach ($assignments as $training) {
                $employeeName = trim(($training->employee?->first_name ?? '').' '.($training->employee?->last_name ?? ''));
                if ($employeeName !== '') {
                    $assigneeNames[] = $employeeName;
                }
                $trainingId = $training->id;
                $assignmentTitle = $training->title ?: $title;
                $training->delete();
                ActivityLogService::log(
                    $request,
                    'Trainings',
                    'deleted',
                    TrainingActivityLog::summarizeDeleted($assignmentTitle, $employeeName, $actorName),
                    EmployeeTraining::class,
                    $trainingId,
                );
            }

            $trainingCourse->delete();
            ActivityLogService::log(
                $request,
                'Trainings',
                'deleted',
                TrainingActivityLog::summarizeCourseDeleted($title, $assignmentCount, $actorName, $assigneeNames),
                TrainingCourse::class,
                $courseId,
            );
        });

        return response()->json([
            'message' => $assignmentCount > 0
                ? 'Training course and its assignments deleted.'
                : 'Training course deleted.',
            'assignment_count' => $assignmentCount,
        ]);
    }

    private function assertCanDeleteCourse(Request $request): void
    {
        $user = $request->user();
        if (
            $user?->canPageAction('Trainings', 'manage_courses')
            || $user?->canPageAction('Trainings', 'delete')
            || $user?->canPageAction('Resource Histogram', 'delete_trainings')
        ) {
            return;
        }

        abort(403, 'You do not have permission to delete training courses.');
    }

    private function assertAdmin(Request $request): void
    {
        if (! $request->user()?->canPageAction('Trainings', 'manage_courses')) {
            abort(403, 'You do not have permission to manage the training course catalog.');
        }
    }

    private function formatCourse(TrainingCourse $course): array
    {
        return [
            'id' => $course->id,
            'title' => $course->title,
            'course_link' => $course->course_link,
            'description' => $course->description,
            'duration' => $course->duration,
            'hours_per_day' => $course->hours_per_day,
            'priority' => $course->priority,
            'urgency' => $course->urgency,
            'is_active' => $course->is_active,
            'color' => $this->normalizeColor($course->color),
            'assignment_count' => (int) ($course->assignments_count ?? $course->assignments()->count()),
        ];
    }

    private function normalizeColor(?string $color): string
    {
        $value = strtoupper(trim((string) $color));
        if (preg_match('/^#[0-9A-F]{6}$/', $value) === 1) {
            return $value;
        }

        return self::DEFAULT_COLOR;
    }
}
