<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->string('dl_dl')->nullable()->after('dl_override_3');
            $table->string('dl_rfi')->nullable()->after('dl_dl');
            $table->string('dl_con')->nullable()->after('dl_rfi');
            $table->string('dl_progress_updated')->nullable()->after('dl_con');
            $table->string('dl_progress_per')->nullable()->after('dl_progress_updated');
            $table->string('dl_done')->nullable()->after('dl_progress_per');
            $table->string('dl_owner')->nullable()->after('dl_done');
            $table->string('dl_project_completion_date')->nullable()->after('dl_owner');
        });
    }

    public function down(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropColumn([
                'dl_dl',
                'dl_rfi',
                'dl_con',
                'dl_progress_updated',
                'dl_progress_per',
                'dl_done',
                'dl_owner',
                'dl_project_completion_date',
            ]);
        });
    }
};
