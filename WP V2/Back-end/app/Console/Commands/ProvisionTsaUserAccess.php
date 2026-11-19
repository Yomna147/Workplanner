<?php

namespace App\Console\Commands;

use Database\Seeders\TsaUsersSeeder;
use Illuminate\Console\Command;

class ProvisionTsaUserAccess extends Command
{
    protected $signature = 'users:provision-tsa-access';

    protected $description = 'Create or update app login accounts for all employees with the standard TSA password';

    public function handle(): int
    {
        $this->call('db:seed', [
            '--class' => TsaUsersSeeder::class,
            '--force' => true,
        ]);

        $this->newLine();
        $this->info('All users can sign in with password: '.TsaUsersSeeder::DEFAULT_PASSWORD);

        return self::SUCCESS;
    }
}
