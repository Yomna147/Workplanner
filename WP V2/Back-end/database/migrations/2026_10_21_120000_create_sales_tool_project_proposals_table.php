<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sales_tool_project_proposals', function (Blueprint $table) {
            $table->id();
            $table->string('deal_id', 64)->nullable()->index();
            $table->string('job_number', 32)->index();
            $table->string('title')->nullable();
            $table->string('project_name');
            $table->string('client')->nullable();
            $table->string('st_status', 64)->nullable();
            $table->string('stage')->nullable();
            $table->string('pipeline_id', 64)->nullable();
            $table->string('owner')->nullable();
            $table->string('agreed_cost')->nullable();
            $table->string('value')->nullable();
            $table->string('quoted_hours')->nullable();
            $table->string('actual_hours')->nullable();
            $table->date('start_date')->nullable();
            $table->date('end_date')->nullable();
            $table->string('delivery_address')->nullable();
            $table->string('contact_name')->nullable();
            $table->string('contact_phone')->nullable();
            $table->string('contact_email')->nullable();
            $table->string('company_phone')->nullable();
            $table->string('company_email')->nullable();
            $table->text('notes')->nullable();
            $table->json('payload')->nullable();
            $table->string('status', 24)->default('pending')->index();
            $table->unsignedBigInteger('created_project_id')->nullable()->index();
            $table->timestamp('accepted_at')->nullable();
            $table->timestamp('dismissed_at')->nullable();
            $table->timestamps();

            $table->unique(['deal_id', 'job_number']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sales_tool_project_proposals');
    }
};
