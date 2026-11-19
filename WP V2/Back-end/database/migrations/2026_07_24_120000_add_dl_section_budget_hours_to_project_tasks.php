<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /** @var list<string> */
    private const DL_BUDGET_SUFFIXES = ['02', '03', '04', '05', '06'];

    public function up(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->string('dl_sec_hrs_02')->nullable()->after('dl_sec_hrs_approved');
            $table->string('dl_sec_hrs_03')->nullable();
            $table->string('dl_sec_hrs_04')->nullable();
            $table->string('dl_sec_hrs_05')->nullable();
            $table->string('dl_sec_hrs_06')->nullable();
        });

        DB::table('project_tasks')
            ->orderBy('id')
            ->chunkById(200, function ($tasks) {
                foreach ($tasks as $task) {
                    $dl = trim((string) ($task->dl ?? ''));
                    if ($dl === '') {
                        continue;
                    }

                    $updates = [];
                    $movedAny = false;

                    foreach (self::DL_BUDGET_SUFFIXES as $suffix) {
                        $secKey = "sec_hrs_{$suffix}";
                        $dlKey = "dl_sec_hrs_{$suffix}";
                        $value = trim((string) ($task->{$secKey} ?? ''));

                        if ($value === '') {
                            continue;
                        }

                        $updates[$dlKey] = $value;
                        $updates[$secKey] = null;
                        $movedAny = true;
                    }

                    if (! $movedAny) {
                        continue;
                    }

                    $tpsTotal = 0;
                    $hasTpsValue = false;

                    foreach (['sec_hrs_07', 'sec_hrs_extra'] as $field) {
                        $value = trim((string) ($updates[$field] ?? $task->{$field} ?? ''));
                        if ($value === '') {
                            continue;
                        }

                        $hasTpsValue = true;
                        $tpsTotal += (float) $value;
                    }

                    $updates['sec_hrs_total'] = $hasTpsValue
                        ? (string) (round($tpsTotal * 100) / 100)
                        : null;

                    DB::table('project_tasks')
                        ->where('id', $task->id)
                        ->update($updates);
                }
            });
    }

    public function down(): void
    {
        Schema::table('project_tasks', function (Blueprint $table) {
            $table->dropColumn([
                'dl_sec_hrs_02',
                'dl_sec_hrs_03',
                'dl_sec_hrs_04',
                'dl_sec_hrs_05',
                'dl_sec_hrs_06',
            ]);
        });
    }
};
