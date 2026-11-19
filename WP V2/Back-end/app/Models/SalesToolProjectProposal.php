<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class SalesToolProjectProposal extends Model
{
    public const STATUS_PENDING = 'pending';

    public const STATUS_ACCEPTED = 'accepted';

    public const STATUS_DISMISSED = 'dismissed';

    protected $fillable = [
        'deal_id',
        'job_number',
        'title',
        'project_name',
        'client',
        'st_status',
        'stage',
        'pipeline_id',
        'owner',
        'agreed_cost',
        'value',
        'quoted_hours',
        'actual_hours',
        'start_date',
        'end_date',
        'delivery_address',
        'contact_name',
        'contact_phone',
        'contact_email',
        'company_phone',
        'company_email',
        'notes',
        'payload',
        'quotations',
        'quotations_checked_at',
        'status',
        'created_project_id',
        'accepted_at',
        'dismissed_at',
    ];

    protected $casts = [
        'payload' => 'array',
        'quotations' => 'array',
        'start_date' => 'date',
        'end_date' => 'date',
        'quotations_checked_at' => 'datetime',
        'accepted_at' => 'datetime',
        'dismissed_at' => 'datetime',
    ];

    public function createdProject(): BelongsTo
    {
        return $this->belongsTo(Project::class, 'created_project_id');
    }

    public function scopePending($query)
    {
        return $query->where('status', self::STATUS_PENDING);
    }

    public const MONTH_STATUS_INDEX = [
        'january' => 1,
        'february' => 2,
        'march' => 3,
        'april' => 4,
        'may' => 5,
        'june' => 6,
        'july' => 7,
        'august' => 8,
        'september' => 9,
        'october' => 10,
        'november' => 11,
        'december' => 12,
    ];

    /**
     * True when the deal falls in [since, until]:
     * - ST created/updated timestamps fall in the window, or
     * - deal start/end dates fall in / overlap the window, or
     * - CRM month-column status matches a month inside the window (e.g. "october").
     *
     * Does not include open-ended "In Progress" / future month columns outside the window.
     */
    public function isDealTouchedSince(\DateTimeInterface $since, ?\DateTimeInterface $until = null): bool
    {
        $sinceAt = \Carbon\Carbon::parse($since)->startOfDay();
        $untilAt = $until
            ? \Carbon\Carbon::parse($until)->endOfDay()
            : now()->endOfDay();

        $payload = is_array($this->payload) ? $this->payload : [];

        foreach (['deal_updated_at', 'deal_created_at', 'updatedAt', 'updated_at', 'createdAt', 'created_at'] as $key) {
            $parsed = $this->parsePayloadDate($payload[$key] ?? null);
            if ($parsed && $parsed->betweenIncluded($sinceAt, $untilAt)) {
                return true;
            }
        }

        if ($this->updated_at && $this->updated_at->betweenIncluded($sinceAt, $untilAt)) {
            return true;
        }
        if ($this->created_at && $this->created_at->betweenIncluded($sinceAt, $untilAt)) {
            return true;
        }

        $start = $this->start_date
            ? $this->start_date->copy()->startOfDay()
            : $this->parsePayloadDate($payload['start_date'] ?? $payload['startDate'] ?? null);
        $end = $this->end_date
            ? $this->end_date->copy()->startOfDay()
            : $this->parsePayloadDate($payload['end_date'] ?? $payload['endDate'] ?? null);

        if ($start && $start->betweenIncluded($sinceAt, $untilAt)) {
            return true;
        }
        if ($end && $end->betweenIncluded($sinceAt, $untilAt)) {
            return true;
        }
        if ($start && $end && $start->lte($untilAt) && $end->gte($sinceAt)) {
            return true;
        }

        // Month column matches any month inside the window (e.g. "october" in Aug–Oct).
        $status = strtolower(trim((string) $this->st_status));
        if ($this->isMonthColumnRelevant($status, $sinceAt, $untilAt)) {
            return true;
        }

        return false;
    }

    /**
     * Month CRM column matches a month inside [since, until] (not future months outside the window).
     */
    public function isMonthColumnRelevant(
        ?string $status,
        \DateTimeInterface $since,
        ?\DateTimeInterface $until = null,
    ): bool {
        $key = strtolower(trim((string) $status));
        if (! isset(self::MONTH_STATUS_INDEX[$key])) {
            return false;
        }

        $monthNum = self::MONTH_STATUS_INDEX[$key];
        $sinceAt = \Carbon\Carbon::parse($since)->startOfMonth();
        $untilAt = $until
            ? \Carbon\Carbon::parse($until)->startOfMonth()
            : $sinceAt->copy();

        if ($untilAt->lt($sinceAt)) {
            $untilAt = $sinceAt->copy();
        }

        $cursor = $sinceAt->copy();
        while ($cursor->lte($untilAt)) {
            if ((int) $cursor->format('n') === $monthNum) {
                return true;
            }
            $cursor->addMonth();
        }

        return false;
    }

    /**
     * Enough data to open Create project with import: job #, name, and a Quotation form.
     */
    public function hasCreateReadyData(): bool
    {
        if (trim((string) $this->job_number) === '') {
            return false;
        }
        if (trim((string) $this->project_name) === '') {
            return false;
        }

        $quotations = is_array($this->quotations) ? $this->quotations : [];
        foreach ($quotations as $file) {
            if (! is_array($file)) {
                continue;
            }
            if (! empty($file['is_quotation_form'])) {
                return true;
            }
            $name = trim((string) ($file['name'] ?? ''));
            if ($name !== '' && preg_match('/^quotation\s*form\s*[-–—:]/i', $name) === 1) {
                return true;
            }
        }

        return false;
    }

    private function parsePayloadDate(mixed $value): ?\Carbon\Carbon
    {
        $raw = trim((string) ($value ?? ''));
        if ($raw === '') {
            return null;
        }
        try {
            return \Carbon\Carbon::parse($raw)->startOfDay();
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * Prefill shape for CreateNewProjectModal / PDE.
     *
     * @return array<string, mixed>
     */
    public function toCreatePrefill(): array
    {
        $boundsStart = now()->startOfMonth()->toDateString();
        $boundsEnd = now()->endOfMonth()->toDateString();
        $start = $this->start_date?->toDateString() ?: $boundsStart;
        $end = $this->end_date?->toDateString() ?: $boundsEnd;
        $hours = trim((string) ($this->quoted_hours ?? ''));
        $partName = trim((string) ($this->title ?: 'Main')) ?: 'Main';
        $taskName = $partName;
        $quotations = is_array($this->quotations) ? $this->quotations : [];
        $preferred = null;
        foreach ($quotations as $file) {
            if (! empty($file['format_compatible']) && ! empty($file['webViewLink'])) {
                $preferred = $file;
                break;
            }
        }
        if ($preferred === null) {
            foreach ($quotations as $file) {
                if (! empty($file['has_tasks']) && ! empty($file['webViewLink'])) {
                    $preferred = $file;
                    break;
                }
            }
        }
        if ($preferred === null && $quotations !== []) {
            $preferred = $quotations[0];
        }

        return [
            'name' => $this->project_name,
            'color' => '#6b7280',
            'status' => 'active',
            'part_name' => $partName,
            'pp' => '',
            'doc_supply' => $start,
            'completion' => $end,
            'description' => $this->buildDescription(),
            'sheet_url' => $preferred['webViewLink'] ?? '',
            'sheet_name' => $preferred['sheet_name'] ?? 'Adjudication - TEMPL',
            'quotation_file_id' => $preferred['id'] ?? null,
            'quotations' => $quotations,
            'has_quotation' => $quotations !== [],
            'tasks' => [
                [
                    'task_name' => $taskName,
                    'est' => $hours !== '' ? $hours : '',
                    'dl' => '',
                    'plan' => $hours !== '' ? $hours : '',
                    'rap' => '',
                    'pp' => '',
                    'pri' => '',
                    'doc_supply' => $start,
                    'completion' => $end,
                ],
            ],
        ];
    }

    public function buildDescription(): string
    {
        $parts = [];
        if ($this->client) {
            $parts[] = 'Client: '.$this->client;
        }
        if ($this->owner) {
            $parts[] = 'Owner: '.$this->owner;
        }
        if ($this->agreed_cost !== null && $this->agreed_cost !== '') {
            $parts[] = 'Agreed: '.$this->agreed_cost;
        }
        if ($this->value !== null && $this->value !== '') {
            $parts[] = 'Value: '.$this->value;
        }
        if ($this->quoted_hours !== null && $this->quoted_hours !== '') {
            $parts[] = 'Quoted hours: '.$this->quoted_hours;
        }
        if ($this->actual_hours !== null && $this->actual_hours !== '') {
            $parts[] = 'Actual hours: '.$this->actual_hours;
        }
        if ($this->st_status) {
            $parts[] = 'ST status: '.$this->st_status;
        }
        if ($this->deal_id) {
            $parts[] = 'ST deal id: '.$this->deal_id;
        }
        if ($this->notes) {
            $parts[] = 'Notes: '.$this->notes;
        }

        return implode(' | ', $parts);
    }

    /**
     * @return array<string, mixed>
     */
    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'deal_id' => $this->deal_id,
            'job_number' => $this->job_number,
            'title' => $this->title,
            'project_name' => $this->project_name,
            'client' => $this->client,
            'st_status' => $this->st_status,
            'stage' => $this->stage,
            'pipeline_id' => $this->pipeline_id,
            'owner' => $this->owner,
            'agreed_cost' => $this->agreed_cost,
            'value' => $this->value,
            'quoted_hours' => $this->quoted_hours,
            'actual_hours' => $this->actual_hours,
            'start_date' => $this->start_date?->toDateString(),
            'end_date' => $this->end_date?->toDateString(),
            'delivery_address' => $this->delivery_address,
            'contact_name' => $this->contact_name,
            'contact_phone' => $this->contact_phone,
            'contact_email' => $this->contact_email,
            'company_phone' => $this->company_phone,
            'company_email' => $this->company_email,
            'notes' => $this->notes,
            'status' => $this->status,
            'created_project_id' => $this->created_project_id,
            'quotations' => is_array($this->quotations) ? $this->quotations : [],
            'quotations_checked_at' => $this->quotations_checked_at?->toIso8601String(),
            'has_quotation' => is_array($this->quotations) && count($this->quotations) > 0,
            'quotation_count' => is_array($this->quotations) ? count($this->quotations) : 0,
            'has_order_confirmation' => (bool) data_get($this->payload, 'has_order_confirmation', false),
            'order_confirmation' => is_array(data_get($this->payload, 'order_confirmation'))
                ? data_get($this->payload, 'order_confirmation')
                : null,
            'created_at' => $this->created_at?->toIso8601String(),
            'updated_at' => $this->updated_at?->toIso8601String(),
            'prefill' => $this->toCreatePrefill(),
            'description' => $this->buildDescription(),
            'href' => '/projects?salesToolProposal='.$this->id,
        ];
    }
}
