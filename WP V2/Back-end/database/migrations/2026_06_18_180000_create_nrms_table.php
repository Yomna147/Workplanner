<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('nrms', function (Blueprint $table) {
            $table->id();
            $table->string('number')->nullable();
            $table->string('name')->nullable();
            $table->string('sc_name');
            $table->string('pri')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('nrms');
    }
};
