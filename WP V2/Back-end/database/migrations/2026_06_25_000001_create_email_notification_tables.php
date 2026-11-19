<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('email_notification_settings', function (Blueprint $table) {
            $table->id();
            $table->string('key', 64)->unique();
            $table->json('value');
            $table->timestamps();
        });

        Schema::create('email_notification_rules', function (Blueprint $table) {
            $table->id();
            $table->string('code', 64)->unique();
            $table->string('label');
            $table->text('description')->nullable();
            $table->string('case_type', 64);
            $table->decimal('case_value', 8, 2)->default(0);
            $table->boolean('enabled')->default(true);
            $table->boolean('in_app_enabled')->default(true);
            $table->boolean('email_enabled')->default(false);
            $table->json('recipient_user_ids')->nullable();
            $table->json('recipient_emails')->nullable();
            $table->json('recipient_names')->nullable();
            $table->unsignedInteger('sort_order')->default(0);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('email_notification_rules');
        Schema::dropIfExists('email_notification_settings');
    }
};
