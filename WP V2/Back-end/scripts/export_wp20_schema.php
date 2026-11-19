<?php

declare(strict_types=1);

require __DIR__.'/../vendor/autoload.php';

$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\DB;

$database = (string) config('database.connections.mysql.database');
$key = 'Tables_in_'.$database;
$rows = DB::select('SHOW TABLES');

$lines = [
    '-- WP 2.0 schema (generated from current database)',
    'SET NAMES utf8mb4;',
    'SET FOREIGN_KEY_CHECKS=0;',
    '',
];

foreach ($rows as $row) {
    $table = $row->{$key};
    $create = DB::select('SHOW CREATE TABLE `'.$table.'`')[0];
    $lines[] = 'DROP TABLE IF EXISTS `'.$table.'`;';
    $lines[] = $create->{'Create Table'}.';';
    $lines[] = '';
}

$lines[] = 'SET FOREIGN_KEY_CHECKS=1;';
$lines[] = '';

$target = __DIR__.'/../database/workplanner_2_0_schema.sql';
file_put_contents($target, implode(PHP_EOL, $lines));

echo 'Wrote '.count($rows)." tables to {$target}\n";
