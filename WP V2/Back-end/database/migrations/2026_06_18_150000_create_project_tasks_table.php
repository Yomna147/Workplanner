<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('project_tasks', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained()->cascadeOnDelete();
            $table->string('task_name')->nullable();
            $table->string('est')->nullable();
            $table->string('hrs_per')->nullable();
            $table->string('red')->nullable();
            $table->string('dl')->nullable();
            $table->string('rfi')->nullable();
            $table->string('pd')->nullable();
            $table->string('buf')->nullable();
            $table->string('adj')->nullable();
            $table->string('plan')->nullable();
            $table->string('doc_supply')->nullable();
            $table->string('con')->nullable();
            $table->string('completion')->nullable();
            $table->string('pp')->nullable();
            $table->string('rap')->nullable();
            $table->string('pri')->nullable();
            $table->string('hbs')->nullable();
            $table->string('ats')->nullable();
            $table->string('ots')->nullable();
            $table->string('dd')->nullable();
            $table->string('sp')->nullable();
            $table->string('algorithm_1')->nullable();
            $table->string('algorithm_2')->nullable();
            $table->string('algorithm_3')->nullable();
            $table->string('override_1')->nullable();
            $table->string('override_2')->nullable();
            $table->string('override_3')->nullable();
            $table->string('progress_updated')->nullable();
            $table->string('progress_per')->nullable();
            $table->string('progress_left_hours')->nullable();
            $table->string('progress_plan')->nullable();
            $table->string('act')->nullable();
            $table->string('pre')->nullable();
            $table->string('duration_left')->nullable();
            $table->boolean('done')->default(false);
            $table->string('owner')->nullable();
            $table->string('project_completion_date')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('project_tasks');
    }
};
