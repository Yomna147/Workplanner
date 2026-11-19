<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('email_notification_rules', function (Blueprint $table) {
            $table->json('for_role_ids')->nullable()->after('recipient_names');
            $table->json('recipient_role_ids')->nullable()->after('for_role_ids');
        });
    }

    public function down(): void
    {
        Schema::table('email_notification_rules', function (Blueprint $table) {
            $table->dropColumn(['for_role_ids', 'recipient_role_ids']);
        });
    }
};
