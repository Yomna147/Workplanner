<?php

use App\Support\TrainingCourseColors;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Courses that existed before the colour column all got the same default blue.
 * Give every course that shares its colour with an earlier course a random, distinct one.
 */
return new class extends Migration
{
    public function up(): void
    {
        $courses = DB::table('training_courses')->orderBy('id')->get(['id', 'color']);
        $used = [];

        foreach ($courses as $course) {
            $color = strtoupper(trim((string) $course->color));

            if (preg_match('/^#[0-9A-F]{6}$/', $color) !== 1 || isset($used[$color])) {
                $color = TrainingCourseColors::randomUnused(array_keys($used));
                DB::table('training_courses')->where('id', $course->id)->update(['color' => $color]);
            }

            $used[$color] = true;
        }
    }

    public function down(): void
    {
        // Colours are cosmetic; nothing to restore.
    }
};
