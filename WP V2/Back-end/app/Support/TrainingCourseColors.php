<?php

namespace App\Support;

/**
 * Random, distinct colours for training courses (bars/legend use white text on them).
 * Every new course gets a freshly generated colour that no other course uses.
 */
class TrainingCourseColors
{
    /** Minimum RGB distance from existing course colours so bars stay tell-apart. */
    private const MIN_DISTANCE = 60;

    public static function normalize(?string $color): ?string
    {
        $value = strtoupper(trim((string) $color));

        return preg_match('/^#[0-9A-F]{6}$/', $value) === 1 ? $value : null;
    }

    /**
     * @param  iterable<string|null>  $used
     */
    public static function isUsed(string $color, iterable $used): bool
    {
        $color = self::normalize($color);
        foreach ($used as $existing) {
            if ($color !== null && self::normalize($existing) === $color) {
                return true;
            }
        }

        return false;
    }

    /**
     * A new random mid-dark colour (readable under white labels) that is not in $used
     * and, when possible, not visually close to any colour in $used.
     *
     * @param  iterable<string|null>  $used
     */
    public static function randomUnused(iterable $used = []): string
    {
        $usedColors = [];
        foreach ($used as $color) {
            $value = self::normalize($color);
            if ($value !== null) {
                $usedColors[$value] = self::toRgb($value);
            }
        }

        // Relax the distance requirement as the catalogue fills up.
        foreach ([self::MIN_DISTANCE, self::MIN_DISTANCE / 2, 1] as $minDistance) {
            for ($attempt = 0; $attempt < 200; $attempt++) {
                $color = self::randomReadableColor();
                if (isset($usedColors[$color])) {
                    continue;
                }
                $rgb = self::toRgb($color);
                $closest = PHP_INT_MAX;
                foreach ($usedColors as $other) {
                    $closest = min($closest, sqrt(
                        ($rgb[0] - $other[0]) ** 2 + ($rgb[1] - $other[1]) ** 2 + ($rgb[2] - $other[2]) ** 2,
                    ));
                }
                if ($closest >= $minDistance) {
                    return $color;
                }
            }
        }

        return self::randomReadableColor();
    }

    private static function randomReadableColor(): string
    {
        do {
            $color = self::hslToHex(random_int(0, 359), random_int(55, 85) / 100, random_int(30, 50) / 100);
        } while (self::relativeLuminance($color) > 0.25); // keeps >= 3.5:1 contrast with white text

        return $color;
    }

    private static function relativeLuminance(string $hex): float
    {
        $linear = array_map(function (int $channel) {
            $c = $channel / 255;

            return $c <= 0.03928 ? $c / 12.92 : (($c + 0.055) / 1.055) ** 2.4;
        }, self::toRgb($hex));

        return 0.2126 * $linear[0] + 0.7152 * $linear[1] + 0.0722 * $linear[2];
    }

    /** @return array{0:int,1:int,2:int} */
    private static function toRgb(string $hex): array
    {
        return [hexdec(substr($hex, 1, 2)), hexdec(substr($hex, 3, 2)), hexdec(substr($hex, 5, 2))];
    }

    private static function hslToHex(int $hue, float $saturation, float $lightness): string
    {
        $chroma = (1 - abs(2 * $lightness - 1)) * $saturation;
        $x = $chroma * (1 - abs(fmod($hue / 60, 2) - 1));
        $m = $lightness - $chroma / 2;

        [$r, $g, $b] = match (intdiv($hue, 60)) {
            0 => [$chroma, $x, 0],
            1 => [$x, $chroma, 0],
            2 => [0, $chroma, $x],
            3 => [0, $x, $chroma],
            4 => [$x, 0, $chroma],
            default => [$chroma, 0, $x],
        };

        return sprintf(
            '#%02X%02X%02X',
            (int) round(($r + $m) * 255),
            (int) round(($g + $m) * 255),
            (int) round(($b + $m) * 255),
        );
    }
}
