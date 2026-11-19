<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $duplicateIds = DB::table('employee_trainings as newer')
            ->join('employee_trainings as older', function ($join) {
                $join->on('newer.employee_id', '=', 'older.employee_id')
                    ->on('newer.title', '=', 'older.title')
                    ->on('newer.start_date', '=', 'older.start_date')
                    ->on('newer.end_date', '=', 'older.end_date')
                    ->whereColumn('newer.id', '>', 'older.id');
            })
            ->pluck('newer.id');

        if ($duplicateIds->isNotEmpty()) {
            DB::table('employee_trainings')->whereIn('id', $duplicateIds)->delete();
        }

        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->unique(
                ['employee_id', 'title', 'start_date', 'end_date'],
                'employee_trainings_session_unique',
            );
        });
    }

    public function down(): void
    {
        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->dropUnique('employee_trainings_session_unique');
        });
    }
};
