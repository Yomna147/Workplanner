<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sales_tool_project_proposals', function (Blueprint $table) {
            $table->json('quotations')->nullable()->after('payload');
            $table->timestamp('quotations_checked_at')->nullable()->after('quotations');
        });
    }

    public function down(): void
    {
        Schema::table('sales_tool_project_proposals', function (Blueprint $table) {
            $table->dropColumn(['quotations', 'quotations_checked_at']);
        });
    }
};
