<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class ImportWorkplannerSql extends Command
{
    protected $signature = 'db:import-wp-sql
                            {file? : Path to SQL import file}
                            {--full : Clear and re-import all tables}
                            {--batch=300 : Rows per INSERT batch for large tables}';

    protected $description = 'Import workplanner_2_0_import.sql with batched inserts (avoids max_allowed_packet errors)';

    public function handle(): int
    {
        $path = $this->argument('file') ?? database_path('workplanner_2_0_import.sql');

        if (! is_file($path)) {
            $this->error("SQL file not found: {$path}");

            return self::FAILURE;
        }

        set_time_limit(0);
        ini_set('memory_limit', '512M');

        $batchSize = max(50, (int) $this->option('batch'));
        $full = (bool) $this->option('full');

        $this->info($full ? 'Full import starting…' : 'Repair import (missing rows only)…');
        $this->line("File: {$path}");

        DB::statement('SET FOREIGN_KEY_CHECKS=0');

        try {
            if ($full) {
                $this->runFullImport($path, $batchSize);
            } else {
                $this->runRepairImport($path, $batchSize);
            }

            DB::statement('SET FOREIGN_KEY_CHECKS=1');

            $this->newLine();
            $this->info('Import completed.');
            $this->printCounts();

            return self::SUCCESS;
        } catch (\Throwable $e) {
            DB::statement('SET FOREIGN_KEY_CHECKS=1');
            $this->error('Import failed: '.$e->getMessage());

            return self::FAILURE;
        }
    }

    private function runFullImport(string $path, int $batchSize): void
    {
        $lines = file($path, FILE_IGNORE_NEW_LINES);

        if ($lines === false) {
            throw new \RuntimeException('Unable to read SQL file.');
        }

        $i = 0;
        $total = count($lines);

        while ($i < $total) {
            $line = $lines[$i];

            if ($this->isSkippableLine($line)) {
                $i++;

                continue;
            }

            if (preg_match('/^\/\*/', trim($line))) {
                while ($i < $total && ! str_contains($lines[$i], '*/')) {
                    $i++;
                }
                $i++;

                continue;
            }

            if (preg_match('/^INSERT INTO `employee_availabilities`/i', $line)) {
                $header = $line;
                $i++;
                $valueLines = [];

                while ($i < $total) {
                    $row = trim($lines[$i]);
                    if ($row === '' || str_starts_with($row, '--')) {
                        $i++;

                        continue;
                    }
                    if (preg_match('/^INSERT INTO `/i', $row) || preg_match('/^ALTER TABLE `/i', $row) || preg_match('/^SET /i', $row) || preg_match('/^COMMIT/i', $row)) {
                        break;
                    }

                    $valueLines[] = rtrim($row, ',;');
                    $i++;
                }

                $this->executeBatchedInsert($header, $valueLines, $batchSize, 'employee_availabilities');

                continue;
            }

            if (preg_match('/^(DELETE|INSERT|ALTER|SET|START|COMMIT)/i', $line)) {
                $statement = $this->collectStatement($lines, $i);
                $trimmed = trim($statement);

                if ($trimmed === '' || preg_match('/^START TRANSACTION/i', $trimmed)) {
                    continue;
                }

                // ALTER TABLE implicitly commits in MySQL; run outside any Laravel transaction.
                if (preg_match('/^ALTER TABLE/i', $trimmed)) {
                    DB::unprepared($statement);

                    continue;
                }

                DB::unprepared($statement);

                continue;
            }

            $i++;
        }
    }

    private function runRepairImport(string $path, int $batchSize): void
    {
        $maxAvailId = (int) DB::table('employee_availabilities')->max('id');
        $this->line("Current max employee_availabilities id: {$maxAvailId}");

        $lines = file($path, FILE_IGNORE_NEW_LINES);

        if ($lines === false) {
            throw new \RuntimeException('Unable to read SQL file.');
        }

        $missingAvail = [];
        $rolePermSql = null;
        $usersSql = null;
        $inAvailInsert = false;
        $availHeader = null;

        foreach ($lines as $line) {
            if (preg_match('/^INSERT INTO `employee_availabilities`/i', $line)) {
                $inAvailInsert = true;
                $availHeader = $line;

                continue;
            }

            if ($inAvailInsert) {
                $row = trim($line);

                if ($row === '' || str_starts_with($row, '--')) {
                    continue;
                }

                if (preg_match('/^INSERT INTO `/i', $row) || preg_match('/^ALTER TABLE `/i', $row)) {
                    $inAvailInsert = false;
                } else {
                    if (preg_match('/^\((\d+),/', $row, $m) && (int) $m[1] > $maxAvailId) {
                        $missingAvail[] = rtrim($row, ',;');
                    }

                    continue;
                }
            }

            if ($rolePermSql === null && preg_match('/^INSERT INTO `role_permissions`/i', $line)) {
                $rolePermSql = $this->extractInsertBlock($lines, array_search($line, $lines, true));

                continue;
            }

            if ($usersSql === null && preg_match('/^INSERT INTO `users`/i', $line)) {
                $usersSql = $this->extractInsertBlock($lines, array_search($line, $lines, true));
            }
        }

        if ($missingAvail !== [] && $availHeader !== null) {
            $this->info('Inserting '.count($missingAvail).' missing availability rows…');
            $this->executeBatchedInsert($availHeader, $missingAvail, $batchSize, 'employee_availabilities');
        } else {
            $this->line('No missing availability rows found.');
        }

        if (DB::table('role_permissions')->count() === 0 && $rolePermSql !== null) {
            $this->info('Inserting role_permissions…');
            DB::unprepared($rolePermSql);
        }

        if (DB::table('users')->count() === 0 && $usersSql !== null) {
            $this->info('Inserting users…');
            DB::unprepared($usersSql);
        }

        DB::unprepared('ALTER TABLE `employee_availabilities` AUTO_INCREMENT = 116126');
        DB::unprepared('ALTER TABLE `role_permissions` AUTO_INCREMENT = 120');
        DB::unprepared('ALTER TABLE `users` AUTO_INCREMENT = 30');
    }

    private function extractInsertBlock(array $lines, int|false $startIndex): ?string
    {
        if ($startIndex === false) {
            return null;
        }

        $parts = [];
        $total = count($lines);

        for ($i = $startIndex; $i < $total; $i++) {
            $line = $lines[$i];

            if ($i > $startIndex && (str_starts_with(trim($line), '--') || trim($line) === '')) {
                if (str_ends_with(end($parts), ';')) {
                    break;
                }

                continue;
            }

            if ($i > $startIndex && preg_match('/^INSERT INTO `/i', $line)) {
                break;
            }

            $parts[] = $line;

            if (str_ends_with(rtrim($line), ';')) {
                break;
            }
        }

        return implode("\n", $parts);
    }

    private function executeBatchedInsert(string $header, array $valueLines, int $batchSize, string $label): void
    {
        $chunks = array_chunk($valueLines, $batchSize);
        $bar = $this->output->createProgressBar(count($chunks));
        $bar->setFormat(" %current%/%max% batches [{$label}]");

        foreach ($chunks as $chunk) {
            $sql = $header."\n".implode(",\n", $chunk).';';
            DB::unprepared($sql);
            $bar->advance();
        }

        $bar->finish();
        $this->newLine();
    }

    private function collectStatement(array $lines, int &$index): string
    {
        $parts = [];
        $total = count($lines);

        while ($index < $total) {
            $parts[] = $lines[$index];
            if (str_ends_with(rtrim($lines[$index]), ';')) {
                $index++;

                break;
            }
            $index++;
        }

        return implode("\n", $parts);
    }

    private function isSkippableLine(string $line): bool
    {
        $trimmed = trim($line);

        return $trimmed === '' || str_starts_with($trimmed, '--');
    }

    private function printCounts(): void
    {
        $tables = [
            'teams', 'nrms', 'roles', 'pages', 'employees', 'employee_nrm',
            'projects', 'parts', 'project_tasks', 'employee_availabilities',
            'role_permissions', 'users',
        ];

        foreach ($tables as $table) {
            $count = DB::table($table)->count();
            $this->line(sprintf('  %-28s %s', $table.':', number_format($count)));
        }
    }
}
