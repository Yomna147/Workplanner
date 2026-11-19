<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->unsignedTinyInteger('day_segment')
                ->default(0)
                ->after('hours_per_day');
        });
    }

    public function down(): void
    {
        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->dropColumn('day_segment');
        });
    }
};
