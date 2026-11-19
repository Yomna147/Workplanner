<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('scheduled_notification_notices', function (Blueprint $table) {
            $table->id();
            $table->string('dedupe_key', 191)->unique();
            $table->string('rule_code', 64)->index();
            $table->string('case_type', 64)->index();
            $table->string('audience', 16)->default('system');
            $table->string('title');
            $table->text('body');
            $table->unsignedBigInteger('employee_id')->nullable()->index();
            $table->unsignedBigInteger('employee_training_id')->nullable()->index();
            $table->unsignedBigInteger('project_task_id')->nullable()->index();
            $table->timestamp('read_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('scheduled_notification_notices');
    }
};
