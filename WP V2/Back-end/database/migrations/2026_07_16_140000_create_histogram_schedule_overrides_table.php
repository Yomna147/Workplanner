<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('histogram_schedule_overrides', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('task_id');
            $table->string('employee', 191);
            $table->json('hours_by_day');
            $table->timestamps();

            $table->unique(['task_id', 'employee']);
            $table->foreign('task_id')
                ->references('id')
                ->on('project_tasks')
                ->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('histogram_schedule_overrides');
    }
};
