<?php

namespace App\Support;

use App\Models\Nrm;
use Illuminate\Support\Collection;

class OperativeAllocationNrms
{
    /** @return list<string> */
    public static function numbers(): array
    {
        return NrmCatalog::numbers();
    }

    public static function ordered(): Collection
    {
        $numbers = self::numbers();

        $records = Nrm::query()
            ->whereIn('number', $numbers)
            ->get()
            ->keyBy('number');

        return collect($numbers)
            ->map(fn (string $number) => $records->get($number))
            ->filter()
            ->values();
    }
}
