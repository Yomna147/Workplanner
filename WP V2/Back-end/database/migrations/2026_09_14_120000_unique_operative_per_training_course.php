<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $seen = [];
        $duplicateIds = [];

        $rows = DB::table('employee_trainings')
            ->whereNotNull('training_course_id')
            ->orderBy('id')
            ->get(['id', 'employee_id', 'training_course_id']);

        foreach ($rows as $row) {
            $key = $row->employee_id.'|'.$row->training_course_id;
            if (isset($seen[$key])) {
                $duplicateIds[] = $row->id;
                continue;
            }
            $seen[$key] = true;
        }

        if ($duplicateIds !== []) {
            DB::table('employee_trainings')->whereIn('id', $duplicateIds)->delete();
        }

        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->unique(
                ['employee_id', 'training_course_id'],
                'employee_trainings_course_operative_unique',
            );
        });
    }

    public function down(): void
    {
        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->dropUnique('employee_trainings_course_operative_unique');
        });
    }
};
