<?php

namespace App\Support;

class NrmSort
{
    public static function compare(?string $a, ?string $b): int
    {
        $partsA = self::parts($a);
        $partsB = self::parts($b);
        $length = max(count($partsA), count($partsB));

        for ($index = 0; $index < $length; $index++) {
            $valueA = $partsA[$index] ?? 0;
            $valueB = $partsB[$index] ?? 0;

            if ($valueA !== $valueB) {
                return $valueA <=> $valueB;
            }
        }

        return 0;
    }

    /**
     * @return list<int>
     */
    private static function parts(?string $number): array
    {
        $number = trim((string) ($number ?? ''));

        if ($number === '') {
            return [0];
        }

        return array_map('intval', explode('.', $number));
    }
}
