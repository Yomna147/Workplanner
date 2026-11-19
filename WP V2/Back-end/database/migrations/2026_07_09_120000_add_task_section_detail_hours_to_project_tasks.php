<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->string('sec_hrs_02')->nullable()->after('project_completion_date');
            $table->string('sec_hrs_03')->nullable();
            $table->string('sec_hrs_04')->nullable();
            $table->string('sec_hrs_05')->nullable();
            $table->string('sec_hrs_06')->nullable();
            $table->string('sec_hrs_07')->nullable();
            $table->string('sec_hrs_extra')->nullable();
            $table->string('sec_hrs_total')->nullable();
            $table->boolean('dl_sec_hrs_approved')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropColumn([
                'sec_hrs_02',
                'sec_hrs_03',
                'sec_hrs_04',
                'sec_hrs_05',
                'sec_hrs_06',
                'sec_hrs_07',
                'sec_hrs_extra',
                'sec_hrs_total',
                'dl_sec_hrs_approved',
            ]);
        });
    }
};
