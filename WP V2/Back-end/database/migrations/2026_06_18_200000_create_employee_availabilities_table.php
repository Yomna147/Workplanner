<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('employee_availabilities', function (Blueprint $table) {
            $table->id();
            $table->date('date');
            $table->string('strt1')->nullable();
            $table->string('end1')->nullable();
            $table->string('strt2')->nullable();
            $table->string('end2')->nullable();
            $table->string('strt3')->nullable();
            $table->string('end3')->nullable();
            $table->string('strt4')->nullable();
            $table->string('end4')->nullable();
            $table->string('total')->default('00:00');
            $table->string('total_ava')->default('00:00');
            $table->foreignId('employee_id')->constrained()->cascadeOnDelete();
            $table->timestamps();

            $table->unique(['employee_id', 'date']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('employee_availabilities');
    }
};
