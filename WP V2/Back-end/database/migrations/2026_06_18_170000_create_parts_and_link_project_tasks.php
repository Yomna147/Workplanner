<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('parts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->timestamps();

            $table->unique(['project_id', 'name']);
        });

        Schema::table('project_tasks', function (Blueprint $table) {
            $table->foreignId('part_id')->nullable()->after('project_id')->constrained()->cascadeOnDelete();
        });

        $projectIds = DB::table('project_tasks')
            ->distinct()
            ->pluck('project_id');

        foreach ($projectIds as $projectId) {
            $partId = DB::table('parts')->insertGetId([
                'project_id' => $projectId,
                'name' => 'Part 1',
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            DB::table('project_tasks')
                ->where('project_id', $projectId)
                ->update(['part_id' => $partId]);
        }

        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropConstrainedForeignId('project_id');
        });
    }

    public function down(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->foreignId('project_id')->nullable()->after('id')->constrained()->cascadeOnDelete();
        });

        $parts = DB::table('parts')->get();
        foreach ($parts as $part) {
            DB::table('project_tasks')
                ->where('part_id', $part->id)
                ->update(['project_id' => $part->project_id]);
        }

        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropConstrainedForeignId('part_id');
        });

        Schema::dropIfExists('parts');
    }
};
