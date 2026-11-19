<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->index(['done', 'part_id'], 'project_tasks_done_part_id_index');
            $table->index(['done', 'pri', 'created_at'], 'project_tasks_algo_order_index');
        });
    }

    public function down(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropIndex('project_tasks_done_part_id_index');
            $table->dropIndex('project_tasks_algo_order_index');
        });
    }
};
