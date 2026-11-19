<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('users')) {
            return;
        }

        Schema::table('users', function (Blueprint $table) {
            $table->dropUnique(['email']);
        });

        DB::statement('ALTER TABLE users MODIFY email VARCHAR(191) NULL');

        Schema::table('users', function (Blueprint $table) {
            $table->unique('email');
        });
    }

    public function down(): void
    {
        if (! Schema::hasTable('users')) {
            return;
        }

        Schema::table('users', function (Blueprint $table) {
            $table->dropUnique(['email']);
        });

        DB::statement('ALTER TABLE users MODIFY email VARCHAR(191) NOT NULL');

        Schema::table('users', function (Blueprint $table) {
            $table->unique('email');
        });
    }
};
