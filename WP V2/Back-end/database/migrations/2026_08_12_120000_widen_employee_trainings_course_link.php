<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('employee_trainings') || ! Schema::hasColumn('employee_trainings', 'course_link')) {
            return;
        }

        // Course URLs (SharePoint/Teams/LMS) routinely exceed varchar(191).
        DB::statement('ALTER TABLE `employee_trainings` MODIFY `course_link` TEXT NULL');
    }

    public function down(): void
    {
        if (! Schema::hasTable('employee_trainings') || ! Schema::hasColumn('employee_trainings', 'course_link')) {
            return;
        }

        DB::statement('ALTER TABLE `employee_trainings` MODIFY `course_link` VARCHAR(191) NULL');
    }
};
