<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('dl_update_submissions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            $table->string('dl_name');
            $table->foreignId('project_id')->constrained()->cascadeOnDelete();
            $table->timestamp('submitted_at');
            $table->unsignedInteger('task_count')->default(0);
            $table->string('note', 500)->nullable();
            $table->json('meta')->nullable();
            $table->timestamps();

            $table->index(['dl_name', 'project_id', 'submitted_at']);
            $table->index(['project_id', 'submitted_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('dl_update_submissions');
    }
};
