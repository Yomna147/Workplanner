<?php

use App\Support\NrmCatalog;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $legacyNumber = '1.0';
        $canonicalNumber = NrmCatalog::canonicalNumber($legacyNumber);

        if ($canonicalNumber === null || $canonicalNumber === $legacyNumber) {
            return;
        }

        $legacy = DB::table('nrms')->where('number', $legacyNumber)->first();
        $canonical = DB::table('nrms')->where('number', $canonicalNumber)->first();

        if ($legacy && $canonical) {
            $legacyPivots = DB::table('employee_nrm')
                ->where('nrm_id', $legacy->id)
                ->get();

            foreach ($legacyPivots as $pivot) {
                $existing = DB::table('employee_nrm')
                    ->where('employee_id', $pivot->employee_id)
                    ->where('nrm_id', $canonical->id)
                    ->first();

                if ($existing) {
                    DB::table('employee_nrm')->where('id', $pivot->id)->delete();
                    continue;
                }

                DB::table('employee_nrm')
                    ->where('id', $pivot->id)
                    ->update(['nrm_id' => $canonical->id]);
            }

            DB::table('nrms')->where('id', $legacy->id)->delete();
        } elseif ($legacy) {
            DB::table('nrms')
                ->where('id', $legacy->id)
                ->update([
                    'number' => $canonicalNumber,
                    'sc_name' => '1.1 - Substructure',
                    'name' => '1 Substructure',
                    'pri' => '0.11',
                ]);
        }

        DB::table('project_tasks')
            ->where('task_name', 'like', '1.0 -%')
            ->update([
                'task_name' => DB::raw("REPLACE(task_name, '1.0 -', '1.1 -')"),
            ]);

        DB::table('project_tasks')
            ->where('task_name', 'like', '1.0-%')
            ->where('task_name', 'not like', '1.0 -%')
            ->update([
                'task_name' => DB::raw("REPLACE(task_name, '1.0-', '1.1-')"),
            ]);
    }

    public function down(): void
    {
        // Legacy 1.0 rows are merged into canonical 1.1; no safe automatic rollback.
    }
};
