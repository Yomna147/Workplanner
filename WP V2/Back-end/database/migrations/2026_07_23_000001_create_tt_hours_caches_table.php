<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tt_hours_caches', function (Blueprint $table) {
            $table->id();
            $table->string('scope_key', 64)->unique()->default('global');
            $table->timestamp('fetched_at');
            $table->date('date_start')->nullable();
            $table->date('date_end')->nullable();
            $table->unsignedSmallInteger('version')->default(1);
            $table->longText('payload');
            $table->foreignId('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tt_hours_caches');
    }
};
