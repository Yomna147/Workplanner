<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('roles', function (Blueprint $table) {
            $table->id();
            $table->string('name')->unique();
            $table->timestamps();
        });

        Schema::create('pages', function (Blueprint $table) {
            $table->id();
            $table->string('name')->unique();
            $table->string('route')->nullable();
            $table->timestamps();
        });

        Schema::create('role_permissions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('role_id')->constrained()->cascadeOnDelete();
            $table->string('page');
            $table->unsignedTinyInteger('permission')->default(0);
            $table->timestamps();

            $table->unique(['role_id', 'page']);
        });

        Schema::table('users', function (Blueprint $table) {
            $table->string('first_name')->nullable()->after('name');
            $table->string('last_name')->nullable()->after('first_name');
            $table->string('login_name')->nullable()->unique()->after('last_name');
            $table->boolean('active')->default(true)->after('password');
            $table->foreignId('role_id')->nullable()->after('active')->constrained('roles')->nullOnDelete();
        });

        $adminRoleId = \Illuminate\Support\Facades\DB::table('roles')->insertGetId([
            'name' => 'Administrator',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        \Illuminate\Support\Facades\DB::table('users')
            ->where('is_admin', true)
            ->update([
                'first_name' => 'Admin',
                'last_name' => 'User',
                'login_name' => 'admin',
                'active' => true,
                'role_id' => $adminRoleId,
            ]);
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropConstrainedForeignId('role_id');
            $table->dropColumn(['first_name', 'last_name', 'login_name', 'active']);
        });

        Schema::dropIfExists('role_permissions');
        Schema::dropIfExists('pages');
        Schema::dropIfExists('roles');
    }
};
