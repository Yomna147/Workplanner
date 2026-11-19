<?php

namespace Database\Seeders;

use App\Models\Nrm;
use App\Support\NrmCatalog;
use Illuminate\Database\Seeder;

class NrmSeeder extends Seeder
{
    public function run(): void
    {
        foreach (NrmCatalog::ENTRIES as $entry) {
            Nrm::updateOrCreate(
                ['number' => $entry['number']],
                [
                    'name' => $entry['name'],
                    'sc_name' => $entry['sc_name'],
                    'pri' => $entry['pri'],
                ],
            );
        }
    }
}
