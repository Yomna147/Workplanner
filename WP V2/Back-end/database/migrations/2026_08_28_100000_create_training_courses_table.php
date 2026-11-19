<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('training_courses', function (Blueprint $table) {
            $table->id();
            $table->string('title')->unique();
            $table->text('course_link')->nullable();
            $table->text('description')->nullable();
            $table->string('duration')->default('1-2 hours');
            $table->decimal('hours_per_day', 5, 2)->default(8);
            $table->string('priority', 8)->default('P2');
            $table->string('urgency', 8)->default('U1');
            $table->boolean('is_active')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('training_courses');
    }
};
