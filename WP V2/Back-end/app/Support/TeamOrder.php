<?php

namespace App\Support;

class TeamOrder
{
    /**
     * Lower rank appears first. NRM teams by section number, then support teams,
     * then management/admin, then trainees.
     */
    public static function rank(?string $name): int
    {
        $name = trim((string) $name);
        if ($name === '') {
            return 99999;
        }

        $lower = mb_strtolower($name);

        if (preg_match('/nrm\s*(\d+)/i', $name, $matches)) {
            return (int) $matches[1];
        }

        if (str_contains($lower, 'q&a') || str_contains($lower, 'qa team')) {
            return 100;
        }

        if (str_contains($lower, 'support')) {
            return 110;
        }

        if (
            str_contains($lower, 'management')
            || str_contains($lower, 'administration')
            || str_contains($lower, 'sales and admin')
            || $lower === 'rauno'
        ) {
            return 9000;
        }

        if (str_contains($lower, 'trainee')) {
            return 9100;
        }

        return 200;
    }

    public static function compare(?string $a, ?string $b): int
    {
        $rank = self::rank($a) <=> self::rank($b);

        return $rank !== 0 ? $rank : strcasecmp((string) $a, (string) $b);
    }
}
