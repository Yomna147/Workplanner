<?php

namespace App\Console\Commands;

use App\Services\ScheduledNotificationService;
use Illuminate\Console\Command;

class EvaluateScheduledNotifications extends Command
{
    protected $signature = 'notifications:evaluate-scheduled
                            {--dry-run : List matches without writing notices or sending email}
                            {--case=* : Limit to one or more case_type values}';

    protected $description = 'Evaluate scheduled planner notification rules (DL weekly status, incomplete training, etc.)';

    public function handle(ScheduledNotificationService $service): int
    {
        $dryRun = (bool) $this->option('dry-run');
        $cases = array_values(array_filter(array_map(
            static fn ($value) => trim((string) $value),
            (array) $this->option('case'),
        )));

        $result = $service->run($dryRun, $cases === [] ? null : $cases);

        $this->info(($dryRun ? '[dry-run] ' : '').'Scheduled notification evaluation complete.');
        $this->line('Matches: '.$result['matches_found']);

        if ($result['by_case'] !== []) {
            $this->table(['Case type', 'Matches'], collect($result['by_case'])
                ->map(fn ($count, $case) => [$case, $count])
                ->values()
                ->all());
        }

        if ($result['skipped'] !== []) {
            $this->warn('Skipped:');
            foreach ($result['skipped'] as $line) {
                $this->line('  - '.$line);
            }
        }

        if ($result['preview'] !== []) {
            $this->newLine();
            $this->line($dryRun ? 'Would notify:' : 'Notified:');
            foreach (array_slice($result['preview'], 0, 40) as $row) {
                $this->line(sprintf('  • [%s] %s — %s', $row['rule'], $row['item_name'], $row['detail']));
            }
            if (count($result['preview']) > 40) {
                $this->line('  … and '.(count($result['preview']) - 40).' more');
            }
        }

        $delivered = $result['delivered'];
        if (! $dryRun) {
            $this->line('Emails sent: '.$delivered['emails_sent']);
            if (($delivered['summary'] ?? '') !== '') {
                $this->line('Rules: '.$delivered['summary']);
            }
            foreach ($delivered['email_errors'] ?? [] as $error) {
                $this->error(($error['rule'] ?? 'email').': '.($error['error'] ?? 'unknown'));
            }
        }

        return self::SUCCESS;
    }
}
