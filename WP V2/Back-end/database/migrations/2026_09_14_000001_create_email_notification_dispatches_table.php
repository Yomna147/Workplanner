<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('email_notification_dispatches', function (Blueprint $table) {
            $table->id();
            $table->foreignId('email_notification_rule_id')
                ->constrained('email_notification_rules')
                ->cascadeOnDelete();
            $table->unsignedBigInteger('project_task_id');
            $table->timestamp('notified_at');
            $table->timestamps();

            $table->unique(
                ['email_notification_rule_id', 'project_task_id'],
                'email_notification_dispatches_rule_task_unique',
            );
            $table->index('project_task_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('email_notification_dispatches');
    }
};
