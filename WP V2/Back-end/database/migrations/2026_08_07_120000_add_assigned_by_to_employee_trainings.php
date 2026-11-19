<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->foreignId('assigned_by_user_id')->nullable()->after('employee_id')->constrained('users')->nullOnDelete();
            $table->string('assigned_by_name')->nullable()->after('assigned_by_user_id');
        });
    }

    public function down(): void
    {
        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->dropConstrainedForeignId('assigned_by_user_id');
            $table->dropColumn('assigned_by_name');
        });
    }
};
