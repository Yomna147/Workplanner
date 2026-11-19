<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('scheduled_notification_notices', function (Blueprint $table) {
            $table->unsignedBigInteger('project_id')->nullable()->after('project_task_id')->index();
        });
    }

    public function down(): void
    {
        Schema::table('scheduled_notification_notices', function (Blueprint $table) {
            $table->dropColumn('project_id');
        });
    }
};
