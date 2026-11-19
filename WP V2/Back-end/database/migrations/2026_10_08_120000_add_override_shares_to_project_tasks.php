<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->string('override_share_1')->nullable()->after('override_3');
            $table->string('override_share_2')->nullable()->after('override_share_1');
            $table->string('override_share_3')->nullable()->after('override_share_2');
        });
    }

    public function down(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropColumn(['override_share_1', 'override_share_2', 'override_share_3']);
        });
    }
};
