<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('training_notification_notices', function (Blueprint $table) {
            $table->id();
            $table->string('dedupe_key', 191)->unique();
            $table->string('rule_code', 64);
            $table->unsignedBigInteger('employee_training_id')->nullable()->index();
            $table->unsignedBigInteger('employee_id')->nullable()->index();
            $table->string('audience', 16);
            $table->string('title');
            $table->text('body');
            $table->string('email_subject')->nullable();
            $table->text('email_body')->nullable();
            $table->timestamp('read_at')->nullable();
            $table->timestamps();
        });

        $now = now();
        $rules = [
            [
                'code' => 'training_completed',
                'label' => 'Training completed',
                'description' => 'Trainee, team, course, and the date and time the course was marked completed.',
                'case_type' => 'training_completed',
                'case_value' => 1,
                'sort_order' => 110,
            ],
            [
                'code' => 'training_rescheduled',
                'label' => 'Training rescheduled',
                'description' => 'Trainee, course, original dates, new dates, who moved it, and the reason.',
                'case_type' => 'training_rescheduled',
                'case_value' => 1,
                'sort_order' => 120,
            ],
            [
                'code' => 'training_overdue',
                'label' => 'Training overdue',
                'description' => 'End date has passed, the course is not complete, and the dates have not been moved. Repeats every 2 days until it is completed or rescheduled.',
                'case_type' => 'training_overdue',
                'case_value' => 2,
                'sort_order' => 130,
            ],
            [
                'code' => 'training_starting_soon',
                'label' => 'Training starting soon',
                'description' => 'A course starts in the next 1–2 days. Notified once per course.',
                'case_type' => 'training_starting_soon',
                'case_value' => 2,
                'sort_order' => 140,
            ],
        ];

        foreach ($rules as $rule) {
            $exists = DB::table('email_notification_rules')->where('code', $rule['code'])->exists();
            if ($exists) {
                continue;
            }

            DB::table('email_notification_rules')->insert([
                'code' => $rule['code'],
                'label' => $rule['label'],
                'description' => $rule['description'],
                'case_type' => $rule['case_type'],
                'case_value' => $rule['case_value'],
                'enabled' => true,
                'in_app_enabled' => true,
                'email_enabled' => false,
                'recipient_user_ids' => json_encode([]),
                'recipient_emails' => json_encode([]),
                'recipient_names' => json_encode([]),
                'recipient_role_ids' => json_encode([1, 5]),
                'sort_order' => $rule['sort_order'],
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('training_notification_notices');

        DB::table('email_notification_rules')->whereIn('code', [
            'training_completed',
            'training_rescheduled',
            'training_overdue',
            'training_starting_soon',
        ])->delete();
    }
};
