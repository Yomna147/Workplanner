<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->string('dl_override_1')->nullable()->after('override_3');
            $table->string('dl_override_2')->nullable()->after('dl_override_1');
            $table->string('dl_override_3')->nullable()->after('dl_override_2');
        });
    }

    public function down(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropColumn(['dl_override_1', 'dl_override_2', 'dl_override_3']);
        });
    }
};
