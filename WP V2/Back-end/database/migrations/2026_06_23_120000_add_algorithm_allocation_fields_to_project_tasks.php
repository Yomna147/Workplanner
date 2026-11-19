<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->string('ts')->nullable()->after('sp');
            $table->string('sh')->nullable()->after('ts');
            $table->string('al')->nullable()->after('sh');
        });
    }

    public function down(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropColumn(['ts', 'sh', 'al']);
        });
    }
};
