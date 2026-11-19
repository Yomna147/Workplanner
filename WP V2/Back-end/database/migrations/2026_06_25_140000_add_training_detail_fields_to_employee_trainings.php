<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->text('course_link')->nullable()->after('title');
            $table->text('description')->nullable()->after('course_link');
            $table->string('duration')->nullable()->after('description');
            $table->string('status')->default('not_started')->after('duration');
            $table->string('priority')->default('P2')->after('status');
            $table->string('urgency')->default('U1')->after('priority');
            $table->boolean('confirm_override')->default(false)->after('urgency');
        });
    }

    public function down(): void
    {
        Schema::table('employee_trainings', function (Blueprint $table) {
            $table->dropColumn([
                'course_link',
                'description',
                'duration',
                'status',
                'priority',
                'urgency',
                'confirm_override',
            ]);
        });
    }
};
