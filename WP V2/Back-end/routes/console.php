<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Current month every day so AVA stays fresh as the sheet is updated.
Schedule::command('availabilities:import-scheduled --months=1')
    ->dailyAt('06:00')
    ->withoutOverlapping();

// Also refresh current + next 2 months twice a week for planning ahead.
Schedule::command('availabilities:import-scheduled --months=3')
    ->days([2, 5])
    ->at('06:15')
    ->withoutOverlapping();

Schedule::command('notifications:evaluate-scheduled')
    ->dailyAt('07:30')
    ->withoutOverlapping();
