<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('employee_nrm', function (Blueprint $table) {
            $table->id();
            $table->foreignId('employee_id')->constrained()->cascadeOnDelete();
            $table->foreignId('nrm_id')->constrained('nrms')->cascadeOnDelete();
            $table->string('OAP')->default('');
            $table->string('performance_percentage')->nullable();
            $table->timestamps();

            $table->unique(['employee_id', 'nrm_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('employee_nrm');
    }
};
