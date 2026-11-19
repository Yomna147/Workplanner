<?php
try {
    $pdo = new PDO('mysql:host=127.0.0.1;port=3306;dbname=workplanner_2_0', 'root', '');
    echo "db ok\n";
} catch (Throwable $e) {
    echo 'db fail: '.$e->getMessage()."\n";
    exit(1);
}
