<?php

namespace App\Support;

/**
 * Canonical NRM sections for Operatives Allocation, PDE imports, and task naming.
 * Sourced from the v1 workplanner nrm table (bill schedule / Sc_Name mapping).
 */
class NrmCatalog
{
    /** Legacy v1 / Time Tracking section numbers mapped to canonical catalog numbers. */
    public const NUMBER_ALIASES = [
        '1.0' => '1.1',
    ];

    /** @var list<array{number: string, name: ?string, sc_name: string, pri: string}> */
    public const ENTRIES = [
        ['number' => '1.1', 'name' => '1 Substructure', 'sc_name' => '1.1 - Substructure', 'pri' => '0.11'],
        ['number' => '2.1', 'name' => '1 Frame', 'sc_name' => '2.1 - Frame', 'pri' => '0.65'],
        ['number' => '2.2', 'name' => '2 Upper floors', 'sc_name' => '2.2 - Upper floors', 'pri' => '0.66'],
        ['number' => '2.3', 'name' => '3 Roof', 'sc_name' => '2.3 - Roof', 'pri' => '0.67'],
        ['number' => '2.4', 'name' => '4 Stairs and ramps ', 'sc_name' => '2.4 - Stairs & ramps', 'pri' => '0.68'],
        ['number' => '2.5', 'name' => '5 External walls', 'sc_name' => '2.5 - External walls', 'pri' => '0.64'],
        ['number' => '2.6', 'name' => '6 Windows and external doors ', 'sc_name' => '2.6 - Win & Ext doors', 'pri' => '0.61'],
        ['number' => '2.7', 'name' => '7 Internal walls and partitions', 'sc_name' => '2.7 - Internal walls', 'pri' => '0.63'],
        ['number' => '2.8', 'name' => '8 Internal doors ', 'sc_name' => '2.8 - Internal doors', 'pri' => '0.62'],
        ['number' => '3.1', 'name' => '1 Wall finishes ', 'sc_name' => '3.1 - Wall finishes', 'pri' => '0.42'],
        ['number' => '3.2', 'name' => '2 Floor finishes ', 'sc_name' => '3.2 - Floor finishes', 'pri' => '0.45'],
        ['number' => '3.3', 'name' => '3 Ceiling finishes', 'sc_name' => '3.3 - Ceiling finishes', 'pri' => '0.46'],
        ['number' => '4.1', 'name' => '1 General fittings, furnishings and equipment', 'sc_name' => '4.1 - Fittings, furn', 'pri' => '0.43'],
        ['number' => '5.1', 'name' => '1 Sanitary appliances', 'sc_name' => '5.1 - Sanitaryware', 'pri' => '0.44'],
        ['number' => '5.15', 'name' => null, 'sc_name' => '5.15 - BWICW', 'pri' => '0.47'],
        ['number' => '7.0', 'name' => '7 Work to existing buildings', 'sc_name' => '7.0 - Alterations', 'pri' => '0.41'],
        ['number' => '8.1', 'name' => '1 Site preparation works', 'sc_name' => '8.1 - Site Works', 'pri' => '0.23'],
        ['number' => '8.2', 'name' => '2 Roads Paths and Pavings', 'sc_name' => '8.2 - Hard Surfaces', 'pri' => '0.24'],
        ['number' => '8.3', 'name' => '3 Planting', 'sc_name' => '8.3 - Soft Landscapings', 'pri' => '0.25'],
        ['number' => '8.4', 'name' => '4 Fences, railings and walls', 'sc_name' => '8.4 - Fences', 'pri' => '0.26'],
        ['number' => '8.5', 'name' => '5 Site/street furnture and equipment', 'sc_name' => '8.5 - Site Furniture', 'pri' => '0.27'],
        ['number' => '8.6', 'name' => '6 External drainage', 'sc_name' => '8.6 - Drainage', 'pri' => '0.21'],
        ['number' => '8.7', 'name' => '7 External services', 'sc_name' => '8.7 - Services', 'pri' => '0.22'],
        ['number' => '8.8', 'name' => '8 Minor Buildings', 'sc_name' => '8.8 - Minor Buildings', 'pri' => '0.28'],
    ];

    /** @return list<string> */
    public static function numbers(): array
    {
        return array_column(self::ENTRIES, 'number');
    }

    public static function canonicalNumber(?string $number): ?string
    {
        $trimmed = trim((string) ($number ?? ''));
        if ($trimmed === '') {
            return null;
        }

        return self::NUMBER_ALIASES[$trimmed] ?? $trimmed;
    }

    public static function normalizeTaskNamePrefix(?string $taskName): string
    {
        $taskName = trim((string) ($taskName ?? ''));
        if ($taskName === '') {
            return '';
        }

        if (! preg_match('/^(\d+\.\d+)(.*)$/u', $taskName, $matches)) {
            return $taskName;
        }

        $canonical = self::canonicalNumber($matches[1]) ?? $matches[1];

        return $canonical.$matches[2];
    }
}
